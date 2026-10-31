import assert from "node:assert/strict";
import test from "node:test";
import { createServer as createH2Server, constants, type Http2Session } from "node:http2";
import { createServer, connect, type Socket } from "node:net";
import { Transform } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PeerTransport, PeerApplicationError, RpcRequestTimeoutError, type RpcHandler, type PeerProgressNotification } from "../../src/federation/transport.js";
import type { FederationConfig } from "../../src/federation/types.js";
import { ExecutionConflictError } from "../../src/execution-coordinator.js";
import { errorEnvelope, errorFromEnvelope } from "../../src/session/outcome.js";

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
    let pacedAt: number | undefined, sentBytes = 0;
    const slower = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      if (!throttled) { this.push(chunk); callback(); return; }
      const startedAt = pacedAt ??= performance.now();
      void (async () => {
        for (let offset = 0; offset < chunk.length; offset += 8192) {
          if (this.destroyed) return;
          const slice = chunk.subarray(offset, offset + 8192);
          this.push(slice); sentBytes += slice.length;
          // 按字节和单调时钟节流，避免 TCP 短尾片及定时器迟到累积。
          const remaining = startedAt + sentBytes / 1024 - performance.now();
          if (remaining > 0) await delay(remaining);
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

test("资源冲突的实际错误和持久回执重放都保留占用身份，不透传私有标题", async t => {
  const directory = await mkdtemp(join(tmpdir(), "qm-peer-conflict-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const secret = "private-title-command-and-credential";
  const original = new ExecutionConflictError("claim_blocker", "agt_blocker", secret, {
    type: "resource", requested: [
      { kind: "tree", path: "C:\\Work\\project", access: "write" },
      { kind: "file", path: "/srv/project/report.txt", access: "read" },
      { kind: "named", key: "compiler:shared", access: "write" },
    ], blockedResources: [{ kind: "named", key: "compiler:shared", access: "write" }],
    operationId: "op_blocker", executionId: "exec_blocker_turn", taskId: "task_blocker", title: secret,
    acquiredAt: "2026-10-29T15:15:00.000Z", queued: false,
  }, "not_started");
  const envelope = errorEnvelope(original, { sideEffecting: true });
  assert.equal((envelope.errorDetails as Record<string, unknown>).claim_id, "claim_blocker");
  assert.equal((envelope.errorDetails as Record<string, unknown>).agent_id, "agt_blocker");
  assert.equal((envelope.errorDetails as Record<string, unknown>).executionId, "exec_blocker_turn");
  const saved = join(directory, "receipt.json");
  await writeFile(saved, JSON.stringify(envelope));
  const replay = errorFromEnvelope(JSON.parse(await readFile(saved, "utf8")), undefined, "op_rejected");
  const { agent_id: _agentId, ...legacyDetails } = original.details;
  const legacy = Object.assign(new Error(secret), { code: "EXECUTION_CONFLICT", claimId: "claim_blocker",
    agentId: "agt_blocker", effect: "not_started", details: legacyDetails });
  const p = await pair(method => { throw method === "original" ? original : method === "legacy" ? legacy : replay; });
  try {
    for (const method of ["original", "replay", "legacy"]) {
      await assert.rejects(p.caller.links.get("target")!.call(method, {}), error => {
        assert.ok(error instanceof PeerApplicationError);
        assert.equal(error.code, "EXECUTION_CONFLICT");
        assert.equal(error.effect, "not_started");
        assert.equal(error.retryHint, method === "replay" ? "retry_later" : undefined);
        const { title: _title, ...expected } = original.details;
        assert.deepEqual(error.details, expected);
        assert.equal(error.details?.agent_id, "agt_blocker");
        assert.equal(error.details?.executionId, "exec_blocker_turn");
        assert.equal(JSON.stringify({ message: error.message, details: error.details }).includes(secret), false);
        assert.notEqual(error.details?.operationId, "op_rejected", "保留阻塞操作，不能换成被拒绝请求的操作");
        return true;
      });
    }
  } finally { await p.close(); }
});

test("冲突投射拒绝未知字段、错型与过大范围，保留明确的执行效果", async () => {
  const secret = "must-not-cross-peer-boundary";
  const safeResource = { kind: "named", key: "compile", access: "write" };
  const cases: Record<string, Record<string, unknown>> = {
    projected: { type: "future-policy-v2", requested: [{ ...safeResource, authorization: secret }],
      blockedResources: [{ kind: "file", path: "/srv/work/report", access: "read", command: secret }],
      operationId: null, taskId: null, agent_id: "agt_legacy", acquiredAt: null, queued: true, title: secret, command: secret, authorization: secret,
      operation_id: "op_rejected", owner_node_id: "worker", next_action: { tool: "workspace_context", authorization: secret,
        arguments: { action: "status", operation_id: "op_rejected", workspace_id: "qm:worker:ws_fixture", command: secret } } },
    invalid: { type: {}, requested: [safeResource, { kind: "shell", path: secret, access: "write" }],
      blockedResources: [{ kind: "file", path: "relative/path", access: "read" }],
      operationId: {}, taskId: [], agent_id: { command: secret }, acquiredAt: false, queued: "false", claim_id: {}, operation_id: { command: secret },
      resources: [{ command: secret }], scope: { token: secret }, conflicts: { title: secret },
      next_action: { tool: "exec_command", arguments: { cmd: secret } } },
    oversized: { requested: Array.from({ length: 129 }, () => safeResource),
      blockedResources: [{ kind: "named", key: "x".repeat(513), access: "write" }] },
    byte_budget: { requested: Array.from({ length: 5 }, (_, index) => ({ kind: "tree", path: "/" + String(index).repeat(4000), access: "write" })),
      blockedResources: [safeResource] },
  };
  const p = await pair(method => { throw Object.assign(new Error(secret), {
    code: "EXECUTION_CONFLICT", claimId: "claim_blocker", effect: "partial", retryHint: "do_not_retry", details: cases[method],
  }); });
  try {
    for (const name of Object.keys(cases)) {
      await assert.rejects(p.caller.links.get("target")!.call(name, {}), error => {
        assert.ok(error instanceof PeerApplicationError);
        assert.equal(error.effect, "partial"); assert.equal(error.retryHint, "do_not_retry");
        assert.equal(error.details?.claim_id, "claim_blocker");
        assert.equal(JSON.stringify({ message: error.message, details: error.details }).includes(secret), false);
        assert.ok(Buffer.byteLength(JSON.stringify(error.details)) <= 16 * 1024);
        if (name === "projected") assert.deepEqual(error.details, {
          claim_id: "claim_blocker", type: "future-policy-v2", requested: [safeResource],
          blockedResources: [{ kind: "file", path: "/srv/work/report", access: "read" }],
          operationId: null, taskId: null, agent_id: "agt_legacy", acquiredAt: null, queued: true,
          operation_id: "op_rejected", owner_node_id: "worker", next_action: { tool: "workspace_context",
            arguments: { action: "status", operation_id: "op_rejected", workspace_id: "qm:worker:ws_fixture" } },
        });
        else if (name === "byte_budget") assert.deepEqual(error.details, { claim_id: "claim_blocker", blockedResources: [safeResource] });
        else assert.deepEqual(error.details, { claim_id: "claim_blocker" });
        return true;
      });
    }
  } finally { await p.close(); }
});

test("旧 peer 的原始冲突帧也清除私有消息，普通错误消息保持原文", async () => {
  const secret = "legacy-private-title-and-command";
  const p = await pair(async (method, _value, peer, context) => {
    const conflict = method === "conflict";
    // Send the old peer's raw envelope, bypassing the new sender projection.
    await p.target.links.get(peer)!.send({ id: context!.requestId, error: {
      code: conflict ? "EXECUTION_CONFLICT" : "LEGACY_ERROR",
      message: conflict ? secret : "original ordinary error",
      effect: "unknown", retryHint: "query_original",
      details: conflict ? { claim_id: "claim_legacy", title: secret } : { operation_id: "op_legacy" },
    } });
    return new Promise(resolve => context!.signal.addEventListener("abort", () => resolve(null), { once: true }));
  });
  try {
    for (const method of ["conflict", "ordinary"]) {
      await assert.rejects(p.caller.links.get("target")!.call(method, {}), error => {
        assert.ok(error instanceof PeerApplicationError);
        assert.equal(error.effect, "unknown"); assert.equal(error.retryHint, "query_original");
        if (method === "conflict") {
          assert.equal(error.message.includes(secret), false);
          assert.deepEqual(error.details, { claim_id: "claim_legacy" });
        } else {
          assert.equal(error.message, "original ordinary error");
          assert.deepEqual(error.details, { operation_id: "op_legacy" });
        }
        return true;
      });
    }
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
