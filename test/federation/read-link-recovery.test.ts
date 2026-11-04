import assert from "node:assert/strict";
import { constants, type ServerHttp2Stream } from "node:http2";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { dispatchPeerRequest, type ReadRetryLink } from "../../src/federation/read-retry.js";
import { PeerApplicationError, PeerTransport, RpcRequestTimeoutError } from "../../src/federation/transport.js";
import type { FederationConfig } from "../../src/federation/types.js";

function config(nodeId: string): FederationConfig {
  return { enabled: true, coordinatorId: "target", nodeId, nickname: nodeId, host: "127.0.0.1", port: 0,
    heartbeatMs: 100, rpcTimeoutMs: 5000, peers: [], roots: [], tokenEnv: "TEST_TOKEN", priority: 0,
    capabilities: { coordinator: false, worker: true, discovery: false, egress: false, meshRelay: false, desktopUi: false, consoleRelay: false },
    egress: { enabled: false, listenPort: 0, proxyUrl: "http://127.0.0.1:1", controllerSecretEnv: "TEST_SECRET",
      probeUrl: "http://example.invalid", probeIntervalMs: 15000, recoveryDelayMs: 60000, inheritProxy: false } };
}

async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) { assert.ok(Date.now() < deadline, "实际连接未达到预期"); await delay(10); }
}

for (const brokenBody of ["request", "reply"] as const) {
  test(`${brokenBody} 大正文建流中断后，只读重试更换仍在线的连接`, { timeout: 15000 }, async () => {
    const payload = "x".repeat(700 * 1024);
    const targetConfig = config("target");
    targetConfig.peers = [{ id: "caller", url: "" }];
    let reads = 0, resets = 0;
    const target = new PeerTransport(targetConfig, "fixture-secret", () => {
      reads++;
      return { status: 200, body: brokenBody === "reply" ? payload : "ready" };
    }, () => {});
    let caller: PeerTransport | undefined;
    try {
      await target.start();
      const callerConfig = config("caller");
      callerConfig.peers = [{ id: "target", url: `http://127.0.0.1:${target.address}` }];
      caller = new PeerTransport(callerConfig, "fixture-secret", () => null, () => {});
      await caller.start();
      await until(() => Boolean(caller!.links.get("target")?.connected && target.links.get("caller")?.connected));
      const old = caller.links.get("target")!;
      const brokenSession = target.links.get("caller")!.session;
      const receiver = target as unknown as {
        accept(stream: ServerHttp2Stream, headers: Record<string, unknown>): Promise<void>;
      };
      const accept = receiver.accept.bind(target);
      receiver.accept = async (stream, headers) => {
        if (headers[":path"] === "/stream" && stream.session === brokenSession) {
          resets++;
          stream.on("error", () => {});
          stream.close(constants.NGHTTP2_CANCEL);
          return;
        }
        await accept(stream, headers);
      };
      const params = { method: "GET", ...(brokenBody === "request" ? { body: payload } : {}) };
      const failures: unknown[] = [];
      const adapter = (): ReadRetryLink<{ status: number; body: string }> | undefined => {
        const link = caller!.links.get("target");
        return link && { get connected() { return link.connected; },
          call: timeout => link.call<{ status: number; body: string }>("console", params, timeout).catch(error => {
            failures.push(error);
            assert.equal(link.connected, true, "正文建流失败时控制流仍在线");
            throw error;
          }),
          close: () => link.close() };
      };
      const reply = await dispatchPeerRequest({
        node: "target", method: "console", params, timeoutMs: 5000, rpcTimeoutMs: 5000, getLink: adapter,
        waitForLink: async waitMs => { await caller!.waitForLink("target", waitMs); return adapter(); },
      });
      assert.deepEqual(reply, { status: 200, body: brokenBody === "reply" ? payload : "ready" });
      assert.equal(resets, 1);
      assert.equal(failures.length, 1);
      assert.equal((failures[0] as { code: string }).code, "RPC_INTERRUPTED");
      assert.equal(failures[0] instanceof PeerApplicationError, brokenBody === "reply");
      assert.equal(reads, brokenBody === "reply" ? 2 : 1);
      assert.equal(old.connected, false);
      assert.notEqual(caller.links.get("target"), old);
    } finally { await caller?.close(); await target.close(); }
  });
}

test("普通读取超时仍复用健康连接", async () => {
  let calls = 0, closed = 0;
  const link: ReadRetryLink<string> = { connected: true, close: () => { closed++; }, call: async () => {
    if (++calls === 1) throw new RpcRequestTimeoutError("target", "slow-read");
    return "ready";
  } };
  assert.equal(await dispatchPeerRequest({ node: "target", method: "console", params: { method: "GET" },
    rpcTimeoutMs: 5000, getLink: () => link, sleep: async () => {}, random: () => 0 }), "ready");
  assert.equal(calls, 2);
  assert.equal(closed, 0);
});

test("调用者取消与建流中断同时到达时不关闭连接", async () => {
  const controller = new AbortController();
  const reason = new Error("caller cancelled");
  let closed = 0, calls = 0;
  const link: ReadRetryLink<string> = { connected: true, close: () => { closed++; }, call: async () => {
    calls++;
    controller.abort(reason);
    throw Object.assign(new Error("frame interrupted"), { code: "RPC_INTERRUPTED" });
  } };
  await assert.rejects(dispatchPeerRequest({ node: "target", method: "console", params: { method: "GET" },
    rpcTimeoutMs: 5000, signal: controller.signal, getLink: () => link, sleep: async () => {}, random: () => 0 }),
  error => error === reason);
  assert.equal(calls, 1);
  assert.equal(closed, 0);
});

test("旧尝试迟到的中断只关闭捕获的旧连接", async () => {
  let oldClosed = 0, replacementClosed = 0;
  const replacement: ReadRetryLink<string> = { connected: true, close: () => { replacementClosed++; }, call: async () => "ready" };
  let current: ReadRetryLink<string>;
  const old: ReadRetryLink<string> = { connected: true, close: () => { oldClosed++; }, call: async () => {
    current = replacement;
    throw Object.assign(new Error("old frame interrupted"), { code: "RPC_INTERRUPTED" });
  } };
  current = old;
  assert.equal(await dispatchPeerRequest({ node: "target", method: "console", params: { method: "GET" },
    rpcTimeoutMs: 5000, getLink: () => current, sleep: async () => {}, random: () => 0 }), "ready");
  assert.equal(oldClosed, 1);
  assert.equal(replacementClosed, 0);
});
