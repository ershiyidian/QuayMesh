import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { openDatabase } from "../db/client.js";
import { SessionFeed } from "../federation/session-feed.js";
import type { FederationRuntime } from "../federation/runtime.js";
import type { SessionFeedRequest, SessionFeedUpdate } from "../federation/session-types.js";
import { PeerTransport } from "../federation/transport.js";
import type { FederationConfig } from "../federation/types.js";
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

function legacySnapshot(snapshot: Snapshot): Snapshot {
  const value = structuredClone(snapshot);
  for (const command of [...value.commands, value.currentCommand, value.runningCommand, value.lastCommand]) {
    if (!command) continue;
    delete command.invocation_id;
    delete command.effect;
  }
  return value;
}

function peerConfig(nodeId: string): FederationConfig {
  return {enabled: true, coordinatorId: "coordinator", nodeId, nickname: nodeId, host: "127.0.0.1", port: 0,
    heartbeatMs: 100, rpcTimeoutMs: 5000, peers: [], roots: [], tokenEnv: "FIXTURE_TOKEN", priority: 0,
    capabilities: {coordinator: nodeId === "coordinator", worker: true, discovery: false, egress: false,
      meshRelay: false, desktopUi: false, consoleRelay: false},
    egress: {enabled: false, listenPort: 0, proxyUrl: "http://127.0.0.1:1", controllerSecretEnv: "FIXTURE_SECRET",
      probeUrl: "http://example.invalid", probeIntervalMs: 15000, recoveryDelayMs: 60000, inheritProxy: false}};
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 5000;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, "peer connection or durable projection did not reach the expected state");
    await delay(10);
  }
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

test("a reconnected owner rebuilds a legacy cache at the same source revision and preserves initial receipts", {timeout: 20_000}, async t => {
  const f = await fixture(t), context = f.context("legacy-reconnect");
  await f.recordPending(context);
  const initial = f.coordinator.store.findInvocation("owner", "transport", "legacy-reconnect")!;
  const snapshot = await f.finishedSnapshot(context), legacy = legacySnapshot(snapshot);
  f.worker.store.putSnapshot(f.session.id, f.member.id, f.worker.store.memberRevision(f.member.id), legacy);
  f.coordinator.store.putRemoteSnapshot(f.session.id, f.member.id, legacy.rev, legacy);
  const events = f.worker.store.eventsForTask(f.task.id), sourceRevision = f.worker.store.getTask(f.task.id).revision;
  const displayRevision = f.coordinator.store.getTask(f.task.id).revision;
  const requests: SessionFeedRequest[] = [];
  let legacyOwner = true, workerFeed: SessionFeed;
  let caller: PeerTransport | undefined, coordinatorFeed: SessionFeed | undefined;
  const token = randomUUID(), workerConfig = peerConfig("worker");
  workerConfig.peers = [{id: "coordinator", url: ""}];
  const worker = new PeerTransport(workerConfig, token, (method, params: SessionFeedRequest, peerId) => {
    assert.equal(method, "session.feed"); requests.push({...params});
    if (!legacyOwner) return workerFeed.handleRequest(params, peerId);
    return {owner_id: "owner", node_id: "worker", session_id: f.session.id, member_id: f.member.id,
      task_id: f.task.id, revision: legacy.rev, observed_at: new Date().toISOString(),
      ...(params.known_revision === legacy.rev ? {} : {snapshot: legacy})} satisfies SessionFeedUpdate;
  }, () => { throw new Error("Unexpected application stream"); });
  const service = {setRemoteFinalizer() {}, setRemoteArchiver() {}};
  workerFeed = new SessionFeed(Object.assign(new EventEmitter(), {localId: "worker", config: {coordinatorId: "coordinator"},
    transport: worker, setSessionFeed() {}}) as unknown as FederationRuntime,
  f.worker.store, f.worker.projector, service as unknown as SessionService);
  f.beforeClose.push(async () => {
    await coordinatorFeed?.close(); await workerFeed.close(); await caller?.close(); await worker.close();
  });
  await worker.start();
  const callerConfig = peerConfig("coordinator");
  callerConfig.peers = [{id: "worker", url: `http://127.0.0.1:${worker.address}`}];
  caller = new PeerTransport(callerConfig, token, (method, params, peerId) => {
    assert.equal(method, "session.feed.update"); return coordinatorFeed!.receiveUpdate(params, peerId);
  }, () => { throw new Error("Unexpected application stream"); });
  coordinatorFeed = new SessionFeed(Object.assign(new EventEmitter(), {localId: "coordinator", config: {}, transport: caller,
    setSessionFeed() {}, request: (peerId: string, method: string, params: unknown, timeout: number, _notify: unknown, signal?: AbortSignal) =>
      caller!.links.get(peerId)!.call(method, params, timeout, undefined, signal)}) as unknown as FederationRuntime,
  f.coordinator.store, f.coordinator.projector, service as unknown as SessionService);
  await caller.start(); await until(() => Boolean(caller!.links.get("worker")?.connected));
  coordinatorFeed.subscribe(f.session.id, f.member.id, "worker", f.task.id);
  await coordinatorFeed.onReconnect("worker");
  assert.ok(requests.length > 0);
  assert.equal(requests[0].known_revision, -1, "a new reader must request the missing identity fields");
  assert.equal(f.coordinator.store.findInvocation("owner", "transport", "legacy-reconnect")!.state, OperationState.running);
  assert.equal(f.coordinator.store.getTask(f.task.id).revision, displayRevision, "an old peer's equal-revision reply stays observational");

  const oldLink = caller.links.get("worker")!.id, beforeReconnect = requests.length;
  legacyOwner = false;
  caller.links.get("worker")!.close("fixture_owner_upgraded");
  await until(() => Boolean(caller!.links.get("worker")?.connected && caller!.links.get("worker")!.id !== oldLink)
    && f.coordinator.store.findInvocation("owner", "transport", "legacy-reconnect")!.state === OperationState.succeeded);
  assert.equal(requests[beforeReconnect].known_revision, -1, "reconnect must not reuse the old shape's acknowledged source revision");
  const received = f.coordinator.store.taskData.projection(f.task.id, f.member.id)!;
  assert.equal(received.revision, sourceRevision);
  assert.equal(received.snapshot.rev, sourceRevision);
  assert.deepEqual(received.snapshot.commands, snapshot.commands);
  assert.equal(f.coordinator.store.getSnapshot(f.session.id, f.member.id).snapshot!.commands[0].invocation_id, context.invocation_id);
  assert.equal(f.worker.store.getTask(f.task.id).revision, sourceRevision);
  assert.deepEqual(f.worker.store.eventsForTask(f.task.id), events);
  const repairedDisplayRevision = f.coordinator.store.getTask(f.task.id).revision;
  assert.ok(repairedDisplayRevision > displayRevision, "display evidence and actual disconnect/reconnect presence may advance the local view");
  const completed = f.coordinator.store.findInvocation("owner", "transport", "legacy-reconnect")!;
  assert.equal(completed.effect, "completed");
  assert.equal(completed.result_json, initial.result_json);
  assert.equal(completed.response_json, initial.response_json);
  const {executionObservation: _beforeObservation, ...savedSnapshot} = received.snapshot;
  await coordinatorFeed.onReconnect("worker");
  assert.equal(requests.at(-1)!.known_revision, sourceRevision, "the repaired format resumes ordinary incremental reads");
  const replayed = f.coordinator.store.taskData.projection(f.task.id, f.member.id)!;
  const {executionObservation: _afterObservation, ...replayedSnapshot} = replayed.snapshot;
  assert.equal(replayed.revision, sourceRevision);
  assert.deepEqual(replayedSnapshot, savedSnapshot);
  assert.equal(f.coordinator.store.getTask(f.task.id).revision, repairedDisplayRevision);
});

test("same-revision identity upgrades cannot change command sets or facts, downgrade evidence, or replace snapshot business data", async t => {
  const f = await fixture(t), first = f.context("shape-first"), second = f.context("shape-second");
  await f.recordPending(first); await f.recordPending(second);
  await f.finishedSnapshot(first);
  const snapshot = await f.finishedSnapshot(second), legacy = legacySnapshot(snapshot);
  f.coordinator.store.putRemoteSnapshot(f.session.id, f.member.id, legacy.rev, legacy);
  const before = f.coordinator.store.taskData.projection(f.task.id, f.member.id)!;
  const displayRevision = f.coordinator.store.getTask(f.task.id).revision;
  const reject = (mutate: (value: Snapshot) => void) => {
    const incoming = structuredClone(snapshot); mutate(incoming);
    f.coordinator.store.putRemoteSnapshot(f.session.id, f.member.id, incoming.rev, incoming);
    assert.deepEqual(f.coordinator.store.taskData.projection(f.task.id, f.member.id), before);
    assert.equal(f.coordinator.store.getTask(f.task.id).revision, displayRevision);
    assert.equal(f.coordinator.store.findInvocation("owner", "transport", "shape-first")!.state, OperationState.running);
  };
  reject(value => { value.commands = []; });
  reject(value => { value.commands.pop(); });
  reject(value => { value.commands.push({...value.commands[0], id: "added-command", operation_id: "added-operation"}); });
  reject(value => { value.commands[0] = structuredClone(value.commands[1]); });
  reject(value => { value.commands[0].id = "different-command"; });
  reject(value => { value.commands[0].member_id = "different-member"; });
  reject(value => { value.commands[0].status = "fail"; });
  reject(value => { value.commands[0].cmd = "different business content"; });
  reject(value => { value.commands[0].endedAt = value.commands[0].endedAt! + 1; });
  reject(value => { value.rev--; });
  const incoming = structuredClone(snapshot);
  incoming.title = "Must not replace the stored title";
  incoming.notices.push("Must not replace stored notices");
  incoming.observedAt++;
  f.coordinator.store.putRemoteSnapshot(f.session.id, f.member.id, incoming.rev, incoming);
  const upgraded = f.coordinator.store.taskData.projection(f.task.id, f.member.id)!;
  assert.deepEqual(upgraded.snapshot, {...legacy, commands: snapshot.commands,
    currentCommand: snapshot.currentCommand, runningCommand: snapshot.runningCommand, lastCommand: snapshot.lastCommand});
  assert.equal(f.coordinator.store.getSnapshot(f.session.id, f.member.id).snapshot!.title, legacy.title);
  assert.equal(f.coordinator.store.getTask(f.task.id).revision, displayRevision + 1);
  for (const replay of [incoming, legacy, {...snapshot, rev: snapshot.rev - 1}]) {
    f.coordinator.store.putRemoteSnapshot(f.session.id, f.member.id, replay.rev, replay);
    assert.deepEqual(f.coordinator.store.taskData.projection(f.task.id, f.member.id), upgraded);
    assert.equal(f.coordinator.store.getTask(f.task.id).revision, displayRevision + 1);
  }
});

test("same-revision owner reads rebuild legacy active and frozen snapshots but preserve explicit null and unknown identity", async t => {
  const f = await fixture(t), context = f.context("owner-cache");
  let snapshot = await f.finishedSnapshot(context);
  const transport = Object.assign(new EventEmitter(), {links: new Map()});
  const runtime = Object.assign(new EventEmitter(), {localId: "worker", config: {}, transport, setSessionFeed() {}});
  const feed = new SessionFeed(runtime as unknown as FederationRuntime, f.worker.store, f.worker.projector,
    {setRemoteFinalizer() {}, setRemoteArchiver() {}} as unknown as SessionService);
  f.beforeClose.push(() => feed.close());
  const events = f.worker.store.eventsForTask(f.task.id);
  const request = () => ({kind: "subscribe" as const, session_id: f.session.id, member_id: f.member.id, task_id: f.task.id,
    known_revision: f.worker.store.getTask(f.task.id).revision, command_identity: true});
  for (const closed of [false, true]) {
    if (closed) {
      f.worker.store.closeTask(f.task.id, "completed", "Saved owner evidence");
      snapshot = await f.worker.projector.materialize(f.session.id, f.member.id, f.task.id);
      f.worker.store.putTaskSnapshot(f.task.id, f.member.id, snapshot.rev, legacySnapshot(snapshot), []);
    }
    const legacy = legacySnapshot(snapshot), revision = f.worker.store.getTask(f.task.id).revision;
    f.worker.store.putSnapshot(f.session.id, f.member.id, f.worker.store.memberRevision(f.member.id), legacy);
    const result = await feed.handleRequest(request(), "coordinator") as SessionFeedUpdate;
    assert.equal(result.revision, revision);
    assert.deepEqual(result.snapshot!.commands, snapshot.commands);
    assert.equal(f.worker.store.getTask(f.task.id).revision, revision);
    assert.deepEqual(f.worker.store.eventsForTask(f.task.id), events);
    if (closed) assert.deepEqual(f.worker.store.getTaskSnapshot(f.task.id, f.member.id)!.snapshot, legacy,
      "frozen historical evidence is not rewritten while rebuilding its derived projection");
    assert.equal((await feed.handleRequest(request(), "coordinator") as SessionFeedUpdate).snapshot, undefined);
  }

  await f.recordPending(context);
  for (const identity of [{invocation_id: null, effect: null}, {invocation_id: context.invocation_id, effect: "unknown" as const}]) {
    const unknown = structuredClone(snapshot);
    for (const command of [...unknown.commands, unknown.currentCommand, unknown.runningCommand, unknown.lastCommand])
      if (command) Object.assign(command, identity);
    f.worker.store.putSnapshot(f.session.id, f.member.id, f.worker.store.memberRevision(f.member.id), unknown);
    assert.equal((await feed.handleRequest(request(), "coordinator") as SessionFeedUpdate).snapshot, undefined);
    f.coordinator.store.taskData.putProjection(f.task.id, f.member.id, unknown.rev, unknown);
    f.coordinator.store.putRemoteSnapshot(f.session.id, f.member.id, snapshot.rev, snapshot);
    assert.deepEqual(f.coordinator.store.taskData.projection(f.task.id, f.member.id)!.snapshot, unknown);
    assert.equal(f.coordinator.store.findInvocation("owner", "transport", "owner-cache")!.state, OperationState.running);
  }
});
