import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import Database from "better-sqlite3";
import { loadConfig } from "../config.js";
import { databasePath } from "../db/client.js";
import { ExecutionCoordinator } from "../execution-coordinator.js";
import { LocalAgentStore } from "../local-agent-store.js";
import { writeTestQuayMeshConfig } from "../test-support/config.test.js";
import { holdSqliteWriteLock } from "../test-support/sqlite-lock.js";
import { WorkLedger } from "../work-ledger.js";
import { SqliteWorkspaceStore } from "../workspace-store.js";
import { WorkspaceRegistry } from "../workspaces.js";
import { createSessionRuntime } from "./runtime.js";
import { OperationState } from "./types.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "qm-runtime-contention-"));
  const stateDir = join(root, "state"), project = join(root, "project");
  await mkdir(project, { recursive: true });
  const config = loadConfig(writeTestQuayMeshConfig(join(root, "config"), {
    storage: { stateDir },
    workspaces: { allowedRoots: [root], worktreeRoot: join(root, "worktrees") },
    subagents: { enabled: false, instructions: "on-demand", providers: [] },
  }));
  const workspaceStore = new SqliteWorkspaceStore(stateDir);
  const workspaces = new WorkspaceRegistry(config, workspaceStore);
  const ledger = new WorkLedger(stateDir), agents = new LocalAgentStore(stateDir);
  // 外部协调器仍由 fixture 所有；运行时关闭只取消它自己发起的维护。
  const execution = new ExecutionCoordinator(stateDir);
  const startedAt = performance.now();
  const runtime = createSessionRuntime({ config, workspaces, ledger, agents, execution });
  await delay(0);
  const reader = new Database(databasePath(stateDir), { readonly: true });
  return { root, stateDir, project, runtime, ledger, startedAt, reader,
    async close() {
      await runtime.close();
      execution.close();
      reader.close();
      agents.close();
      ledger.close();
      workspaceStore.close?.();
      await rm(root, { recursive: true, force: true });
    } };
}

function pendingReceipt(f: Awaited<ReturnType<typeof fixture>>) {
  const session = f.runtime.store.createSession("test-owner", "runtime-observation", "周期核对");
  const member = f.runtime.store.addMember(session.id, "local", "test-workspace", f.project, "checkout", null);
  const run = f.ledger.begin({ root: f.project, workspaceId: "test-workspace", workItemId: "observation",
    runKey: "once", title: "周期核对", origin: { entryPoint: "other_mcp", evidence: "server_entry" } });
  const operationId = f.ledger.operation({ runId: run.id, requestKey: "test-invocation", kind: "read",
    label: "已完成，等待核对", status: "completed" });
  f.runtime.store.reserveInvocation({ id: "test-invocation", ownerId: "test-owner", transportInstanceId: "test-transport",
    requestId: "test-request", sessionId: session.id, memberId: member.id, toolName: "read", argumentsJson: "{}", operationId });
  f.ledger.db.exec(`CREATE TABLE observation_transitions(state TEXT NOT NULL);
    CREATE TRIGGER observe_receipt_transition AFTER UPDATE OF state ON qm_invocations
    WHEN OLD.state <> NEW.state BEGIN INSERT INTO observation_transitions VALUES(NEW.state); END`);
  return operationId;
}

async function until(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!check()) {
    assert.ok(performance.now() < deadline, "等待真实周期维护超时");
    await delay(20);
  }
}

async function beforeFirstObservation(startedAt: number): Promise<void> {
  // 保留生产五秒周期，外部 Worker 的五秒写锁覆盖第一次维护。
  await delay(Math.max(0, startedAt + 4_300 - performance.now()));
}

test("运行时五秒周期遇真实 Worker 写锁，读取和计时器持续响应，解锁后只核对一次", { timeout: 15_000 }, async t => {
  const f = await fixture();
  let lock: Awaited<ReturnType<typeof holdSqliteWriteLock>> | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    const operationId = pendingReceipt(f);
    await beforeFirstObservation(f.startedAt);
    lock = await holdSqliteWriteLock(databasePath(f.stateDir), 5_000);
    let ticks = 0, maxGapMs = 0, last = performance.now();
    const reads: Array<string | undefined> = [];
    timer = setInterval(() => {
      const current = performance.now(); maxGapMs = Math.max(maxGapMs, current - last); last = current;
      reads.push(f.runtime.store.findInvocationByOperationId(operationId)?.state);
      assert.ok((f.reader.prepare("SELECT COUNT(*) FROM observation_transitions").pluck().get() as number) <= 1);
      ticks++;
    }, 20);
    await lock.done;
    clearInterval(timer); timer = undefined;
    assert.ok(ticks >= 100, `写锁期间有效读取次数：${ticks}`);
    assert.ok(maxGapMs < 1_000, `计时器最长间隔：${maxGapMs} ms`);
    assert.ok(reads.filter(state => state === OperationState.accepted).length >= 100);
    assert.ok(reads.every(state => state === OperationState.accepted || state === OperationState.succeeded));
    await until(() => f.runtime.store.findInvocationByOperationId(operationId)?.state === OperationState.succeeded, 1_500);
    assert.deepEqual(f.reader.prepare("SELECT state FROM observation_transitions").all(), [{ state: "succeeded" }]);
    assert.equal(f.runtime.store.findInvocationByOperationId(operationId)?.effect, "completed");
    t.diagnostic(JSON.stringify({ held_ms: 5_000, ticks, max_gap_ms: maxGapMs, receipt_transitions: 1 }));
  } finally {
    if (timer) clearInterval(timer);
    await lock?.release();
    await f.close();
  }
});

test("关闭运行时取消正在等锁的周期维护，原连接可关闭且解锁后不会补写", { timeout: 10_000 }, async t => {
  const f = await fixture();
  let lock: Awaited<ReturnType<typeof holdSqliteWriteLock>> | undefined;
  try {
    const operationId = pendingReceipt(f);
    await beforeFirstObservation(f.startedAt);
    lock = await holdSqliteWriteLock(databasePath(f.stateDir), 15_000);
    await delay(Math.max(0, f.startedAt + 5_300 - performance.now()));
    assert.equal(f.runtime.store.findInvocationByOperationId(operationId)?.state, OperationState.accepted);
    const started = performance.now();
    await f.runtime.close();
    const closeMs = performance.now() - started;
    assert.ok(closeMs < 1_000, `取消自己的维护耗时：${closeMs} ms`);
    assert.throws(() => f.runtime.store.findInvocationByOperationId(operationId), /not open/);
    await lock.release();
    await delay(150);
    assert.deepEqual(f.reader.prepare("SELECT state FROM qm_invocations WHERE operation_id=?").get(operationId), { state: "accepted" });
    assert.equal(f.reader.prepare("SELECT COUNT(*) FROM observation_transitions").pluck().get(), 0);
    t.diagnostic(JSON.stringify({ close_ms: closeMs, cancelled_maintenance_commits: 0 }));
  } finally {
    await lock?.release();
    await f.close();
  }
});

test("真实 SQL 触发器使周期维护失败时拒绝被观察，去除故障后下一周期恢复", { timeout: 15_000 }, async t => {
  const f = await fixture();
  const failures: unknown[] = [], unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => { unhandled.push(error); };
  // 只采集日志；被测 service、store 和 SQL 执行均保持真实实现。
  const logging = t.mock.method(console, "error", (_message: unknown, error: unknown) => { failures.push(error); });
  process.on("unhandledRejection", onUnhandled);
  try {
    const operationId = pendingReceipt(f);
    f.ledger.db.exec(`CREATE TRIGGER refuse_observation BEFORE UPDATE OF state ON qm_invocations
      WHEN NEW.state='succeeded' BEGIN SELECT RAISE(ABORT,'periodic observation refused'); END`);
    await until(() => failures.length > 0, 6_500);
    assert.ok(failures.some(error => error && typeof error === "object" && "code" in error && error.code === "SQLITE_CONSTRAINT_TRIGGER"));
    assert.equal(f.runtime.store.findInvocationByOperationId(operationId)?.state, OperationState.accepted);
    assert.equal(f.reader.prepare("SELECT COUNT(*) FROM observation_transitions").pluck().get(), 0);
    f.ledger.db.exec("DROP TRIGGER refuse_observation");
    await until(() => f.runtime.store.findInvocationByOperationId(operationId)?.state === OperationState.succeeded, 6_500);
    await delay(0);
    assert.deepEqual(unhandled, []);
    assert.deepEqual(f.reader.prepare("SELECT state FROM observation_transitions").all(), [{ state: "succeeded" }]);
    t.diagnostic(JSON.stringify({ observed_sql_errors: failures.length, unhandled_rejections: unhandled.length, recovered: true }));
  } finally {
    process.off("unhandledRejection", onUnhandled);
    logging.mock.restore();
    await f.close();
  }
});
