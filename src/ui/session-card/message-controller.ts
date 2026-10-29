import { messageDraftError, taskMessageFinishing } from "./message-state.js";
import type { SessionCardSource } from "./source.js";
import type { CardState } from "./state.js";
import type { PendingMessageState } from "./pending-message-state.js";

export function createTaskMessagesController(
  state: CardState,
  source: SessionCardSource,
  visible: () => boolean,
  render: () => void,
  pendingState?: PendingMessageState,
) {
  const messages = state.messages;
  messages.available = source.live && Boolean(source.taskMessages && source.enqueueTaskMessage);
  messages.supportsHostMessage = source.supportsHostMessage === true;
  let disposed = false, generation = 0;
  let read: { controller: AbortController; promise: Promise<void>; before: number | null } | null = null;
  let sending: Promise<void> | null = null;
  let sendController: AbortController | null = null;
  let recoveredTask: string | null = null;
  const panelVisible = () => !disposed && visible() && !state.collapsed && state.tab === "messages";
  const canRefresh = () => messages.available && panelVisible();

  function restorePending(renderChange = true): "none" | "restored" | "draft_conflict" {
    const taskId = state.snapshot?.taskId;
    if (disposed || !messages.available || !taskId || recoveredTask === taskId) return "none";
    if (messages.pending) { recoveredTask = taskId; return "none"; }
    const saved = pendingState?.load(taskId);
    // The optional host snapshot may arrive after the card. A null read does not complete recovery.
    if (!saved || saved.taskId !== taskId) return "none";
    const draftConflict = Boolean(messages.draft && messages.draft !== saved.body);
    recoveredTask = taskId;
    messages.pending = { key: saved.key, body: saved.body };
    if (!draftConflict) messages.draft = saved.body;
    messages.sendError = draftConflict
      ? "已找到上次待确认的原消息；当前草稿未发送。请核对下方原文，再明确重试上次消息。"
      : "已恢复上次发送的原文；保存回执仍未确认，请明确重试。";
    if (renderChange) render();
    return draftConflict ? "draft_conflict" : "restored";
  }
  // The parent controller performs its first render after all controllers are initialized.
  restorePending(false);

  function cancelRead(): void {
    generation++;
    read?.controller.abort("TASK_MESSAGES_NOT_VISIBLE");
    read = null;
    messages.loading = false;
  }

  function refresh(before = messages.beforeSequence, signal?: AbortSignal): Promise<void> {
    restorePending();
    if (!canRefresh() || signal?.aborted) return Promise.resolve();
    if (read?.before === before) return read.promise;
    cancelRead();
    const current = generation;
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    messages.loading = true;
    messages.loadError = null;
    render();
    const promise = (async () => {
      try {
        const page = await source.taskMessages!(before ?? undefined, controller.signal);
        if (disposed || controller.signal.aborted || current !== generation) return;
        if (page.task_id !== state.snapshot?.taskId) throw new Error("TASK_MESSAGES_IDENTITY_MISMATCH");
        // A page is bounded by the server; replace it instead of retaining an unbounded thread cache.
        messages.messages = page.messages;
        messages.beforeSequence = before;
        messages.nextBeforeSequence = page.next_before_sequence;
        messages.mailbox = page.mailbox;
        messages.loaded = true;
      } catch (error) {
        if (!disposed && !controller.signal.aborted && current === generation) messages.loadError = errorText(error);
      } finally {
        signal?.removeEventListener("abort", abort);
        if (!disposed && current === generation) {
          read = null;
          messages.loading = false;
          render();
        }
      }
    })();
    read = { controller, promise, before };
    return promise;
  }

  function send(): Promise<void> {
    if (sending) return sending;
    if (disposed || !messages.available) return Promise.resolve();
    if (restorePending() === "draft_conflict") {
      // This click targeted the visible draft. Show the recovered original before offering its retry.
      return Promise.resolve();
    }
    // Retrying a lost receipt is also allowed after closure; the server decides whether this key was saved.
    if (!messages.pending) {
      if (state.snapshot?.taskState === "closed" || taskMessageFinishing(state.snapshot)) return Promise.resolve();
      const error = messageDraftError(messages.draft);
      if (error) { messages.sendError = error; render(); return Promise.resolve(); }
      messages.pending = { key: crypto.randomUUID(), body: messages.draft };
    }
    const submission = messages.pending;
    const taskId = state.snapshot?.taskId;
    const recovery = taskId ? { taskId, key: submission.key, body: submission.body } : null;
    if (recovery) {
      recoveredTask = recovery.taskId;
      pendingState?.save(recovery);
    }
    const controller = new AbortController();
    sendController = controller;
    messages.sending = true;
    messages.sendError = null;
    messages.sendNotice = null;
    render();
    sending = (async () => {
      try {
        const receipt = await source.enqueueTaskMessage!(submission.key, submission.body, controller.signal);
        if (disposed) return;
        if (receipt.task_id !== state.snapshot?.taskId || taskId && receipt.task_id !== taskId
          || receipt.message.role !== "user" || receipt.message.body !== submission.body) {
          throw new Error("TASK_MESSAGE_RECEIPT_MISMATCH");
        }
        cancelRead();
        if (recovery) {
          recoveredTask = recovery.taskId;
          pendingState?.clear(recovery);
        }
        messages.pending = null;
        if (messages.draft === submission.body) messages.draft = "";
        messages.sendNotice = messages.draft ? "上次消息已保存。当前草稿尚未发送。" : "消息已保存。";
        messages.beforeSequence = null;
        messages.mailbox = receipt.mailbox;
        // Show the saved receipt even if refreshing the history fails afterwards.
        messages.messages = [receipt.message];
        messages.nextBeforeSequence = receipt.message.sequence;
        messages.loaded = true;
        void refresh(null);
      } catch (error) {
        if (!disposed) messages.sendError = errorText(error);
      } finally {
        sending = null;
        sendController = null;
        if (!disposed) { messages.sending = false; render(); }
      }
    })();
    return sending;
  }

  return {
    canRefresh,
    restorePending,
    // A background tick must not supersede an explicit history page still being read.
    poll() { return read?.promise ?? refresh(); },
    refresh,
    send,
    visibilityChanged() { if (!panelVisible()) cancelRead(); },
    dispose() { disposed = true; cancelRead(); sendController?.abort("TASK_MESSAGES_DISPOSED"); },
  };
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
