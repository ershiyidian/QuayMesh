import assert from "node:assert/strict";
import { constants, type ServerHttp2Stream } from "node:http2";
import type { Duplex } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { PeerLink, PeerTransport, type RpcHandler } from "../../src/federation/transport.js";
import type { FederationConfig } from "../../src/federation/types.js";

const FRAME_SERVICE = "$frame.v1";
const payload = "x".repeat(256 * 1024);

function config(nodeId: string): FederationConfig {
  return { enabled: true, coordinatorId: "target", nodeId, nickname: nodeId, host: "127.0.0.1", port: 0,
    heartbeatMs: 100, rpcTimeoutMs: 5000, peers: [], roots: [], tokenEnv: "TEST_TOKEN", priority: 0,
    capabilities: { coordinator: false, worker: true, discovery: false, egress: false, meshRelay: false, desktopUi: false, consoleRelay: false },
    egress: { enabled: false, listenPort: 0, proxyUrl: "http://127.0.0.1:1", controllerSecretEnv: "TEST_SECRET",
      probeUrl: "http://example.invalid", probeIntervalMs: 15000, recoveryDelayMs: 60000, inheritProxy: false } };
}

async function until(check: () => boolean, message: string) {
  const deadline = Date.now() + 4000;
  while (!check()) { assert.ok(Date.now() < deadline, message); await delay(5); }
}

async function pair(handler: RpcHandler) {
  const targetConfig = config("target");
  targetConfig.peers = [{ id: "caller", url: "" }];
  const target = new PeerTransport(targetConfig, "fixture-secret", handler, () => {});
  await target.start();
  const callerConfig = config("caller");
  callerConfig.peers = [{ id: "target", url: `http://127.0.0.1:${target.address}` }];
  const caller = new PeerTransport(callerConfig, "fixture-secret", () => null, () => {});
  await caller.start();
  await until(() => Boolean(caller.links.get("target")?.connected && target.links.get("caller")?.connected), "实际连接未建立");
  return { caller, target, close: async () => { await caller.close(); await target.close(); } };
}

function receiveFrames(transport: PeerTransport, receive: (link: PeerLink, stream: Duplex) => Promise<void>) {
  const receiver = transport as unknown as {
    receiveStream(link: PeerLink, service: string, metadata: unknown, stream: Duplex): Promise<void>;
  };
  const original = receiver.receiveStream.bind(transport);
  receiver.receiveStream = (link, service, metadata, stream) => service === FRAME_SERVICE
    ? receive(link, stream) : original(link, service, metadata, stream);
  return original;
}

for (const cancelled of [false, true]) {
  test(`正文接收遇到${cancelled ? "显式取消仍保留" : "异常重置即关闭"}控制连接，即使发送者尚未换链`, { timeout: 8000 }, async () => {
    const p = await pair(() => null);
    const receiver = p.caller.links.get("target")!;
    let read!: () => void;
    const reading = new Promise<void>(resolve => { read = resolve; });
    const receive = receiveFrames(p.caller, async (link, stream) => {
      stream.once("data", read);
      await receive(link, FRAME_SERVICE, {}, stream);
    });
    try {
      const stream = await p.target.openStream(p.target.links.get("caller")!, FRAME_SERVICE, {});
      stream.on("error", () => {});
      stream.write('{"method":"notice","params":"' + payload);
      await reading;
      if (cancelled) (stream as ServerHttp2Stream).close(constants.NGHTTP2_CANCEL);
      else stream.destroy(new Error("fixture unexpected body reset"));
      if (cancelled) {
        await delay(30);
        assert.equal(receiver.connected, true, receiver.closeReason);
      } else {
        await until(() => !receiver.connected, "接收者应使异常正文所属连接失效");
        assert.match(receiver.closeReason, /frame_receive_error/u);
      }
    } finally { await p.close(); }
  });
}

for (const body of ["request", "reply"] as const) {
  test(`${body} 正文在本地写完后被重置，发送者使连接失效且修改不重放`, { timeout: 10000 }, async () => {
    let executions = 0;
    const p = await pair(method => {
      if (method === "small") return "ready";
      executions++;
      return body === "reply" ? payload : "saved";
    });
    const originalCaller = p.caller.links.get("target")!;
    const sender = body === "request" ? p.caller : p.target;
    const receiver = body === "request" ? p.target : p.caller;
    const originalReceiver = receiver.links.get(body === "request" ? "caller" : "target")!;
    let writer: Duplex | undefined, resetAfterWrite = false;
    const open = sender.openStream.bind(sender);
    sender.openStream = async (...args) => {
      const stream = await open(...args);
      if (args[1] === FRAME_SERVICE) writer = stream;
      return stream;
    };
    const receive = receiveFrames(receiver, async (link, stream) => {
      if (link !== originalReceiver) { await receive(link, FRAME_SERVICE, {}, stream); return; }
      for await (const _chunk of stream) {}
      await until(() => writer?.writableFinished === true, "故障必须发生在实际本地写完之后");
      resetAfterWrite = true;
      stream.destroy(new Error("fixture late frame reset"));
    });
    try {
      await assert.rejects(originalCaller.call("mutation", body === "request" ? { body: payload } : {}, 1000),
        (error: any) => error.code === "RPC_INTERRUPTED" && error.effect === "unknown");
      assert.equal(resetAfterWrite, true);
      assert.equal(originalCaller.connected, false);
      assert.equal(executions, body === "reply" ? 1 : 0);
      await until(() => Boolean(p.caller.links.get("target")?.connected && p.caller.links.get("target") !== originalCaller), "故障连接应自动重建");
      assert.equal(await p.caller.links.get("target")!.call("small", {}), "ready");
      assert.equal(executions, body === "reply" ? 1 : 0, "换链不能重放修改");
    } finally { await p.close(); }
  });
}

test("正文名额保持到对端确认，已写完但未确认的八条流仍占用名额", { timeout: 10000 }, async () => {
  const p = await pair(() => null);
  let release!: () => void, received = 0;
  const acknowledgement = new Promise<void>(resolve => { release = resolve; });
  receiveFrames(p.target, async (link, stream) => {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    received++;
    await acknowledgement;
    link.receiveFrame(Buffer.concat(chunks).toString("utf8"));
    stream.end(Buffer.from([1]));
  });
  const link = p.caller.links.get("target")!;
  assert.equal(link.frameAcknowledgements, true);
  let settled = 0;
  const deliveries = Array.from({ length: 8 }, () => link.send({ method: "notice", params: payload }).then(() => { settled++; }));
  try {
    await until(() => received === 8, "对端必须实际读完八份正文");
    await delay(10);
    assert.equal(settled, 0);
    assert.equal(link.diagnostics().outgoingLargeFrames, 8);
    await assert.rejects(link.send({ method: "notice", params: payload }), { code: "PEER_BUSY", effect: "not_started" });
    assert.equal(link.connected, true);
    release();
    await Promise.all(deliveries);
    assert.equal(link.diagnostics().outgoingLargeFrames, 0);
    assert.equal(link.connected, true);
  } finally { release(); await Promise.allSettled(deliveries); await p.close(); }
});

for (const acknowledgement of ["early", "body", "empty", "cancel"] as const) {
  test(`正文拒绝 ${acknowledgement} 确认，不能将未完成交付记为成功`, { timeout: 8000 }, async () => {
    const p = await pair(() => null);
    receiveFrames(p.target, async (_link, stream) => {
      if (acknowledgement === "early") { stream.end(Buffer.from([1])); return; }
      for await (const _chunk of stream) {}
      if (acknowledgement === "cancel") (stream as ServerHttp2Stream).close(constants.NGHTTP2_CANCEL);
      else stream.end(acknowledgement === "body" ? "unexpected acknowledgement body" : undefined);
    });
    const link = p.caller.links.get("target")!;
    try {
      await assert.rejects(link.send({ method: "notice", params: "x".repeat(4 * 1024 * 1024) }), { code: "RPC_INTERRUPTED" });
      assert.equal(link.connected, false);
      assert.equal(link.diagnostics().outgoingLargeFrames, 0);
    } finally { await p.close(); }
  });
}

for (const body of ["request", "reply"] as const) {
  test(`${body} 正文只收到第一块时取消，双方保留控制连接`, { timeout: 8000 }, async () => {
    let executions = 0;
    const controller = new AbortController();
    const p = await pair(method => {
      if (method === "small") return "ready";
      executions++;
      return body === "reply" ? "x".repeat(4 * 1024 * 1024) : "saved";
    });
    const receiver = body === "request" ? p.target : p.caller;
    const receive = receiveFrames(receiver, async (link, stream) => {
      stream.once("data", () => controller.abort());
      await receive(link, FRAME_SERVICE, {}, stream);
    });
    const caller = p.caller.links.get("target")!, target = p.target.links.get("caller")!;
    try {
      await assert.rejects(caller.call("mutation", body === "request" ? { body: "x".repeat(4 * 1024 * 1024) } : {},
        5000, undefined, controller.signal), { code: "REQUEST_CANCELLED" });
      await delay(30);
      assert.equal(caller.connected, true, caller.closeReason);
      assert.equal(target.connected, true, target.closeReason);
      assert.equal(await caller.call("small", {}), "ready");
      assert.equal(executions, body === "reply" ? 1 : 0);
    } finally { await p.close(); }
  });
}
