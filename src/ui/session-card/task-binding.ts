import type { TaskBindingState } from "../../tasks/task-binding.js";
import type { CardState } from "./state.js";

export interface TaskResumeState {
  available: boolean;
  supportsHostMessage: boolean;
  busy: "inspect" | "resume" | "host" | null;
  pending: { key: string; expectedRevision: number } | null;
  requiresInspection: boolean;
  error: string | null;
  notice: string | null;
}

export function createTaskResumeState(): TaskResumeState {
  return { available: false, supportsHostMessage: false, busy: null, pending: null,
    requiresInspection: false, error: null, notice: null };
}

/** Binding belongs to the current external entry, not the Task's saved revision or activity. */
export function applyTaskBinding(state: CardState, next: TaskBindingState | null): boolean {
  if (next && next.task_id !== state.snapshot?.taskId) next = null;
  if (sameBinding(state.taskBinding, next)) return false;
  state.taskBinding = next;
  if (!next?.can_continue) state.taskResume.notice = null;
  return true;
}

export function canContinueTask(state: CardState): boolean {
  if (!state.snapshot || state.snapshot.taskState === "closed" || state.connection === "unconfirmed"
    || state.taskResume.pending || state.taskResume.requiresInspection) return false;
  // Live entry authority may change while the persisted Task revision stays the same.
  return state.taskResume.available
    ? state.connection === "live" && state.taskBinding?.can_continue === true
    : state.snapshot.capabilities.continue;
}

export function canResumeTask(state: CardState): boolean {
  return state.taskResume.available && state.connection === "live" && state.snapshot?.taskState !== "closed"
    && !state.taskResume.requiresInspection && state.taskBinding?.can_resume === true
    && state.taskBinding.status !== "selected";
}

export function taskBindingLabel(state: CardState): string {
  if (state.snapshot?.taskState === "closed") return "任务已结束，历史仍可查看。";
  const binding = state.taskBinding;
  if (!binding) return "尚未确认当前入口与此任务的关联。";
  if (!binding.entry_available) return "此宿主暂不支持从卡片直接恢复任务，可请 GPT 核对并恢复。";
  switch (binding.status) {
    case "selected": return "当前入口已关联此任务。恢复关联本身不会让 GPT 开始执行。";
    case "unbound": return "当前入口尚未关联任务。恢复后将继续使用此任务及其工作区。";
    case "different_task": return `当前入口关联任务 ${binding.selected_task_id}。恢复会将当前入口切换到此任务；其他对话和已接受的操作保持原任务。`;
    case "closed": return "任务已结束，不能重新开启。历史仍可查看。";
    case "finalizing": return "任务正在确认交付，暂不能恢复或继续。";
  }
}

export function taskBindingErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string") return code;
  const message = error instanceof Error ? error.message : String(error);
  // MCP adapters may prefix the server's error message with the tool name.
  return message.match(/\b(TASK_[A-Z0-9_]+):/)?.[1] ?? "";
}

function sameBinding(left: TaskBindingState | null, right: TaskBindingState | null): boolean {
  if (left === right) return true;
  if (!left || !right || left.entry_available !== right.entry_available) return false;
  return left.task_id === right.task_id && left.binding_revision === right.binding_revision
    && left.selected_task_id === right.selected_task_id && left.status === right.status
    && left.can_resume === right.can_resume && left.can_continue === right.can_continue
    && (left.entry_available || !right.entry_available && left.reason === right.reason);
}
