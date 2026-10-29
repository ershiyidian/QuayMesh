import assert from "node:assert/strict";
import test from "node:test";
import type { TaskMessageReceipt } from "../../messaging/task-message-types.js";
import { createCardController } from "./controller.js";
import { createTaskMessagesController } from "./message-controller.js";
import { createPendingMessageState, PENDING_MESSAGE_NAMESPACE } from "./pending-message-state.js";
import { createPreviewSource, previewSnapshot } from "./preview.js";
import { applySnapshot, createCardState } from "./state.js";

const taskId = "recover-task", body = "请先审查日志，再决定修改。";
function state(id = taskId) {
  const value = createCardState();
  applySnapshot(value, { ...previewSnapshot, taskId: id, taskState: "active", finalization: null });
  value.collapsed = false; value.tab = "messages";
  return value;
}
function receipt(text = body): TaskMessageReceipt {
  return { task_id: taskId, replayed: true, mailbox: { sequence: 1, pending: 1 }, message: {
    id: "saved-message", sequence: 1, role: "user", reply_to: [], body: text, status: "queued",
    created_at: "2026-10-28T06:00:00.000Z", offered_at: null, acknowledged_at: null,
  } };
}
function host() {
  let widgetState: Record<string, any> = { privateContent: { otherPanel: "preserved" }, modelContent: "unchanged" }, writes = 0;
  return { store: createPendingMessageState(() => ({
    get widgetState() { return widgetState; },
    setWidgetState(next: Record<string, any>) { widgetState = next; writes++; },
  })), snapshot: () => widgetState, writes: () => writes };
}

test("restored state waits for the parent controller's first render and a renderer failure keeps its original diagnostic", t => {
  const h = host(), current = state();
  h.store.save({ taskId, key: "restore-before-parent-start", body });
  let renders = 0;
  const stages: string[] = [];
  const view = {
    render() { this.renderPanel(); },
    renderPanel() { renders++; throw new Error("RESTORED_PANEL_RENDER_FAILED"); },
    renderFooter() {}, fillTimers() {}, dispose() {},
  };
  const doc = new class extends EventTarget { hidden = false; defaultView = null; getElementById() { return null; } }();
  const source = { ...createPreviewSource(), live: true,
    async taskMessages() { throw new Error("UNEXPECTED_READ"); },
    async enqueueTaskMessage() { throw new Error("UNEXPECTED_SEND"); },
    async widgetStage(stage: string) { stages.push(stage); },
  };
  const controller = createCardController(current, view, source, doc as unknown as Document, h.store);
  t.after(() => controller.dispose());
  assert.equal(renders, 0, "constructor recovery must not reenter the still-initializing parent controller");
  assert.deepEqual(current.messages.pending, { key: "restore-before-parent-start", body });
  assert.equal(current.messages.draft, body);
  assert.doesNotThrow(() => controller.start());
  assert.equal(renders, 1);
  assert.equal(current.connection, "error");
  assert.equal(current.message, "RESTORED_PANEL_RENDER_FAILED");
  assert.equal(stages.filter(stage => stage === "error").length, 1);
  assert.equal(h.store.load(taskId)?.key, "restore-before-parent-start");
});

test("an explicitly submitted uncertain message survives remount with the same Task/key/body and never auto-sends", async () => {
  const h = host(), attempts: Array<{ key: string; body: string }> = [];
  let first = true, hostMessages = 0;
  const source = { ...createPreviewSource(), live: true,
    async taskMessages() { return { task_id: taskId, messages: [], next_before_sequence: null, mailbox: { sequence: 1, pending: 1 } }; },
    async enqueueTaskMessage(key: string, text: string) {
      attempts.push({ key, body: text });
      assert.deepEqual(h.snapshot().privateContent[PENDING_MESSAGE_NAMESPACE], { version: 1, taskId, key, body: text },
        "the user-approved retry identity is saved before the network request");
      if (first) { first = false; throw new Error("LOST_SAVED_RECEIPT"); }
      return receipt(text);
    },
    async continueSession() { hostMessages++; },
  };
  const original = state(); original.messages.draft = body;
  const controller = createTaskMessagesController(original, source, () => true, () => {}, h.store);
  assert.equal(h.writes(), 0, "typing or mounting does not persist an unsubmitted draft");
  await controller.send();
  const pending = original.messages.pending!;
  assert.equal(original.messages.draft, body);
  controller.dispose();

  const remounted = state();
  const restored = createTaskMessagesController(remounted, source, () => true, () => {}, h.store);
  assert.deepEqual(remounted.messages.pending, pending);
  assert.equal(remounted.messages.draft, body);
  assert.match(remounted.messages.sendError!, /保存回执仍未确认/);
  assert.equal(attempts.length, 1);
  await restored.refresh();
  assert.equal(attempts.length, 1, "polling after restoration is not consent to resend");
  await restored.send();
  assert.deepEqual(attempts, [{ key: pending.key, body }, { key: pending.key, body }]);
  assert.equal(remounted.messages.pending, null);
  assert.equal(remounted.messages.draft, "");
  assert.equal(h.snapshot().privateContent[PENDING_MESSAGE_NAMESPACE], undefined);
  assert.equal(h.snapshot().privateContent.otherPanel, "preserved");
  assert.equal(h.snapshot().modelContent, "unchanged");
  assert.equal(hostMessages, 0);
  restored.dispose();
});

test("a different Task never restores or deletes another Task's pending message; an existing draft is not overwritten", () => {
  const h = host(); h.store.save({ taskId, key: "previous-key", body });
  const source = { ...createPreviewSource(), live: true,
    async taskMessages() { throw new Error("UNEXPECTED_READ"); },
    async enqueueTaskMessage() { throw new Error("UNEXPECTED_SEND"); },
  };
  const other = state("different-task"), writes = h.writes();
  const otherController = createTaskMessagesController(other, source, () => true, () => {}, h.store);
  assert.equal(other.messages.pending, null); assert.equal(other.messages.draft, "");
  otherController.dispose(); assert.equal(h.writes(), writes);
  assert.equal(h.store.load(taskId)?.body, body);

  const edited = state(); edited.messages.draft = "本轮已经输入的另一份草稿";
  const editedController = createTaskMessagesController(edited, source, () => true, () => {}, h.store);
  assert.equal(edited.messages.draft, "本轮已经输入的另一份草稿");
  assert.deepEqual(edited.messages.pending, { key: "previous-key", body });
  assert.match(edited.messages.sendError!, /当前草稿未发送/);
  editedController.dispose();
});

test("a delayed host snapshot can restore the original request on a later refresh without sending", async () => {
  const h = host(), current = state();
  const attempts: Array<{ key: string; body: string }> = [];
  const source = { ...createPreviewSource(), live: true,
    async taskMessages() { return { task_id: taskId, messages: [], next_before_sequence: null, mailbox: { sequence: 1, pending: 1 } }; },
    async enqueueTaskMessage(key: string, text: string) { attempts.push({ key, body: text }); return receipt(text); },
  };
  const controller = createTaskMessagesController(current, source, () => true, () => {}, h.store);
  await controller.refresh();
  assert.equal(current.messages.pending, null);
  h.store.save({ taskId, key: "late-host-key", body });
  await controller.refresh();
  assert.deepEqual(current.messages.pending, { key: "late-host-key", body });
  assert.equal(current.messages.draft, body);
  assert.equal(attempts.length, 0);
  await controller.send();
  assert.deepEqual(attempts, [{ key: "late-host-key", body }]);
  controller.dispose();
});

test("send checks a late same-body pending request before creating a new key", async () => {
  const h = host(), current = state(), attempts: Array<{ key: string; body: string }> = [];
  const source = { ...createPreviewSource(), live: true,
    async taskMessages() { return { task_id: taskId, messages: [], next_before_sequence: null, mailbox: { sequence: 1, pending: 1 } }; },
    async enqueueTaskMessage(key: string, text: string) { attempts.push({ key, body: text }); return receipt(text); },
  };
  const controller = createTaskMessagesController(current, source, () => true, () => {}, h.store);
  current.messages.draft = body;
  h.store.save({ taskId, key: "same-text-original-key", body });
  await controller.send();
  assert.deepEqual(attempts, [{ key: "same-text-original-key", body }]);
  controller.dispose();
});

test("a restored original is rendered immediately even while an existing history read is pending", async () => {
  const h = host(), current = state();
  let release!: () => void, renders = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  const source = { ...createPreviewSource(), live: true,
    async taskMessages() {
      await held;
      return { task_id: taskId, messages: [], next_before_sequence: null, mailbox: { sequence: 1, pending: 1 } };
    },
    async enqueueTaskMessage() { throw new Error("UNEXPECTED_SEND"); },
  };
  const controller = createTaskMessagesController(current, source, () => true, () => { renders++; }, h.store);
  const reading = controller.refresh();
  current.messages.draft = "还在编辑的不同草稿";
  h.store.save({ taskId, key: "late-during-read", body });
  const before = renders;
  assert.equal(controller.refresh(), reading);
  assert.equal(renders, before + 1, "pending identity and its visible original are updated together");
  assert.equal(current.messages.pending?.body, body);
  assert.equal(current.messages.draft, "还在编辑的不同草稿");
  release(); await reading;
  controller.dispose();
});

test("discovering a different pending body during send preserves the draft and waits for an explicit original-message retry", async () => {
  const h = host(), current = state(), attempts: Array<{ key: string; body: string }> = [];
  const source = { ...createPreviewSource(), live: true,
    async taskMessages() { return { task_id: taskId, messages: [], next_before_sequence: null, mailbox: { sequence: 1, pending: 1 } }; },
    async enqueueTaskMessage(key: string, text: string) { attempts.push({ key, body: text }); return receipt(text); },
  };
  let renders = 0;
  const controller = createTaskMessagesController(current, source, () => true, () => { renders++; }, h.store);
  const draft = "这是刚编辑的草稿，尚未提交。";
  current.messages.draft = draft;
  h.store.save({ taskId, key: "original-request-key", body });
  const writes = h.writes();
  await controller.send();
  assert.equal(attempts.length, 0, "a click on Send draft is not permission to send a newly discovered different body");
  assert.equal(h.writes(), writes);
  assert.deepEqual(current.messages.pending, { key: "original-request-key", body });
  assert.equal(current.messages.draft, draft);
  assert.equal(current.messages.sending, false);
  assert.match(current.messages.sendError!, /核对下方原文/);
  assert.equal(renders, 1);
  await controller.send();
  assert.deepEqual(attempts, [{ key: "original-request-key", body }]);
  assert.equal(current.messages.draft, draft);
  assert.equal(current.messages.pending, null);
  assert.equal(current.messages.sendNotice, "上次消息已保存。当前草稿尚未发送。");
  assert.equal(h.store.load(taskId), null);
  controller.dispose();
});

test("a locally confirmed submission is not restored when a delayed host echo appears after a skipped clear", async () => {
  let visible: Record<string, any> = {}, durable: Record<string, any> = {}, writes = 0;
  const store = createPendingMessageState(() => ({
    get widgetState() { return visible; },
    setWidgetState(next: Record<string, any>) { durable = next; writes++; },
  }));
  const current = state(); current.messages.draft = body;
  let attempts = 0;
  const source = { ...createPreviewSource(), live: true,
    async taskMessages() { return { task_id: taskId, messages: [], next_before_sequence: null, mailbox: { sequence: 1, pending: 1 } }; },
    async enqueueTaskMessage() { attempts++; return receipt(); },
  };
  const controller = createTaskMessagesController(current, source, () => true, () => {}, store);
  await controller.send();
  assert.equal(attempts, 1);
  assert.equal(writes, 1, "the invisible cache is not cleared with a blind host write");
  assert.equal(current.messages.pending, null);
  assert.equal(current.messages.draft, "");
  visible = durable;
  assert.ok(store.load(taskId), "the host may still echo the old cache");
  await controller.refresh();
  assert.equal(current.messages.pending, null);
  assert.equal(current.messages.draft, "");
  assert.equal(current.messages.sendNotice, "消息已保存。");
  assert.equal(attempts, 1);
  controller.dispose();
});

test("a foreign Task pending record stays intact while this Task uses in-memory retry", async () => {
  const h = host(), foreign = { taskId: "another-task", key: "foreign-key", body: "另一个任务的原消息" };
  h.store.save(foreign);
  const current = state(); current.messages.draft = body;
  const attempts: string[] = [];
  const source = { ...createPreviewSource(), live: true,
    async taskMessages() { return { task_id: taskId, messages: [], next_before_sequence: null, mailbox: { sequence: 1, pending: 1 } }; },
    async enqueueTaskMessage(key: string) {
      attempts.push(key);
      if (attempts.length === 1) throw new Error("RECEIPT_LOST");
      return receipt();
    },
  };
  const controller = createTaskMessagesController(current, source, () => true, () => {}, h.store);
  const writes = h.writes();
  await controller.send();
  assert.ok(current.messages.pending);
  assert.deepEqual(h.store.load(foreign.taskId), foreign);
  await controller.send();
  assert.equal(attempts.length, 2);
  assert.equal(attempts[1], attempts[0]);
  assert.equal(current.messages.pending, null);
  assert.deepEqual(h.store.load(foreign.taskId), foreign);
  assert.equal(h.writes(), writes);
  controller.dispose();
});

test("a disposed sender's late receipt cannot clear a newer pending record", async () => {
  const h = host(), current = state(); current.messages.draft = body;
  let complete!: (value: TaskMessageReceipt) => void;
  const source = { ...createPreviewSource(), live: true,
    async taskMessages() { throw new Error("UNEXPECTED_READ"); },
    enqueueTaskMessage() { return new Promise<TaskMessageReceipt>(resolve => { complete = resolve; }); },
  };
  const controller = createTaskMessagesController(current, source, () => true, () => {}, h.store);
  const sending = controller.send();
  controller.dispose();
  const newer = { taskId, key: "newer-confirmation-key", body: "另一条已经明确提交的消息" };
  h.store.save(newer);
  const writes = h.writes();
  complete(receipt()); await sending;
  assert.deepEqual(h.store.load(taskId), newer);
  assert.equal(h.writes(), writes);
});

test("late success after teardown leaves recovery pending; a closed Task may explicitly replay the saved intent", async () => {
  const h = host();
  let complete!: (value: TaskMessageReceipt) => void, signal: AbortSignal | undefined;
  const source = { ...createPreviewSource(), live: true,
    async taskMessages() { return { task_id: taskId, messages: [], next_before_sequence: null, mailbox: { sequence: 1, pending: 1 } }; },
    enqueueTaskMessage(_key: string, _body: string, inputSignal?: AbortSignal) {
      signal = inputSignal; return new Promise<TaskMessageReceipt>(resolve => { complete = resolve; });
    },
  };
  const original = state(); original.messages.draft = body;
  const controller = createTaskMessagesController(original, source, () => true, () => {}, h.store);
  const sending = controller.send(), key = original.messages.pending!.key;
  controller.dispose(); assert.equal(signal!.aborted, true);
  complete(receipt()); await sending;
  assert.equal(h.store.load(taskId)?.key, key);

  const closed = state(); closed.snapshot = { ...closed.snapshot!, taskState: "closed", taskResult: "completed" };
  const restored = createTaskMessagesController(closed, { ...source, async enqueueTaskMessage(inputKey: string, inputBody: string) {
    assert.equal(inputKey, key); assert.equal(inputBody, body); return receipt();
  } }, () => true, () => {}, h.store);
  assert.equal(closed.messages.pending?.key, key);
  await restored.send();
  assert.equal(h.store.load(taskId), null);
  assert.equal(closed.messages.pending, null);
  restored.dispose();
});

test("host storage failure does not block normal sending or clear a draft before a server receipt", async () => {
  const store = createPendingMessageState(() => ({ widgetState: {}, setWidgetState() { throw new Error("HOST_REJECTED_STATE"); } }));
  const current = state(); current.messages.draft = body;
  let attempts = 0;
  const source = { ...createPreviewSource(), live: true,
    async taskMessages() { return { task_id: taskId, messages: [], next_before_sequence: null, mailbox: { sequence: 1, pending: 1 } }; },
    async enqueueTaskMessage() { attempts++; if (attempts === 1) throw new Error("NETWORK_UNCONFIRMED"); return receipt(); },
  };
  const controller = createTaskMessagesController(current, source, () => true, () => {}, store);
  await controller.send();
  const key = current.messages.pending!.key;
  assert.equal(current.messages.draft, body);
  assert.match(current.messages.sendError!, /NETWORK_UNCONFIRMED/);
  await controller.send();
  assert.equal(attempts, 2);
  assert.ok(key); assert.equal(current.messages.pending, null); assert.equal(current.messages.draft, "");
  controller.dispose();
});

test("recovery waits for the explicit Task snapshot and a mismatched receipt does not clear the cached intent", async () => {
  const h = host(); h.store.save({ taskId, key: "recover-after-bootstrap", body });
  const current = createCardState(); current.collapsed = false; current.tab = "messages";
  const source = { ...createPreviewSource(), live: true,
    async taskMessages() { return { task_id: taskId, messages: [], next_before_sequence: null, mailbox: { sequence: 1, pending: 1 } }; },
    async enqueueTaskMessage() { return { ...receipt(), task_id: "different-task" }; },
  };
  const controller = createTaskMessagesController(current, source, () => true, () => {}, h.store);
  assert.equal(current.messages.pending, null);
  applySnapshot(current, { ...previewSnapshot, taskId, taskState: "active", finalization: null });
  controller.restorePending();
  assert.deepEqual(current.messages.pending, { key: "recover-after-bootstrap", body });
  await controller.send();
  assert.match(current.messages.sendError!, /TASK_MESSAGE_RECEIPT_MISMATCH/);
  assert.equal(h.store.load(taskId)?.key, "recover-after-bootstrap");
  assert.equal(current.messages.draft, body);
  controller.dispose();
});
