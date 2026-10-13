import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { access, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { openDatabase } from "../../src/db/client.js";
import { git } from "../../src/git.js";
import { RecoveryService } from "../../src/session/recovery.js";
import { SessionStore } from "../../src/session/store.js";
import { createRealTestServer } from "../session-card/server-fixture.js";
import { until } from "./fixture.js";

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
}

async function completedPatch(
  call: (name: string, args: Record<string, unknown>) => Promise<Record<string, any>>,
  workspace_id: string,
  patch: string,
): Promise<Record<string, any>> {
  const initial = await call("apply_patch", { workspace_id, patch, operation_key: randomUUID() });
  if (initial.files) return initial;
  assert.equal(initial.accepted, true);
  let completed: Record<string, any> | undefined;
  await until(async () => {
    const status = await call("workspace_context", { workspace_id, action: "status", operation_id: initial.operation_id });
    if (["accepted", "queued", "running"].includes(status.operation_state)) return false;
    assert.equal(status.operation_state, "succeeded", JSON.stringify(status));
    completed = status.result.structuredContent;
    return true;
  }, 60000);
  return completed!;
}

test("移走真实 Git worktree 后原目录消失，仍能归档并保留记录", { timeout: 45000 }, async t => {
  const server = await createRealTestServer({ git: true });
  let closeDb: (() => void) | undefined;
  t.after(async () => { closeDb?.(); await server.dispose(); });
  const meta = { "openai/session": randomUUID() };
  const raw = (name: string, args: Record<string, unknown>) => server.client.callTool({ name, arguments: args, _meta: meta });
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await raw(name, args);
    assert.notEqual(response.isError, true, JSON.stringify(response));
    return response.structuredContent as Record<string, any>;
  };
  const task = await call("start_session", { title: "工作树消失归档", request_key: randomUUID() });
  const worktree = join(server.secondRoot, "removed-worktree");
  await git(server.project, ["worktree", "add", "-b", `finalization-${randomUUID().slice(0, 8)}`, worktree]);
  const opened = await call("open_workspace", { path: worktree });
  const workspace_id = opened.workspace_id;
  const patched = await completedPatch(call, workspace_id,
    "*** Begin Patch\n*** Add File: change.txt\n+stored file evidence\n*** End Patch");
  assert.equal(patched.files[0].path, "change.txt");
  assert.equal(await readFile(join(worktree, "change.txt"), "utf8"), "stored file evidence\n");
  const db = openDatabase(server.config.stateDir);
  closeDb = () => db.close();
  await until(() => Boolean(db.sqlite.prepare("SELECT 1 FROM qm_task_file_changes WHERE task_id=? AND path='change.txt'").get(task.task_id)));
  // Windows 可能占用目录句柄；将真实工作树移走，直接验证旧路径永久失效的行为。
  const moved = `${worktree}-moved`;
  await rename(worktree, moved);
  assert.equal(await exists(worktree), false);
  assert.equal(await readFile(join(moved, "change.txt"), "utf8"), "stored file evidence\n");
  const recoveryStore = new RecoveryService(new SessionStore(db.sqlite), server.config.stateDir);
  await recoveryStore.exportRoot(worktree);
  await recoveryStore.close();
  assert.equal(await exists(worktree), false);
  const recovery = await call("workspace_context", { workspace_id, action: "recovery", task_id: task.task_id });
  assert.equal(recovery.task_id, task.task_id);
  assert.ok(recovery.facts.files.some((file: {path:string}) => file.path === "change.txt"));

  const finished = await call("finish_task", { task_id: task.task_id, status: "completed", summary: "原工作树删除后完成归档" });
  assert.equal(finished.state, "closed");
  const saved = db.sqlite.prepare("SELECT state,result_status,change_summary_state,change_summary_error FROM qm_tasks WHERE id=?")
    .get(task.task_id) as { state: string; result_status: string; change_summary_state: string; change_summary_error: string };
  assert.equal(saved.state, "closed");
  assert.equal(saved.result_status, "completed");
  assert.equal(saved.change_summary_state, "incomplete");
  assert.match(saved.change_summary_error, /WORKSPACE_REMOVED/);
  assert.ok(db.sqlite.prepare("SELECT 1 FROM qm_task_snapshots WHERE task_id=?").get(task.task_id));
  assert.ok(db.sqlite.prepare("SELECT 1 FROM qm_task_file_changes WHERE task_id=? AND path='change.txt'").get(task.task_id));
});

test("任务结束被真实运行进程拒绝后，仍能取消命令、修改文件并再次完成归档", { timeout: 30000 }, async t => {
  const server = await createRealTestServer({ git: true });
  let closeDb: (() => void) | undefined;
  t.after(async () => { closeDb?.(); await server.dispose(); });
  const meta = { "openai/session": randomUUID() };
  const raw = (name: string, args: Record<string, unknown>) => server.client.callTool({ name, arguments: args, _meta: meta });
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await raw(name, args);
    assert.notEqual(response.isError, true, JSON.stringify(response));
    return response.structuredContent as Record<string, any>;
  };
  const task = await call("start_session", { title: "失败后的归档重试", request_key: randomUUID() });
  const opened = await call("open_workspace", { path: server.project });
  const workspace_id = opened.workspace_id;
  await completedPatch(call, workspace_id, "*** Begin Patch\n*** Add File: warm.txt\n+ready\n*** End Patch");
  const command = await call("exec_command", { workspace_id,
    cmd: `"${process.execPath}" -e "setTimeout(() => {}, 20000)"`, yield_time_ms: 100, operation_key: randomUUID() });
  assert.equal(command.running, true);
  const failed = await raw("finish_task", { task_id: task.task_id, status: "completed", summary: "结束任务" });
  assert.equal(failed.isError, true);
  const db = openDatabase(server.config.stateDir);
  closeDb = () => db.close();
  const finalization = db.sqlite.prepare("SELECT completed_at,error FROM qm_task_finalizations WHERE task_id=?").get(task.task_id) as {
    completed_at: string | null; error: string | null;
  };
  assert.equal(finalization.completed_at, null);
  assert.match(finalization.error ?? "", /TASK_HAS_ACTIVE_EXECUTIONS/);

  const cancelled = await call("cancel_command", { workspace_id, operation_id: command.operation_id });
  assert.equal(cancelled.cancel_requested, true);
  await until(async () => {
    const result = await call("read_output", { workspace_id, operation_id: command.operation_id });
    return result.process_done;
  }, 60000);
  await until(() => {
    const status = server.running.execution.admissionStatus();
    return status.claims === 0 && status.activeWork === 0;
  }, 60000);
  const patched = await completedPatch(call, workspace_id,
    "*** Begin Patch\n*** Add File: after-failed-finish.txt\n+still writable\n*** End Patch");
  assert.equal(patched.files[0].path, "after-failed-finish.txt");
  assert.equal(await readFile(join(server.project, "after-failed-finish.txt"), "utf8"), "still writable\n");
  const finished = await call("finish_task", { task_id: task.task_id, status: "completed", summary: "结束任务" });
  assert.equal(finished.state, "closed");
  const saved = db.sqlite.prepare("SELECT error,completed_at FROM qm_task_finalizations WHERE task_id=?").get(task.task_id) as {
    error: string | null; completed_at: string | null;
  };
  assert.equal(saved.error, null);
  assert.ok(saved.completed_at);
});
