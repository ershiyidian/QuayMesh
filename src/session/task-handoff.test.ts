import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { ExecutionCoordinator } from "../execution-coordinator.js";
import { WorkLedger } from "../work-ledger.js";
import { openDatabase } from "../db/client.js";
import type { WorkspaceRegistry } from "../workspaces.js";
import { taskExecutionEntryFromAuthInfo } from "../tasks/task-binding.js";
import { SessionService } from "./service.js";
import { SessionStore } from "./store.js";
import { SessionProjector } from "./projection.js";
import { validateSnapshot } from "./schema.js";
import { HANDOFF_FINALIZATION_CODE } from "./task-completion.js";

const entry = (correlation: string) => taskExecutionEntryFromAuthInfo(
  { clientId: "client", extra: { owner_id: "owner" } }, correlation);

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "qm-task-handoff-")), stateDir = join(directory, "state");
  const ledger = new WorkLedger(stateDir), store = new SessionStore(ledger.db), execution = new ExecutionCoordinator(stateDir);
  // Workspace discovery is not exercised here: the members and all state are real SQLite records.
  const service = new SessionService(store, {} as WorkspaceRegistry, ledger, undefined, undefined, undefined,
    undefined, "local", execution);
  const identity = { owner_id: "owner", conversation_id: "original", task_entry: entry("original") };
  const first = await service.startTask(identity, "Persistent goal", "goal");
  const member = store.addMember(first.session.id, "local", "workspace", directory, "checkout", null);
  store.touchTaskMember(first.task.id, member.id);
  const scope = { principal: identity.task_entry.principal, taskId: first.task.id };
  t.after(async () => { await service.close(); execution.close(); ledger.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, ledger, store, execution, service, identity, scope, session: first.session, task: first.task };
}

test("handoff is rejected before finalization at every write boundary, preserving live work, binding and unread input", async t => {
  const f = await fixture(t);
  await f.store.mailbox.enqueue(f.scope, { messageKey: "user-input", body: "继续原目标" });
  const lease = f.execution.beginWork({ kind: "tool", taskId: f.task.id });
  try {
    const before = f.store.getTask(f.task.id), binding = f.store.taskBindings.current(f.identity.task_entry);
    const refusal = { code: HANDOFF_FINALIZATION_CODE, effect: "not_started" };
    await assert.rejects(f.service.finishTask("owner", f.task.id, "handed_off", "continue elsewhere"), refusal);
    await assert.rejects(f.service.finishOwnedTask("owner", f.task.id, "handed_off", "continue elsewhere"), refusal);
    assert.throws(() => f.store.taskData.requestFinalization(f.task.id, "handed_off", "continue elsewhere"), refusal);
    assert.throws(() => f.store.completeTaskFinalization(f.task.id, "handed_off", "continue elsewhere"), refusal);
    assert.throws(() => f.store.closeTask(f.task.id, "handed_off", "continue elsewhere"), refusal);
    assert.deepEqual(f.store.getTask(f.task.id), before);
    assert.deepEqual(f.store.taskBindings.current(f.identity.task_entry), binding);
    assert.equal(f.store.taskData.finalization(f.task.id), null);
    assert.equal(f.store.taskData.activeWork(f.task.id), 1);
    assert.deepEqual([f.store.mailbox.inspect(f.scope).sequence, f.store.mailbox.inspect(f.scope).pending], [1, 1]);
    await f.service.retryFinalizations();
    assert.equal(f.store.getTask(f.task.id).state, "active");
    assert.equal(f.store.taskData.activeWork(f.task.id), 1);
  } finally { lease.release(); }
});

test("unconfirmed legacy handoffs retire without changing history or acknowledgements; later completion still checks the exact mailbox cutoff", async t => {
  const f = await fixture(t);
  const selected = f.store.taskBindings.current(f.identity.task_entry);
  assert.ok(selected);
  const closed = await f.service.startTask(f.identity, "Historical handed-off goal", "history", undefined,
    { newGoal: true, expectedBindingRevision: selected.revision });
  await f.store.mailbox.enqueue(f.scope, { messageKey: "before-upgrade", body: "待确认的补充" });
  const when = "2026-01-01T00:00:00.000Z";
  // Persist records produced by the previous version; the new public API must never create these.
  f.ledger.db.prepare(`INSERT INTO qm_task_finalizations(task_id,status,summary,requested_at,completed_at,error,mailbox_sequence)
    VALUES(?,'handed_off','legacy pending',?,NULL,'previous owner unavailable',0)`).run(f.task.id, when);
  f.ledger.db.prepare(`UPDATE qm_tasks SET state='closed',result_status='handed_off',summary='historic confirmed',
    finished_at=?,archived_at=?,delivery_ended_at=?,closure_reason='explicit' WHERE id=?`).run(when, when, when, closed.task.id);
  f.ledger.db.prepare(`INSERT INTO qm_task_finalizations(task_id,status,summary,requested_at,completed_at,error,mailbox_sequence)
    VALUES(?,'handed_off','historic confirmed',?,?,NULL,0)`).run(closed.task.id, when, when);
  const oldTask = f.store.getTask(closed.task.id), oldIntent = f.store.taskData.finalization(closed.task.id);
  const binding = f.store.taskBindings.current(f.identity.task_entry), current = f.store.getTask(f.task.id);
  assert.equal(f.store.taskData.pendingFinalizations().some(intent => intent.status === "handed_off"), false);
  assert.equal(f.store.taskData.rejectLegacyHandoffFinalizations(), 1);
  const retired = f.store.taskData.finalization(f.task.id)!;
  assert.equal(retired.status, "handed_off");
  assert.equal(retired.summary, "legacy pending");
  assert.equal(retired.requested_at, when);
  assert.equal(retired.completed_at, null);
  assert.equal(retired.mailbox_sequence, 0);
  assert.match(retired.error!, new RegExp(HANDOFF_FINALIZATION_CODE));
  assert.match(retired.error!, /previous owner unavailable/);
  assert.equal(f.store.taskData.rejectLegacyHandoffFinalizations(), 0, "startup reconciliation is idempotent");
  assert.equal(f.store.getTask(f.task.id).revision, current.revision + 1);
  assert.equal(f.store.getTask(f.task.id).last_activity_at, current.last_activity_at, "retiring a legacy intent is not new model activity");
  assert.equal(f.store.getTask(f.task.id).state, "active");
  assert.equal(f.store.getTask(f.task.id).finished_at, null);
  assert.deepEqual(f.store.getTask(closed.task.id), oldTask);
  assert.deepEqual(f.store.taskData.finalization(closed.task.id), oldIntent);
  assert.deepEqual(f.store.taskBindings.current(f.identity.task_entry), binding, "Task display revision is not entry CAS revision");
  assert.equal(f.store.mailbox.inspect(f.scope).pending, 1);

  const receivingEntry = entry("receiving-entry");
  const resumed = await f.store.taskBindings.resume(receivingEntry, f.task.id, 0, "resume-original-goal");
  assert.equal(resumed.taskId, f.task.id);
  await f.store.mailbox.enqueue(f.scope, { messageKey: "after-upgrade", body: "继续原目标，不新建任务" });
  await f.service.retryFinalizations();
  assert.equal(f.store.getTask(f.task.id).state, "active");
  assert.deepEqual(f.store.taskData.finalization(f.task.id), retired, "background maintenance cannot revive the retired handoff");
  await assert.rejects(f.service.finishTask("owner", f.task.id, "completed", "done"), { code: "TASK_MAILBOX_CHANGED" });
  await assert.rejects(f.service.finishTask("owner", f.task.id, "completed", "done", undefined, 2), { code: "TASK_MAILBOX_INPUT_PENDING" });
  const receiverId = await f.store.mailbox.bindReceiver(f.scope, { clientId: "client", correlationId: "receiving-entry" });
  const delivery = await f.store.mailbox.claim(f.scope, { receiverId, requestKey: "receive-input" });
  assert.equal(delivery.status, "offered");
  if (delivery.status !== "offered") throw new Error("expected messages");
  await f.store.mailbox.acknowledge(f.scope, { receiverId, deliveryId: delivery.deliveryId,
    messageIds: delivery.messages.map(message => message.id) });
  await f.service.finishTask("owner", f.task.id, "completed", "done", undefined, 2);
  assert.equal(f.store.getTask(f.task.id).state, "closed");
  assert.equal(f.store.taskData.finalization(f.task.id)?.status, "completed");
  assert.equal(f.store.taskData.finalization(f.task.id)?.mailbox_sequence, 2);
  assert.equal(f.store.taskData.finalization(f.task.id)?.error, null);
  await assert.rejects(f.store.taskBindings.resume(entry("after-close"), f.task.id, 0, "cannot-reopen"), { code: "TASK_NOT_ACTIVE" });
  assert.deepEqual(f.store.getTask(closed.task.id), oldTask);
  assert.deepEqual(f.store.taskData.finalization(closed.task.id), oldIntent);
});

test("historical closed handed_off snapshots remain valid observations across real SQLite stores", async t => {
  const f = await fixture(t), stateDir = join(f.directory, "legacy-worker"), database = openDatabase(stateDir);
  const source = new SessionStore(database.sqlite), projector = new SessionProjector(source, stateDir, null, undefined, "legacy-worker");
  try {
    const session = source.createSession("owner", "legacy-peer-entry", "Legacy peer");
    const task = source.createTask(session.id, "Historical closed goal", "legacy-goal");
    const member = source.addMember(session.id, "legacy-worker", "legacy-workspace", f.directory, "checkout", null);
    source.touchTaskMember(task.id, member.id);
    const when = "2026-01-01T00:00:00.000Z";
    database.sqlite.prepare(`UPDATE qm_tasks SET state='closed',result_status='handed_off',summary='legacy fact',
      finished_at=?,archived_at=?,delivery_ended_at=?,closure_reason='explicit' WHERE id=?`).run(when, when, when, task.id);
    f.store.adoptRemoteSession({ id: session.id, ownerId: "owner", conversationId: session.conversation_id, title: session.title });
    f.store.adoptRemoteTask(session.id, task.id, task.title, task.created_at);
    f.store.upsertRemoteMember({ id: member.id, sessionId: session.id, nodeId: "legacy-worker", workspaceId: member.workspace_id,
      root: member.root, sourceRoot: null, mode: "checkout", online: true, revision: 0 });
    f.store.touchTaskMember(task.id, member.id);
    f.ledger.db.prepare(`UPDATE qm_tasks SET state='closed',result_status='handed_off',summary='legacy fact',
      finished_at=?,archived_at=?,delivery_ended_at=?,closure_reason='explicit' WHERE id=?`).run(when, when, when, task.id);
    const snapshot = await projector.materialize(session.id, member.id, task.id);
    validateSnapshot(snapshot); // Validate the wire contract without replacing the typed projector snapshot.
    assert.equal(snapshot.taskState, "closed");
    assert.equal(snapshot.taskResult, "handed_off");
    f.store.putRemoteSnapshot(session.id, member.id, snapshot.rev, snapshot);
    f.store.putTaskSnapshot(task.id, member.id, snapshot.rev, snapshot, []);
    assert.equal(f.store.taskData.projection(task.id, member.id)?.snapshot.taskResult, "handed_off");
    assert.equal(f.store.getTaskSnapshot(task.id, member.id)?.snapshot.taskState, "closed");
    assert.equal(f.store.getTask(task.id).state, "closed");
    assert.equal(f.store.getTask(task.id).result_status, "handed_off");
    assert.equal(f.store.getTask(task.id).delivery_ended_at, when);
    assert.equal(f.store.taskData.rejectLegacyHandoffFinalizations(), 0);
  } finally { await projector.close(); database.close(); }
});
