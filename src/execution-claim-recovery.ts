import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { pidAlive } from "./process-liveness.js";
import { processOwnerAlive } from "./process-identity.js";
import { quiescenceSubject, type ExecutionDomain } from "./maintenance-status.js";

interface ClaimRow {
  id: string; owner_id: string; owner_pid: number; owner_process_start: string | null;
  kind: string; checkout_root: string; agent_id: string | null; operation_id: string | null;
  execution_id: string | null; execution_generation: string | null;
  task_id: string | null; acquired_at: string; scopes_json: string | null; resources: string;
}
interface ExecutionRow {
  id: string; run_id: string; status: string; created_at: string; finished_at: string | null;
  agent_id?: string; request_key?: string;
}
interface OwnerRow {
  generation: string; owner_pid: number; process_start: string | null; created_at: string;
}
interface Target { domain: ExecutionDomain; row: ExecutionRow; owner?: OwnerRow }
export interface ExecutionClaimRecovery {
  claimId: string;
  state: "released" | "recoverable" | "active" | "unknown" | "not_found";
  kind?: string;
  workspaceRoot?: string;
  taskId?: string | null;
  agentId?: string | null;
  operationId?: string | null;
  executionId?: string | null;
  generation?: string | null;
  runId?: string | null;
  executionStatus?: string | null;
  ownerAlive?: boolean;
  physicalState?: "quiescent" | "active" | "unknown";
  receiptId?: string;
  reason?: string;
}
const atOrBefore = (a: string, b: string) => Number.isFinite(Date.parse(a)) && Date.parse(a) <= Date.parse(b);

/** Legacy agents are linked only when one saved attempt spans claim acquisition.
 * The agent's latest turn is never evidence for a different turn's resources. */
function targetFor(db: Database.Database, claim: ClaimRow): Target | undefined {
  const domain = claim.kind === "agent" ? "execution" : "operation";
  let row: ExecutionRow | undefined;
  if (domain === "execution") {
    if (claim.execution_id) {
      row = db.prepare("SELECT * FROM console_executions WHERE id=? AND agent_id=?")
        .get(claim.execution_id, claim.agent_id) as ExecutionRow | undefined;
    } else if (claim.agent_id) {
      const candidates = db.prepare(`SELECT e.* FROM console_executions e
        JOIN execution_owners o ON o.domain='execution' AND o.id=e.id
        WHERE e.agent_id=? AND o.owner_pid=? AND e.created_at<=?
          AND (e.finished_at IS NULL OR e.finished_at>=?) ORDER BY e.id LIMIT 2`)
        .all(claim.agent_id, claim.owner_pid, claim.acquired_at, claim.acquired_at) as ExecutionRow[];
      if (candidates.length === 1) row = candidates[0];
    }
  } else if (claim.operation_id) {
    row = db.prepare("SELECT * FROM console_operations WHERE id=?").get(claim.operation_id) as ExecutionRow | undefined;
  }
  if (!row) return;
  const owner = db.prepare("SELECT generation,owner_pid,process_start,created_at FROM execution_owners WHERE domain=? AND id=?")
    .get(domain, row.id) as OwnerRow | undefined;
  if (owner) {
    if (owner.owner_pid !== claim.owner_pid || claim.owner_process_start && owner.process_start !== claim.owner_process_start) return;
    if (claim.execution_generation ? claim.execution_generation !== owner.generation : !atOrBefore(owner.created_at, claim.acquired_at)) return;
  } else if (claim.execution_generation) return;
  return { domain, row, owner };
}

function inspect(db: Database.Database, claimId: string): {
  claim?: ClaimRow; target?: Target; result: ExecutionClaimRecovery; releasable: boolean;
} {
  const claim = db.prepare("SELECT * FROM execution_claims WHERE id=?").get(claimId) as ClaimRow | undefined;
  if (!claim) return { result: { claimId, state: "not_found" }, releasable: false };
  const target = targetFor(db, claim);
  const processStart = claim.owner_process_start ?? target?.owner?.process_start;
  const ownerAlive = processStart
    ? processOwnerAlive({ owner_pid: claim.owner_pid, process_start: processStart })
    : pidAlive(claim.owner_pid);
  let receiptId: string | undefined;
  if (target && ["unknown", "reconciliation_required", "completed", "failed", "cancelled"].includes(target.row.status)) {
    const subject = quiescenceSubject(db, target.domain, target.row.id, {allowTerminal:true});
    receiptId = (db.prepare(`SELECT receipt_id FROM execution_quiescence
      WHERE domain=? AND object_id=? AND generation=? AND fingerprint=? AND invalidated_at IS NULL LIMIT 1`)
      .get(subject.domain, subject.id, subject.generation, subject.fingerprint) as { receipt_id: string } | undefined)?.receipt_id;
  }
  // A business result and an absent owner do not prove that its children or
  // provider turn stopped. Local joined handlers produce the same explicit
  // generation-bound proof as process/agent completion.
  const releasable = Boolean(receiptId);
  const active = ownerAlive && target && ["starting", "queued", "running"].includes(target.row.status);
  const physicalState = releasable ? "quiescent" : active ? "active" : "unknown";
  return { claim, target, releasable, result: {
    claimId, state: releasable ? "recoverable" : physicalState === "active" ? "active" : "unknown", kind: claim.kind,
    workspaceRoot: claim.checkout_root, taskId: claim.task_id, agentId: claim.agent_id,
    operationId: claim.operation_id, executionId: target?.domain === "execution" ? target.row.id : claim.execution_id,
    generation: target?.owner?.generation ?? claim.execution_generation,
    runId: target?.row.run_id ?? null, executionStatus: target?.row.status ?? null,
    ownerAlive, physicalState, ...(receiptId ? { receiptId } : {}),
    reason: receiptId ? "physical_completion_receipt"
      : !target ? "execution_identity_unresolved" : ownerAlive ? "execution_owner_present" : "physical_completion_unconfirmed",
  } };
}

export function inspectExecutionClaim(db: Database.Database, claimId: string): ExecutionClaimRecovery {
  return db.transaction(() => inspect(db, claimId).result).deferred();
}

/** Recover only this claim. No global pause, process termination, Task transition
 * or business-result inference is part of consuming a physical completion. */
export function recoverExecutionClaim(db: Database.Database, claimId: string): ExecutionClaimRecovery {
  return db.transaction(() => {
    const { claim, target, result, releasable } = inspect(db, claimId);
    if (!claim || !releasable) return result;
    db.prepare(`INSERT INTO execution_claim_reconciliations
      (id,claim_id,kind,owner_pid,agent_id,checkout_root,run_id,reason,evidence,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(`claimrec_${randomUUID()}`, claim.id, claim.kind, claim.owner_pid,
        claim.agent_id, claim.checkout_root, target?.row.run_id ?? null, "execution_physical_completion",
        JSON.stringify({ version: 1, operationId: result.operationId, executionId: result.executionId,
          generation: result.generation, receiptId: result.receiptId ?? null,
          boundary: result.reason, resultReconciliation: "unchanged" }), new Date().toISOString());
    const deleted = db.prepare("DELETE FROM execution_claims WHERE id=? AND owner_id=?")
      .run(claim.id, claim.owner_id);
    if (deleted.changes !== 1) throw new Error("Execution claim changed during recovery.");
    return { ...result, state: "released" as const };
  }).immediate();
}
