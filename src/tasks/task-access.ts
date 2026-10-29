import type Database from "better-sqlite3";

const authenticatedPrincipal = Symbol("authenticated-task-principal");

/** Construct only from authInfo already verified by the server's authentication middleware. */
export interface TaskPrincipal {
  readonly ownerId: string;
  readonly [authenticatedPrincipal]: true;
}

export interface VerifiedTaskAuthInfo {
  extra?: Record<string, unknown>;
}

/** This reads verified middleware state; it does not verify OAuth credentials itself. */
export function taskPrincipalFromAuthInfo(authInfo: VerifiedTaskAuthInfo | null | undefined): TaskPrincipal {
  const ownerId = authInfo?.extra?.owner_id;
  if (!validIdentifier(ownerId)) throw failure("MISSING_AUTHENTICATED_OWNER");
  return Object.freeze({ ownerId, [authenticatedPrincipal]: true as const });
}

export type TaskOwnerSource = "task" | "legacy-session";

/** An ownership observation, not an execution permit or a receiver binding. */
export interface TaskAccess {
  readonly taskId: string;
  readonly ownerId: string;
  readonly state: "active" | "closed";
}

interface TaskAccessRow {
  taskId: string;
  ownerId: string;
  state: string;
}

function failure(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code, effect: "not_started" });
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256;
}

/**
 * Resolves explicit Task ownership without interpreting any external conversation.
 *
 * Choose the owner source when constructing this adapter. A failed direct-owner
 * lookup never falls back to a Session owner. During migration the legacy join
 * is an internal storage mapping; no Session ID is accepted or returned here.
 *
 * Mutations must resolve again inside their existing synchronous write callback.
 * This class neither starts transactions nor grants execution/claim/ack rights.
 */
export class TaskAccessResolver {
  private readonly lookup: Database.Statement;

  constructor(
    private readonly db: Database.Database,
    options: { ownerSource: TaskOwnerSource },
  ) {
    if (options.ownerSource === "task") {
      this.lookup = db.prepare(`SELECT id AS taskId, owner_id AS ownerId, state
        FROM qm_tasks WHERE id = ? AND owner_id = ?`);
    } else if (options.ownerSource === "legacy-session") {
      this.lookup = db.prepare(`SELECT t.id AS taskId, s.owner_id AS ownerId, t.state
        FROM qm_tasks t JOIN qm_sessions s ON s.id = t.session_id
        WHERE t.id = ? AND s.owner_id = ?`);
    } else {
      throw failure("TASK_ACCESS_OWNER_SOURCE_INVALID");
    }
  }

  resolve(principal: TaskPrincipal, taskId: string): TaskAccess {
    if (!principal || principal[authenticatedPrincipal] !== true || !validIdentifier(principal.ownerId)) {
      throw failure("MISSING_AUTHENTICATED_OWNER");
    }
    if (!validIdentifier(taskId)) throw failure("TASK_ACCESS_INVALID_ID");
    const row = this.lookup.get(taskId, principal.ownerId) as TaskAccessRow | undefined;
    // Missing, orphaned and another owner's Tasks have the same public failure.
    if (!row) throw failure("TASK_ACCESS_DENIED");
    if (row.taskId !== taskId || row.ownerId !== principal.ownerId
      || (row.state !== "active" && row.state !== "closed")) {
      throw failure("TASK_ACCESS_METADATA_INVALID");
    }
    return Object.freeze({ taskId: row.taskId, ownerId: row.ownerId, state: row.state });
  }

  resolveInTransaction(principal: TaskPrincipal, taskId: string): TaskAccess {
    if (!this.db.inTransaction) throw failure("TASK_ACCESS_TRANSACTION_REQUIRED");
    return this.resolve(principal, taskId);
  }
}
