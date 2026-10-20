import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { openDatabase, databasePath } from "../db/client.js";
import { holdSqliteWriteLock } from "../test-support/sqlite-lock.js";
import { createInvocationContext, executeRecorded, InvocationPersistenceError } from "./invocations.js";
import { SessionStore } from "./store.js";
import { OperationState } from "./types.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "qm-receipt-contention-"));
  const stateDir = join(root, "state"), database = openDatabase(stateDir);
  const store = new SessionStore(database.sqlite);
  const session = store.createSession("owner", "receipt-contention", "真实数据库回执");
  const member = store.addMember(session.id, "local", "ws", root, "checkout", null);
  const task = store.createTask(session.id, "原操作");
  const identity = {auth: {owner_id: "owner"}, transport: {instance_id: "transport"},
    request: {id: "first", tool_name: "append"},
    session: {session_id: session.id, member_id: member.id, workspace_id: "ws", task_id: task.id}};
  return {root, stateDir, database, store, session, member, task, identity,
    async close() { database.close(); await rm(root, {recursive: true, force: true}); }};
}

test("真实写锁下并发相同请求只取得一次执行权，等待期间仍可读账本", async t => {
  const f = await fixture();
  const lock = await holdSqliteWriteLock(databasePath(f.stateDir), 600);
  t.after(async () => { await lock.release(); await f.close(); });
  const file = join(f.root, "writes.txt"), context = createInvocationContext(f.identity);
  const operation = {invoke: async () => { await appendFile(file, "once\n"); return {saved: true}; }};
  let ticks = 0, maxGap = 0, last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now;
    assert.equal(f.store.getTask(f.task.id).state, "active"); ticks++;
  }, 10);
  try {
    const [first, replay] = await Promise.all([
      executeRecorded(f.store, context, {text: "once"}, operation),
      executeRecorded(f.store, context, {text: "once"}, operation),
    ]);
    assert.equal([first, replay].filter(value => !value.replay).length, 1);
    assert.equal(first.operation_id, replay.operation_id);
    assert.deepEqual(first.result, replay.result);
    assert.equal(await readFile(file, "utf8"), "once\n");
    assert.ok(ticks >= 20, `reader ticks: ${ticks}`);
    assert.ok(maxGap < 300, `event-loop gap: ${maxGap}`);
    t.diagnostic(JSON.stringify({ticks, max_gap_ms: maxGap, external_writes: 1}));
  } finally { clearInterval(timer); }
});

test("外部文件修改完成后遇真实锁，只等待保存原结果，重复key重取同一回执", async t => {
  const f = await fixture();
  let lock: Awaited<ReturnType<typeof holdSqliteWriteLock>> | undefined;
  t.after(async () => { await lock?.release(); await f.close(); });
  const file = join(f.root, "completed.txt"), context = createInvocationContext(f.identity);
  let executed!: () => void;
  const completed = new Promise<void>(resolve => {executed = resolve;});
  let calls = 0;
  const input = {operation_key: "save-original-result", text: "one"};
  const first = executeRecorded(f.store, context, input, {invoke: async () => {
    calls++; await appendFile(file, "one\n");
    lock = await holdSqliteWriteLock(databasePath(f.stateDir), 650);
    executed();
    return {result: "original", bytes: 4};
  }});
  await completed;
  assert.equal(f.store.findInvocationByOperationId(context.operation_id!)?.state, OperationState.running);
  const duplicate = executeRecorded(f.store, createInvocationContext({...f.identity,
    request: {...f.identity.request, id: "retry"}}), input, {invoke: async () => {
    calls++; await appendFile(file, "duplicate\n"); return {result: "wrong"};
  }});
  const [saved, replay] = await Promise.all([first, duplicate]);
  assert.equal(saved.state, OperationState.succeeded);
  assert.equal(replay.replay, true);
  assert.equal(replay.operation_id, saved.operation_id);
  assert.deepEqual(replay.result, {result: "original", bytes: 4});
  assert.equal(calls, 1);
  assert.equal(await readFile(file, "utf8"), "one\n");
});

test("真实SQL拒绝回执保存时不把已发生的外部写入改记为not_started执行失败", async t => {
  const f = await fixture(); t.after(() => f.close());
  const file = join(f.root, "effect.txt"), context = createInvocationContext(f.identity);
  f.database.sqlite.exec(`CREATE TRIGGER refuse_receipt BEFORE UPDATE OF result_json ON qm_invocations
    WHEN NEW.result_json IS NOT NULL BEGIN SELECT RAISE(ABORT,'receipt storage refused'); END`);
  let calls = 0;
  await assert.rejects(executeRecorded(f.store, context, {}, {sideEffecting: true, invoke: async () => {
    calls++; await appendFile(file, "completed\n"); return {completed: true};
  }}), error => {
    assert.ok(error instanceof InvocationPersistenceError);
    assert.equal(error.effect, "unknown");
    assert.equal(error.details.operation_id, context.operation_id);
    assert.match(String(error.cause), /receipt storage refused/);
    return true;
  });
  assert.equal(calls, 1);
  assert.equal(await readFile(file, "utf8"), "completed\n");
  const saved = f.store.findInvocationByOperationId(context.operation_id!)!;
  assert.equal(saved.state, OperationState.running);
  assert.equal(saved.effect, "started");
  assert.equal(saved.result_json, null);
  assert.equal(saved.finished_at, null);
});

test("提交后监听器抛BUSY不重放事件或版本更新，原source_id可安全重取", async t => {
  const f = await fixture(); t.after(() => f.close());
  const event = {session_id: f.session.id, task_id: f.task.id, member_id: f.member.id,
    type: "operation_started" as const, source_id: "stable-event", timestamp: new Date().toISOString(), payload: {operation_id: "op_one"}};
  const previous = f.store.getSession(f.session.id).revision;
  let notifications = 0;
  const failure = Object.assign(new Error("listener failed after commit"), {code: "SQLITE_BUSY"});
  const detach = f.store.onChange(() => { notifications++; throw failure; });
  await assert.rejects(f.store.appendEventAsync(event), error => error === failure);
  detach();
  const replay = await f.store.appendEventAsync(event);
  assert.equal(replay.changed, false);
  assert.equal(notifications, 1);
  assert.equal(f.store.getSession(f.session.id).revision, previous + 1);
  assert.deepEqual(f.database.sqlite.prepare("SELECT COUNT(*) n FROM qm_events WHERE source_id=?").get(event.source_id), {n: 1});
});
