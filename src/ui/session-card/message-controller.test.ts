import assert from "node:assert/strict";
import test from "node:test";
import type { TaskMessagePage, TaskMessageReceipt, TaskMessageView } from "../../messaging/task-message-types.js";
import { createCardController } from "./controller.js";
import { createTaskMessagesController } from "./message-controller.js";
import { createPreviewSource, previewSnapshot } from "./preview.js";
import { applySnapshot, createCardState } from "./state.js";
import type { SessionCardSource } from "./source.js";

const message: TaskMessageView = {
  id: "message-1", sequence: 1, role: "user", reply_to: [], body: "先检查日志，再修改。",
  created_at: "2026-10-28T06:00:00.000Z", offered_at: null, acknowledged_at: null, status: "queued",
};
const taskId = previewSnapshot.taskId!;
function page(messages = [message]): TaskMessagePage {
  return { task_id: taskId, messages, next_before_sequence: null, mailbox: { sequence: 1, pending: 1 } };
}
function receipt(replayed = false): TaskMessageReceipt {
  return { task_id: taskId, message, replayed, mailbox: { sequence: 1, pending: 1 } };
}
function cardState() {
  const state = createCardState();
  applySnapshot(state, { ...previewSnapshot, taskState: "active", finalization: null });
  state.collapsed = false;
  state.tab = "messages";
  return state;
}

test("a lost saved receipt preserves the draft and key; a retry after closure reuses the original submission", async () => {
  const state = cardState();
  state.messages.draft = message.body;
  const stored = new Map<string, string>(), keys: string[] = [];
  let calls = 0, followups = 0;
  const source: SessionCardSource = { ...createPreviewSource(), live: true,
    taskMessages: async () => page(),
    enqueueTaskMessage: async (key, body) => {
      calls++; keys.push(key);
      if (!stored.has(key)) stored.set(key, body);
      await Promise.resolve();
      if (calls === 1) throw new Error("REQUEST_TIMEOUT after durable save");
      return receipt(true);
    },
    continueSession: async () => { followups++; },
  };
  const messages = createTaskMessagesController(state, source, () => true, () => {});
  const sending = messages.send();
  assert.equal(messages.send(), sending);
  assert.equal(state.messages.draft, message.body);
  assert.equal(state.messages.sending, true);
  await sending;
  assert.match(state.messages.sendError!, /REQUEST_TIMEOUT/);
  assert.equal(state.messages.draft, message.body);
  const key = state.messages.pending!.key;
  applySnapshot(state, { ...state.snapshot!, rev: state.snapshot!.rev + 1, taskState: "closed", taskResult: "completed" });
  assert.equal(state.messages.pending!.key, key);
  await messages.send();
  assert.deepEqual(keys, [key, key]);
  assert.equal(stored.size, 1);
  assert.equal(state.messages.pending, null);
  assert.equal(state.messages.draft, "");
  assert.equal(state.messages.messages[0].status, "queued");
  assert.equal(followups, 0);
  messages.dispose();
});

test("mailbox refresh observes acknowledgement without requiring a new sequence or inventing task activity", async () => {
  const state = cardState();
  state.messages.draft = "尚未提交的草稿";
  const original = state.snapshot, confirmed = state.lastConfirmedAt;
  let response = page();
  const source = { ...createPreviewSource(), live: true, taskMessages: async () => response, enqueueTaskMessage: async () => receipt() };
  const messages = createTaskMessagesController(state, source, () => true, () => {});
  await messages.refresh();
  response = page([{ ...message, status: "acknowledged", offered_at: message.created_at, acknowledged_at: message.created_at }]);
  await messages.refresh();
  assert.equal(state.messages.messages[0].status, "acknowledged");
  assert.equal(state.messages.mailbox!.sequence, 1);
  assert.equal(state.snapshot, original);
  assert.equal(state.lastConfirmedAt, confirmed);
  assert.equal(state.messages.draft, "尚未提交的草稿");
  messages.dispose();
});

test("mailbox reads stop when the panel hides and late pages cannot overwrite newer navigation", async () => {
  const state = cardState();
  let visible = true, reads = 0;
  const waits: Array<{ resolve(value: TaskMessagePage): void; signal?: AbortSignal }> = [];
  const source = { ...createPreviewSource(), live: true,
    taskMessages: (_before?: number, signal?: AbortSignal) => { reads++; return new Promise<TaskMessagePage>(resolve => waits.push({ resolve, signal })); },
    enqueueTaskMessage: async () => receipt(),
  };
  const messages = createTaskMessagesController(state, source, () => visible, () => {});
  const first = messages.refresh();
  visible = false;
  messages.visibilityChanged();
  assert.equal(waits[0].signal!.aborted, true);
  await messages.refresh();
  assert.equal(reads, 1);
  waits[0].resolve(page());
  await first;
  assert.equal(state.messages.loaded, false);
  visible = true;
  const latest = messages.refresh(null);
  const older = messages.refresh(3);
  assert.equal(waits[1].signal!.aborted, true);
  waits[2].resolve({ ...page(), next_before_sequence: 1 });
  await older;
  waits[1].resolve(page([{ ...message, id: "late", sequence: 5 }]));
  await latest;
  assert.equal(state.messages.beforeSequence, 3);
  assert.deepEqual(state.messages.messages.map(row => row.id), ["message-1"]);
  state.tab = "commands";
  messages.visibilityChanged();
  await messages.refresh();
  assert.equal(reads, 3);
  messages.dispose();
});

test("closed and finalizing tasks keep drafts without new writes; mismatched receipts never clear them", async () => {
  const state = cardState();
  state.messages.draft = message.body;
  let writes = 0;
  const source = { ...createPreviewSource(), live: true, taskMessages: async () => page(),
    enqueueTaskMessage: async () => { writes++; return { ...receipt(), task_id: "different-task" }; },
  };
  const messages = createTaskMessagesController(state, source, () => true, () => {});
  state.snapshot = { ...state.snapshot!, taskState: "closed" };
  await messages.send();
  assert.equal(writes, 0);
  state.snapshot = { ...state.snapshot!, taskState: "active", finalization: { state: "pending" } as typeof previewSnapshot.finalization };
  await messages.send();
  assert.equal(writes, 0);
  state.snapshot = { ...state.snapshot!, finalization: null };
  await messages.send();
  assert.equal(writes, 1);
  assert.equal(state.messages.draft, message.body);
  assert.ok(state.messages.pending);
  assert.match(state.messages.sendError!, /RECEIPT_MISMATCH/);
  messages.dispose();
});

test("the card uses its existing refresh cadence, with no message polling after closure or while hidden", async (t) => {
  const now = Date.parse("2026-10-28T06:00:00Z");
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now });
  const state = cardState();
  const doc = new class extends EventTarget { hidden = false; defaultView = null; getElementById() { return null; } }();
  let reads = 0;
  const snapshot = { ...state.snapshot!, taskState: "closed" as const, taskResult: "completed" as const,
    rev: state.snapshot!.rev + 1,
    status: "done" as const, commands: [], agents: [], runningCommand: null, currentCommand: null, lastCommand: null,
    capabilities: { ...previewSnapshot.capabilities, refresh: false },
    executionObservation: { observedAt: now, activeOperationIds: [], preparingOperationIds: [], staleOperationIds: [] } };
  const source = { ...createPreviewSource(), live: true, snapshot: async () => snapshot,
    taskMessages: async () => { reads++; return page(); }, enqueueTaskMessage: async () => receipt(),
  };
  const view = { render() {}, renderPanel() {}, renderFooter() {}, fillTimers() {}, dispose() {} };
  const controller = createCardController(state, view, source, doc as unknown as Document);
  t.after(() => controller.dispose());
  controller.start();
  await controller.pollOnce();
  assert.equal(reads, 1);
  t.mock.timers.tick(60_000);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(reads, 1);
  doc.hidden = true;
  doc.dispatchEvent(new Event("visibilitychange"));
  await controller.handleIntent({ type: "task_messages" });
  t.mock.timers.tick(60_000);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(reads, 1);
  doc.hidden = false;
  doc.dispatchEvent(new Event("visibilitychange"));
  await controller.pollOnce();
  assert.equal(reads, 2);
  state.tab = "commands";
  await controller.handleIntent({ type: "tab_changed" });
  await controller.pollOnce();
  assert.equal(reads, 2);
  controller.dispose();
});
