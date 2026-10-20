import assert from "node:assert/strict";
import test from "node:test";
import {randomUUID} from "node:crypto";
import {readFile, stat, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {openDatabase} from "../../src/db/client.js";
import {SessionStore} from "../../src/session/store.js";
import {twoNodes, until} from "./fixture.js";

test("a refused federated command retries the same operation once after its real claim is released", {timeout: 60000}, async t => {
  const {worker, cloud} = await twoNodes(t);
  const meta = {"openai/session": randomUUID()};
  // 先发现输出 schema，再由标准 SDK 校验拒绝和重试回执。
  await cloud.client.listTools();
  const raw = (name: string, args: Record<string, unknown>) => cloud.client.callTool({name, arguments: args, _meta: meta});
  assert.notEqual((await raw("start_session", {title: "Admission retry", request_key: randomUUID()})).isError, true);
  const opened = await raw("open_workspace", {root_id: "worker/main"});
  assert.notEqual(opened.isError, true, JSON.stringify(opened));
  const workspaceId = (opened.structuredContent as any).workspace_id;
  const script = join(worker.project, "append.mjs");
  await writeFile(script, "import {appendFileSync} from 'node:fs';appendFileSync('once.txt','once\\n');\n");
  const key = randomUUID();
  const args = {workspace_id: workspaceId, cmd: `"${process.execPath}" "${script}"`, yield_time_ms: 2000, operation_key: key};
  const blocker = worker.running.execution.acquire({workspaceRoot: worker.project, kind: "command", access: "write", operationId: "blocking-command"});
  const databases: ReturnType<typeof openDatabase>[] = [];
  try {
    const refused = await raw("exec_command", args);
    assert.equal(refused.isError, true, JSON.stringify(refused));
    assert.equal((refused.structuredContent as any)?.effect, "not_started", JSON.stringify(refused));
    assert.equal((refused.structuredContent as any)?.retry_hint, "retry_later");
    for (const server of [cloud, worker]) databases.push(openDatabase(server.config.stateDir));
    const rows = (index: number) => databases[index]!.sqlite.prepare("SELECT * FROM qm_invocations WHERE json_extract(arguments_json,'$.operation_key')=? ORDER BY rowid").all(key) as any[];
    const old = [rows(0)[0], rows(1)[0]];
    assert.ok(old.every(row => row?.effect === "not_started"));
    assert.equal(old[0].operation_id, old[1].operation_id);
    blocker.release();
    const retried = await Promise.all([raw("exec_command", args), raw("exec_command", args)]);
    for (const result of retried) assert.notEqual(result.isError, true, JSON.stringify(result));
    await until(() => rows(1).at(-1)?.state === "succeeded");
    assert.equal(await readFile(join(worker.project, "once.txt"), "utf8"), "once\n");
    for (const index of [0, 1]) {
      const attempts = rows(index);
      assert.equal(attempts.length, 2, JSON.stringify(attempts));
      assert.deepEqual(attempts[0], old[index], "the original refusal remains immutable");
      assert.equal(attempts[1].operation_id, old[index].operation_id);
      assert.equal(attempts[1].state, "succeeded");
      const store = new SessionStore(databases[index]!.sqlite);
      assert.equal(store.findInvocationByOperationId(old[index].operation_id)?.id, attempts[1].id);
    }
    const replay = await raw("exec_command", args);
    assert.notEqual(replay.isError, true, JSON.stringify(replay));
    assert.equal((replay.structuredContent as any).operation_id, old[0].operation_id);
    assert.equal(await readFile(join(worker.project, "once.txt"), "utf8"), "once\n");
  } finally {
    // Node 的 after 不倒序执行；测试打开的连接必须先于两台 fixture 的目录清理关闭。
    try { blocker.release(); } finally { databases.forEach(db => db.close()); }
  }
});

test("coordinator preserves the operation ID when worker admission rejected before recording any attempt", {timeout: 60000}, async t => {
  const {worker, cloud} = await twoNodes(t);
  const meta = {"openai/session": randomUUID()};
  await cloud.client.listTools();
  const raw = (name: string, args: Record<string, unknown>) => cloud.client.callTool({name, arguments: args, _meta: meta});
  assert.notEqual((await raw("start_session", {title: "Worker admission", request_key: randomUUID()})).isError, true);
  const opened = await raw("open_workspace", {root_id: "worker/main"});
  assert.notEqual(opened.isError, true, JSON.stringify(opened));
  const key = randomUUID();
  const args = {workspace_id: (opened.structuredContent as any).workspace_id, cmd: `"${process.execPath}" -e "console.log('admitted')"`, yield_time_ms: 2000, operation_key: key};
  worker.running.execution.pause("test pause before tool dispatch");
  const refused = await raw("exec_command", args);
  assert.equal(refused.isError, true);
  assert.equal((refused.structuredContent as any)?.error_code, "NODE_ADMISSION_PAUSED");
  const databases: ReturnType<typeof openDatabase>[] = [];
  try {
    for (const server of [cloud, worker]) databases.push(openDatabase(server.config.stateDir));
    const rows = (index: number) => databases[index]!.sqlite.prepare("SELECT * FROM qm_invocations WHERE json_extract(arguments_json,'$.operation_key')=? ORDER BY rowid").all(key) as any[];
    const original = rows(0)[0];
    assert.equal(rows(1).length, 0);
    worker.running.execution.resume();
    const retried = await raw("exec_command", args);
    assert.notEqual(retried.isError, true, JSON.stringify(retried));
    assert.equal((retried.structuredContent as any).operation_id, original.operation_id);
    assert.equal(rows(0).length, 2);
    assert.equal(rows(1).length, 1);
    assert.equal(rows(1)[0].operation_id, original.operation_id);
  } finally {
    databases.forEach(db => db.close());
  }
});

test("closed task blocks new federated work while preserving original receipts, output and cancellation", {timeout: 60000}, async t => {
  const {worker, cloud} = await twoNodes(t);
  const meta = {"openai/session": randomUUID()};
  await cloud.client.listTools();
  const raw = (name: string, args: Record<string, unknown>) => cloud.client.callTool({name, arguments: args, _meta: meta});
  const call = async (name: string, args: Record<string, unknown>): Promise<Record<string, any>> => {
    const result = await raw(name, args);
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.ok(result.structuredContent);
    return result.structuredContent as Record<string, any>;
  };
  const task = await call("start_session", {title: "Original command", request_key: randomUUID()});
  const opened = await call("open_workspace", {root_id: "worker/main"});
  const workspace_id = opened.workspace_id as string;
  const script = join(worker.project, "closed-task-command.mjs"), marker = join(worker.project, "once.txt");
  await writeFile(script, "import {appendFileSync} from 'node:fs';appendFileSync('once.txt','once\\n');console.log('saved-result');\n");
  const input = {workspace_id, cmd: `"${process.execPath}" "${script}"`, yield_time_ms: 1000, operation_key: randomUUID()};
  const first = await call("exec_command", input);
  await until(async () => {
    const status = await call("workspace_context", {workspace_id, action: "status", operation_id: first.operation_id});
    return status.operation_state === "succeeded";
  });
  await writeFile(join(worker.project, "copy-source.txt"), "original-copy\n");
  const copyInput = {action: "start", request_key: randomUUID(), source_workspace_id: workspace_id, destination_workspace_id: workspace_id,
    source_path: "copy-source.txt", destination_path: "copied.txt", overwrite: true};
  const copied = await call("copy_artifact", copyInput);
  await until(async () => {
    const view = await call("copy_artifact", {action: "observe", copy_id: copied.id});
    assert.notEqual(view.status, "failed", view.error);
    return view.status === "completed";
  });
  await call("finish_task", {task_id: task.task_id, status: "completed", summary: "Original command completed"});
  const replay = await call("exec_command", input);
  assert.equal(replay.operation_id, first.operation_id);
  const output = await call("read_output", {workspace_id, operation_id: first.operation_id});
  assert.match(output.result, /saved-result/);
  assert.equal(output.process_done, true);
  const cancellation = await call("cancel_command", {workspace_id, operation_id: first.operation_id});
  assert.equal(cancellation.cancel_requested, false);
  assert.equal(await readFile(marker, "utf8"), "once\n");
  await writeFile(join(worker.project, "copy-source.txt"), "changed-after-finish\n");
  const copyReplay = await call("copy_artifact", copyInput);
  assert.equal(copyReplay.id, copied.id);
  assert.equal(copyReplay.status, "completed");
  assert.equal((await call("copy_artifact", {action: "cancel", copy_id: copied.id})).status, "completed");
  assert.equal(await readFile(join(worker.project, "copied.txt"), "utf8"), "original-copy\n");

  const copyOnly = await call("start_session", {title: "Copy-only task", request_key: randomUUID()});
  const copyOnlyReceipt = await call("copy_artifact", {...copyInput, request_key: randomUUID(), destination_path: "copy-only.txt"});
  await until(async () => {
    const view = await call("copy_artifact", {action: "observe", copy_id: copyOnlyReceipt.id});
    assert.notEqual(view.status, "failed", view.error);
    return view.status === "completed";
  });
  await call("finish_task", {task_id: copyOnly.task_id, status: "completed", summary: "Only copied a file"});

  // 入口新任务从未使用 worker，关闭后不能被一次新写入首次镜像为 active。
  const unseen = await call("start_session", {title: "Coordinator-only task", request_key: randomUUID()});
  await call("finish_task", {task_id: unseen.task_id, status: "completed", summary: "No worker work was needed"});
  const db = openDatabase(worker.config.stateDir);
  try {
    const workerTask = db.sqlite.prepare("SELECT state FROM qm_tasks WHERE id=?");
    assert.equal((workerTask.get(copyOnly.task_id) as {state: string}).state, "closed", "只做复制的任务也必须收尾目标节点");
    assert.equal(workerTask.get(unseen.task_id), undefined);
    for (const [name, args] of [
      ["exec_command", {...input, operation_key: randomUUID()}],
      ["apply_patch", {workspace_id, operation_key: randomUUID(), patch: "*** Begin Patch\n*** Add File: after-closed.txt\n+must not be written\n*** End Patch"}],
      ["copy_artifact", {...copyInput, request_key: randomUUID(), destination_path: "copy-after-closed.txt"}],
    ] as const) {
      const refused = await raw(name, args);
      assert.equal(refused.isError, true, JSON.stringify(refused));
      const error = refused.structuredContent as Record<string, unknown>;
      assert.equal(error.error_code, "TASK_NOT_ACTIVE", name);
      assert.equal(error.effect, "not_started", name);
      assert.equal(error.retry_hint, "fix_input", name);
      assert.equal(workerTask.get(unseen.task_id), undefined, name);
    }
    await assert.rejects(stat(join(worker.project, "after-closed.txt")), {code: "ENOENT"});
    await assert.rejects(stat(join(worker.project, "copy-after-closed.txt")), {code: "ENOENT"});
    assert.equal(await readFile(marker, "utf8"), "once\n");
  } finally {db.close();}
});
