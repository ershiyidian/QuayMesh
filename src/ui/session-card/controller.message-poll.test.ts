import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { TaskMessagePage, TaskMessageView } from "../../messaging/task-message-types.js";
import { ExecutionState, type Snapshot } from "../../session/types.js";
import type { TaskBindingState, TaskBindingView } from "../../tasks/task-binding.js";
import { createCardController } from "./controller.js";
import { createPreviewSource, previewSnapshot } from "./preview.js";
import type { SessionCardSource } from "./source.js";
import { applySnapshot, createCardState } from "./state.js";

const now = Date.parse("2026-10-28T06:00:00Z");
function message(taskId: string, sequence = 1): TaskMessageView {
  return { id: `${taskId}-message-${sequence}`, sequence, role: "assistant", reply_to: [], body: `${taskId} 的回复 ${sequence}`,
    created_at: new Date(now).toISOString(), offered_at: null, acknowledged_at: null, status: "replied" };
}
function page(taskId: string, sequence = 1): TaskMessagePage {
  return { task_id: taskId, messages: [message(taskId, sequence)], next_before_sequence: null,
    mailbox: { sequence, pending: 0 } };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settled(): Promise<void> { await new Promise<void>(resolve => setImmediate(resolve)); }

function fixture(t: TestContext, taskId = "task-a", overrides: Partial<SessionCardSource> = {}) {
  const snapshot: Snapshot = { ...previewSnapshot, taskId, status: "idle", taskState: "active", taskResult: null,
    execution_status: ExecutionState.idle, finalization: null, startedAt: now - 120_000, lastActivityAt: now,
    serverNow: now, observedAt: now, commands: [], agents: [], currentCommand: null, runningCommand: null,
    lastCommand: null, lastOperation: null,
    executionObservation: { observedAt: now, activeOperationIds: [], preparingOperationIds: [], staleOperationIds: [] } };
  const state = createCardState();
  applySnapshot(state, snapshot);
  state.collapsed = false; state.tab = "messages";
  const doc = new class extends EventTarget { hidden = false; defaultView = null; getElementById() { return null; } }();
  const view = { render() {}, renderPanel() {}, renderFooter() {}, fillTimers() {}, dispose() {} };
  const source: SessionCardSource = { ...createPreviewSource(), live: true,
    async snapshot() { return snapshot; }, async taskMessages() { return page(taskId); },
    async enqueueTaskMessage() { throw new Error("NOT_USED"); } };
  Object.defineProperties(source, Object.getOwnPropertyDescriptors(overrides));
  const controller = createCardController(state, view, source, doc as unknown as Document);
  t.after(() => controller.dispose());
  return { snapshot, state, doc, controller };
}

test("Coordinator messages arrive while the worker snapshot is pending, without confirming Task state or changing its entry", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now });
  const pendingSnapshot = deferred<Snapshot | null>();
  const f = fixture(t, "task-a", { snapshot: () => pendingSnapshot.promise });
  const binding: TaskBindingState = { task_id: "task-a", entry_available: true, binding_revision: 4,
    selected_task_id: "task-a", status: "selected", can_resume: true, can_continue: true };
  f.state.taskBinding = binding;
  const confirmation = f.state.lastConfirmedAt, activity = f.state.snapshot!.lastActivityAt;
  const polling = f.controller.pollOnce();
  await settled();
  assert.equal(f.state.messages.messages[0]?.body, "task-a 的回复 1", "mailbox is not sequenced after the slow worker read");
  assert.equal(f.state.connection, "connecting");
  assert.equal(f.state.lastConfirmedAt, confirmation);
  assert.equal(f.state.snapshot!.lastActivityAt, activity);
  assert.equal(f.state.taskBinding, binding);
  pendingSnapshot.reject(new Error("WORKER_OFFLINE"));
  await polling;
  assert.equal(f.state.connection, "error");
  assert.equal(f.state.lastConfirmedAt, confirmation);
  assert.equal(f.state.messages.loadError, null);
});

test("one hanging snapshot spans multiple mailbox ticks without a second snapshot or overlapping mailbox; hiding and remounting discard late results", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now });
  const worker = deferred<Snapshot | null>(), slowMailbox = deferred<TaskMessagePage>();
  let snapshots = 0, reads = 0, workerSignal: AbortSignal | undefined, slowSignal: AbortSignal | undefined;
  const user: TaskMessageView = { ...message("task-a"), role: "user", status: "queued", body: "请核对补充" };
  let response: TaskMessagePage = { ...page("task-a"), messages: [user], mailbox: { sequence: 1, pending: 1 } };
  const old = fixture(t, "task-a", {
    snapshot: (_revision, signal) => { snapshots++; workerSignal = signal; return worker.promise; },
    taskMessages: async (_before, signal) => {
      reads++;
      if (reads >= 4) { slowSignal = signal; return slowMailbox.promise; }
      return response;
    },
  });
  old.controller.start();
  const pending = old.controller.pollOnce();
  await settled();
  const confirmation = old.state.lastConfirmedAt, activity = old.state.snapshot!.lastActivityAt;
  assert.equal(old.state.messages.messages[0].status, "queued");

  const acknowledged = { ...user, status: "acknowledged" as const, acknowledged_at: user.created_at };
  response = { ...response, messages: [acknowledged], mailbox: { sequence: 1, pending: 0 } };
  t.mock.timers.tick(5000); await settled();
  assert.equal(snapshots, 1);
  assert.equal(reads, 2, "a still-pending snapshot cannot hold the next mailbox tick");
  assert.equal(old.state.messages.messages[0].status, "acknowledged");

  response = { ...page("task-a", 2), messages: [acknowledged, { ...message("task-a", 2), reply_to: [user.id] }] };
  t.mock.timers.tick(5000); await settled();
  assert.equal(reads, 3);
  assert.equal(old.state.messages.messages[1].status, "replied");
  assert.equal(old.state.messages.messages[1].body, "task-a 的回复 2");
  assert.equal(old.state.lastConfirmedAt, confirmation);
  assert.equal(old.state.snapshot!.lastActivityAt, activity);
  assert.equal(old.state.connection, "connecting");

  for (let step = 0; step < 7; step++) { t.mock.timers.tick(5000); await settled(); }
  assert.equal(snapshots, 1, "45 seconds of ticks do not overlap a worker snapshot request");
  assert.equal(reads, 4, "a pending mailbox request is also single-flight across subsequent ticks");
  old.doc.hidden = true; old.doc.dispatchEvent(new Event("visibilitychange"));
  assert.equal(workerSignal!.aborted, true);
  assert.equal(slowSignal!.aborted, true);
  t.mock.timers.tick(30_000); await settled();
  assert.equal(snapshots, 1); assert.equal(reads, 4);
  old.controller.dispose();

  const current = fixture(t, "task-b");
  await current.controller.pollOnce();
  slowMailbox.resolve(page("task-a", 99));
  worker.resolve({ ...old.snapshot, rev: old.snapshot.rev + 1, lastActivityAt: Date.now() });
  await pending; await settled();
  assert.deepEqual(current.state.messages.messages.map(row => row.id), ["task-b-message-1"]);
  assert.deepEqual(old.state.messages.messages.map(row => row.sequence), [1, 2]);
  assert.equal(old.state.lastConfirmedAt, confirmation);
  assert.equal(old.state.snapshot!.lastActivityAt, activity);
});

test("the existing timer keeps an open mailbox fresh after three initial snapshot failures, while snapshot authority stays unconfirmed", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now });
  let snapshots = 0, messages = 0;
  const f = fixture(t, "task-a", {
    async snapshot() { snapshots++; throw new Error("WORKER_OFFLINE"); },
    async taskMessages() { messages++; return page("task-a", messages); },
  });
  f.state.messages.draft = "断线时继续保留草稿";
  const confirmation = f.state.lastConfirmedAt, activity = f.state.snapshot!.lastActivityAt;
  f.controller.start(); await f.controller.pollOnce();
  for (let step = 0; step < 3; step++) { t.mock.timers.tick(5000); await f.controller.pollOnce(); }
  assert.equal(snapshots, 3);
  assert.equal(messages, 4, "the message refresh also runs during snapshot backoff");
  assert.equal(f.state.connection, "unconfirmed");
  assert.equal(f.state.snapshot!.capabilities.continue, false);
  assert.equal(f.state.snapshot!.capabilities.revert, false);
  assert.equal(f.state.taskBinding, null);
  const previous = messages;
  t.mock.timers.tick(5000); await settled();
  assert.equal(messages, previous + 1, "the timer remains scheduled for the visible mailbox after the snapshot budget is exhausted");
  assert.equal(snapshots, 3);
  assert.equal(f.state.messages.messages[0].sequence, messages);
  assert.equal(f.state.lastConfirmedAt, confirmation);
  assert.equal(f.state.snapshot!.lastActivityAt, activity);
  assert.equal(f.state.messages.draft, "断线时继续保留草稿");

  f.state.collapsed = true; f.doc.dispatchEvent(new Event("quaymesh:card-expanded"));
  t.mock.timers.tick(60_000); await settled();
  assert.equal(messages, previous + 1);
  f.state.collapsed = false; f.doc.dispatchEvent(new Event("quaymesh:card-expanded"));
  await f.controller.pollOnce();
  assert.equal(messages, previous + 2);
  f.state.tab = "commands"; await f.controller.handleIntent({ type: "tab_changed" });
  t.mock.timers.tick(60_000); await settled();
  assert.equal(messages, previous + 2);
  f.state.tab = "messages"; await f.controller.handleIntent({ type: "tab_changed" });
  const reopened = messages;
  t.mock.timers.tick(10_000); await settled();
  assert.equal(messages, reopened + 1, "reopening the tab reuses the same timer even when snapshot retries stopped");
  f.doc.hidden = true; f.doc.dispatchEvent(new Event("visibilitychange"));
  t.mock.timers.tick(60_000); await f.controller.pollOnce();
  assert.equal(messages, reopened + 1);
  assert.equal(snapshots, 3, "visibility changes never reset the failed first-handshake budget");
});

test("failed mailbox reads retain the last page and draft; later polls keep the explicitly selected history page", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now });
  const cursors: Array<number | undefined> = [];
  let fail = false;
  const f = fixture(t, "task-a", {
    async snapshot() { throw new Error("WORKER_OFFLINE"); },
    async taskMessages(before) { cursors.push(before); if (fail) throw new Error("COORDINATOR_TEMPORARILY_UNAVAILABLE");
      return { ...page("task-a", before === undefined ? 20 : 3), next_before_sequence: before === undefined ? 10 : null }; },
  });
  await f.controller.pollOnce();
  await f.controller.handleIntent({ type: "task_messages", beforeSequence: 10 });
  f.state.messages.draft = "历史页的草稿";
  const history = f.state.messages.messages;
  fail = true; t.mock.timers.tick(5000); await f.controller.pollOnce();
  assert.equal(f.state.messages.messages, history);
  assert.match(f.state.messages.loadError!, /COORDINATOR_TEMPORARILY_UNAVAILABLE/);
  assert.equal(f.state.messages.beforeSequence, 10);
  assert.equal(f.state.messages.draft, "历史页的草稿");
  fail = false; t.mock.timers.tick(5000); await f.controller.pollOnce();
  assert.deepEqual(cursors, [undefined, 10, 10, 10]);
  assert.equal(f.state.messages.messages[0].sequence, 3);
  assert.equal(f.state.messages.loadError, null);
  assert.notEqual(f.state.connection, "live");
});

test("background ticks reuse a pending explicit history read instead of navigating back to the latest page", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now });
  const older = deferred<TaskMessagePage>(), cursors: Array<number | undefined> = [];
  let historySignal: AbortSignal | undefined, firstHistory = true;
  const f = fixture(t, "task-a", {
    async taskMessages(before, signal) {
      cursors.push(before);
      if (before === 10 && firstHistory) { firstHistory = false; historySignal = signal; return older.promise; }
      return { ...page("task-a", before === undefined ? 20 : 3), next_before_sequence: before === undefined ? 10 : null };
    },
  });
  f.controller.start(); await f.controller.pollOnce();
  const navigation = f.controller.handleIntent({ type: "task_messages", beforeSequence: 10 });
  for (let step = 0; step < 2; step++) { t.mock.timers.tick(5000); await settled(); }
  assert.deepEqual(cursors, [undefined, 10]);
  assert.equal(historySignal!.aborted, false);
  older.resolve(page("task-a", 3)); await navigation;
  assert.equal(f.state.messages.beforeSequence, 10);
  assert.equal(f.state.messages.messages[0].sequence, 3);
  t.mock.timers.tick(5000); await settled();
  assert.deepEqual(cursors, [undefined, 10, 10]);
});

test("a disposed Task's late page cannot overwrite a newly mounted Task, and a wrong-Task page is rejected", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now });
  const late = deferred<TaskMessagePage>();
  let oldSignal: AbortSignal | undefined;
  const old = fixture(t, "task-a", {
    async snapshot() { throw new Error("WORKER_OFFLINE"); },
    taskMessages: (_before, signal) => { oldSignal = signal; return late.promise; },
  });
  const oldPoll = old.controller.pollOnce();
  await settled();
  old.controller.dispose();
  assert.equal(oldSignal!.aborted, true);
  let wrongTask = false;
  const current = fixture(t, "task-b", { async taskMessages() { return page(wrongTask ? "task-a" : "task-b"); } });
  current.state.messages.draft = "属于 task-b 的草稿";
  await current.controller.pollOnce();
  late.resolve(page("task-a", 99)); await oldPoll;
  assert.equal(old.state.messages.loaded, false);
  assert.deepEqual(current.state.messages.messages.map(row => row.id), ["task-b-message-1"]);
  wrongTask = true; await current.controller.pollOnce();
  assert.match(current.state.messages.loadError!, /TASK_MESSAGES_IDENTITY_MISMATCH/);
  assert.deepEqual(current.state.messages.messages.map(row => row.id), ["task-b-message-1"]);
  assert.equal(current.state.messages.draft, "属于 task-b 的草稿");
});

test("explicit entry inspection cancels both reads and its late mailbox reply cannot confirm the entry", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now });
  const worker = deferred<Snapshot | null>(), mailbox = deferred<TaskMessagePage>(), inspection = deferred<TaskBindingView>();
  let workerSignal: AbortSignal | undefined, mailboxSignal: AbortSignal | undefined, reads = 0;
  const selected: TaskBindingView = { task_id: "task-a", entry_available: true, binding_revision: 5,
    selected_task_id: "task-a", status: "selected", can_resume: true, can_continue: true };
  let authoritative: TaskBindingState | null = null;
  const f = fixture(t, "task-a", {
    snapshot: (_revision, signal) => { workerSignal = signal; return worker.promise; },
    taskMessages: (_before, signal) => { reads++; mailboxSignal = signal; return mailbox.promise; },
    get taskBinding() { return authoritative; },
    async inspectTaskBinding() { const value = await inspection.promise; authoritative = value; return value; },
    async resumeTask() { throw new Error("UNEXPECTED_RESUME"); },
  });
  const polling = f.controller.pollOnce(); await settled();
  const inspecting = f.controller.handleIntent({ type: "inspect_task_binding" });
  assert.equal(workerSignal!.aborted, true);
  assert.equal(mailboxSignal!.aborted, true);
  await f.controller.handleIntent({ type: "task_messages" });
  await f.controller.pollOnce();
  assert.equal(reads, 1);
  mailbox.resolve(page("task-a")); worker.reject(new Error("WORKER_CANCELLED")); await polling;
  assert.equal(f.state.messages.loaded, false);
  assert.equal(f.state.taskBinding, null);
  inspection.resolve(selected); await inspecting;
  assert.deepEqual(f.state.taskBinding, selected);
});

test("a confirmed closed Task does not gain a mailbox polling loop", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now });
  let messages = 0;
  const f = fixture(t, "task-a", { async taskMessages() { messages++; return page("task-a"); } });
  f.snapshot.taskState = "closed"; f.snapshot.taskResult = "completed"; f.snapshot.status = "done";
  f.snapshot.capabilities = { ...f.snapshot.capabilities, refresh: false };
  f.controller.start(); await f.controller.pollOnce();
  assert.equal(messages, 1);
  t.mock.timers.tick(120_000); await settled();
  assert.equal(messages, 1);
  assert.equal(f.state.connection, "live");
});
