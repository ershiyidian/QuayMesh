import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import test from "node:test";
import { openDatabase } from "../../src/db/client.js";
import type { PeerLink } from "../../src/federation/transport.js";
import { twoNodes, until } from "../tool-contract/fixture.js";

test("首次受理回执正常关闭后，真实跨节点写入继续归档结果且重试不重复执行", { timeout: 30_000 }, async t => {
  const { worker, cloud } = await twoNodes(t);
  const meta = { "openai/session": randomUUID() };
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await cloud.client.callTool({ name, arguments: args, _meta: meta });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.ok(result.structuredContent);
    return result.structuredContent;
  };
  await call("start_session", { title: "持久写入与回执生命周期", request_key: randomUUID() });
  const opened = await call("open_workspace", { root_id: "worker/main" });
  const runtime = worker.running.federation!;
  const original = runtime.handlers.get("apply_patch")!;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let dispatches = 0;
  const operationKey = randomUUID();
  runtime.handlers.set("apply_patch", async (input, extra) => {
    if (input.operation_key === operationKey) {
      dispatches++;
      await gate;
    }
    return original(input, extra);
  });
  const database = openDatabase(cloud.config.stateDir);
  try {
    const args = {
      workspace_id: opened.workspace_id,
      operation_key: operationKey,
      patch: "*** Begin Patch\n*** Add File: durable-result.txt\n+written once\n*** End Patch",
    };
    // The real MCP exchange ends while the worker is deliberately still preparing.
    const accepted = await call("apply_patch", args);
    assert.equal(accepted.accepted, true);
    assert.equal(typeof accepted.operation_id, "string");
    release();
    await until(async () => {
      try { return await readFile(join(worker.project, "durable-result.txt"), "utf8") === "written once\n"; }
      catch { return false; }
    });
    const receipt = () => database.sqlite.prepare(
      "SELECT state,effect,result_json FROM qm_invocations WHERE operation_id=? ORDER BY rowid DESC LIMIT 1",
    ).get(accepted.operation_id) as { state: string; effect: string; result_json: string } | undefined;
    await until(() => Boolean(receipt() && !["accepted", "queued", "running"].includes(receipt()!.state)));
    assert.equal(receipt()!.state, "succeeded", receipt()!.result_json);
    assert.equal(receipt()!.effect, "completed");
    const replay = await call("apply_patch", args);
    assert.equal(replay.operation_id, accepted.operation_id);
    assert.equal(dispatches, 1);
    assert.equal(await readFile(join(worker.project, "durable-result.txt"), "utf8"), "written once\n");
  } finally {
    release();
    runtime.handlers.set("apply_patch", original);
    database.close();
  }
});

test("并行正文故障换链后，已受理写入继续完成且原操作不会重发", { timeout: 30_000 }, async t => {
  const { worker, cloud } = await twoNodes(t);
  const meta = { "openai/session": randomUUID() };
  const call = (name: string, args: Record<string, unknown>) =>
    cloud.client.callTool({ name, arguments: args, _meta: meta });
  await call("start_session", { title: "正文故障与并行持久写入", request_key: randomUUID() });
  const opened = await call("open_workspace", { root_id: "worker/main" });
  assert.notEqual(opened.isError, true);
  const runtime = worker.running.federation!;
  const original = runtime.handlers.get("apply_patch")!;
  const transport = runtime.transport as any;
  const receive = transport.receiveStream;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let dispatches = 0;
  let workSignal: AbortSignal | undefined;
  const operationKey = randomUUID();
  runtime.handlers.set("apply_patch", async (input, extra) => {
    if (input.operation_key === operationKey) {
      dispatches++;
      workSignal = extra.signal instanceof AbortSignal ? extra.signal : undefined;
      await gate;
    }
    return original(input, extra);
  });
  try {
    const args = { workspace_id: opened.structuredContent!.workspace_id, operation_key: operationKey,
      patch: "*** Begin Patch\n*** Add File: survives-frame-failure.txt\n+written once\n*** End Patch" };
    const accepted = await call("apply_patch", args);
    assert.notEqual(accepted.isError, true, JSON.stringify(accepted));
    assert.equal(accepted.structuredContent!.accepted, true);
    assert.equal(dispatches, 1);
    const failed = cloud.running.federation!.transport.links.get("worker")!;
    const receiving = runtime.transport.links.get("cloud")!;
    transport.receiveStream = async (link: PeerLink, service: string, metadata: unknown, stream: Duplex) => {
      if (link === receiving && service === "$frame.v1") {
        for await (const _chunk of stream) { /* 完整读入后模拟实际接收异常。 */ }
        stream.destroy(new Error("fixture frame delivery failed"));
        return;
      }
      await receive.call(transport, link, service, metadata, stream);
    };
    await assert.rejects(failed.call("fixture.failure", { body: "x".repeat(128 * 1024) }, 3000),
      (error: any) => error.code === "RPC_INTERRUPTED" && error.effect === "unknown");
    assert.equal(failed.connected, false);
    transport.receiveStream = receive;
    await until(() => cloud.running.federation!.transport.links.get("worker")?.connected === true);
    assert.notEqual(cloud.running.federation!.transport.links.get("worker"), failed);
    assert.notEqual(workSignal?.aborted, true);
    release();
    await until(async () => {
      try { return await readFile(join(worker.project, "survives-frame-failure.txt"), "utf8") === "written once\n"; }
      catch { return false; }
    });
    const replay = await call("apply_patch", args);
    assert.equal(replay.structuredContent!.operation_id, accepted.structuredContent!.operation_id);
    assert.equal(dispatches, 1);
  } finally {
    release();
    transport.receiveStream = receive;
    runtime.handlers.set("apply_patch", original);
  }
});

test("普通读取的 HTTP 观察流取消会传到 Worker，随后读取可以正常完成", { timeout: 25_000 }, async t => {
  const { worker, cloud } = await twoNodes(t);
  const meta = { "openai/session": randomUUID() };
  await cloud.client.callTool({ name: "start_session", arguments: {
    title: "只读请求取消", request_key: randomUUID(),
  }, _meta: meta });
  const opened = await cloud.client.callTool({ name: "open_workspace", arguments: { root_id: "worker/main" }, _meta: meta });
  assert.notEqual(opened.isError, true);
  const runtime = worker.running.federation!;
  const original = runtime.handlers.get("read")!;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  let aborted = false;
  runtime.handlers.set("read", async (input, extra) => {
    const signal = extra.signal as AbortSignal;
    signal.addEventListener("abort", () => { aborted = true; }, { once: true });
    started();
    await gate;
    return original(input, extra);
  });
  try {
    const controller = new AbortController();
    // SDK 1.x signal sends a separate notifications/cancelled POST; a fresh
    // stateless instance cannot find the original request. Cancel its actual
    // HTTP observation stream here. Durable work retains the preceding contract.
    const response = await fetch(new URL("/mcp", cloud.baseUrl), {
      method: "POST",
      headers: {
        authorization: "Bearer " + cloud.accessToken,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-11-25",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method: "tools/call", params: {
        name: "read", arguments: { workspace_id: opened.structuredContent!.workspace_id, path: "README.md" }, _meta: meta,
      } }),
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream\b/);
    // Observe the body rejection before aborting to avoid an unhandled promise.
    const cancelled = assert.rejects(response.text());
    await entered;
    const cancelledAt = performance.now();
    controller.abort(new Error("test observation cancelled"));
    await cancelled;
    await until(() => aborted, 2000);
    assert.ok(performance.now() - cancelledAt < 2000, "远端取消不能等到普通读取的 10 秒期限");
    release();
    runtime.handlers.set("read", original);
    const read = await cloud.client.callTool({ name: "read", arguments: {
      workspace_id: opened.structuredContent!.workspace_id, path: "README.md",
    }, _meta: meta });
    assert.notEqual(read.isError, true, JSON.stringify(read));
  } finally {
    release();
    runtime.handlers.set("read", original);
  }
});
