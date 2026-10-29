import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {readFile, writeFile} from "node:fs/promises";
import {join} from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import {databasePath, openDatabase} from "../../src/db/client.js";
import {holdSqliteWriteLock} from "../../src/test-support/sqlite-lock.js";
import type {TrustedInvocationEnvelope} from "../../src/federation/session-types.js";
import {parseWorkspaceHandle} from "../../src/federation/routing.js";
import {twoNodes, until} from "./fixture.js";

test("双节点历史观察在 worker 持写锁时保持只读，新 Cloud Task 不补建历史镜像且修改仍受准入限制", {timeout: 60_000}, async t => {
  const {worker, cloud} = await twoNodes(t, {git: true});
  const meta = {"openai/session": randomUUID()};
  const raw = (name: string, args: Record<string, unknown>) => cloud.client.callTool({name, arguments: args, _meta: meta});
  const call = async (name: string, args: Record<string, unknown>): Promise<Record<string, any>> => {
    const result = await raw(name, args);
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.ok(result.structuredContent, JSON.stringify(result));
    return result.structuredContent as Record<string, any>;
  };
  const task = await call("start_session", {title: "Saved worker output", request_key: randomUUID()});
  const workspace = await call("open_workspace", {root_id: "worker/main"});
  const workspaceId = String(workspace.workspace_id);
  assert.match(workspaceId, /^qm:worker:/u);
  const script = join(worker.project, "observation-effect.mjs"), marker = join(worker.project, "once.txt");
  await writeFile(script, "import {appendFileSync} from 'node:fs';appendFileSync('once.txt','once\\n');console.log('saved-worker-output');\n");
  const command = {workspace_id: workspaceId, cmd: `"${process.execPath}" "${script}"`, operation_key: randomUUID(), yield_time_ms: 1000};
  const original = await call("exec_command", command);
  await until(async () => (await call("workspace_context", {workspace_id: workspaceId, action: "status", operation_id: original.operation_id})).operation_state === "succeeded");
  await call("finish_task", {task_id: task.task_id, status: "completed", summary: "The original command finished once."});
  const selected = await call("task_resume", {action: "inspect", task_id: task.task_id});
  const nextTask = await call("start_session", {title: "New ingress task", request_key: randomUUID(), new_goal: true,
    expected_binding_revision: selected.binding.binding_revision});
  assert.equal(nextTask.session_id, task.session_id);
  assert.notEqual(nextTask.task_id, task.task_id);
  const foreignMeta = {"openai/session": randomUUID()};
  const refusedLocalStart = await worker.client.callTool({name: "start_session", arguments: {title: "Separate worker task", request_key: randomUUID()},
    _meta: foreignMeta});
  assert.equal(refusedLocalStart.isError, true, JSON.stringify(refusedLocalStart));
  assert.equal((refusedLocalStart.structuredContent as Record<string, unknown>).error_code, "TASK_BINDING_AUTHORITY_REQUIRED");
  assert.equal((refusedLocalStart.structuredContent as Record<string, unknown>).effect, "not_started");
  // 另一个有效 Task 也由权威入口创建并实际镜像，不能靠绕过 Worker 的入口约束准备拒绝用例。
  const foreign = await cloud.client.callTool({name: "start_session", arguments: {title: "Separate worker task", request_key: randomUUID()},
    _meta: foreignMeta});
  assert.notEqual(foreign.isError, true, JSON.stringify(foreign));
  const foreignTask = foreign.structuredContent as Record<string, any>;
  const foreignOpen = await cloud.client.callTool({name: "open_workspace", arguments: {root_id: "worker/main"}, _meta: foreignMeta});
  assert.notEqual(foreignOpen.isError, true, JSON.stringify(foreignOpen));
  assert.equal((foreignOpen.structuredContent as Record<string, unknown>).task_id, foreignTask.task_id);
  assert.equal((foreignOpen.structuredContent as Record<string, unknown>).session_id, foreignTask.session_id);
  assert.notEqual(foreignTask.session_id, task.session_id);
  const ingressDb = openDatabase(cloud.config.stateDir);
  let workerDb: Database.Database | undefined;
  let lock: Awaited<ReturnType<typeof holdSqliteWriteLock>> | undefined;
  let paused = false;
  try {
    workerDb = new Database(databasePath(worker.config.stateDir), {readonly: true, fileMustExist: true});
    const workerSession = () => workerDb!.prepare("SELECT owner_id,title,current_task_id,last_activity_at FROM qm_sessions WHERE id=?")
      .get(task.session_id) as {owner_id: string; title: string; current_task_id: string; last_activity_at: string};
    const workerAttempt = () => workerDb!.prepare("SELECT * FROM qm_invocations WHERE operation_id=? ORDER BY rowid DESC LIMIT 1").get(original.operation_id) as Record<string, any>;
    const missingMirror = () => workerDb!.prepare("SELECT id FROM qm_tasks WHERE id=?").get(nextTask.task_id);
    const counts = (db: Database.Database) => Object.fromEntries(
      ["qm_sessions", "qm_tasks", "qm_session_members", "qm_invocations", "qm_events", "qm_runtime_work", "execution_claims"]
        .map(table => [table, (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {n: number}).n]),
    );
    const savedSession = workerSession(), savedAttempt = workerAttempt();
    assert.equal(savedAttempt.task_id, task.task_id);
    assert.equal(savedAttempt.state, "succeeded");
    assert.equal(missingMirror(), undefined);
    // 真实构造两端标题不同；观察请求不能顺便同步标题或创建新 Task。
    ingressDb.sqlite.prepare("UPDATE qm_sessions SET title=? WHERE id=?").run("Ingress-only updated title", task.session_id);
    await worker.running.execution.pauseAsync("Observation contention fixture");
    paused = true;
    const before = {worker: counts(workerDb), cloud: counts(ingressDb.sqlite)};
    lock = await holdSqliteWriteLock(databasePath(worker.config.stateDir), 3000);
    const workerVersion = workerDb.pragma("data_version", {simple: true});
    let released = false;
    void lock.done.then(() => {released = true;}, () => {released = true;});
    const start = performance.now();
    const [output, status, recovery, diagnostics] = await Promise.all([
      call("read_output", {workspace_id: workspaceId, operation_id: original.operation_id, cursor: 0, wait_ms: 0}),
      call("workspace_context", {workspace_id: workspaceId, action: "status", operation_id: original.operation_id}),
      call("workspace_context", {workspace_id: workspaceId, action: "recovery", task_id: task.task_id}),
      call("read_diagnostics", {node_id: "worker", task_id: task.task_id, operation_id: original.operation_id,
        since: new Date(Date.now() - 60_000).toISOString()}),
    ]);
    const observationMs = performance.now() - start;
    assert.equal(released, false, "跨节点观察必须在独立 writer 仍持锁时完成");
    assert.ok(observationMs < 1200, `observation_ms=${observationMs}`);
    assert.equal(output.operation_id, original.operation_id);
    assert.equal(output.task_id, task.task_id);
    assert.equal(output.process_done, true);
    assert.match(String(output.result), /saved-worker-output/u);
    assert.equal(status.operation_id, original.operation_id);
    assert.equal(status.session_id, task.session_id);
    assert.equal(status.workspace_id, workspaceId);
    assert.equal(status.operation_state, "succeeded");
    assert.equal(recovery.task_id, task.task_id);
    assert.equal(recovery.state, "closed");
    assert.equal(diagnostics.node_id, "worker");
    assert.equal(diagnostics.task.id, task.task_id);
    assert.equal(missingMirror(), undefined);
    assert.deepEqual(workerSession(), savedSession);
    assert.deepEqual(workerAttempt(), savedAttempt);
    assert.deepEqual({worker: counts(workerDb), cloud: counts(ingressDb.sqlite)}, before);
    assert.equal(workerDb.pragma("data_version", {simple: true}), workerVersion);

    // 使用真实 peer TCP 验证受信入口仍核对 owner 与 Task/session，而不是跳过 handler 身份边界。
    const envelope: TrustedInvocationEnvelope = {invocation_id: randomUUID(), owner_id: savedSession.owner_id,
      conversation_id: meta["openai/session"], transport_instance_id: "observation-fixture", request_id: randomUUID(),
      session_id: task.session_id, member_id: savedAttempt.member_id, task_id: nextTask.task_id,
      workspace_id: workspaceId, actor: "model"};
    const peer = (trustedInvocation: TrustedInvocationEnvelope, input: Record<string, unknown> = {
      workspace_id: parseWorkspaceHandle(workspaceId)!.local, action: "status", operation_id: original.operation_id,
    }) => cloud.running.federation!.request("worker", "tool", {
      name: "workspace_context", input,
      extra: {trustedInvocation, requestId: trustedInvocation.request_id, _meta: meta,
        authInfo: {clientId: "observation-fixture", extra: {owner_id: trustedInvocation.owner_id, transport_instance_id: "observation-fixture"}}},
    });
    await assert.rejects(peer({...envelope, owner_id: "unrelated-owner"}), /SESSION_NOT_FOUND/u);
    // 原 operation 的查询按持久归属恢复；Task 级 recovery 才验证不一致的 Task/session 声明。
    await assert.rejects(peer({...envelope, task_id: foreignTask.task_id}, {
      workspace_id: parseWorkspaceHandle(workspaceId)!.local, action: "recovery", task_id: foreignTask.task_id,
    }), /TASK_SESSION_MISMATCH/u);
    assert.equal(released, false);
    assert.deepEqual({worker: counts(workerDb), cloud: counts(ingressDb.sqlite)}, before);
    assert.equal(workerDb.pragma("data_version", {simple: true}), workerVersion);
    await lock.release();
    lock = undefined;

    const refused = await raw("exec_command", {...command, operation_key: randomUUID()});
    assert.equal(refused.isError, true, JSON.stringify(refused));
    assert.equal((refused.structuredContent as Record<string, any>).error_code, "NODE_ADMISSION_PAUSED");
    assert.equal((refused.structuredContent as Record<string, any>).effect, "not_started");
    assert.equal(counts(workerDb).qm_invocations, before.worker.qm_invocations);
    assert.equal(missingMirror(), undefined);
    assert.equal(await readFile(marker, "utf8"), "once\n");
    t.diagnostic(JSON.stringify({writer_lock_ms: 3000, observation_ms: observationMs,
      original_operation_id: original.operation_id, original_task_id: task.task_id,
      unmirrored_task_id: nextTask.task_id, observation_invocations: 0, worker_commits_while_locked: 0, command_effects: 1}));
  } finally {
    // 旁路连接必须先于 fixture 的 Windows 目录清理关闭。
    try {await lock?.release();}
    finally {
      try {if (paused) worker.running.execution.resume();}
      finally {workerDb?.close(); ingressDb.close();}
    }
  }
});
