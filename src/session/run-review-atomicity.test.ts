import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { loadConfig } from "../config.js";
import { openDatabase } from "../db/client.js";
import { writeTestQuayMeshConfig } from "../test-support/config.test.js";
import { WorkLedger } from "../work-ledger.js";
import { SqliteWorkspaceStore } from "../workspace-store.js";
import { WorkspaceRegistry } from "../workspaces.js";
import { SessionService } from "./service.js";
import { SessionStore } from "./store.js";
import { OperationState, ReviewState } from "./types.js";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "qm-run-review-"));
  const root = join(directory, "project"), stateDir = join(directory, "state");
  await mkdir(root);
  const config = loadConfig(writeTestQuayMeshConfig(join(directory, "config"), {
    storage: { stateDir }, workspaces: { allowedRoots: [root], worktreeRoot: join(directory, "worktrees") },
  }));
  const workspaceStore = new SqliteWorkspaceStore(stateDir), ledger = new WorkLedger(stateDir);
  const database = openDatabase(stateDir), store = new SessionStore(database.sqlite);
  const service = new SessionService(store, new WorkspaceRegistry(config, workspaceStore), ledger);
  const session = store.createSession("owner", "review-atomicity", "原会话");
  const member = store.addMember(session.id, "local", "workspace", root, "checkout", null);
  const task = store.createTask(session.id, "原任务");
  return { root, stateDir, database, store, service, ledger, session, member, task,
    async close() {
      if (database.sqlite.inTransaction) database.sqlite.exec("ROLLBACK");
      await service.close(); database.close(); ledger.close(); workspaceStore.close();
      await rm(directory, { recursive: true, force: true });
    } };
}

for (const asynchronous of [false, true]) {
  test(`${asynchronous ? "异步" : "同步"} review 通知抛错后，其他连接已读到唯一提交且重试不增加事件`, async () => {
    const f = await fixture();
    const failure = Object.assign(new Error("listener failed after review commit"), { code: "SQLITE_BUSY" });
    const observed: Array<{ transaction: boolean; state: unknown; events: unknown }> = [];
    const detach = f.store.onChange(() => {
      observed.push({ transaction: f.database.sqlite.inTransaction,
        state: f.ledger.db.prepare("SELECT review_state FROM qm_sessions WHERE id=?").pluck().get(f.session.id),
        events: f.ledger.db.prepare("SELECT COUNT(*) FROM qm_events WHERE event_type='verification_recorded'").pluck().get() });
      throw failure;
    });
    try {
      const before = f.store.getSession(f.session.id).revision;
      if (asynchronous) await assert.rejects(f.store.setReviewStateAsync(f.session.id, ReviewState.passed), error => error === failure);
      else assert.throws(() => f.store.setReviewState(f.session.id, ReviewState.passed), error => error === failure);
      assert.deepEqual(observed, [{ transaction: false, state: "passed", events: 1 }]);
      assert.equal(f.store.getSession(f.session.id).review_state, ReviewState.passed);
      assert.equal(f.store.getSession(f.session.id).revision, before + 1);
      if (asynchronous) await f.store.setReviewStateAsync(f.session.id, ReviewState.passed);
      else f.store.setReviewState(f.session.id, ReviewState.passed);
      assert.equal(observed.length, 1);
      assert.equal(f.store.eventsForSession(f.session.id).filter(event => event.type === "verification_recorded").length, 1);
    } finally { detach(); await f.close(); }
  });
}

test("关联插入被真实 SQL 触发器拒绝时，新 run 与项目记录全部回滚；并发重试只创建一个关联 run", async () => {
  const f = await fixture();
  try {
    f.database.sqlite.exec(`CREATE TRIGGER refuse_run_link BEFORE INSERT ON qm_run_links
      BEGIN SELECT RAISE(ABORT,'run link refused'); END`);
    const create = () => f.service.ensureRun(f.session, f.member, { kind: "read", label: "真实 run" }, f.task.id);
    await assert.rejects(create(), { code: "SQLITE_CONSTRAINT_TRIGGER" });
    for (const table of ["console_projects", "console_work_items", "console_work_runs", "qm_run_links"])
      assert.equal(f.ledger.db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get(), 0, table);
    f.database.sqlite.exec("DROP TRIGGER refuse_run_link");
    const runs = await Promise.all([create(), create(), create()]);
    assert.equal(new Set(runs).size, 1);
    assert.deepEqual(f.store.runIdsForTask(f.task.id), [runs[0]]);
    assert.equal(f.ledger.db.prepare("SELECT COUNT(*) FROM console_work_runs").pluck().get(), 1);
    assert.equal(f.ledger.db.prepare("SELECT COUNT(*) FROM qm_run_links").pluck().get(), 1);
  } finally { await f.close(); }
});

test("review 的真实 SQL 失败回滚状态和事件，外层事务调用同步通知入口被拒绝", async () => {
  const f = await fixture();
  try {
    f.database.sqlite.exec(`CREATE TRIGGER refuse_review BEFORE INSERT ON qm_events
      WHEN NEW.event_type='verification_recorded' BEGIN SELECT RAISE(ABORT,'review refused'); END`);
    await assert.rejects(f.store.setReviewStateAsync(f.session.id, ReviewState.passed), { code: "SQLITE_CONSTRAINT_TRIGGER" });
    assert.equal(f.store.getSession(f.session.id).review_state, ReviewState.unknown);
    assert.equal(f.store.eventsForSession(f.session.id).length, 0);
    f.database.sqlite.exec("DROP TRIGGER refuse_review; BEGIN IMMEDIATE");
    assert.throws(() => f.store.setReviewState(f.session.id, ReviewState.passed), { code: "SQLITE_WRITE_OUTER_TRANSACTION" });
    assert.equal(f.database.sqlite.inTransaction, true);
    f.database.sqlite.exec("ROLLBACK");
    assert.equal(f.store.getSession(f.session.id).review_state, ReviewState.unknown);
  } finally { await f.close(); }
});

test("等待 ledger 写锁期间任务关闭，取得锁后拒绝创建 run", async () => {
  const f = await fixture();
  try {
    f.database.sqlite.exec("BEGIN IMMEDIATE");
    const creating = f.service.ensureRun(f.session, f.member, { kind: "read", label: "等待中的任务" }, f.task.id);
    const refused = assert.rejects(creating, /TASK_NOT_ACTIVE/);
    await delay(20);
    f.store.closeTask(f.task.id, "completed", "在等锁期间结束");
    f.database.sqlite.exec("COMMIT");
    await refused;
    assert.equal(f.ledger.db.prepare("SELECT COUNT(*) FROM console_work_runs").pluck().get(), 0);
    assert.equal(f.ledger.db.prepare("SELECT COUNT(*) FROM qm_run_links").pluck().get(), 0);
  } finally { await f.close(); }
});

test("run 提交后的 review 通知失败不会留下孤立 run，重取不重复事件或新建 run", async () => {
  const f = await fixture();
  let detach: (() => void) | undefined;
  try {
    f.store.setReviewState(f.session.id, ReviewState.passed);
    const failure = new Error("notification failed after run and review commit");
    detach = f.store.onChange(() => { throw failure; });
    const create = () => f.service.ensureRun(f.session, f.member, { kind: "read", label: "同一 run" }, f.task.id);
    await assert.rejects(create(), error => error === failure);
    const [runId] = f.store.runIdsForTask(f.task.id);
    assert.ok(runId);
    assert.equal(f.store.getSession(f.session.id).review_state, ReviewState.unknown);
    assert.equal(await create(), runId);
    assert.equal(f.ledger.db.prepare("SELECT COUNT(*) FROM console_work_runs").pluck().get(), 1);
    assert.equal(f.ledger.db.prepare("SELECT COUNT(*) FROM qm_run_links").pluck().get(), 1);
    assert.equal(f.store.eventsForTask(f.task.id).filter(event => event.type === "verification_recorded"
      && event.payload.decision === "unknown").length, 1);
  } finally { detach?.(); await f.close(); }
});

test("review 等锁期间切换任务，不把旧请求的验收结果写进新任务", async () => {
  const f = await fixture();
  try {
    f.ledger.db.exec("BEGIN IMMEDIATE");
    const updating = f.store.setReviewStateAsync(f.session.id, ReviewState.passed, f.task.id);
    const refused = assert.rejects(updating, /STALE_CONTEXT/);
    await delay(20);
    const writer = new SessionStore(f.ledger.db);
    writer.closeTask(f.task.id, "completed", "结束原任务");
    const next = writer.createTask(f.session.id, "新任务");
    f.ledger.db.exec("COMMIT");
    await refused;
    assert.equal(f.store.getSession(f.session.id).review_state, ReviewState.unknown);
    assert.equal(f.store.eventsForTask(f.task.id).length, 0);
    assert.equal(f.store.eventsForTask(next.id).length, 0);
  } finally {
    if (f.ledger.db.inTransaction) f.ledger.db.exec("ROLLBACK");
    await f.close();
  }
});

test("等待 ledger 写锁期间原 attempt 被替代，取得锁后拒绝旧身份创建 run", async () => {
  const f = await fixture();
  try {
    const reservation = { id: "attempt-first", ownerId: "owner", transportInstanceId: "transport", requestId: "request-first",
      sessionId: f.session.id, memberId: f.member.id, taskId: f.task.id, toolName: "read", argumentsJson: "{}",
      operationId: "operation-original", operationKey: "original-key" };
    f.store.reserveInvocation(reservation);
    f.database.sqlite.exec("BEGIN IMMEDIATE");
    const creating = f.service.ensureRun(f.session, f.member, { kind: "read", label: "旧身份",
      invocationId: reservation.id, operationId: reservation.operationId }, f.task.id);
    const refused = assert.rejects(creating, /OPERATION_RETRY_SUPERSEDED/);
    await delay(20);
    f.store.updateInvocation({ ownerId: "owner", transportInstanceId: "transport", requestId: reservation.requestId,
      state: OperationState.failed, effect: "not_started", result: { kind: "error", errorCode: "EXECUTION_CONFLICT",
        effect: "not_started", retryHint: "retry_later" }, finished: true });
    f.store.reserveInvocation({ ...reservation, id: "attempt-next", requestId: "request-next", retryOfInvocationId: reservation.id });
    f.database.sqlite.exec("COMMIT");
    await refused;
    assert.equal(f.store.findInvocationByOperationId(reservation.operationId)?.id, "attempt-next");
    assert.equal(f.ledger.db.prepare("SELECT COUNT(*) FROM console_work_runs").pluck().get(), 0);
    assert.equal(f.ledger.db.prepare("SELECT COUNT(*) FROM qm_run_links").pluck().get(), 0);
  } finally { await f.close(); }
});

test("旧 finish 等待事件写锁期间新 attempt 已提交，不追加旧事件或回退活动时间", { timeout: 8_000 }, async () => {
  const f = await fixture(), writer = new WorkLedger(f.stateDir);
  let finishing: Promise<void> | undefined;
  try {
    const incoming = new SessionStore(writer.db);
    const reservation = { id: "old-attempt", ownerId: "owner", transportInstanceId: "transport", requestId: "old-request",
      sessionId: f.session.id, memberId: f.member.id, taskId: f.task.id, toolName: "exec_command", argumentsJson: "{}",
      operationId: "op_original", operationKey: "original-key" };
    f.store.reserveInvocation(reservation);
    const run = f.ledger.begin({ root: f.root, workspaceId: f.member.workspace_id, workItemId: "original", runKey: "original",
      title: "原操作", origin: { entryPoint: "other_mcp", evidence: "server_entry" } });
    f.store.linkRun(f.session.id, f.member.id, run.id, f.task.id);
    f.ledger.operation({ id: reservation.operationId, runId: run.id, requestKey: reservation.id, kind: "command", label: "原命令", status: "running" });
    f.store.appendEvent({ session_id: f.session.id, task_id: f.task.id, member_id: f.member.id, type: "operation_started",
      source_id: "original-start", timestamp: new Date().toISOString(), payload: { operation_id: reservation.operationId,
        invocation_id: reservation.id, kind: "command", label: "原命令", run_id: run.id } });
    f.store.updateInvocation({ ownerId: "owner", transportInstanceId: "transport", requestId: reservation.requestId,
      state: OperationState.failed, effect: "not_started", result: { kind: "error", errorCode: "EXECUTION_CONFLICT",
        effect: "not_started", retryHint: "retry_later" }, finished: true });

    let lockedResolve!: () => void, lockedReject!: (error: unknown) => void, queued = false;
    const locked = new Promise<void>((resolve, reject) => { lockedResolve = resolve; lockedReject = reject; });
    // 真实 SQL 更新后排队取得另一连接的写锁，确定性覆盖 ledger 提交与事件提交之间的窗口。
    f.ledger.db.function("hold_event_writer", () => {
      if (!queued) {
        queued = true;
        queueMicrotask(() => {
          try { writer.db.exec("BEGIN IMMEDIATE"); lockedResolve(); } catch (error) { lockedReject(error); }
        });
      }
      return 0;
    });
    writer.db.function("hold_event_writer", () => 0);
    f.ledger.db.exec(`CREATE TRIGGER hold_after_operation_end AFTER UPDATE OF status ON console_operations
      WHEN NEW.status='failed' BEGIN SELECT hold_event_writer(); END`);
    finishing = f.service.operationFinished({ ticket_id: "original-ticket", operation_id: reservation.operationId,
      invocation_id: reservation.id, session_id: f.session.id, task_id: f.task.id, member_id: f.member.id, run_id: run.id,
      kind: "command", label: "原命令", started_at: Date.now(), actor: "model" },
    { status: OperationState.failed, effect: "not_started", error_code: "EXECUTION_CONFLICT" });
    void finishing.catch(() => {});
    await locked;
    await delay(40);
    incoming.reserveInvocation({ ...reservation, id: "next-attempt", requestId: "next-request", retryOfInvocationId: reservation.id });
    writer.operation({ id: reservation.operationId, runId: run.id, requestKey: "next-attempt", kind: "command", label: "原命令",
      status: "running", retryOfInvocationId: reservation.id });
    incoming.updateInvocation({ ownerId: "owner", transportInstanceId: "transport", requestId: "next-request",
      state: OperationState.running, effect: "started" });
    const nextAt = new Date().toISOString();
    incoming.appendEvent({ session_id: f.session.id, task_id: f.task.id, member_id: f.member.id, type: "operation_started",
      source_id: "next-start", timestamp: nextAt, payload: { operation_id: reservation.operationId, invocation_id: "next-attempt",
        retry_of_invocation_id: reservation.id, kind: "command", label: "原命令", run_id: run.id, status: "running" } });
    writer.db.exec("COMMIT");
    const next = f.store.findInvocationByOperationId(reservation.operationId);
    await finishing;
    assert.equal(f.store.eventsForTask(f.task.id).filter(event => event.type === "operation_finished").length, 0);
    assert.equal(f.store.getSession(f.session.id).last_activity_at, nextAt);
    assert.equal(f.store.getTask(f.task.id).last_activity_at, nextAt);
    assert.deepEqual(f.store.findInvocationByOperationId(reservation.operationId), next);
    assert.deepEqual(f.ledger.db.prepare("SELECT request_key,status FROM console_operations WHERE id=?").get(reservation.operationId),
      { request_key: "next-attempt", status: "running" });
  } finally {
    if (writer.db.inTransaction) writer.db.exec("ROLLBACK");
    await finishing?.catch(() => {});
    writer.close();
    await f.close();
  }
});
