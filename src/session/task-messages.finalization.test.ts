import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import Database from "better-sqlite3";
import { WorkLedger } from "../work-ledger.js";
import type { WorkspaceRegistry } from "../workspaces.js";
import { migrateDatabase, LATEST_DATABASE_VERSION } from "../db/migrations.js";
import { taskPrincipalFromAuthInfo } from "../tasks/task-access.js";
import { createInvocationContext, executeRecorded } from "./invocations.js";
import { SessionService } from "./service.js";
import { SessionStore } from "./store.js";
import { OperationState } from "./types.js";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "qm-task-message-finalize-"));
  const ledger = new WorkLedger(join(directory, "state")), store = new SessionStore(ledger.db);
  // These cases operate on persisted members; workspace discovery is outside this boundary.
  const service = new SessionService(store, {} as WorkspaceRegistry, ledger);
  const identity = { owner_id: "owner", conversation_id: "entry" };
  const first = await service.startTask(identity, "Goal A", "goal-a");
  const member = store.addMember(first.session.id, "local", "workspace", directory, "checkout", null);
  store.touchTaskMember(first.task.id, member.id);
  const principal = taskPrincipalFromAuthInfo({ extra: { owner_id: identity.owner_id } });
  const scope = { principal, taskId: first.task.id };
  t.after(async () => { await service.close(); ledger.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, ledger, store, service, identity, session: first.session, task: first.task, member, scope };
}

async function acknowledgeAll(f: Awaited<ReturnType<typeof fixture>>, requestKey: string) {
  const receiverId = await f.store.mailbox.bindReceiver(f.scope, { clientId: "client", correlationId: "entry" });
  const claim = await f.store.mailbox.claim(f.scope, { receiverId, requestKey });
  assert.equal(claim.status, "offered");
  if (claim.status !== "offered") throw new Error("expected an offered batch");
  await f.store.mailbox.acknowledge(f.scope, { receiverId, deliveryId: claim.deliveryId,
    messageIds: claim.messages.map(message => message.id) });
  return { receiverId, messages: claim.messages };
}

test("new independent goals leave previous Tasks open and request-key retries never create or reactivate another Task", async t => {
  const f = await fixture(t);
  const second = await f.service.startTask(f.identity, "Goal B", "goal-b");
  assert.notEqual(second.task.id, f.task.id);
  assert.equal(f.store.getTask(f.task.id).state, "active");
  assert.equal(f.store.getTask(f.task.id).archived_at, null);
  assert.equal(f.store.getTask(f.task.id).closure_reason, null);
  assert.equal(f.store.currentTask(f.session.id)?.id, second.task.id);
  const retry = await f.service.startTask(f.identity, "Ignored retry title", "goal-a");
  assert.equal(retry.task.id, f.task.id);
  assert.equal(f.store.currentTask(f.session.id)?.id, second.task.id, "retrying creation must not silently rebind execution");
  const derived = await f.service.startTask(f.identity, "Independent derived goal", "derived", f.task.id);
  assert.notEqual(derived.task.id, f.task.id);
  assert.equal(derived.task.source_task_id, f.task.id);
  assert.equal(f.store.getTask(second.task.id).state, "active");
});

test("an accepted operation finishes under its original Task after another goal starts; finishing A leaves B and B's run open", async t => {
  const f = await fixture(t), file = join(f.directory, "result.txt");
  const context = createInvocationContext({ auth: { owner_id: "owner" }, transport: { instance_id: "transport" },
    request: { id: "async-a", conversation_id: "entry", actor: "model", tool_name: "exec_command" },
    session: { session_id: f.session.id, task_id: f.task.id, member_id: f.member.id, workspace_id: f.member.workspace_id } });
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), pending = new Promise<void>(resolve => { release = resolve; });
  const work = executeRecorded(f.store, context, { operation_key: "write-for-a" }, {
    sideEffecting: true,
    beforeEffect: async () => { await f.service.beforeOperation(context, "command", "write A result"); },
    invoke: async () => { enter(); await pending; await appendFile(file, "A\n"); return { completed: true }; },
  });
  await Promise.race([entered, work.then(() => { throw new Error("operation finished before its test boundary"); })]);
  let second: Awaited<ReturnType<SessionService["startTask"]>>;
  try {
    second = await f.service.startTask(f.identity, "Goal B", "goal-b");
    assert.equal(f.store.getTask(f.task.id).state, "active");
  } finally { release(); await work; }
  const recorded = await work;
  await f.service.finishOperationById(recorded.operation_id!, { status: OperationState.succeeded, effect: "completed" }, context.invocation_id);
  assert.equal(await readFile(file, "utf8"), "A\n");
  const completed = f.store.eventsForTask(f.task.id).filter(event => event.type === "operation_finished");
  assert.equal(completed.length, 1);
  assert.equal(completed[0].payload.operation_id, recorded.operation_id);
  assert.equal(f.store.eventsForTask(second!.task.id).filter(event => event.type === "operation_finished").length, 0);
  assert.equal(f.store.findInvocation("owner", "transport", "async-a")?.task_id, f.task.id);
  const runB = await f.service.ensureRun(f.store.getSession(f.session.id), f.member, { kind: "read", label: "B remains open" }, second!.task.id);
  await f.service.finishTask("owner", f.task.id, "completed", "A complete");
  assert.equal(f.store.getTask(f.task.id).state, "closed");
  assert.equal(f.store.getTask(second!.task.id).state, "active");
  assert.equal(f.store.currentTask(f.session.id)?.id, second!.task.id);
  assert.equal(f.ledger.run(runB).status, "running");
});

test("finish requires the exact message cutoff and every received user message; another Task's pending input stays independent", async t => {
  const f = await fixture(t);
  await f.store.mailbox.enqueue(f.scope, { messageKey: "input", body: "解释结果以后再结束" });
  await assert.rejects(f.service.finishTask("owner", f.task.id, "completed", "done"), { code: "TASK_MAILBOX_CHANGED" });
  await assert.rejects(f.service.finishTask("owner", f.task.id, "completed", "done", undefined, 1), { code: "TASK_MAILBOX_INPUT_PENDING" });
  assert.equal(f.store.taskData.finalization(f.task.id), null);
  const { receiverId, messages } = await acknowledgeAll(f, "receive");
  await f.store.mailbox.reply(f.scope, { receiverId, messageKey: "reply", replyTo: messages.map(message => message.id), body: "已保存解释。" });
  await assert.rejects(f.service.finishTask("owner", f.task.id, "completed", "done", undefined, 1), { code: "TASK_MAILBOX_CHANGED" });
  const second = await f.service.startTask(f.identity, "Goal B", "goal-b");
  const otherScope = { ...f.scope, taskId: second.task.id };
  await f.store.mailbox.enqueue(otherScope, { messageKey: "pending-b", body: "B还需要继续" });
  await f.service.finishTask("owner", f.task.id, "completed", "done", undefined, 2);
  assert.equal(f.store.getTask(f.task.id).state, "closed");
  assert.equal(f.store.getTask(second.task.id).state, "active");
  assert.equal(f.store.mailbox.inspect(otherScope).pending, 1);
});

test("a real second SQLite connection can win against a waiting finish; the old cutoff is checked only after its write lock", async t => {
  const f = await fixture(t);
  const competing = new Database(join(f.directory, "state", "quaymesh.sqlite"));
  competing.pragma("foreign_keys = ON");
  const otherStore = new SessionStore(competing);
  try {
    competing.exec("BEGIN IMMEDIATE");
    // The production write helper must asynchronously wait for this separate writer.
    const finishing = f.store.writeAsync(() => f.store.taskData.requestFinalization(f.task.id, "completed", "old cutoff", undefined, 0));
    competing.exec("COMMIT");
    await otherStore.mailbox.enqueue(f.scope, { messageKey: "arriving", body: "先处理此消息" });
    await assert.rejects(finishing, { code: "TASK_MAILBOX_CHANGED" });
    assert.equal(f.store.taskData.finalization(f.task.id), null);
    assert.equal(f.store.getTask(f.task.id).state, "active");
    assert.equal(f.store.mailbox.inspect(f.scope).pending, 1);
  } finally {
    if (competing.inTransaction) competing.exec("ROLLBACK");
    competing.close();
  }
});

test("a committed finish intent blocks new input, failed finalization allows it, and stale background retry cannot close the Task", async t => {
  const f = await fixture(t);
  const outcomes = await Promise.allSettled([
    f.store.writeAsync(() => f.store.taskData.requestFinalization(f.task.id, "completed", "done", undefined, 0)),
    f.store.mailbox.enqueue(f.scope, { messageKey: "draft", body: "不可悄悄丢弃" }),
  ]);
  assert.equal(outcomes[0].status, "fulfilled");
  assert.equal(outcomes[1].status, "rejected");
  assert.equal((outcomes[1] as PromiseRejectedResult).reason.code, "TASK_MAILBOX_TASK_FINISHING");
  assert.equal(f.store.mailbox.inspect(f.scope).sequence, 0);
  await f.store.writeAsync(() => f.store.taskData.finishFinalization(f.task.id, "temporary owner failure"));
  await f.store.mailbox.enqueue(f.scope, { messageKey: "draft", body: "不可悄悄丢弃" });
  assert.equal(f.store.taskData.pendingFinalizations().some(intent => intent.task_id === f.task.id), false);
  await assert.rejects(f.store.writeAsync(() => f.store.completeTaskFinalization(f.task.id, "completed", "done")), { code: "TASK_MAILBOX_CHANGED" });
  assert.equal(f.store.taskData.finalization(f.task.id)?.completed_at, null);
  await acknowledgeAll(f, "receive-new-input");
  assert.equal(f.store.taskData.pendingFinalizations().some(intent => intent.task_id === f.task.id), false,
    "acknowledgement alone must not reactivate a stale finish intent");
  await f.service.finishTask("owner", f.task.id, "completed", "done", undefined, 1);
  assert.equal(f.store.getTask(f.task.id).state, "closed");
});

test("version 9 database migration retains existing Tasks and finalization records and creates one durable mailbox schema", async t => {
  const f = await fixture(t);
  f.store.taskData.requestFinalization(f.task.id, "completed", "legacy pending finish");
  // Reconstruct v9 without changing its existing business rows. Later file-time
  // and execution-entry metadata is removed before replaying the real migrations.
  f.ledger.db.exec("DROP TABLE qm_task_binding_requests; DROP TABLE qm_task_bindings; DROP TABLE qm_task_creation_receipts;");
  for (const table of ["qm_file_changes", "qm_task_file_changes"]) {
    if ((f.ledger.db.pragma(`table_info(${table})`) as Array<{ name: string }>).some(column => column.name === "recorded_at")) {
      f.ledger.db.exec(`ALTER TABLE ${table} DROP COLUMN recorded_at`);
    }
  }
  f.ledger.db.exec(`DROP TABLE qm_task_messages; DROP TABLE qm_task_message_deliveries; DROP TABLE qm_task_message_receivers;
    ALTER TABLE qm_task_finalizations DROP COLUMN mailbox_sequence;
    ALTER TABLE qm_task_finalizations DROP COLUMN recovery_state;
    ALTER TABLE qm_task_finalizations DROP COLUMN finalization_revision;
    ALTER TABLE qm_task_members DROP COLUMN context_inherited;
    ALTER TABLE qm_invocations DROP COLUMN response_uses_result;
    DELETE FROM qm_schema_migrations WHERE version>=10;`);
  migrateDatabase(f.ledger.db);
  assert.equal((f.ledger.db.prepare("SELECT MAX(version) AS version FROM qm_schema_migrations").get() as { version: number }).version,
    LATEST_DATABASE_VERSION);
  assert.equal(f.store.getTask(f.task.id).title, "Goal A");
  assert.equal(f.store.taskData.finalization(f.task.id)?.summary, "legacy pending finish");
  assert.equal(f.store.taskData.finalization(f.task.id)?.mailbox_sequence, 0);
  assert.equal(f.store.taskData.finalization(f.task.id)?.finalization_revision, 0);
  assert.equal(f.store.taskData.finalization(f.task.id)?.recovery_state, null,"legacy error text is not unsent proof");
  migrateDatabase(f.ledger.db);
  assert.deepEqual(f.store.mailbox.inspect(f.scope), { sequence: 0, pending: 0 });
});
