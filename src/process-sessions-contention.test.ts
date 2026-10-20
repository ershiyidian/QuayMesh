import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { openDatabase } from "./db/client.js";
import { ProcessSessionManager, type StartCommandInput } from "./process-sessions.js";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "quaymesh-process-contention-"));
  const state = join(root, "state");
  const events: string[] = [];
  const manager = new ProcessSessionManager({ stateDir: state, diagnostics: event => { events.push(event); } });
  const database = openDatabase(state);
  t.after(async () => {
    try { await manager.shutdown(); }
    finally { database.close(); await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
  });
  const input = (id: string, script: string, args: string[] = []): StartCommandInput => ({
    workspaceId: "process-review", cwd: root, workspaceRoot: root, command: "process lifecycle check",
    sessionOperationId: id, yieldTimeMs: 2_000,
    scopes: [{ kind: "tree", path: root, access: "write" }],
    program: { executable: process.execPath, args: ["-e", script, ...args] },
  });
  return { root, manager, database, events, input };
}

test("同 operation 并发启动只执行一个真实子进程且完成后仍拒绝重放", { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const marker = join(f.root, "effects.txt");
  const input = f.input("same-operation", "require('node:fs').appendFileSync(process.argv[1],'effect\\n');", [marker]);
  const results = await Promise.allSettled([f.manager.start(input), f.manager.start(input)]);
  const completed = results.filter(result => result.status === "fulfilled");
  const rejected = results.filter(result => result.status === "rejected");
  assert.equal(completed.length, 1);
  assert.equal(rejected.length, 1);
  assert.match(String(rejected[0]?.reason), /RECORDED_OPERATION/);
  assert.equal(await readFile(marker, "utf8"), "effect\n");
  assert.equal(f.events.filter(event => event === "process_started").length, 1);
  await assert.rejects(f.manager.start(input), /RECORDED_OPERATION/);
  assert.equal(await readFile(marker, "utf8"), "effect\n");
});

test("启动准备失败释放 ID 占位且下一次成功仍只执行一个子进程", { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const marker = join(f.root, "effects.txt");
  const input = f.input("failed-preparation", "require('node:fs').appendFileSync(process.argv[1],'effect\\n');", [marker]);
  await assert.rejects(f.manager.start({ ...input, cwd: join(f.root, "missing"), workspaceRoot: join(f.root, "missing") }),
    error => (error as { code?: string }).code === "ENOENT");
  assert.equal(f.events.filter(event => event === "process_started").length, 0);
  const result = await f.manager.start(input);
  assert.equal(result.running, false);
  assert.equal(result.exitCode, 0);
  assert.equal(await readFile(marker, "utf8"), "effect\n");
  await assert.rejects(f.manager.start(input), /RECORDED_OPERATION/);
});

test("shutdown 等待真实进程已进入的 finish listener 完成", { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  let entered!: () => void, release!: () => void;
  const entering = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let listenerDone = false, shutdownDone = false;
  f.manager.addFinishListener(async () => { entered(); await gate; listenerDone = true; });
  let stopping: Promise<void> | undefined;
  try {
    await f.manager.start({ ...f.input("finish-listener", "console.log('exited');"), yieldTimeMs: 0 });
    await entering;
    stopping = f.manager.shutdown().then(() => { shutdownDone = true; });
    await delay(30);
    assert.equal(shutdownDone, false, "running=false 不能跳过尚未完成的终态回调");
    assert.equal(listenerDone, false);
  } finally {
    release();
    await stopping;
  }
  assert.equal(listenerDone, true);
  assert.equal(shutdownDone, true);
});

test("真实进程结束后 claim 提交失败由 shutdown 完成待释放清理", { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const started = await f.manager.start({ ...f.input("commit-failure", "process.stdin.once('data',()=>{console.log('done');process.exit(0);});"), yieldTimeMs: 0 });
  assert.ok(started.sessionId);
  const claim = f.database.sqlite.prepare("SELECT id FROM execution_claims WHERE operation_id=?").get("commit-failure") as { id: string };
  assert.ok(claim);
  f.database.sqlite.exec(`CREATE TABLE claim_reference (
    claim_id TEXT REFERENCES execution_claims(id) DEFERRABLE INITIALLY DEFERRED)`);
  f.database.sqlite.prepare("INSERT INTO claim_reference(claim_id) VALUES(?)").run(claim.id);
  try {
    const completed = await f.manager.write({ workspaceId: "process-review", sessionId: started.sessionId, chars: "exit\n", yieldTimeMs: 2_000 });
    assert.equal(completed.running, false);
    assert.equal(completed.exitCode, 0);
    assert.ok(f.events.includes("process_claim_release_pending"));
    assert.ok(f.database.sqlite.prepare("SELECT 1 FROM execution_claims WHERE id=?").get(claim.id));
  } finally {
    f.database.sqlite.exec("DELETE FROM claim_reference");
  }
  await f.manager.shutdown();
  assert.equal(f.database.sqlite.prepare("SELECT 1 FROM execution_claims WHERE id=?").get(claim.id), undefined);
});
