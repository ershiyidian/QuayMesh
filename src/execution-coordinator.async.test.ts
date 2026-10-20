import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { openDatabase } from "./db/client.js";
import { ExecutionCoordinator } from "./execution-coordinator.js";

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "quaymesh-coordinator-async-"));
  const state = join(root, "state");
  const coordinator = new ExecutionCoordinator(state);
  const other = new ExecutionCoordinator(state);
  const database = openDatabase(state);
  const timers = new Set<ReturnType<typeof setTimeout>>();
  t.after(() => {
    for (const timer of timers) clearTimeout(timer);
    if (database.sqlite.inTransaction) database.sqlite.exec("ROLLBACK");
    coordinator.close();
    other.close();
    database.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });
  const count = () => Number((database.sqlite.prepare("SELECT COUNT(*) AS n FROM qm_runtime_work").get() as { n: number }).n);
  const claimCount = () => Number((database.sqlite.prepare("SELECT COUNT(*) AS n FROM execution_claims").get() as { n: number }).n);
  const unlock = () => { if (database.sqlite.inTransaction) database.sqlite.exec("ROLLBACK"); };
  const unlockLater = (ms: number, beforeUnlock?: () => void) => {
    const timer = setTimeout(() => { timers.delete(timer); beforeUnlock?.(); unlock(); }, ms);
    timers.add(timer);
  };
  return { root, coordinator, other, database, count, claimCount, unlock, unlockLater };
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 3_000;
  while (!check()) {
    assert.ok(performance.now() < deadline, "已结束占用应在写锁释放后完成后台清理");
    await delay(10);
  }
}

test("withWork 等待真实写锁时让出事件循环且只执行一次动作", async t => {
  const f = fixture(t);
  f.database.sqlite.exec("BEGIN IMMEDIATE");
  const started = performance.now();
  let timerAt = 0, actions = 0;
  f.unlockLater(80, () => { timerAt = performance.now() - started; });
  const result = await f.coordinator.withWork({ kind: "tool" }, async () => ++actions);
  assert.equal(result, 1);
  assert.equal(actions, 1);
  assert.ok(timerAt > 0 && timerAt < 1_000, `解锁定时器延迟 ${timerAt} ms`);
  assert.ok(performance.now() - started < 1_500, "不能等待同步五秒 busy timeout");
  assert.equal(f.count(), 0);
});

test("admissionStatus 在真实写锁下只读并排除死 PID 工作", t => {
  const f = fixture(t);
  const active = f.coordinator.beginWork({ kind: "tool" });
  f.database.sqlite.prepare(`INSERT INTO qm_runtime_work
    (id,owner_id,owner_pid,kind,blocking,started_at) VALUES(?,?,?,?,?,?)`)
    .run("dead-work", "dead-owner", 2_147_483_647, "transfer", 1, new Date().toISOString());
  f.database.sqlite.exec("BEGIN IMMEDIATE");
  const started = performance.now();
  const status = f.other.admissionStatus();
  assert.ok(performance.now() - started < 500, "只读状态不应请求 SQLite 写锁");
  assert.equal(status.activeWork, 1);
  assert.equal(status.idle, false);
  assert.deepEqual(status.work, [{ kind: "tool", count: 1 }]);
  assert.equal(f.count(), 2, "查询状态不清除持久行");
  f.unlock();
  const next = f.other.beginWork({ kind: "console" });
  assert.equal(f.count(), 2, "新写入单元清除死 PID 行");
  active.release();
  next.release();
});

test("withWork 准入等待到期不进入动作且可以接受后续工作", async t => {
  const f = fixture(t);
  f.database.sqlite.exec("BEGIN IMMEDIATE");
  let actions = 0;
  await assert.rejects(f.coordinator.withWork({ kind: "tool" }, async () => ++actions, { timeoutMs: 40 }));
  assert.equal(actions, 0);
  assert.equal(f.count(), 0);
  f.unlock();
  assert.equal(await f.coordinator.withWork({ kind: "tool" }, async () => ++actions), 1);
  assert.equal(f.count(), 0);
});

test("异步释放到期保留原占用并在后台仅清理已结束租约", async t => {
  const f = fixture(t);
  const active = f.other.beginWork({ kind: "transfer" });
  const ended = await f.coordinator.beginWorkAsync({ kind: "tool" });
  f.database.sqlite.exec("BEGIN IMMEDIATE");
  const first = ended.releaseAsync({ timeoutMs: 40 });
  assert.equal(first, ended.releaseAsync({ timeoutMs: 40 }), "重复释放共享同一次等待");
  await assert.rejects(first, error => {
    const value = error as Error & { code?: string; effect?: string; details?: { leaseId?: string } };
    assert.equal(value.code, "EXECUTION_RELEASE_PENDING");
    assert.equal(value.effect, "unknown");
    assert.equal(value.details?.leaseId, ended.id);
    return true;
  });
  assert.equal(f.count(), 2);
  assert.equal(f.coordinator.admissionStatus().idle, false);
  assert.throws(() => ended.run(() => assert.fail("释放请求之后不再接受工作")));
  f.unlock();
  await waitFor(() => f.count() === 1);
  assert.ok(f.database.sqlite.prepare("SELECT 1 FROM qm_runtime_work WHERE id=?").get(active.id));
  await ended.releaseAsync();
  active.release();
});

test("withWork 收尾失败保留动作原异常且后台不重放动作", async t => {
  const f = fixture(t);
  const original = new Error("动作原异常");
  let actions = 0;
  await assert.rejects(f.coordinator.withWork({ kind: "tool" }, async () => {
    actions++;
    f.database.sqlite.exec("BEGIN IMMEDIATE");
    throw original;
  }, { timeoutMs: 40 }), error => error === original);
  assert.equal(actions, 1);
  assert.equal(f.count(), 1);
  f.unlock();
  await waitFor(() => f.count() === 0);
  assert.equal(actions, 1);
});

test("withWork 动作完成后释放到期返回明确收尾错误", async t => {
  const f = fixture(t);
  let actions = 0;
  await assert.rejects(f.coordinator.withWork({ kind: "tool" }, async () => {
    actions++;
    f.database.sqlite.exec("BEGIN IMMEDIATE");
    return "动作已完成";
  }, { timeoutMs: 40 }), error => (error as { code?: string }).code === "EXECUTION_RELEASE_PENDING");
  assert.equal(actions, 1);
  assert.equal(f.count(), 1);
  f.unlock();
  await waitFor(() => f.count() === 0);
  assert.equal(actions, 1);
});

test("close 清理本 owner 已结束占用且不清理其他活动工作", async t => {
  const f = fixture(t);
  const active = f.other.beginWork({ kind: "transfer" });
  const ownedActive = f.coordinator.beginWork({ kind: "resource" });
  const ended = await f.coordinator.beginWorkAsync({ kind: "tool" });
  f.database.sqlite.exec("BEGIN IMMEDIATE");
  await assert.rejects(ended.releaseAsync({ timeoutMs: 40 }));
  f.unlock();
  f.coordinator.close();
  assert.equal(f.count(), 2);
  await ended.releaseAsync();
  assert.ok(f.database.sqlite.prepare("SELECT 1 FROM qm_runtime_work WHERE id=?").get(active.id));
  assert.ok(f.database.sqlite.prepare("SELECT 1 FROM qm_runtime_work WHERE id=?").get(ownedActive.id));
  active.release();
});

test("closeAsync 等待真实写锁时让出事件循环并只清理本 owner 的结束记录", async t => {
  const f = fixture(t);
  const ended = await f.coordinator.beginWorkAsync({ kind: "tool" });
  const ownWaiter = f.coordinator.enqueue({ workspaceRoot: f.root, kind: "command" }, 10_000);
  const otherWaiter = f.other.enqueue({ workspaceRoot: f.root, kind: "command" }, 10_000);
  const active = f.other.beginWork({ kind: "transfer" });
  f.database.sqlite.exec("BEGIN IMMEDIATE");
  await assert.rejects(ended.releaseAsync({ timeoutMs: 40 }));
  f.unlockLater(80);
  const started = performance.now();
  const closing = f.coordinator.closeAsync();
  assert.equal(closing, f.coordinator.closeAsync(), "重复关闭共享同一次等待");
  await closing;
  assert.ok(performance.now() - started < 1_500, "关闭应异步等待写锁");
  assert.equal(f.count(), 1);
  const waiters = f.database.sqlite.prepare("SELECT id FROM execution_waiters").all();
  assert.deepEqual(waiters, [{ id: otherWaiter.id }]);
  assert.notEqual(ownWaiter.id, otherWaiter.id);
  await ended.releaseAsync();
  active.release();
  otherWaiter.cancel();
});

test("closeAsync 等待到期保留连接与待清理记录且允许再次关闭", async t => {
  const f = fixture(t);
  const ended = await f.coordinator.beginWorkAsync({ kind: "tool" });
  f.database.sqlite.exec("BEGIN IMMEDIATE");
  await assert.rejects(ended.releaseAsync({ timeoutMs: 40 }));
  await assert.rejects(f.coordinator.closeAsync({ timeoutMs: 40 }), error => (error as { code?: string }).code === "SQLITE_BUSY");
  assert.equal(f.count(), 1);
  assert.equal(f.coordinator.admissionStatus().activeWork, 1);
  f.unlock();
  await waitFor(() => f.count() === 0);
  await f.coordinator.closeAsync();
  await ended.releaseAsync();
});

test("closeAsync 可以取消等锁且取消不丢失后续清理能力", async t => {
  const f = fixture(t);
  const waiter = f.coordinator.enqueue({ workspaceRoot: f.root, kind: "command" }, 10_000);
  f.database.sqlite.exec("BEGIN IMMEDIATE");
  const controller = new AbortController();
  const reason = new Error("停止等待关闭");
  const closing = f.coordinator.closeAsync({ signal: controller.signal });
  controller.abort(reason);
  await assert.rejects(closing, error => error === reason);
  assert.ok(f.database.sqlite.prepare("SELECT 1 FROM execution_waiters WHERE id=?").get(waiter.id));
  f.unlock();
  await f.coordinator.closeAsync();
  assert.equal(f.database.sqlite.prepare("SELECT 1 FROM execution_waiters WHERE id=?").get(waiter.id), undefined);
});

test("pauseAsync 等待真实写锁期间不阻塞定时器", async t => {
  const f = fixture(t);
  f.database.sqlite.exec("BEGIN IMMEDIATE");
  const started = performance.now();
  f.unlockLater(80);
  await f.coordinator.pauseAsync("异步暂停检查");
  assert.ok(performance.now() - started < 1_500, "暂停应异步等待写锁");
  assert.equal(f.other.admissionStatus().accepting, false);
  assert.equal(f.other.admissionStatus().reason, "异步暂停检查");
  await assert.rejects(f.other.beginWorkAsync({ kind: "tool" }), /异步暂停检查/);
  f.other.resume();
});

test("异步准入保留已接受工作的上下文并拒绝独立新工作", async t => {
  const f = fixture(t);
  await f.coordinator.withWork({ kind: "tool" }, async () => {
    f.other.pause("维护检查");
    const nested = await f.other.beginWorkAsync({ kind: "transfer" });
    assert.equal(f.coordinator.admissionStatus().activeWork, 2);
    await nested.releaseAsync();
  });
  await assert.rejects(f.other.beginWorkAsync({ kind: "tool" }), /维护检查/);
  assert.equal(f.count(), 0);
});

test("run 等待 claim 写锁时让出事件循环且只调用一次动作", async t => {
  const f = fixture(t);
  f.database.sqlite.exec("BEGIN IMMEDIATE");
  const started = performance.now();
  let actions = 0;
  f.unlockLater(80);
  assert.equal(await f.coordinator.run({ workspaceRoot: f.root, kind: "command" }, async () => ++actions), 1);
  assert.ok(performance.now() - started < 1_500, "申请 claim 应异步等待写锁");
  assert.equal(actions, 1);
  assert.equal(f.claimCount(), 0);
});

test("run 释放 claim 写锁时让出事件循环且不重放动作", async t => {
  const f = fixture(t);
  const started = performance.now();
  let actions = 0;
  assert.equal(await f.coordinator.run({ workspaceRoot: f.root, kind: "command" }, async () => {
    actions++;
    f.database.sqlite.exec("BEGIN IMMEDIATE");
    f.unlockLater(80);
    return "完成";
  }), "完成");
  assert.ok(performance.now() - started < 1_500, "释放 claim 应异步等待写锁");
  assert.equal(actions, 1);
  assert.equal(f.claimCount(), 0);
});

function namedClaim(root: string, key: string) {
  return { workspaceRoot: root, kind: "command" as const, scopes: [{ kind: "named" as const, key, access: "write" as const }] };
}

test("acquireAsync 等锁到期不留下 claim 且恢复后仍执行资源独占", async t => {
  const f = fixture(t);
  f.database.sqlite.exec("BEGIN IMMEDIATE");
  await assert.rejects(f.coordinator.acquireAsync(namedClaim(f.root, "held"), { timeoutMs: 40 }));
  assert.equal(f.claimCount(), 0);
  f.unlock();
  const claim = await f.coordinator.acquireAsync(namedClaim(f.root, "held"));
  await assert.rejects(f.other.acquireAsync(namedClaim(f.root, "held")), error => (error as { code?: string }).code === "EXECUTION_CONFLICT");
  await claim.releaseAsync();
  assert.equal(f.claimCount(), 0);
});

test("claim 释放到期保留独占且后台仅删除明确结束的 claim", async t => {
  const f = fixture(t);
  const ownActive = f.coordinator.acquire(namedClaim(f.root, "own-active"));
  const otherActive = f.other.acquire(namedClaim(f.root, "other-active"));
  const endedInput = { ...namedClaim(f.root, "ended"), operationId: "ending-operation" };
  const ended = await f.coordinator.acquireAsync(endedInput);
  f.database.sqlite.exec("BEGIN IMMEDIATE");
  const releasing = ended.releaseAsync({ timeoutMs: 40 });
  assert.equal(releasing, ended.releaseAsync({ timeoutMs: 40 }));
  await assert.rejects(releasing, error => {
    const value = error as { code?: string; effect?: string; details?: { leaseId?: string } };
    assert.equal(value.code, "EXECUTION_RELEASE_PENDING");
    assert.equal(value.effect, "unknown");
    assert.equal(value.details?.leaseId, ended.id);
    return true;
  });
  assert.equal(f.claimCount(), 3);
  assert.equal(f.other.admissionStatus().claims, 3);
  assert.throws(() => ended.bindThread("after-release"));
  f.unlock();
  assert.throws(() => f.other.acquire(namedClaim(f.root, "ended")), error => (error as { code?: string }).code === "EXECUTION_CONFLICT");
  await assert.rejects(f.coordinator.acquireAsync(endedInput), error => (error as { code?: string }).code === "EXECUTION_CONFLICT");
  await waitFor(() => f.claimCount() === 2);
  for (const claim of [ownActive, otherActive])
    assert.ok(f.database.sqlite.prepare("SELECT 1 FROM execution_claims WHERE id=?").get(claim.id));
  const next = await f.other.acquireAsync(namedClaim(f.root, "ended"));
  await next.releaseAsync();
  await ended.releaseAsync();
  await ownActive.releaseAsync();
  await otherActive.releaseAsync();
});

test("claim DELETE 后提交失败仍保留占用并允许再次释放", async t => {
  const f = fixture(t);
  const claim = await f.coordinator.acquireAsync({ workspaceRoot: f.root, kind: "command", operationId: "commit-operation" });
  const path = join(f.root, "owned-file.txt");
  assert.equal(f.coordinator.ownsWriteClaim(claim.id, path, "commit-operation"), true);
  f.database.sqlite.exec(`CREATE TABLE claim_reference (
    claim_id TEXT REFERENCES execution_claims(id) DEFERRABLE INITIALLY DEFERRED)`);
  f.database.sqlite.prepare("INSERT INTO claim_reference(claim_id) VALUES(?)").run(claim.id);
  await assert.rejects(claim.releaseAsync(), error => {
    const value = error as Error & { code?: string; cause?: { code?: string } };
    assert.equal(value.code, "EXECUTION_RELEASE_PENDING");
    assert.equal(value.cause?.code, "SQLITE_CONSTRAINT_FOREIGNKEY");
    return true;
  });
  assert.equal(f.claimCount(), 1, "延迟外键使 COMMIT 失败，DELETE 必须回滚");
  assert.equal(f.coordinator.ownsWriteClaim(claim.id, path, "commit-operation"), false, "待释放占用不再授权新写入");
  f.database.sqlite.exec("DELETE FROM claim_reference");
  await claim.releaseAsync();
  assert.equal(f.claimCount(), 0, "失败提交不能提前把本地句柄标成已释放");
});

test("同 operation 继承父 claim 的异步释放不等待写锁也不释放父占用", async t => {
  const f = fixture(t);
  const parent = await f.coordinator.acquireAsync({ workspaceRoot: f.root, kind: "command", operationId: "parent-operation" });
  const child = await f.coordinator.acquireAsync({ workspaceRoot: f.root, kind: "mutation", operationId: "parent-operation",
    scopes: [{ kind: "file", path: join(f.root, "child.txt"), access: "write" }] });
  assert.equal(child.id, parent.id);
  assert.equal(f.claimCount(), 1);
  f.database.sqlite.exec("BEGIN IMMEDIATE");
  const started = performance.now();
  await child.releaseAsync();
  assert.ok(performance.now() - started < 500, "继承句柄不操作数据库");
  assert.equal(f.claimCount(), 1);
  assert.throws(() => child.bindThread("child-thread"), /内部调用/);
  f.unlock();
  await f.coordinator.closeAsync();
  assert.equal(f.claimCount(), 1, "关闭不将已释放的继承句柄当成结束的父 claim");
});

test("closeAsync 只清理待释放 claim 并保留本 owner 与其他 owner 的活动 claim", async t => {
  const f = fixture(t);
  const ownActive = f.coordinator.acquire(namedClaim(f.root, "own-active"));
  const otherActive = f.other.acquire(namedClaim(f.root, "other-active"));
  const ended = await f.coordinator.acquireAsync(namedClaim(f.root, "ended"));
  f.database.sqlite.exec("BEGIN IMMEDIATE");
  await assert.rejects(ended.releaseAsync({ timeoutMs: 40 }));
  await assert.rejects(f.coordinator.closeAsync({ timeoutMs: 40 }));
  assert.equal(f.claimCount(), 3);
  f.unlock();
  await f.coordinator.closeAsync();
  assert.equal(f.claimCount(), 2);
  for (const claim of [ownActive, otherActive])
    assert.ok(f.database.sqlite.prepare("SELECT 1 FROM execution_claims WHERE id=?").get(claim.id));
  await ended.releaseAsync();
  await otherActive.releaseAsync();
});

test("run 的 claim 收尾失败保留动作原异常且后台不重放动作", async t => {
  const f = fixture(t);
  const original = new Error("claim 动作原异常");
  let actions = 0;
  await assert.rejects(f.coordinator.run(namedClaim(f.root, "failed"), async () => {
    actions++;
    f.database.sqlite.exec("BEGIN IMMEDIATE");
    throw original;
  }, { timeoutMs: 40 }), error => error === original);
  assert.equal(f.claimCount(), 1);
  assert.equal(actions, 1);
  f.unlock();
  await waitFor(() => f.claimCount() === 0);
  assert.equal(actions, 1);
});
