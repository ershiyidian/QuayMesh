import assert from "node:assert/strict";
import test from "node:test";
import { createServer as createH2Server, constants, type Http2Session } from "node:http2";
import { createServer, connect, type Socket } from "node:net";
import { Transform } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { PeerTransport, PeerApplicationError, RpcRequestTimeoutError, type RpcHandler, type PeerProgressNotification } from "../../src/federation/transport.js";
import type { FederationConfig } from "../../src/federation/types.js";

function config(nodeId: string): FederationConfig {
  return { enabled: true, coordinatorId: "target", nodeId, nickname: nodeId, host: "127.0.0.1", port: 0,
    heartbeatMs: 100, rpcTimeoutMs: 10_000, peers: [], roots: [], tokenEnv: "TEST_TOKEN", priority: 0,
    capabilities: { coordinator: false, worker: true, discovery: false, egress: false, meshRelay: false, desktopUi: false, consoleRelay: false },
    egress: { enabled: false, listenPort: 0, proxyUrl: "http://127.0.0.1:1", controllerSecretEnv: "TEST_SECRET",
      probeUrl: "http://example.invalid", probeIntervalMs: 15000, recoveryDelayMs: 60000, inheritProxy: false } };
}
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) { assert.ok(Date.now() < deadline, "实际连接状态未达到预期"); await delay(10); }
}
async function pair(handler: RpcHandler) {
  const targetConfig = config("target"); targetConfig.peers = [{ id: "caller", url: "" }];
  const target = new PeerTransport(targetConfig, "fixture-secret", handler, () => {});
  await target.start();
  const callerConfig = config("caller"); callerConfig.peers = [{ id: "target", url: `http://127.0.0.1:${target.address}` }];
  const caller = new PeerTransport(callerConfig, "fixture-secret", handler, () => {});
  await caller.start(); await until(() => !!caller.links.get("target")?.connected && !!target.links.get("caller")?.connected);
  return { caller, target, close: async () => { await caller.close(); await target.close(); } };
}

test("协商的大正文在 NAT 双向连接上保留完整 8 MiB 图片编码", { timeout: 30_000 }, async () => {
  const p = await pair((_method, value) => value);
  try {
    const image = Buffer.alloc(8 * 1024 * 1024, 42).toString("base64");
    for (const link of [p.caller.links.get("target")!, p.target.links.get("caller")!]) {
      assert.equal(link.frameStreams, true);
      assert.deepEqual(await link.call("image", { image }), { image });
      assert.equal(link.connected, true);
    }
  } finally { await p.close(); }
});

test("真实限速链路中大正文传输期间小响应可独立完成", { timeout: 20_000 }, async () => {
  const sockets = new Set<Socket>(); let bulkStarted = false; let throttled = false;
  const targetConfig = config("target"); targetConfig.peers = [{ id: "caller", url: "" }];
  const target = new PeerTransport(targetConfig, "fixture-secret", method => {
    if (method === "bulk") { bulkStarted = true; return "x".repeat(4 * 1024 * 1024); }
    return "small";
  }, () => {});
  const proxy = createServer(client => {
    const upstream = connect(target.address, "127.0.0.1"); sockets.add(client); sockets.add(upstream);
    client.on("error", () => upstream.destroy()); upstream.on("error", () => client.destroy());
    client.on("close", () => { sockets.delete(client); upstream.destroy(); });
    upstream.on("close", () => { sockets.delete(upstream); client.destroy(); });
    const slower = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      if (!throttled) { this.push(chunk); callback(); return; }
      void (async () => {
        for (let offset = 0; offset < chunk.length; offset += 8192) {
          if (this.destroyed) return;
          this.push(chunk.subarray(offset, offset + 8192)); await delay(8);
        }
      })().then(() => callback(), callback);
    } });
    client.on("close", () => slower.destroy()); client.pipe(upstream); upstream.pipe(slower).pipe(client);
  });
  let caller: PeerTransport | undefined;
  try {
    await target.start(); await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
    const callerConfig = config("caller"); callerConfig.peers = [{ id: "target", url: `http://127.0.0.1:${(proxy.address() as { port: number }).port}` }];
    caller = new PeerTransport(callerConfig, "fixture-secret", () => null, () => {}); await caller.start();
    await until(() => !!caller!.links.get("target")?.connected);
    const link = caller.links.get("target")!;
    throttled = true; let bulkFinished = false;
    const bulk = link.call<string>("bulk", {}, 15_000).then(value => { bulkFinished = true; return value; }); bulk.catch(() => {});
    await until(() => bulkStarted); await delay(25);
    assert.equal(await link.call("small", {}, 1500), "small");
    assert.equal(bulkFinished, false, "小响应在大正文结束前已经送达");
    assert.equal((await bulk).length, 4 * 1024 * 1024);
    assert.equal(link.connected, true);
  } finally {
    await caller?.close(); await target.close(); for (const socket of sockets) socket.destroy();
    if (proxy.listening) await new Promise<void>(resolve => proxy.close(() => resolve()));
  }
});

test("响应头前 RST_STREAM 立即拒绝建流，保留 control 连接", async () => {
  const sessions = new Set<Http2Session>(); const server = createH2Server();
  server.on("session", session => { sessions.add(session); session.on("error", () => {}); session.on("close", () => sessions.delete(session)); });
  server.on("stream", (stream, headers) => {
    stream.on("error", () => {});
    if (headers[":path"] === "/control") { stream.respond({ ":status": 200, "x-quaymesh-node": "target" }); stream.on("data", () => {}); }
    else stream.close(constants.NGHTTP2_CANCEL);
  });
  let caller: PeerTransport | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const cfg = config("caller"); cfg.peers = [{ id: "target", url: `http://127.0.0.1:${(server.address() as { port: number }).port}` }];
    caller = new PeerTransport(cfg, "fixture-secret", () => null, () => {}); await caller.start();
    await until(() => !!caller!.links.get("target")); const link = caller.links.get("target")!;
    assert.equal(link.frameStreams, false, "旧节点继续走兼容协议");
    await assert.rejects(Promise.race([link.openStream("fixture"), delay(1000).then(() => { throw new Error("test_deadline"); })]),
      error => error instanceof Error && /响应头前/.test(error.message) && (error as Error & {code?:string}).code === "RPC_INTERRUPTED");
    assert.equal(link.connected, true);
    await assert.rejects(link.call("oversized", { image: "x".repeat(9 * 1024 * 1024) }), { code: "PEER_PAYLOAD_TOO_LARGE", effect: "not_started" });
    assert.equal(link.connected, true);
  } finally {
    await caller?.close(); for (const session of sessions) session.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("跨节点错误保留安全恢复身份、effect 和 retryHint", async () => {
  const p = await pair(() => { throw Object.assign(new Error("fixture"), { code: "FIXTURE_ERROR", effect: "partial", retryHint: "do_not_retry",
    details: { operation_id: "op_fixture", receipt_node_id: "target", next_action: { tool: "workspace_context", arguments: { action: "status", operation_id: "op_fixture" } }, authorization: "secret" } }); });
  try {
    await assert.rejects(p.caller.links.get("target")!.call("error", {}), error => {
      assert.ok(error instanceof PeerApplicationError); assert.equal(error.effect, "partial"); assert.equal(error.retryHint, "do_not_retry");
      assert.equal(error.details?.operation_id, "op_fixture"); assert.equal(error.details?.authorization, undefined); return true;
    });
  } finally { await p.close(); }
});

test("调用超时传播取消信号并释放远端只读等待", async () => {
  let cancelled = false;
  const p = await pair((_method, _value, _peer, context) => new Promise(resolve => {
    context!.signal.addEventListener("abort", () => { cancelled = true; resolve(null); }, { once: true });
  }));
  try {
    const link = p.caller.links.get("target")!;
    await assert.rejects(link.call("read", {}, 100), RpcRequestTimeoutError);
    await until(() => cancelled); assert.equal(link.pending.size, 0); assert.equal(link.connected, true);
    assert.equal(p.target.links.get("caller")!.diagnostics().incomingRpc, 0);
  } finally { await p.close(); }
});

test("业务进度绑定实际 RPC，只在等待期间转发安全的 progress 通知", async () => {
  let requestId = "";
  const p = await pair(async (_method, _value, _peer, context) => {
    requestId = context!.requestId!;
    context!.notify({ method: "notifications/progress", params: { progressToken: "host-token", progress: 1, message: "读取已完成" } });
    context!.notify({ method: "notifications/message", params: { message: "must-not-forward" } });
    await delay(30);
    return { persisted: true };
  });
  try {
    const notifications: PeerProgressNotification[] = [];
    const result = await p.caller.links.get("target")!.call("read", {}, 1000, notification => { notifications.push(notification); });
    assert.deepEqual(result, { persisted: true });
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].params.message, "读取已完成");
    p.target.links.get("caller")!.notify("$progress", { id: requestId, notification: {
      method: "notifications/progress", params: { progressToken: "host-token", progress: 2, message: "late" },
    } });
    await delay(30);
    assert.equal(notifications.length, 1, "交付后的迟到进度不能重启宿主等待状态");
  } finally { await p.close(); }
});

test("宿主取消立即结束 RPC 并通知远端，预先取消的请求不发送", async () => {
  let started = 0, cancelled = 0;
  const p = await pair((_method, _value, _peer, context) => {
    started++;
    return new Promise(resolve => context!.signal.addEventListener("abort", () => { cancelled++; resolve(null); }, { once: true }));
  });
  try {
    const controller = new AbortController();
    const link = p.caller.links.get("target")!;
    const result = link.call("read", {}, 20_000, undefined, controller.signal);
    const rejected = assert.rejects(result, { code: "REQUEST_CANCELLED", effect: "unknown" });
    await until(() => started === 1); controller.abort(); await rejected;
    await until(() => cancelled === 1); assert.equal(link.pending.size, 0);
    await assert.rejects(link.call("read", {}, 20_000, undefined, controller.signal), { code: "REQUEST_CANCELLED", effect: "not_started" });
    assert.equal(started, 1); assert.equal(link.connected, true);
  } finally { await p.close(); }
});
