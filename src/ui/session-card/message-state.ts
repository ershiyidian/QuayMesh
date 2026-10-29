import type { TaskMessagePage, TaskMessageView } from "../../messaging/task-message-types.js";
import { taskMessageBodyFits } from "../../messaging/task-message-types.js";
import type { Snapshot } from "../../session/types.js";

export interface TaskMessagesState {
  available: boolean;
  supportsHostMessage: boolean;
  draft: string;
  pending: { key: string; body: string } | null;
  sending: boolean;
  sendError: string | null;
  sendNotice: string | null;
  loading: boolean;
  loaded: boolean;
  loadError: string | null;
  messages: TaskMessageView[];
  beforeSequence: number | null;
  nextBeforeSequence: number | null;
  mailbox: TaskMessagePage["mailbox"] | null;
}

export function createTaskMessagesState(): TaskMessagesState {
  return {
    available: false, supportsHostMessage: false, draft: "", pending: null, sending: false, sendError: null, sendNotice: null,
    loading: false, loaded: false, loadError: null, messages: [], beforeSequence: null,
    nextBeforeSequence: null, mailbox: null,
  };
}

export function messageDraftError(body: string): string | null {
  if (!body.trim()) return "请输入消息。";
  if (!taskMessageBodyFits(body)) {
    return "消息过长，请缩短正文；普通文本最多 16 KiB，换行、引号和反斜杠会占用更多传输空间。";
  }
  return null;
}

export function taskMessageFinishing(snapshot: Snapshot | null): boolean {
  return Boolean(snapshot?.finalization && snapshot.finalization.state !== "failed");
}

export function messageStatusText(message: TaskMessageView): string {
  switch (message.status) {
    case "queued": return "已保存 · 等待模型领取";
    case "offered": return "正文已提供给模型 · 待确认";
    case "acknowledged": return "模型已确认收到";
    case "replied": return "GPT 回复已保存";
  }
}

export function messageStatusDetail(message: TaskMessageView): string {
  switch (message.status) {
    case "queued": return "消息已保存到本任务，模型尚未领取正文。";
    case "offered": return "正文已进入模型领取消息的工具回包；尚未证明模型收到或采用。";
    case "acknowledged": return "模型入口已明确确认收到；不表示已回复或要求已落实。换聊天后仍可在同一任务读取历史并继续回复。";
    case "replied": return "模型的文字回复已保存；任务是否完成仍以任务状态和执行证据为准。";
  }
}
