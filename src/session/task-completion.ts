import type { TaskFinalStatus } from "./task-data.js";

export type TaskCompletionStatus = Exclude<TaskFinalStatus, "handed_off">;

export const HANDOFF_FINALIZATION_CODE = "TASK_HANDOFF_NOT_TERMINAL";
export const HANDOFF_FINALIZATION_MESSAGE = `${HANDOFF_FINALIZATION_CODE}: A handoff leaves the Task open. Save progress with checkpoint_task; in the receiving entry, inspect and resume the same Task with task_resume. finish_task is only for completed or explicitly ended goals.`;

/** Historical handed_off results remain readable; they are not new completion requests. */
export function assertTaskCompletionStatus(status: TaskFinalStatus): asserts status is TaskCompletionStatus {
  if (status === "handed_off") {
    throw Object.assign(new Error(HANDOFF_FINALIZATION_MESSAGE), {
      code: HANDOFF_FINALIZATION_CODE, effect: "not_started", retryHint: "fix_input",
    });
  }
}
