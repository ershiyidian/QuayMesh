import { realpathSync, existsSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { DatabaseHandle } from "./db/client.js";
import type { ExecutionClaimInput, SourceAccess } from "./execution-coordinator.js";
import { canonicalPathIdentity } from "./roots.js";
import { resourcesConflict, type ExecutionResource } from "./execution-resources.js";

export interface ClaimRow {
  id: string; owner_id: string; owner_pid: number;
  kind: ExecutionClaimInput["kind"];
  checkout_root: string; agent_id: string | null; thread_key: string | null;
  access_mode: SourceAccess; resources: string; acquired_at?: string;
  scopes_json: string | null; operation_id: string | null; task_id: string | null; title: string | null;
  execution_id: string | null; execution_generation: string | null; owner_process_start: string | null;
}
export interface WaiterRow extends ClaimRow { sequence: number; expires_at_ms: number }

/** Aliases and subdirectories identify one real checkout; linked worktrees remain distinct. */
export function canonicalExecutionRoot(path: string): string {
  const real = realpathSync(resolve(path));
  let cursor = real;
  for (;;) {
    if (existsSync(resolve(cursor, ".git"))) return canonicalPathIdentity(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) return canonicalPathIdentity(real);
    cursor = parent;
  }
}
function contains(parent: string, child: string): boolean {
  const rest = relative(parent, child);
  return rest === "" || (!isAbsolute(rest) && rest !== ".." && !rest.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
}
export function overlaps(a: string, b: string): boolean { return contains(a, b) || contains(b, a); }
export function claimResources(row: ClaimRow): ExecutionResource[] {
  const paths: ExecutionResource[] = row.scopes_json === null || row.scopes_json === undefined
    ? [{kind:"tree",path:row.checkout_root,access:row.access_mode}]
    : JSON.parse(row.scopes_json) as ExecutionResource[];
  return [...paths, ...(JSON.parse(row.resources) as string[]).map(key => ({kind:"named" as const,key,access:"write" as const}))];
}
export function exclusiveConflict(a: ClaimRow, b: ClaimRow): boolean {
  return Boolean((a.agent_id && a.agent_id === b.agent_id) ||
    (a.thread_key && a.thread_key === b.thread_key) ||
    claimResources(a).some(resource => claimResources(b).some(other => resourcesConflict(resource,other))));
}

/** Saved occupancy evidence only. Never cleans up waiters, reconciles claims or infers process completion. */
export function readExecutionClaims(database: DatabaseHandle["sqlite"], workspaceRoot: string) {
  const root = canonicalExecutionRoot(workspaceRoot);
  const active = database.prepare("select * from execution_claims").all() as ClaimRow[];
  const waiting = database.prepare("select * from execution_waiters where expires_at_ms > ? order by sequence").all(Date.now()) as WaiterRow[];
  return [...active.map((row) => ({ ...row, state: "active" })), ...waiting.map((row) => ({ ...row, state: "queued" }))]
    .filter((row) => overlaps(row.checkout_root, root))
    .map((row) => ({ id: row.id, kind: row.kind, access: row.access_mode, state: row.state,
      agentId: row.agent_id ?? undefined, ownerPid: row.owner_pid, resources: JSON.parse(row.resources) as string[],
      scopes:claimResources(row),operationId:row.operation_id,executionId:row.execution_id,
      generation:row.execution_generation,taskId:row.task_id,title:row.title,
      acquiredAt: row.acquired_at,
      recovery: "Active claims require reconciliation after an interrupted owner; never replay or steal them by timeout." }));
}

/** Read-only queue evidence. Do not expose another workspace's agent, path or resource names. */
export function readExecutionWaitingState(database: DatabaseHandle["sqlite"], workspaceRoot: string, agentId: string) {
  const root = canonicalExecutionRoot(workspaceRoot);
  const ticket = database.prepare("select * from execution_waiters where agent_id=? and checkout_root=? order by sequence limit 1")
    .get(agentId, root) as WaiterRow | undefined;
  if (!ticket) return undefined;
  const active = database.prepare("select * from execution_claims").all() as ClaimRow[];
  const prior = database.prepare("select * from execution_waiters where sequence < ? and expires_at_ms > ? order by sequence")
    .all(ticket.sequence, Date.now()) as WaiterRow[];
  const blockers = [...active, ...prior].filter((row) => exclusiveConflict(ticket, row));
  return { state: ticket.expires_at_ms <= Date.now() ? "expired_pending_settlement" : "queued",
    expiresAt: new Date(ticket.expires_at_ms).toISOString(),
    reason: blockers.length ? "claim_or_prior_waiter" : "admission_limit_or_pending_dispatch",
    owners: blockers.slice(0, 8).map((row) => ({ claimId: row.id, kind: row.kind, access: row.access_mode,
      scope: overlaps(row.checkout_root, root) ? "checkout" : "shared_resource", state: "sequence" in row ? "queued" : "active" })),
    ownersTruncated: blockers.length > 8,
    guidance: "Wait for admission or cancel this owned queued task. Active claims are never stolen; writes are never replayed automatically." };
}
