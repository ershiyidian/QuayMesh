import { messageDraftError, messageStatusDetail, messageStatusText, taskMessageFinishing } from "./message-state.js";
import type { CardState } from "./state.js";
import { hasBackground } from "./timing.js";
import { canContinueTask, canResumeTask, taskBindingLabel } from "./task-binding.js";
import { fullTime } from "../console-v5/format.js";

const markup = `
  <p class="message-help">消息保存在当前任务中。GPT 继续调用 QuayMesh 后可领取消息并在这里回复；暂停时可点“让 GPT 继续”。</p>
  <section class="task-binding" aria-label="任务关联" hidden>
    <p id="task-binding-state" class="message-help" role="status"></p>
    <div class="task-binding-actions">
      <button type="button" class="ib" data-act="binding-resume" id="task-binding-resume" hidden>恢复此任务</button>
      <button type="button" class="ib" data-act="binding-inspect" id="task-binding-inspect">检查当前关联</button>
      <button type="button" class="ib" data-act="binding-host" id="task-binding-host" hidden>请 GPT 恢复此任务</button>
    </div>
    <p id="task-binding-notice" class="message-help" role="status"></p>
  </section>
  <div class="message-toolbar">
    <button type="button" class="ib" data-act="messages-refresh">刷新对话</button>
    <button type="button" class="ib" data-act="messages-older" hidden>更早消息</button>
    <button type="button" class="ib" data-act="messages-latest" hidden>最新消息</button>
    <span id="task-message-history-state" role="status"></span>
  </div>
  <ol id="task-message-list" class="message-list" aria-label="任务对话历史"></ol>
  <form id="task-message-form" class="message-form">
    <label for="task-message-draft">给 GPT 的消息</label>
    <textarea id="task-message-draft" rows="3" placeholder="补充要求、纠正方向或询问进展…" aria-describedby="task-message-send-state"></textarea>
    <section id="task-message-pending-original" class="task-message-pending" aria-label="上次待确认的原消息" hidden>
      <strong>上次待确认的原消息</strong>
      <p id="task-message-pending-body" class="task-message-pending-body"></p>
      <p class="message-help">重试只会提交这段原文；上方草稿会保留，尚未发送。</p>
    </section>
    <div class="message-compose-actions">
      <span id="task-message-size"></span>
      <button type="button" class="ib" data-act="continue-session" id="task-message-continue">让 GPT 继续</button>
      <button type="submit" class="ib message-send" id="task-message-send">发送消息</button>
    </div>
    <p id="task-message-send-state" class="message-help" role="status"></p>
  </form>`;

/** Only the history rows are replaced. The input and its selection survive every snapshot refresh. */
export function renderTaskMessagePanel(panel: HTMLElement, state: CardState): void {
  if (!panel.querySelector("#task-message-form")) panel.innerHTML = markup;
  const messages = state.messages;
  const closed = state.snapshot?.taskState === "closed";
  const finishing = taskMessageFinishing(state.snapshot);
  renderTaskBinding(panel, state);
  const draft = element<HTMLTextAreaElement>(panel, "#task-message-draft");
  if (draft.value !== messages.draft) draft.value = messages.draft;
  draft.readOnly = Boolean(messages.pending);
  draft.disabled = !messages.available || ((closed || finishing) && !messages.pending);
  const draftDiffers = Boolean(messages.pending && messages.draft !== messages.pending.body);
  element<HTMLElement>(panel, "#task-message-pending-original").hidden = !draftDiffers;
  element<HTMLElement>(panel, "#task-message-pending-body").textContent = draftDiffers ? messages.pending!.body : "";

  const send = element<HTMLButtonElement>(panel, "#task-message-send");
  const validation = messages.draft ? messageDraftError(messages.draft) : null;
  send.disabled = !messages.available || messages.sending || (!messages.pending && (closed || finishing || Boolean(messageDraftError(messages.draft))));
  send.textContent = messages.sending ? "正在保存…" : draftDiffers ? "重试上次消息" : messages.pending ? "重试保存" : "发送消息";
  element<HTMLElement>(panel, "#task-message-size").textContent = validation ?? "每条最多 16 KiB";
  const notice = messages.sending
    ? (draftDiffers ? "正在重试上次消息；当前草稿不会发送或清空。" : "正在保存消息；收到保存回执后才会清空草稿。")
    : messages.sendError ? `保存未确认，草稿已保留。重试会沿用原文和发送标识。${messages.sendError}`
    : !messages.available ? "此卡片暂不支持对话，请打开当前任务的实时卡片。"
    : closed ? "任务已结束，历史对话仍可查看。"
    : finishing ? "任务正在确认交付，暂不接受新消息；草稿已保留。"
    : messages.sendNotice ?? "保存成功表示消息已入队；模型确认收到后会显示单独的状态。";
  element<HTMLElement>(panel, "#task-message-send-state").textContent = notice;
  const resume = element<HTMLButtonElement>(panel, "#task-message-continue");
  resume.hidden = !messages.available || !messages.supportsHostMessage || !canContinueTask(state) || hasBackground(state.snapshot);
  resume.disabled = messages.sending || Boolean(messages.pending) || state.busy;

  const older = element<HTMLButtonElement>(panel, '[data-act="messages-older"]');
  const latest = element<HTMLButtonElement>(panel, '[data-act="messages-latest"]');
  older.hidden = messages.nextBeforeSequence === null;
  latest.hidden = messages.beforeSequence === null;
  for (const button of [older, latest, element<HTMLButtonElement>(panel, '[data-act="messages-refresh"]')]) {
    button.disabled = messages.loading || !messages.available;
  }
  element<HTMLElement>(panel, "#task-message-history-state").textContent = messages.loadError
    ? `对话更新失败：${messages.loadError}` : messages.loading ? "正在读取…"
    : messages.loaded && !messages.messages.length ? "暂无消息" : "";

  const list = element<HTMLOListElement>(panel, "#task-message-list");
  const signature = messages.messages.map(message => `${message.id}:${message.status}:${message.offered_at}:${message.acknowledged_at}`).join("|");
  if (list.dataset.messages === signature) return;
  const atEnd = list.scrollHeight - list.scrollTop - list.clientHeight < 32;
  const pageChanged = list.dataset.before !== String(messages.beforeSequence);
  list.dataset.messages = signature;
  list.dataset.before = String(messages.beforeSequence);
  const doc = panel.ownerDocument;
  const rows = messages.messages.map(message => {
    const row = doc.createElement("li");
    row.className = `task-message task-message-${message.role}`;
    row.dataset.messageId = message.id;
    row.dataset.messageStatus = message.status;
    const header = doc.createElement("div");
    header.className = "task-message-header";
    const author = doc.createElement("strong");
    author.textContent = message.role === "assistant" ? "GPT" : "你";
    const timestamp = doc.createElement("time");
    timestamp.dateTime = message.created_at;
    timestamp.textContent = fullTime(Date.parse(message.created_at));
    header.append(author, timestamp);
    const body = doc.createElement("p");
    body.className = "task-message-body";
    body.textContent = message.body;
    const status = doc.createElement("span");
    status.className = "task-message-status";
    status.textContent = messageStatusText(message);
    status.title = messageStatusDetail(message);
    row.append(header, body, status);
    if (message.reply_to.length) {
      const reply = doc.createElement("span");
      reply.className = "task-message-reply";
      const sequences = message.reply_to.map(id => messages.messages.find(item => item.id === id)?.sequence).filter(sequence => sequence !== undefined);
      reply.textContent = sequences.length === message.reply_to.length ? `回复消息 ${sequences.map(sequence => `#${sequence}`).join("、")}` : "回复较早的消息";
      row.append(reply);
    }
    return row;
  });
  list.replaceChildren(...rows);
  if (messages.beforeSequence === null && (atEnd || pageChanged)) list.scrollTop = list.scrollHeight;
  else if (pageChanged) list.scrollTop = 0;
}

function renderTaskBinding(panel: HTMLElement, state: CardState): void {
  const section = element<HTMLElement>(panel, ".task-binding");
  section.hidden = !state.taskResume.available;
  if (section.hidden) return;
  const action = state.taskResume, binding = state.taskBinding, closed = state.snapshot?.taskState === "closed";
  element<HTMLElement>(panel, "#task-binding-state").textContent = taskBindingLabel(state);
  const resume = element<HTMLButtonElement>(panel, "#task-binding-resume");
  resume.hidden = closed || (!action.pending && (action.requiresInspection || !binding?.can_resume || binding.status === "selected"));
  resume.disabled = state.busy || (!action.pending && !canResumeTask(state));
  resume.textContent = action.busy === "resume" ? "正在恢复…" : action.pending ? "重试恢复" : "恢复此任务";
  const inspect = element<HTMLButtonElement>(panel, "#task-binding-inspect");
  inspect.hidden = closed || binding?.entry_available === false;
  inspect.disabled = state.busy;
  inspect.textContent = action.busy === "inspect" ? "正在检查…" : "检查当前关联";
  const host = element<HTMLButtonElement>(panel, "#task-binding-host");
  host.hidden = closed || binding?.entry_available !== false || !action.supportsHostMessage;
  host.disabled = state.busy;
  host.textContent = action.busy === "host" ? "正在发送请求…" : "请 GPT 恢复此任务";
  element<HTMLElement>(panel, "#task-binding-notice").textContent = action.error ?? action.notice
    ?? (action.busy === "resume" ? "正在保存当前入口与任务的关联；尚未请求 GPT 执行。"
      : binding?.entry_available === false && !action.supportsHostMessage
        ? "此宿主也未提供发送消息能力。请在原对话中明确要求 GPT 检查并恢复此任务。" : "");
}

function element<T extends Element>(panel: HTMLElement, selector: string): T {
  const result = panel.querySelector<T>(selector);
  if (!result) throw new Error(`TASK_MESSAGE_ELEMENT_MISSING: ${selector}`);
  return result;
}
