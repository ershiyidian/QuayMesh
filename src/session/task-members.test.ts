import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import Database from "better-sqlite3";
import { loadConfig } from "../config.js";
import { migrateDatabase } from "../db/migrations.js";
import { readLocalSessionTitles } from "../console-workbench/local-queries.js";
import { writeTestQuayMeshConfig } from "../test-support/config.test.js";
import { WorkLedger } from "../work-ledger.js";
import type { WorkspaceRegistry } from "../workspaces.js";
import { createInvocationContext } from "./invocations.js";
import { SessionService } from "./service.js";
import { SessionStore } from "./store.js";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "qm-task-members-")), root = join(directory, "project");
  await mkdir(root);
  const config = loadConfig(writeTestQuayMeshConfig(join(directory, "config"), {
    storage: { stateDir: join(directory, "state") },
    workspaces: { allowedRoots: [root], worktreeRoot: join(directory, "worktrees") },
  }));
  if (config.federation) config.federation.nodeId = "local";
  const ledger = new WorkLedger(config.stateDir), store = new SessionStore(ledger.db);
  const session = store.createSession("owner", "entry", "Membership");
  const member = store.addMember(session.id, "local", "workspace", root, "checkout", null);
  const task = store.createTask(session.id, "First task", "first");
  const hostContext = (path: string) => store.upsertContextRead({
    sessionId: session.id, memberId: member.id, actorId: "host", path,
    kind: "instruction", state: "available", contentRef: null,
  });
  const event = (sourceId: string, taskId: string | null = task.id) => ({
    session_id: session.id, task_id: taskId, member_id: member.id,
    type: "operation_started" as const, source_id: sourceId, timestamp: "2026-10-28T12:00:00.000Z", payload: {},
  });
  t.after(async () => { ledger.close(); await rm(directory, { recursive: true, force: true }); });
  return { config, ledger, store, session, member, task, root, hostContext, event };
}

test("事件与成员关系原子保存，首次真实使用才继承一次工作区上下文", async t => {
  const f = await fixture(t);
  f.hostContext("AGENTS.md");
  const revision = f.store.getTask(f.task.id).revision;
  f.store.appendEvent(f.event("first-event"));
  assert.deepEqual(f.store.taskMemberIds(f.task.id), [f.member.id]);
  assert.equal(f.store.getTask(f.task.id).revision, revision + 1);
  assert.deepEqual(f.store.contextReads(f.session.id, f.member.id, f.task.id), []);
  f.store.touchTaskMember(f.task.id, f.member.id);
  assert.deepEqual(f.store.contextReads(f.session.id, f.member.id, f.task.id).map(row => row.path), ["AGENTS.md"]);
  f.hostContext("later.md");
  const usedRevision = f.store.getTask(f.task.id).revision;
  f.store.touchTaskMember(f.task.id, f.member.id);
  assert.deepEqual(f.store.contextReads(f.session.id, f.member.id, f.task.id).map(row => row.path), ["AGENTS.md"]);
  assert.equal(f.store.getTask(f.task.id).revision, usedRevision);
  assert.equal((f.ledger.db.prepare("SELECT first_seen_at FROM qm_task_members WHERE task_id=?").get(f.task.id) as {first_seen_at: string}).first_seen_at,
    f.event("first-event").timestamp);
});

test("重复事件与 legacy 空 Task 不给当前目标增加成员或上下文", async t => {
  const f = await fixture(t), original = f.event("original");
  f.store.appendEvent(original);
  const next = f.store.createTask(f.session.id, "Second task", "second");
  f.hostContext("new-rules.md");
  const revision = f.store.getTask(next.id).revision;
  const replay = f.store.appendEvent({ ...original, task_id: next.id });
  assert.equal(replay.changed, false);
  assert.deepEqual(f.store.taskMemberIds(next.id), []);
  assert.deepEqual(f.store.contextReads(f.session.id, f.member.id, next.id), []);
  assert.equal(f.store.getTask(next.id).revision, revision);
  f.store.appendEvent(f.event("legacy", null));
  assert.deepEqual(f.store.taskMemberIds(next.id), []);
  assert.equal(f.store.eventsForSession(f.session.id).find(event => event.source_id === "legacy")?.task_id, null);
});

test("错误归属及失败事件写入不会留下成员关系", async t => {
  const f = await fixture(t);
  const other = f.store.createSession("other-owner", "other-entry", "Other");
  const foreignTask = f.store.createTask(other.id, "Foreign task");
  const foreignMember = f.store.addMember(other.id, "local", "foreign", f.root, "checkout", null);
  assert.throws(() => f.store.appendEvent(f.event("wrong-task", foreignTask.id)), /TASK_SESSION_MISMATCH/);
  assert.throws(() => f.store.appendEvent({ ...f.event("wrong-member"), member_id: foreignMember.id }), /SESSION_MEMBER_NOT_FOUND/);
  f.ledger.db.exec("CREATE TRIGGER reject_member_event BEFORE INSERT ON qm_events BEGIN SELECT RAISE(ABORT,'event rejected'); END");
  assert.throws(() => f.store.appendEvent(f.event("failed-write")), /event rejected/);
  assert.deepEqual(f.store.taskMemberIds(f.task.id), []);
  assert.deepEqual(f.store.taskMemberIds(foreignTask.id), []);
  assert.equal(f.store.eventsForSession(f.session.id).length, 0);
});

test("新 Task 复用已知工作区时，前台操作登记成员并继承上下文", async t => {
  const f = await fixture(t), service = new SessionService(f.store, {} as WorkspaceRegistry, f.ledger);
  try {
  f.store.touchTaskMember(f.task.id, f.member.id);
  const next = f.store.createTask(f.session.id, "Use existing workspace", "next");
  f.hostContext("AGENTS.md");
  const context = createInvocationContext({ auth: { owner_id: "owner" }, transport: { instance_id: "transport" },
    request: { id: "new-work", operation_id: "op-new-work", actor: "model", tool_name: "read" },
    session: { session_id: f.session.id, task_id: next.id, member_id: f.member.id, workspace_id: f.member.workspace_id } });
  f.store.reserveInvocation({ id: context.invocation_id, ownerId: context.owner_id, transportInstanceId: context.transport_instance_id,
    requestId: String(context.request_id), sessionId: f.session.id, memberId: f.member.id, taskId: next.id,
    toolName: "read", argumentsJson: "{}", operationId: context.operation_id });
  assert.deepEqual(f.store.taskMemberIds(next.id), []);
  const ticket = await service.beforeOperation(context, "read", "Read with an existing workspace");
  assert.deepEqual(f.store.taskMemberIds(next.id), [f.member.id]);
  assert.deepEqual(f.store.contextReads(f.session.id, f.member.id, next.id).map(row => row.path), ["AGENTS.md"]);
  assert.ok(f.store.eventsForTask(next.id).some(event => event.payload.operation_id === ticket.operation_id));
  } finally { await service.close(); }
});

test("v14 只回填明确历史关系，保留原上下文和首次使用语义", async t => {
  const f = await fixture(t);
  f.store.touchTaskMember(f.task.id, f.member.id);
  const old = f.store.createTask(f.session.id, "Event-only history", "history");
  f.store.appendEvent(f.event("old-later", old.id));
  f.store.appendEvent({ ...f.event("old-earlier", old.id), timestamp: "2026-10-27T12:00:00.000Z" });
  f.store.appendEvent(f.event("unassigned", null));
  f.hostContext("today.md");
  f.ledger.db.prepare("DELETE FROM qm_task_members WHERE task_id=?").run(old.id);
  const contexts = f.ledger.db.prepare("SELECT * FROM qm_task_context_reads").all();
  const tasks = f.ledger.db.prepare("SELECT * FROM qm_tasks ORDER BY id").all();
  f.ledger.db.exec(`DROP TABLE qm_task_creation_receipts;
    ALTER TABLE qm_invocations DROP COLUMN response_uses_result;
    ALTER TABLE qm_task_members DROP COLUMN context_inherited; DELETE FROM qm_schema_migrations WHERE version>=14`);
  migrateDatabase(f.ledger.db);
  assert.deepEqual(f.ledger.db.prepare("SELECT * FROM qm_task_context_reads").all(), contexts);
  assert.deepEqual(f.ledger.db.prepare("SELECT * FROM qm_tasks ORDER BY id").all(), tasks);
  assert.deepEqual(f.ledger.db.prepare("SELECT first_seen_at,context_inherited FROM qm_task_members WHERE task_id=?").get(old.id),
    { first_seen_at: "2026-10-27T12:00:00.000Z", context_inherited: 0 });
  assert.deepEqual(f.store.taskMemberIds(old.id), [f.member.id]);
  assert.deepEqual(f.store.contextReads(f.session.id, f.member.id, old.id), []);
  f.store.touchTaskMember(old.id, f.member.id);
  assert.deepEqual(f.store.contextReads(f.session.id, f.member.id, old.id).map(row => row.path), ["today.md"]);
  const before = f.ledger.db.prepare("SELECT total_changes() n").get();
  migrateDatabase(f.ledger.db);
  assert.deepEqual(f.ledger.db.prepare("SELECT total_changes() n").get(), before);
  assert.deepEqual(f.ledger.db.pragma("foreign_key_check"), []);
});

test("成员热查询与任务列表不再读取事件历史，保留全部任务关系", async t => {
  const f = await fixture(t);
  f.ledger.db.transaction(() => {
    for (let index = 0; index < 2000; index++) f.store.appendEvent(f.event(`history-${index}`));
  }).immediate();
  const queries: string[] = [], prepare = Database.prototype.prepare;
  const capture = t.mock.method(Database.prototype, "prepare", function (this: Database.Database, sql: string) {
    queries.push(sql);
    return prepare.call(this, sql);
  });
  const members = f.store.taskMemberIds(f.task.id), titles = readLocalSessionTitles(f.config);
  capture.mock.restore();
  assert.deepEqual(members, [f.member.id]);
  assert.deepEqual(titles.tasks.find(task => task.id === f.task.id)?.workspaces?.map(member => member.memberId), [f.member.id]);
  assert.ok(queries.every(sql => !/\bqm_events\b/u.test(sql)), queries.join("\n"));
  const plan = f.ledger.db.prepare("EXPLAIN QUERY PLAN SELECT member_id FROM qm_task_members WHERE task_id=? ORDER BY member_id").all(f.task.id);
  assert.match(JSON.stringify(plan), /COVERING INDEX/);
  t.diagnostic(JSON.stringify({ historicalEvents: 2000, memberRows: members.length, eventQueries: 0, plan }));
});
