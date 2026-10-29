import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { openDatabase } from "../db/client.js";
import { SessionFeed } from "../federation/session-feed.js";
import type { FederationRuntime } from "../federation/runtime.js";
import type { SessionFeedUpdate } from "../federation/session-types.js";
import { createInvocationContext, executeRecorded } from "./invocations.js";
import { savedOperationStatus } from "./operation-status.js";
import { SessionProjector } from "./projection.js";
import { commandSchema, validateSnapshot } from "./schema.js";
import type { SessionService } from "./service.js";
import { SessionStore } from "./store.js";
import { OperationState, type InvocationContext, type Snapshot } from "./types.js";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "qm-remote-command-"));
  const root = join(directory, "project");
  await mkdir(root);
  const beforeClose: Array<() => Promise<void>> = [];
  const nodes = ["coordinator", "worker"].map(nodeId => {
    const stateDir = join(directory, nodeId), database = openDatabase(stateDir);
    const store = new SessionStore(database.sqlite);
    const projector = new SessionProjector(store, stateDir, null, undefined, nodeId);
    return {database, store, projector};
  });
  t.after(async () => {
    for (const close of beforeClose) await close();
    for (const node of nodes) { await node.projector.close(); node.database.close(); }
    await rm(directory, {recursive: true, force: true});
  });
  const [coordinator, worker] = nodes;
  const session = coordinator.store.createSession("owner", "conversation", "Remote command");
  worker.store.adoptRemoteSession({id: session.id, ownerId: "owner", conversationId: "conversation", title: session.title});
  const member = worker.store.addMember(session.id, "worker", "workspace", root, "checkout", null);
  coordinator.store.upsertRemoteMember({id: member.id, sessionId: session.id, nodeId: "worker", workspaceId: "workspace",
    root, sourceRoot: null, mode: "checkout", online: true, revision: 0});
  const task = coordinator.store.createTask(session.id, "Command task", "command-request");
  worker.store.adoptRemoteTask(session.id, task.id, task.title, task.created_at);
  coordinator.store.touchTaskMember(task.id, member.id);
  worker.store.touchTaskMember(task.id, member.id);
  const context = (name: string, operationId = `op-${name}`) => createInvocationContext({
    auth: {owner_id: "owner"}, transport: {instance_id: "transport"},
    request: {id: name, invocation_id: `inv-${name}`, operation_id: operationId,
      conversation_id: "conversation", actor: "model", tool_name: "exec_command"},
    session: {session_id: session.id, task_id: task.id, member_id: member.id, workspace_id: "workspace"},
  });
  const initialReceipt = (value: InvocationContext) => ({kind: "result" as const, value: {
    structuredContent: {operation_id: value.operation_id, running: true, accepted: true, result: ""},
    content: [{type: "text", text: "Accepted"}],
  }});
  const recordPending = async (value: InvocationContext, input: Record<string, unknown> = {cmd: "node -e process.exit(0)"}) => {
    const receipt = initialReceipt(value);
    await executeRecorded(coordinator.store, value, input, {invoke: async () => receipt, runningResult: () => true});
    return {input, receipt};
  };
  const finishedSnapshot = async (value: InvocationContext, options: {
    status?: "succeeded" | "failed" | "cancelled"; effect?: "completed" | "partial" | "not_started";
    retryOf?: string;
  } = {}) => {
    const startedAt = Date.now(), endedAt = startedAt + 1;
    worker.store.appendEvent({session_id: session.id, task_id: task.id, member_id: member.id,
      type: "operation_started", source_id: `${value.invocation_id}-start`, timestamp: new Date(startedAt).toISOString(),
      payload: {operation_id: value.operation_id, invocation_id: value.invocation_id,
        ...(options.retryOf ? {retry_of_invocation_id: options.retryOf} : {}), kind: "command", label: "Command", actor: "model"}});
    worker.store.appendEvent({session_id: session.id, task_id: task.id, member_id: member.id,
      type: "operation_finished", source_id: `${value.invocation_id}-finish`, timestamp: new Date(endedAt).toISOString(),
      payload: {operation_id: value.operation_id, invocation_id: value.invocation_id,
        status: options.status ?? "succeeded", effect: options.effect ?? "completed", exit_code: 0}});
    const snapshot = await worker.projector.materialize(session.id, member.id, task.id);
    validateSnapshot(snapshot);
    return snapshot;
  };
  return {directory, beforeClose, coordinator, worker, session, member, task, context, recordPending, finishedSnapshot};
}

test("remote terminal command updates its coordinator attempt without a local process row or rewriting its receipt", async t => {
  const f = await fixture(t), context = f.context("completed");
  const {input, receipt} = await f.recordPending(context);
  const before = f.coordinator.store.findInvocation("owner", "transport", "completed")!;
  const snapshot = await f.finishedSnapshot(context, {effect: "partial"});
  assert.equal(snapshot.commands[0].invocation_id, context.invocation_id);
  assert.equal(snapshot.commands[0].effect, "partial");
  const processes = f.coordinator.database.sqlite.prepare("SELECT count(*) AS n FROM console_operations").get() as {n: number};
  assert.equal(processes.n, 0);
  f.coordinator.store.putRemoteSnapshot(f.session.id, f.member.id, snapshot.rev, snapshot);
  const saved = f.coordinator.store.findInvocation("owner", "transport", "completed")!;
  assert.equal(saved.state, OperationState.succeeded);
  assert.equal(saved.effect, "partial");
  assert.equal(saved.finished_at, new Date(snapshot.commands[0].endedAt!).toISOString());
  assert.equal(saved.result_json, before.result_json);
  assert.equal(saved.response_json, before.response_json);
  const status = savedOperationStatus(f.coordinator.store, context, "qm:worker:workspace", context.operation_id!)!;
  assert.equal(status.operation_state, "succeeded");
  assert.deepEqual(status.initial_receipt, receipt.value);
  assert.equal(status.poll_after_ms, null);
  assert.equal((status.next_action as {tool: string}).tool, "read_output");
  const replay = await executeRecorded(f.coordinator.store, context, input, {
    invoke: async () => { throw new Error("A receipt retry must not execute another command"); },
  });
  assert.equal(replay.replay, true);
  assert.deepEqual(replay.result, receipt);
  assert.equal(replay.state, OperationState.succeeded);
  assert.equal(f.coordinator.store.eventsForTask(f.task.id).length, 0);
});

test("remote completion requires matching task, member, operation and attempt; legacy and stale snapshots stay observational", async t => {
  const f = await fixture(t), context = f.context("scope");
  await f.recordPending(context);
  const snapshot = await f.finishedSnapshot(context);
  let revision = snapshot.rev;
  const apply = (transform: (value: Snapshot) => void) => {
    const value = structuredClone(snapshot); value.rev = ++revision; transform(value);
    f.coordinator.store.putRemoteSnapshot(f.session.id, f.member.id, value.rev, value);
    assert.equal(f.coordinator.store.findInvocation("owner", "transport", "scope")!.state, OperationState.running);
  };
  apply(value => { value.commands[0].member_id = "other-member"; });
  apply(value => { value.commands[0].operation_id = "other-operation"; });
  apply(value => { value.commands[0].invocation_id = "other-attempt"; });
  apply(value => { delete value.commands[0].invocation_id; delete value.commands[0].effect; });
  apply(value => { value.commands[0].effect = "unknown"; });
  apply(value => { value.commands[0].status = "run"; value.commands[0].endedAt = null; });
  const otherTask = f.coordinator.store.createTask(f.session.id, "Other task", "other-request");
  f.coordinator.store.touchTaskMember(otherTask.id, f.member.id);
  apply(value => { value.taskId = otherTask.id; });
  const stale = {...snapshot, rev: revision - 2};
  f.coordinator.store.putRemoteSnapshot(f.session.id, f.member.id, stale.rev, stale);
  assert.equal(f.coordinator.store.findInvocation("owner", "transport", "scope")!.state, OperationState.running);
  const latest = {...snapshot, rev: ++revision};
  f.coordinator.store.putRemoteSnapshot(f.session.id, f.member.id, latest.rev, latest);
  assert.equal(f.coordinator.store.findInvocation("owner", "transport", "scope")!.state, OperationState.succeeded);
  const conflicting = structuredClone(latest); conflicting.rev++;
  conflicting.commands[0].status = "fail";
  f.coordinator.store.putRemoteSnapshot(f.session.id, f.member.id, conflicting.rev, conflicting);
  assert.equal(f.coordinator.store.findInvocation("owner", "transport", "scope")!.state, OperationState.succeeded);
});

test("late completion of a superseded attempt leaves the active retry untouched", async t => {
  const f = await fixture(t), previous = f.context("rejected", "op-retry");
  const input = {cmd: "Command", operation_key: "retry-key"};
  const rejected = {kind: "error" as const, errorCode: "NODE_ADMISSION_PAUSED", message: "Admission paused",
    effect: "not_started" as const, retryHint: "retry_later"};
  await executeRecorded(f.coordinator.store, previous, input, {invoke: async () => rejected,
    isError: () => true, outcome: () => ({state: OperationState.failed, effect: "not_started"})});
  const current = f.context("retry", "op-retry");
  await f.recordPending(current, input);
  assert.equal(f.coordinator.store.findInvocation("owner", "transport", "retry")!.retry_of_invocation_id, previous.invocation_id);
  const oldSnapshot = await f.finishedSnapshot(previous, {status: "failed", effect: "not_started"});
  f.coordinator.store.putRemoteSnapshot(f.session.id, f.member.id, oldSnapshot.rev, oldSnapshot);
  assert.equal(f.coordinator.store.findInvocation("owner", "transport", "retry")!.state, OperationState.running);
  const latest = await f.finishedSnapshot(current, {retryOf: previous.invocation_id});
  assert.equal(latest.commands.length, 1);
  assert.equal(latest.commands[0].invocation_id, current.invocation_id);
  f.coordinator.store.putRemoteSnapshot(f.session.id, f.member.id, latest.rev, latest);
  assert.equal(f.coordinator.store.findInvocation("owner", "transport", "retry")!.state, OperationState.succeeded);
  assert.equal(f.coordinator.store.findInvocation("owner", "transport", "rejected")!.state, OperationState.failed);
});

test("remote failed and cancelled outcomes preserve their effects and leave unknown receipts for owner recovery", async t => {
  const f = await fixture(t);
  for (const status of ["failed", "cancelled"] as const) {
    const context = f.context(status);
    await f.recordPending(context);
    const snapshot = await f.finishedSnapshot(context, {status, effect: "partial"});
    f.coordinator.store.putRemoteSnapshot(f.session.id, f.member.id, snapshot.rev, snapshot);
    const saved = f.coordinator.store.findInvocation("owner", "transport", status)!;
    assert.equal(saved.state, status);
    assert.equal(saved.effect, "partial");
  }
  const context = f.context("unknown");
  await executeRecorded(f.coordinator.store, context, {}, {
    invoke: async () => ({kind: "error", errorCode: "RPC_INTERRUPTED", effect: "unknown"}),
    unknownResult: () => true,
  });
  const before = f.coordinator.store.findInvocation("owner", "transport", "unknown")!;
  const snapshot = await f.finishedSnapshot(context);
  f.coordinator.store.putRemoteSnapshot(f.session.id, f.member.id, snapshot.rev, snapshot);
  assert.deepEqual(f.coordinator.store.findInvocation("owner", "transport", "unknown"), before);
});

test("session feed negotiates command identity for replies and pushed snapshots while preserving legacy strict schemas", async t => {
  const f = await fixture(t), context = f.context("wire");
  const snapshot = await f.finishedSnapshot(context);
  const notifications = new Map<string, SessionFeedUpdate[]>();
  const links = new Map(["legacy", "current"].map(peer => [peer, {notify(_method: string, update: SessionFeedUpdate) {
    const saved = notifications.get(peer) ?? []; saved.push(update); notifications.set(peer, saved);
  }}]));
  const transport = Object.assign(new EventEmitter(), {links});
  const runtime = Object.assign(new EventEmitter(), {localId: "worker", config: {}, transport, setSessionFeed() {}});
  const service = {setRemoteFinalizer() {}, setRemoteArchiver() {}};
  const feed = new SessionFeed(runtime as unknown as FederationRuntime, f.worker.store, f.worker.projector, service as unknown as SessionService);
  f.beforeClose.push(() => feed.close());
  const request = {kind: "subscribe" as const, session_id: f.session.id, member_id: f.member.id, task_id: f.task.id};
  const legacy = await feed.handleRequest(request, "legacy") as SessionFeedUpdate;
  const current = await feed.handleRequest({...request, command_identity: true}, "current") as SessionFeedUpdate;
  const legacyCommandSchema = commandSchema.omit({invocation_id: true, effect: true});
  const checkLegacy = (value: Snapshot) => {
    for (const command of [...value.commands, value.currentCommand, value.runningCommand, value.lastCommand].filter(Boolean)) {
      legacyCommandSchema.parse(command);
      assert.equal(command!.invocation_id, undefined);
      assert.equal(command!.effect, undefined);
    }
  };
  checkLegacy(legacy.snapshot!);
  assert.equal(current.snapshot!.commands[0].invocation_id, context.invocation_id);
  assert.equal(f.worker.store.taskData.projection(f.task.id, f.member.id)!.snapshot.commands[0].invocation_id, context.invocation_id);
  const publish = feed as unknown as {publishLocalChange(sessionId: string, memberId: string, revision: number, taskId: string): void};
  publish.publishLocalChange(f.session.id, f.member.id, snapshot.rev, f.task.id);
  await new Promise<void>(resolve => setTimeout(resolve, 20));
  assert.ok(notifications.get("legacy")?.length);
  checkLegacy(notifications.get("legacy")![0].snapshot!);
  assert.equal(notifications.get("current")![0].snapshot!.commands[0].invocation_id, context.invocation_id);
});
