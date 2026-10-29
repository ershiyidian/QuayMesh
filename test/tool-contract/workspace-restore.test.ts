import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { access, chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Database from "better-sqlite3";
import { git } from "../../src/git.js";
import { cleanupManagedWorktrees } from "../../src/git-worktrees.js";
import { parseWorkspaceHandle } from "../../src/federation/routing.js";
import { twoNodes, until } from "./fixture.js";

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
}

function hookPath(path: string): string {
  // Git for Windows 的 hook 也由 sh 执行；正斜杠路径与单引号保护空格及引号。
  return `'${path.replaceAll("\\", "/").replaceAll("'", "'\"'\"'")}'`;
}

test("真实双节点 HTTP：查询不恢复已清理工作树，授权的显式恢复保留身份、暂存区和未暂存内容", { timeout: 90_000 }, async t => {
  const { worker, cloud } = await twoNodes(t, { git: true });
  const tools = (await cloud.client.listTools()).tools;
  for (const name of ["open_workspace", "attach_workspace"]) {
    const declaration = tools.find(tool => tool.name === name);
    assert.ok(declaration, name);
    assert.equal(declaration.annotations?.readOnlyHint, false, name);
    assert.equal(declaration.annotations?.destructiveHint, true, name);
    assert.equal(declaration.annotations?.openWorldHint, true, name);
  }
  const originalMeta = { "openai/session": randomUUID() };
  const otherMeta = { "openai/session": randomUUID() };
  const raw = (name: string, args: Record<string, unknown>, meta = originalMeta) =>
    cloud.client.callTool({ name, arguments: args, _meta: meta });
  const call = async (name: string, args: Record<string, unknown>, meta = originalMeta) => {
    const response = await raw(name, args, meta);
    assert.notEqual(response.isError, true, JSON.stringify(response));
    assert.ok(response.structuredContent, JSON.stringify(response));
    return response.structuredContent as Record<string, any>;
  };
  const store = worker.running.workspaceStore;
  const hooks = join(worker.root, "checkout hooks");
  const marker = join(worker.root, "checkout marker.txt");
  await mkdir(hooks);
  const hook = join(hooks, "post-checkout");
  await writeFile(hook, `#!/bin/sh\nprintf '%s\\n' checkout >> ${hookPath(marker)}\n`, { mode: 0o755 });
  await chmod(hook, 0o755);
  await git(worker.project, ["config", "core.hooksPath", hooks.replaceAll("\\", "/")]);
  await git(worker.project, ["config", "core.autocrlf", "false"]);

  const task = await call("start_session", { title: "显式恢复原工作树", request_key: randomUUID() });
  const openedReply = await raw("open_workspace", { root_id: "worker/main", mode: "worktree" });
  assert.notEqual(openedReply.isError, true, JSON.stringify(openedReply));
  const opened = openedReply.structuredContent as Record<string, any>;
  const workspace_id = opened.workspace_id as string;
  const root = opened.root as string;
  const handle = parseWorkspaceHandle(workspace_id);
  assert.equal(handle?.node, "worker");
  assert.ok(handle?.local);
  assert.equal(opened.session_id, task.session_id);
  assert.equal(opened.task_id, task.task_id);
  assert.equal(opened.mode, "worktree");
  assert.equal(store.getSession(handle.local)?.root, root);
  assert.equal(store.getSession(handle.local)?.managed, true);
  const memberId = (openedReply._meta?.quaymesh as Record<string, unknown>).member_id;
  assert.equal(typeof memberId, "string");
  // 首次真实 worktree add 必须运行同一个 hook，避免把无效 hook 误当成无副作用证据。
  assert.equal(await readFile(marker, "utf8"), "checkout\n");

  const script = join(worker.project, "historical-output.mjs");
  await writeFile(script, "console.log('saved-worktree-output');\n");
  const receipt = await call("exec_command", { workspace_id,
    cmd: `"${process.execPath}" "${script}"`, tty: false, yield_time_ms: 1000, operation_key: randomUUID() });
  assert.equal(typeof receipt.operation_id, "string");
  const operation_id = receipt.operation_id as string;
  await until(async () => {
    const status = await call("workspace_context", { workspace_id, action: "status", operation_id });
    if (["accepted", "queued", "running"].includes(status.operation_state)) return false;
    assert.equal(status.operation_state, "succeeded", JSON.stringify(status));
    const output = await call("read_output", { workspace_id, operation_id, cursor: 0 });
    if (!output.process_done) return false;
    assert.equal(output.exit_code, 0);
    assert.match(output.result, /saved-worktree-output/);
    return true;
  }, 30_000);

  // 另一个会话也从真实入口建立有效成员，拒绝测试不依赖伪造或不存在的会话 ID。
  const otherTask = await call("start_session", { title: "另一个有效会话", request_key: randomUUID() }, otherMeta);
  const otherWorkspace = await call("open_workspace", { root_id: "worker/main" }, otherMeta);
  assert.equal(otherWorkspace.session_id, otherTask.session_id);
  assert.notEqual(otherTask.session_id, task.session_id);
  assert.notEqual(otherWorkspace.workspace_id, workspace_id);

  const staged = "staged worktree content\n";
  const dirty = staged + "unstaged worktree content\n";
  await writeFile(join(root, "README.md"), staged);
  await git(root, ["add", "README.md"]);
  await writeFile(join(root, "README.md"), dirty);
  assert.equal((await git(root, ["status", "--short"])).stdout.trim(), "MM README.md");
  const pruned = await cleanupManagedWorktrees({ store,
    worktreeRoot: worker.config.worktreeRoot, allowedRoots: worker.config.allowedRoots,
    staleBefore: new Date(Date.now() + 60_000) });
  assert.ok(pruned.isOk(), pruned.isErr() ? pruned.error.message : "");
  assert.deepEqual(pruned.value.failed, []);
  assert.deepEqual(pruned.value.skipped, []);
  assert.deepEqual(pruned.value.removed.map(entry => entry.workspaceId), [handle.local]);
  assert.ok(pruned.value.removed[0].recoveryRef);
  assert.equal(store.getSession(handle.local)?.recoveryKind, "stash");
  await rm(marker);
  const assertStillPruned = async () => {
    assert.equal(store.getSession(handle.local)?.status, "pruned");
    assert.equal(store.getSession(handle.local)?.root, root);
    assert.equal(await exists(root), false, "查询或拒绝的恢复不得重新创建工作树目录");
    assert.equal(await exists(marker), false, "查询或拒绝的恢复不得执行 post-checkout hook");
  };
  await assertStillPruned();

  for (const [name, args] of [
    ["read", { workspace_id, path: "README.md" }],
    ["workspace_context", { workspace_id, action: "status", environment: true }],
  ] as const) {
    const refused = await raw(name, args);
    assert.equal(refused.isError, true, JSON.stringify(refused));
    const error = refused.structuredContent as Record<string, any>;
    assert.equal(error.error_code, "WORKSPACE_RESTORE_REQUIRED");
    assert.equal(error.effect, "not_started");
    assert.equal(error.retry_hint, "fix_input");
    assert.equal(error.details.workspace_id, workspace_id);
    assert.deepEqual(error.details.restore, { tool: "attach_workspace", arguments: { workspace_id } });
    await assertStillPruned();
  }

  const status = await call("workspace_context", { workspace_id, action: "status", operation_id });
  assert.equal(status.operation_id, operation_id);
  assert.equal(status.operation_state, "succeeded");
  await assertStillPruned();
  const recovery = await call("workspace_context", { workspace_id, action: "recovery", task_id: task.task_id });
  assert.equal(recovery.task_id, task.task_id);
  assert.ok(recovery.facts.operations.some((operation: Record<string, unknown>) =>
    operation.operation_id === operation_id && operation.state === "succeeded"));
  await assertStillPruned();
  const output = await call("read_output", { workspace_id, operation_id, cursor: 0 });
  assert.equal(output.operation_id, operation_id);
  assert.equal(output.task_id, task.task_id);
  assert.equal(output.process_done, true);
  assert.equal(output.exit_code, 0);
  assert.match(output.result, /saved-worktree-output/);
  await assertStillPruned();

  for (const [meta, expected] of [
    [otherMeta, "WORKSPACE_SESSION_MISMATCH"],
    // The selected Task rejects a foreign canonical Session before the Worker restore RPC.
    [originalMeta, "TASK_SESSION_MISMATCH"],
  ] as const) {
    const refused = await raw("attach_workspace", { workspace_id, session_id: otherTask.session_id }, meta);
    assert.equal(refused.isError, true, JSON.stringify(refused));
    const error = refused.structuredContent as Record<string, unknown>;
    assert.equal(error.error_code, expected);
    assert.equal(error.effect, "not_started");
    await assertStillPruned();
  }

  const restoredReply = await raw("attach_workspace", { workspace_id, session_id: task.session_id });
  assert.notEqual(restoredReply.isError, true, JSON.stringify(restoredReply));
  const restored = restoredReply.structuredContent as Record<string, unknown>;
  assert.equal(restored.workspace_id, workspace_id);
  assert.equal(restored.root, root);
  assert.equal(restored.session_id, task.session_id);
  assert.equal(restored.task_id, task.task_id);
  assert.equal((restoredReply._meta?.quaymesh as Record<string, unknown>).member_id, memberId);
  assert.equal(store.getSession(handle.local)?.status, "active");
  assert.equal(await readFile(marker, "utf8"), "checkout\n");
  assert.equal(await readFile(join(root, "README.md"), "utf8"), dirty);
  assert.equal((await git(root, ["show", ":README.md"])).stdout, staged);
  assert.equal((await git(root, ["status", "--short"])).stdout.trim(), "MM README.md");
  const repeated = await call("attach_workspace", { workspace_id, session_id: task.session_id });
  assert.equal(repeated.workspace_id, workspace_id);
  assert.equal(repeated.root, root);
  assert.equal(await readFile(marker, "utf8"), "checkout\n", "已恢复的工作区不应再次运行 checkout hook");
  const read = await call("read", { workspace_id, path: "README.md" });
  assert.match(read.result, /staged worktree content/);
  assert.match(read.result, /unstaged worktree content/);

  // 新任务只在入口创建并完成，worker 没见过它；恢复前不能把它首次镜像为 active。
  await call("finish_task", { task_id: task.task_id, status: "completed", summary: "原工作树任务已完成" });
  const selection = await call("task_resume", { action: "inspect", task_id: task.task_id });
  const closedTask = await call("start_session", { title: "未访问 worker 的任务", request_key: randomUUID(),
    new_goal: true, expected_binding_revision: selection.binding.binding_revision });
  const finished = await call("finish_task", { task_id: closedTask.task_id, status: "completed", summary: "入口任务完成" });
  assert.equal(finished.state, "closed");
  const prunedAgain = await cleanupManagedWorktrees({ store,
    worktreeRoot: worker.config.worktreeRoot, allowedRoots: worker.config.allowedRoots,
    staleBefore: new Date(Date.now() + 60_000) });
  assert.ok(prunedAgain.isOk(), prunedAgain.isErr() ? prunedAgain.error.message : "");
  assert.deepEqual(prunedAgain.value.failed, []);
  assert.deepEqual(prunedAgain.value.removed.map(entry => entry.workspaceId), [handle.local]);
  await rm(marker);
  const workerDb = new Database(join(worker.config.stateDir, "quaymesh.sqlite"), { readonly: true });
  try {
    const workerTask = workerDb.prepare("SELECT state FROM qm_tasks WHERE id=?");
    assert.equal(workerTask.get(closedTask.task_id), undefined);
    const refused = await raw("attach_workspace", { workspace_id, session_id: task.session_id });
    assert.equal(refused.isError, true, JSON.stringify(refused));
    const error = refused.structuredContent as Record<string, unknown>;
    assert.equal(error.error_code, "TASK_NOT_ACTIVE");
    assert.equal(error.effect, "not_started");
    assert.equal(error.retry_hint, "fix_input");
    assert.equal(workerTask.get(closedTask.task_id), undefined, "入口拒绝不得在 worker 上创建 active 镜像");
    await assertStillPruned();
  } finally {
    workerDb.close();
  }
});
