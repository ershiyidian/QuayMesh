import { finalizationBlocksNewWork, type FinalizationFence } from "./task-finalization.js";
import type { TaskRecord } from "./types.js";

export type TaskContinuationEligibility =
  | { allowed: true }
  | { allowed: false; code: "TASK_NOT_ACTIVE" | "TASK_FINISHING" | "TASK_CONTINUATION_BINDING_REQUIRED" };

/** Display/execution consistency only. The caller must separately verify owner and Task membership. */
export function taskContinuationEligibility(
  task: Pick<TaskRecord, "id" | "state"> | null | undefined,
  currentTaskId: string | null | undefined,
  finalization: FinalizationFence | null | undefined,
): TaskContinuationEligibility {
  if (!task || task.state !== "active") return { allowed: false, code: "TASK_NOT_ACTIVE" };
  if (finalizationBlocksNewWork(finalization)) return { allowed: false, code: "TASK_FINISHING" };
  // Request handlers supply the authenticated entry's captured selection. A
  // persisted Task projection may only use intrinsic Task eligibility.
  if (currentTaskId !== task.id) return { allowed: false, code: "TASK_CONTINUATION_BINDING_REQUIRED" };
  return { allowed: true };
}
