import type Database from "better-sqlite3";

export type FinalizationRecoveryState = "safe" | "reconcile" | "superseded";
export interface FinalizationFence {
  error: string | null;
  completed_at?: string | null;
  recovery_state?: FinalizationRecoveryState | null;
}

/** A legacy NULL is unknown, never evidence that no owner received the finish. */
export function finalizationBlocksNewWork(intent: FinalizationFence | null | undefined): boolean {
  if (!intent || intent.completed_at || intent.recovery_state === "superseded") return false;
  return intent.error === null || intent.recovery_state !== "safe";
}

function failure(code: string, message: string, details?: Record<string, unknown>): Error {
  return Object.assign(
    new Error(`${code}: ${message}`),
    { code, effect: "not_started", retryHint: "fix_input", details }
  );
}

export function taskFinishingError(taskId: string, intent: FinalizationFence): Error {
  return failure(
    "TASK_FINISHING",
    "The earlier finish is in progress or may have reached an owner. Reconcile that finish before new workspace work; saved messages and original operation output remain readable.",
    { task_id: taskId, recovery_state: intent.recovery_state ?? "legacy_unknown" }
  );
}

/** SQL only. Call in the same write transaction as binding or execution admission. */
export function admitTaskWorkInTransaction(db: Database.Database, taskId: string): void {
  if (!db.inTransaction) throw new Error("TASK_FINALIZATION_WRITE_TRANSACTION_REQUIRED");
  const task = db.prepare("SELECT state FROM qm_tasks WHERE id=?").get(taskId) as { state: string } | undefined;
  if (task?.state !== "active") throw failure("TASK_NOT_ACTIVE", "New work cannot reopen an ended Task.", { task_id: taskId });
  const intent = db.prepare("SELECT error,completed_at,recovery_state FROM qm_task_finalizations WHERE task_id=?")
    .get(taskId) as FinalizationFence | undefined;
  if (finalizationBlocksNewWork(intent)) throw taskFinishingError(taskId, intent!);
  if (intent?.error && !intent.completed_at && intent.recovery_state === "safe") {
    db.prepare(`UPDATE qm_task_finalizations SET recovery_state='superseded',finalization_revision=finalization_revision+1
      WHERE task_id=? AND completed_at IS NULL AND error IS NOT NULL AND recovery_state='safe'`).run(taskId);
    // Display bookkeeping is separate from activity, entry CAS and mailbox sequence.
    db.prepare("UPDATE qm_tasks SET revision=revision+1 WHERE id=?").run(taskId);
  }
}

export function finalizationChangedError(): Error {
  return Object.assign(
    new Error("TASK_FINALIZATION_SUPERSEDED: This saved finish attempt is no longer current. It cannot close the Task or overwrite a newer attempt."),
    { code: "TASK_FINALIZATION_SUPERSEDED" }
  );
}

/** Constructed only after all owner calls settle; remote error text is never this proof. */
export class FinalizationDispatchError extends AggregateError {
  readonly code = "TASK_OWNER_FINALIZATION_UNCONFIRMED";
  readonly effect: "not_started" | "unknown";
  readonly retryHint: "retry_later" | "query_original";
  constructor(errors: unknown[], readonly allNotSent: boolean) {
    super(
      errors,
      allNotSent ? "No Task owner received this finish attempt."
        : "At least one Task owner may have received this finish; reconcile the original intent."
    );
    const diagnostics = errors.slice(0, 16).map(error => {
      const value = error && typeof error === "object"
        ? error as { nodeId?: unknown; code?: unknown }
        : {};
      const node = typeof value.nodeId === "string" && /^[a-zA-Z0-9_.:-]{1,80}$/.test(value.nodeId)
        ? value.nodeId
        : "owner";
      const code = typeof value.code === "string" && /^[A-Z0-9_]{1,80}$/.test(value.code)
        ? value.code
        : "UNCONFIRMED";
      return `${node}:${code}`;
    });
    if (diagnostics.length) this.message += ` ${diagnostics.join(", ")}`;
    this.name = "FinalizationDispatchError";
    this.effect = allNotSent ? "not_started" : "unknown";
    this.retryHint = allNotSent ? "retry_later" : "query_original";
  }
}
