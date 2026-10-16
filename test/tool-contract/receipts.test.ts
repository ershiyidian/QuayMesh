import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { git } from "../../src/git.js";
import { openDatabase } from "../../src/db/client.js";
import { twoNodes, until } from "./fixture.js";

async function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`真实工具回执超过 ${ms}ms`)), ms);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, error => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
}

async function delayedGit(t: TestContext, slowAtOpen = false) {
  const { worker, cloud } = await twoNodes(t, { git: true });
  const marker = join(worker.root, "filter-started");
  const release = join(worker.root, "filter-release");
  const filter = join(worker.root, "git-clean.mjs");
  // Git 真正执行 clean 过滤进程；原文件字节保持不变，释放文件控制处理时间。
  await writeFile(filter, `import {access,writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);
const bytes=Buffer.concat(chunks);
if(bytes.includes('SLOW_CONTENT')){
 await writeFile(${JSON.stringify(marker)},'started');
 for(;;){try{await access(${JSON.stringify(release)});break;}
 catch(error){if(error.code!=='ENOENT')throw error;await delay(25);}}
}
process.stdout.write(bytes);`);
  await git(worker.project, ["config", "filter.receipt-delay.clean", `"${process.execPath}" "${filter}"`]);
  await git(worker.project, ["config", "filter.receipt-delay.required", "true"]);
  await writeFile(join(worker.project, ".gitattributes"), "*.delayed filter=receipt-delay\n");
  await writeFile(join(worker.project, "data.delayed"), slowAtOpen ? "SLOW_CONTENT\n" : "NORMAL\n");
  const meta = { "openai/session": randomUUID() };
  const raw = (name: string, args: Record<string, unknown>) => cloud.client.callTool({ name, arguments: args, _meta: meta });
  const call = async (name: string, args: Record<string, unknown>) => {
    const value = await raw(name, args);
    assert.notEqual(value.isError, true, JSON.stringify(value));
    return value.structuredContent as Record<string, any>;
  };
  const task = await call("start_session", { title: "真实慢 Git 回执验证", request_key: randomUUID() });
  const workspace = await within(call("open_workspace", { root_id: "worker/main" }), 6000).catch(async error => {
    await writeFile(release, "release");
    throw error;
  });
  const scope = { workspace_id: workspace.workspace_id };
  const db = openDatabase(worker.config.stateDir);
  return { worker, cloud, marker, release, call, raw, task, scope, db };
}

test("打开 Task 工作区不执行多余的 Git 全目录快照", { timeout: 15000 }, async t => {
  const f = await delayedGit(t, true);
  try {
    assert.ok(f.scope.workspace_id);
    assert.equal(await exists(f.marker), false);
    const result = await f.call("read", { ...f.scope, path: "data.delayed" });
    assert.equal(result.result, "SLOW_CONTENT\n");
  } finally { await writeFile(f.release, "release"); f.db.close(); }
});

test("已完成写入立即返回，真实 Git 差异扫描继续且可查询最终改动", { timeout: 30000 }, async t => {
  const f = await delayedGit(t);
  try {
    await f.call("apply_patch", { ...f.scope, patch: "*** Begin Patch\n*** Add File: warm.txt\n+baseline\n*** End Patch" });
    await until(() => Number((f.db.sqlite.prepare("SELECT count(*) n FROM qm_task_file_changes WHERE task_id=?").get(f.task.task_id) as any).n) > 0);
    const pending = f.call("apply_patch", { ...f.scope, operation_key: randomUUID(),
      patch: "*** Begin Patch\n*** Update File: data.delayed\n@@\n-NORMAL\n+SLOW_CONTENT\n*** End Patch" });
    const result = await within(pending, 6000);
    assert.equal(result.additions, 1);
    assert.equal(await readFile(join(f.worker.project, "data.delayed"), "utf8"), "SLOW_CONTENT\n");
    await until(() => exists(f.marker));
    assert.equal(await exists(f.release), false);
    const status = await f.call("workspace_context", { ...f.scope, action: "status", operation_id: result.operation_id });
    assert.equal(status.operation_state, "succeeded");
    assert.equal(status.result.structuredContent.additions, 1);
    const read = await f.call("read", { ...f.scope, path: "data.delayed" });
    assert.match(read.result, /SLOW_CONTENT/);
    await writeFile(f.release, "release");
    const finished = await f.call("finish_task", { task_id: f.task.task_id, status: "completed", summary: "写入及延后差异均已验证" });
    assert.equal(finished.result_status, "completed");
    const changes = f.db.sqlite.prepare("SELECT path FROM qm_task_file_changes WHERE task_id=?").all(f.task.task_id) as any[];
    assert.ok(changes.some(row => row.path === "data.delayed"));
  } finally { await writeFile(f.release, "release"); f.db.close(); }
});

test("慢基线准备返回可查受理回执，重试复用原操作且命令仅执行一次", { timeout: 35000 }, async t => {
  const f = await delayedGit(t);
  try {
    await writeFile(join(f.worker.project, "data.delayed"), "SLOW_CONTENT\n");
    const script = join(f.worker.project, "count.mjs");
    await writeFile(script, `import {appendFile} from 'node:fs/promises';await appendFile('count.txt','once\\n');console.log('EXECUTED_ONCE');`);
    const args = { ...f.scope, cmd: `"${process.execPath}" "${script}"`, operation_key: randomUUID(), yield_time_ms: 1000 };
    const result = await within(f.call("exec_command", args), 6000);
    assert.equal(result.accepted, true);
    // 入口回执可能先于 worker 回执；实际副作用状态以 worker 查询为准。
    assert.ok(["unknown","not_started"].includes(result.effect));
    await until(() => exists(f.marker));
    assert.equal(await exists(join(f.worker.project, "count.txt")), false);
    const status = await f.call("workspace_context", { ...f.scope, action: "status", operation_id: result.operation_id });
    assert.equal(status.result_ready, false);
    assert.equal(status.effect, "not_started");
    const output = await f.call("read_output", { ...f.scope, operation_id: result.operation_id });
    assert.equal(output.operation_state, "preparing");
    assert.equal(output.process_done, false);
    const replay = await within(f.call("exec_command", args), 6000);
    assert.equal(replay.operation_id, result.operation_id);
    assert.ok(f.worker.running.execution.admissionStatus().activeWork > 0);
    await writeFile(f.release, "release");
    await until(async () => {
      const row = await f.call("workspace_context", { ...f.scope, action: "status", operation_id: result.operation_id });
      return row.operation_state === "succeeded";
    });
    const complete = await f.call("read_output", { ...f.scope, operation_id: result.operation_id });
    assert.equal(complete.exit_code, 0);
    assert.match(complete.result, /EXECUTED_ONCE/);
    assert.equal(await readFile(join(f.worker.project, "count.txt"), "utf8"), "once\n");
    const final = await f.call("finish_task", { task_id: f.task.task_id, status: "completed", summary: "慢准备、查询、幂等与命令输出均已验证" });
    assert.equal(final.result_status, "completed");
  } finally { await writeFile(f.release, "release"); f.db.close(); }
});

test("准备中的命令可以取消，基线完成后也不会启动已取消进程", { timeout: 20000 }, async t => {
  const f = await delayedGit(t);
  try {
    await writeFile(join(f.worker.project, "data.delayed"), "SLOW_CONTENT\n");
    const script = join(f.worker.project, "cancel.mjs");
    await writeFile(script, `import {writeFile} from 'node:fs/promises';await writeFile('must-not-run.txt','executed');`);
    const args = { ...f.scope, cmd: `"${process.execPath}" "${script}"`, operation_key: randomUUID(), yield_time_ms: 1000 };
    const result = await within(f.call("exec_command", args), 6000);
    assert.equal(result.accepted, true);
    const cancel = await f.call("cancel_command", { ...f.scope, operation_id: result.operation_id });
    assert.equal(cancel.state, "cancelled");
    await writeFile(f.release, "release");
    await until(() => f.worker.running.execution.admissionStatus().activeWork === 0);
    assert.equal(await exists(join(f.worker.project, "must-not-run.txt")), false);
    const status = await f.call("workspace_context", { ...f.scope, action: "status", operation_id: result.operation_id });
    assert.equal(status.operation_state, "cancelled");
    const output = await f.call("read_output", { ...f.scope, operation_id: result.operation_id });
    assert.equal(output.process_done, true);
    assert.equal(output.operation_state, "cancelled");
  } finally { await writeFile(f.release, "release"); f.db.close(); }
});
