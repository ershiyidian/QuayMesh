import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { ProcessSessionManager } from "./process-sessions.js";

const command = (file: string) => `"${process.execPath}" "${file}"`;
async function terminal(manager: ProcessSessionManager, workspace: string, id: string) {
  for (let i = 0; i < 30; i++) {
    const result = await manager.write({ workspaceId: workspace, sessionId: id, chars: "", yieldTimeMs: 100 });
    if (!result.running) return result;
  }
  throw new Error("真实子进程未在预期时间内结束");
}

test("两个真实管理器不会把旧命令引用绑定到新命令", { timeout: 15000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "quaymesh-process-identity-"));
  const first = new ProcessSessionManager(), second = new ProcessSessionManager();
  t.after(async () => { await first.shutdown(); await second.shutdown(); await rm(root, { recursive: true, force: true }); });
  const a = join(root, "a.cjs"), b = join(root, "b.cjs");
  await writeFile(a, "console.log('FIRST_RUNTIME');\n"); await writeFile(b, "console.log('SECOND_RUNTIME');\n");
  const one = await first.start({ workspaceId: "workspace", command: command(a), cwd: root, yieldTimeMs: 1000 });
  await first.shutdown();
  const two = await second.start({ workspaceId: "workspace", command: command(b), cwd: root, yieldTimeMs: 1000 });
  assert.equal(typeof one.sessionId, "string"); assert.notEqual(one.sessionId, two.sessionId);
  await assert.rejects(second.write({ workspaceId: "workspace", sessionId: one.sessionId!, chars: "" }), /Unknown process session/);
  await assert.rejects(second.write({ workspaceId: "workspace", sessionId: one.sessionId!, chars: "input" }), /Unknown process session/);
  assert.throws(() => second.terminate("workspace", one.sessionId!), /Unknown process session/);
  assert.match(two.output, /SECOND_RUNTIME/);
});

test("根进程退出且子进程关闭标准输出后，仍等待其真实进程归属结束", { timeout: 15000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "quaymesh-process-owned-"));
  const manager = new ProcessSessionManager({ stdioDrainTimeoutMs: 100 });
  t.after(async () => { await manager.shutdown(); await rm(root, { recursive: true, force: true }); });
  const child = join(root, "child.cjs"), parent = join(root, "parent.cjs");
  const completed = join(root, "completed.txt");
  await writeFile(child, `setTimeout(() => {require('node:fs').writeFileSync(${JSON.stringify(completed)},'completed');process.exit(0);}, 700);\n`);
  await writeFile(parent, `const c=require('node:child_process').spawn(process.execPath,[${JSON.stringify(child)}],{stdio:'ignore',detached:process.platform==='win32'});c.unref();console.log('parent-ended');\n`);
  const started = await manager.start({ workspaceId: "workspace", command: command(parent), cwd: root, yieldTimeMs: 50 });
  assert.equal(started.running, true);
  const result = await terminal(manager, "workspace", started.sessionId!);
  assert.equal(result.exitCode, 0);
  assert.ok(result.wallTimeMs >= 650, JSON.stringify(result));
  assert.equal(await readFile(completed, "utf8"), "completed");
});

test("取消一个真实命令不终止另一个命令", { timeout: 15000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "quaymesh-process-cancel-"));
  const manager = new ProcessSessionManager();
  t.after(async () => { await manager.shutdown(); await rm(root, { recursive: true, force: true }); });
  const a = join(root, "a.cjs"), b = join(root, "b.cjs");
  await writeFile(a, "setInterval(()=>{},100);\n");
  await writeFile(b, "setTimeout(()=>console.log('other-completed'),800);\n");
  const one = await manager.start({ workspaceId: "a", command: command(a), cwd: root, yieldTimeMs: 10 });
  const two = await manager.start({ workspaceId: "b", command: command(b), cwd: root, yieldTimeMs: 10 });
  await manager.write({ workspaceId: "a", sessionId: one.sessionId!, chars: "\u0003", yieldTimeMs: 100 });
  const result = await terminal(manager, "b", two.sessionId!);
  assert.equal(result.exitCode, 0);
});
