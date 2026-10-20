import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { dispatchPeerRequest } from "../../src/federation/read-retry.js";
import { PeerTransport, RpcRequestTimeoutError } from "../../src/federation/transport.js";
import type { FederationConfig } from "../../src/federation/types.js";
import { toolDeadline, TOOL_DEADLINE_META } from "../../src/tool-request-budget.js";
import { twoNodes, until } from "../tool-contract/fixture.js";

test("真实双节点 MCP 的安静输出等待满 10 秒后只返回一次且不改变原操作", { timeout: 35_000 }, async t => {
  const { worker, cloud } = await twoNodes(t, { git: true });
  const meta = { "openai/session": randomUUID() };
  const raw = (name: string, args: Record<string, unknown>) => cloud.client.callTool({ name, arguments: args, _meta: meta });
  const call = async (name: string, args: Record<string, unknown>): Promise<Record<string, any>> => {
    const result = await raw(name, args);
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.ok(result.structuredContent);
    return result.structuredContent;
  };
  await call("start_session", { title: "观察等待预算", request_key: randomUUID() });
  const opened = await call("open_workspace", { root_id: "worker/main" });
  const scope = { workspace_id: opened.workspace_id };
  const script = join(worker.project, "quiet-operation.mjs");
  await writeFile(script, "import {appendFileSync,existsSync} from 'node:fs';\nappendFileSync('starts.txt','start\\n');\nconst timer=setInterval(()=>{if(existsSync('release.txt'))clearInterval(timer);},25);\nsetTimeout(()=>clearInterval(timer),40000).unref();\n");
  const command = await call("exec_command", { ...scope, cmd: `"${process.execPath}" "${script}"`, tty: false,
    yield_time_ms: 100, operation_key: randomUUID() });
  const outputArgs = { ...scope, operation_id: command.operation_id, cursor: 0 };
  let before: Record<string, any> = {};
  await until(async () => {
    before = await call("read_output", outputArgs);
    return before.operation_state === "running" && before.process_done === false;
  });
  const link = worker.running.federation!.transport.links.get("cloud")!;
  let buffer = "", requests = 0;
  // 只旁听真实控制流，记录目标节点收到的长轮询次数。
  const received = (part: string | Buffer) => {
    buffer += part.toString();
    for (let end; (end = buffer.indexOf("\n")) >= 0;) {
      const frame = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      if (frame.method === "tool" && frame.params?.name === "read_output" &&
          frame.params.input?.operation_id === command.operation_id && frame.params.input?.wait_ms === 10_000) requests++;
    }
  };
  link.control.on("data", received);
  try {
    const started = performance.now();
    const after = await call("read_output", { ...outputArgs, cursor: before.next_cursor, wait_ms: 10_000 });
    const elapsedMs = performance.now() - started;
    t.diagnostic(JSON.stringify({ observationMs: elapsedMs, remoteAttempts: requests }));
    assert.ok(elapsedMs >= 9_900 && elapsedMs < 13_000, `等待与回传应位于 13 秒预算内：${elapsedMs}`);
    assert.equal(requests, 1);
    assert.equal(after.operation_id, command.operation_id);
    assert.equal(after.operation_state, before.operation_state);
    assert.equal(after.process_done, false);
    assert.equal(after.next_cursor, before.next_cursor);
    assert.equal(after.result, "");
    assert.equal(await readFile(join(worker.project, "starts.txt"), "utf8"), "start\n");
  } finally {
    link.control.off("data", received);
    await writeFile(join(worker.project, "release.txt"), "release\n");
    await until(async () => (await call("read_output", outputArgs)).process_done === true);
  }
});

function peerConfig(nodeId: string): FederationConfig {
  return { nodeId, nickname: nodeId, capabilities: { coordinator: false, worker: true, discovery: false,
    egress: false, meshRelay: false, desktopUi: false, consoleRelay: false }, priority: 0, host: "127.0.0.1",
    port: 0, heartbeatMs: 500, rpcTimeoutMs: 30_000, peers: [], egress: { enabled: false }, roots: [] };
}

test("真实 peer RPC 给 wait_agent 留回传时间且不延长总期限或重放写入", { timeout: 30_000 }, async t => {
  const token = randomUUID(), targetConfig = peerConfig("target"), callerConfig = peerConfig("caller");
  targetConfig.peers = [{ id: "caller", url: "" }];
  const requests: string[] = [], pending = new Set<Promise<unknown>>();
  // 使用真实 TCP 和真实计时器验证 RPC 预算；这里不启动模型提供方。
  const target = new PeerTransport(targetConfig, token, async (_method, params) => {
    requests.push(params.input.case);
    const work = delay(params.input.timeout_ms ?? params.input.yield_time_ms).then(() => ({ state: "running" }));
    pending.add(work);
    try { return await work; } finally { pending.delete(work); }
  }, () => {});
  await target.start();
  callerConfig.peers = [{ id: "target", url: `http://127.0.0.1:${target.address}` }];
  const caller = new PeerTransport(callerConfig, token, () => null, () => {});
  t.after(async () => { await Promise.allSettled(pending); await caller.close(); await target.close(); });
  await caller.start();
  await until(() => Boolean(caller.links.get("target")?.connected && target.links.get("caller")?.connected));
  const request = (name: string, input: Record<string, unknown>, deadlineAt = toolDeadline(name, input, undefined)) => {
    const params = { name, input, extra: { _meta: { [TOOL_DEADLINE_META]: deadlineAt } } };
    return dispatchPeerRequest({ node: "target", method: "tool", params, timeoutMs: deadlineAt - Date.now(),
      rpcTimeoutMs: 30_000, getLink: () => {
        const link = caller.links.get("target");
        return link && { get connected() { return link.connected; }, call: (timeout: number) => link.call("tool", params, timeout), close: () => link.close() };
      } });
  };
  const started = performance.now();
  assert.deepEqual(await request("wait_agent", { case: "quiet-agent", agent_ids: ["existing-agent"], timeout_ms: 10_000 }), { state: "running" });
  const elapsedMs = performance.now() - started;
  t.diagnostic(JSON.stringify({ agentWaitRpcMs: elapsedMs, remoteAttempts: requests.length }));
  assert.ok(elapsedMs >= 9_900 && elapsedMs < 13_000);
  assert.equal(requests.filter(value => value === "quiet-agent").length, 1);
  const shortStarted = performance.now();
  await assert.rejects(request("wait_agent", { case: "short-deadline", timeout_ms: 1000 }, Date.now() + 250), RpcRequestTimeoutError);
  assert.ok(performance.now() - shortStarted < 1000);
  assert.equal(requests.filter(value => value === "short-deadline").length, 1);
  await assert.rejects(request("write_stdin", { case: "write-once", chars: "input", yield_time_ms: 1000 }, Date.now() + 250), RpcRequestTimeoutError);
  assert.equal(requests.filter(value => value === "write-once").length, 1);
});
