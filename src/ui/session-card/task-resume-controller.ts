import type { SessionCardSource } from "./source.js";
import type { CardState } from "./state.js";
import { applyTaskBinding, canResumeTask, taskBindingErrorCode } from "./task-binding.js";

const reviewErrors = new Set(["TASK_BINDING_CHANGED", "TASK_BINDING_REPLAY_SUPERSEDED", "TASK_BINDING_KEY_CONFLICT",
  "TASK_NOT_ACTIVE", "TASK_FINISHING", "TASK_ENTRY_REQUIRED", "TASK_BINDING_AUTHORITY_REQUIRED"]);

export function createTaskResumeController(state: CardState, source: SessionCardSource,
  changed: () => void, begin: () => void, end: () => void) {
  state.taskResume.available = source.live && Boolean(source.inspectTaskBinding && source.resumeTask);
  state.taskResume.supportsHostMessage = Boolean(source.supportsHostMessage && source.requestHostTaskResume);
  let stopped = false, inFlight: Promise<void> | null = null, request: AbortController | null = null;

  function sync(): boolean {
    return state.taskResume.available && applyTaskBinding(state, source.taskBinding ?? null);
  }

  function run(kind: "inspect" | "resume" | "host", action: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (inFlight) return inFlight;
    if (stopped || state.busy || !state.taskResume.available) return Promise.resolve();
    state.busy = true;
    state.taskResume.busy = kind;
    state.taskResume.error = null;
    state.taskResume.notice = null;
    request = new AbortController();
    const signal = request.signal;
    begin(); changed();
    inFlight = action(signal).catch(error => {
      if (stopped || signal.aborted) return;
      sync();
      const code = taskBindingErrorCode(error);
      if (kind === "resume" && reviewErrors.has(code)) {
        // A definite rejection is different from a lost receipt. New input needs explicit review.
        state.taskResume.pending = null;
        state.taskResume.requiresInspection = true;
        state.taskResume.error = "当前关联或任务状态已改变，请先重新检查，再决定是否恢复。";
      } else if (kind === "resume") {
        state.taskResume.error = `恢复回执未确认，重试会沿用原请求与关联版本。${messageOf(error)}`;
      } else if (kind === "host") {
        state.taskResume.error = "宿主未确认恢复请求是否发送；任务关联仍未确认，可重试发送同一请求。";
      } else {
        state.taskResume.error = `关联状态读取失败：${messageOf(error)}`;
      }
    }).finally(() => {
      request = null; inFlight = null;
      state.busy = false; state.taskResume.busy = null;
      if (!stopped) { changed(); end(); }
    });
    return inFlight;
  }

  return {
    sync,
    inspect(): Promise<void> {
      return run("inspect", async signal => {
        const binding = await source.inspectTaskBinding!(signal);
        if (stopped || signal.aborted) return;
        if (binding.task_id !== state.snapshot?.taskId) throw new Error("TASK_RESUME_RECEIPT_IDENTITY_MISMATCH");
        sync();
        state.taskResume.requiresInspection = false;
        state.taskResume.notice = state.taskResume.pending
          ? "当前关联已读取；上次恢复回执仍未确认，重试将沿用原请求。"
          : state.taskBinding?.can_continue ? "当前入口已关联此任务。需要继续时，请单独点击“让 GPT 继续”。"
          : state.taskBinding?.can_resume ? "当前关联已读取。确认目标后，可明确恢复此任务。"
          : "当前关联已读取；此任务目前不能恢复或继续。";
      });
    },
    resume(): Promise<void> {
      if (inFlight) return inFlight;
      if (state.snapshot?.taskState === "closed" || !state.taskResume.pending && !canResumeTask(state)) return Promise.resolve();
      return run("resume", async signal => {
        state.taskResume.pending ??= { key: crypto.randomUUID(), expectedRevision: state.taskBinding!.binding_revision! };
        const pending = state.taskResume.pending;
        const binding = await source.resumeTask!(pending.expectedRevision, pending.key, signal);
        if (stopped || signal.aborted) return;
        if (binding.task_id !== state.snapshot?.taskId) throw new Error("TASK_RESUME_RECEIPT_IDENTITY_MISMATCH");
        sync();
        state.taskResume.pending = null;
        state.taskResume.requiresInspection = !state.taskBinding?.can_continue;
        state.taskResume.notice = state.taskBinding?.can_continue
          ? "已恢复此任务。尚未请求 GPT 继续；需要时请单独点击“让 GPT 继续”。"
          : "恢复请求已确认；当前关联或任务状态已改变，请重新检查。";
      });
    },
    requestHost(): Promise<void> {
      if (!state.taskResume.supportsHostMessage || state.taskBinding?.entry_available !== false
        || state.snapshot?.taskState === "closed") return Promise.resolve();
      return run("host", async signal => {
        await source.requestHostTaskResume!();
        if (stopped || signal.aborted) return;
        state.taskResume.notice = "恢复请求已发送给宿主，等待 GPT 核对任务关联；尚未确认恢复或开始执行。";
      });
    },
    dispose(): void { stopped = true; request?.abort("SESSION_CARD_DISPOSED"); },
  };
}

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
