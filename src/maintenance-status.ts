import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { pidAlive } from "./process-liveness.js";
import { processOwnerAlive } from "./process-identity.js";

export type ExecutionDomain = "operation" | "execution";
export interface QuiescenceSubject {
  domain: ExecutionDomain;
  id: string;
  generation: string;
  fingerprint: string;
}
export interface ReviewedCommandClaim {
  id: string;
  operationId: string;
  ownerId: string;
  ownerPid: number;
  processStart: string;
  generation: string;
  fingerprint: string;
}
type Owner = { generation: string; owner_token: string; owner_pid: number; process_start: string | null };
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const canonical = (row: Record<string, unknown>) => Object.fromEntries(Object.keys(row).sort().map(key => [key, row[key]]));
const unresolved = new Set(["unknown", "reconciliation_required"]);

function ownerFor(db: Database.Database, domain: ExecutionDomain, id: string): Owner | undefined {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='execution_owners'").get()) return;
  return db.prepare("SELECT * FROM execution_owners WHERE domain=? AND id=?").get(domain, id) as Owner | undefined;
}

/** The complete row and owner identity bind the proof to one persisted attempt.
 * A same-id retry, new owner or later evidence invalidates the previous proof. */
export function quiescenceSubject(db: Database.Database, domain: ExecutionDomain, id: string): QuiescenceSubject {
  const table = domain === "operation" ? "console_operations" : "console_executions";
  const row = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id) as Record<string, unknown> | undefined;
  if (!row || !unresolved.has(String(row.status))) throw new Error("Quiescence proof requires an existing unresolved execution.");
  const owner = ownerFor(db, domain, id);
  const generation = owner?.generation ?? digest([domain, row.id, row.created_at, row.request_key ?? null,
    row.agent_id ?? null, row.managed_thread_id ?? null, row.provider_turn_id ?? null]);
  return { domain, id, generation, fingerprint: digest({ row: canonical(row), owner: owner ? canonical(owner) : null }) };
}

export function unresolvedSubjects(db: Database.Database): QuiescenceSubject[] {
  const result: QuiescenceSubject[] = [];
  let bytes=2;
  for (const domain of ["operation", "execution"] as const) {
    const table = domain === "operation" ? "console_operations" : "console_executions";
    for (const row of db.prepare(`SELECT id FROM ${table} WHERE status IN ('unknown','reconciliation_required') ORDER BY id`).iterate() as Iterable<{id:string}>) {
      const subject=quiescenceSubject(db,domain,row.id);
      bytes+=Buffer.byteLength(JSON.stringify(subject))+1;
      if(bytes>2*1024*1024)throw new Error("Historical physical proof subjects exceed the 2 MiB review bound.");
      result.push(subject);
    }
  }
  return result;
}

/** Called only after an authoritative physical boundary was verified. It never
 * changes a result, finish timestamp, owner, resource claim or replay decision. */
export function recordExecutionQuiescence(db: Database.Database, subjects: readonly QuiescenceSubject[],
  receipt: { id: string; verifiedAt: string; evidence: Record<string, unknown> }): void {
  if (!receipt.id || !Number.isFinite(Date.parse(receipt.verifiedAt)) || !receipt.evidence ||
      subjects.length === 0 || subjects.some(row => !["operation","execution"].includes(row.domain) ||
        !row.id || !row.generation || !/^[a-f0-9]{64}$/.test(row.fingerprint)) ||
      new Set(subjects.map(row => `${row.domain}:${row.id}`)).size !== subjects.length)
    throw new Error("Invalid execution quiescence receipt.");
  db.transaction(() => {
    const insert = db.prepare(`INSERT INTO execution_quiescence
    (id,domain,object_id,generation,fingerprint,receipt_id,evidence_json,verified_at) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(domain,object_id,fingerprint,receipt_id) DO NOTHING`);
    // No partial batch may survive a changed subject or a failed insert.
    for (const subject of subjects) {
      const current = quiescenceSubject(db, subject.domain, subject.id);
      if (current.fingerprint !== subject.fingerprint || current.generation !== subject.generation)
        throw new Error(`Execution changed after physical review: ${subject.domain}:${subject.id}`);
    }
    for (const subject of subjects) insert.run(`quiescence_${randomUUID()}`, subject.domain, subject.id,
      subject.generation, subject.fingerprint, receipt.id, JSON.stringify(receipt.evidence), receipt.verifiedAt);
  }).immediate();
}

const claimIdentity = (claim: ReviewedCommandClaim) => [claim.id, claim.operationId, claim.ownerId,
  claim.ownerPid, claim.processStart, claim.generation, claim.fingerprint];
const claimReleaseReason = "reviewed_command_physical_quiescence";

/** These are identities eligible for external review, not proof of termination.
 * The raw claim count still includes live, unsupported and unidentifiable rows. */
export function reviewableCommandClaims(db: Database.Database): ReviewedCommandClaim[] {
  return db.transaction(() => {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='execution_owners'").get()) return [];
    const rows = db.prepare(`SELECT c.* FROM execution_claims c
      JOIN console_operations o ON o.id=c.operation_id
      JOIN execution_owners e ON e.domain='operation' AND e.id=o.id
      WHERE c.kind='command' AND o.kind='command' AND o.status IN ('unknown','reconciliation_required')
        AND e.owner_pid=c.owner_pid AND e.generation=o.request_key
        AND e.process_start IS NOT NULL AND length(e.process_start)>0
      ORDER BY c.id`).all() as Array<Record<string, unknown>>;
    return rows.flatMap(row => {
      const operationId = String(row.operation_id), owner = ownerFor(db, "operation", operationId)!;
      if (processOwnerAlive(owner)) return [];
      const subject = quiescenceSubject(db, "operation", operationId);
      return [{ id: String(row.id), operationId, ownerId: String(row.owner_id), ownerPid: owner.owner_pid,
        processStart: owner.process_start!, generation: owner.generation,
        fingerprint: digest({claim: canonical(row), subject}) }];
    });
  }).deferred();
}

/** Consume only the explicit installer's reviewed stop-domain receipt. The
 * caller records that receipt in this same transaction after validating its
 * installation, pause and process generations. No business outcome is changed. */
export function releaseReviewedCommandClaims(db: Database.Database, claims: readonly ReviewedCommandClaim[], receiptId: string): {
  released: number; replayed: number;
} {
  if (!db.inTransaction) throw new Error("Reviewed claim release requires the physical receipt transaction.");
  if (!receiptId || !Array.isArray(claims) || claims.some(claim => !claim ||
    [claim.id, claim.operationId, claim.ownerId, claim.processStart, claim.generation].some(value => typeof value !== "string" || !value) ||
    !Number.isSafeInteger(claim.ownerPid) || claim.ownerPid < 1 || !/^[a-f0-9]{64}$/.test(claim.fingerprint)) ||
    new Set(claims.map(claim => claim.id)).size !== claims.length)
    throw new Error("Invalid reviewed command claim identities.");
  const admission = readMaintenanceStatus(db);
  if (admission.accepting || admission.waiting + admission.operations + admission.executions +
    admission.queuedOperations + admission.queuedExecutions + admission.persistedRuntimeWork > 0)
    throw new Error("Reviewed claim release requires paused admission and no other physical work.");
  const current = new Map(reviewableCommandClaims(db).map(claim => [claim.id, claim]));
  const release: Array<{ claim: ReviewedCommandClaim; row: Record<string, unknown>; runId: string }> = [];
  let replayed = 0;
  for (const claim of claims) {
    const row = db.prepare("SELECT * FROM execution_claims WHERE id=?").get(claim.id) as Record<string, unknown> | undefined;
    const subject = quiescenceSubject(db, "operation", claim.operationId);
    const owner = ownerFor(db, "operation", claim.operationId);
    if (!owner || owner.owner_pid !== claim.ownerPid || owner.process_start !== claim.processStart ||
      owner.generation !== claim.generation || processOwnerAlive(owner))
      throw new Error(`Reviewed command owner changed or is still present: ${claim.id}`);
    const proof = db.prepare(`SELECT evidence_json FROM execution_quiescence WHERE domain='operation' AND object_id=?
      AND generation=? AND fingerprint=? AND receipt_id=? AND invalidated_at IS NULL`)
      .get(subject.id, subject.generation, subject.fingerprint, receiptId) as {evidence_json: string} | undefined;
    const evidence = proof && JSON.parse(proof.evidence_json) as {
      boundary?: string; context?: {attemptId?: string}; claims?: ReviewedCommandClaim[];
    };
    if (!evidence || evidence.boundary !== "reviewed_installation_stop_domain" || evidence.context?.attemptId !== receiptId ||
      !Array.isArray(evidence.claims) || evidence.claims.length !== claims.length ||
      claims.some(expected => !evidence.claims!.some(saved => JSON.stringify(claimIdentity(saved)) === JSON.stringify(claimIdentity(expected)))))
      throw new Error(`Command claim lacks this attempt's exact physical receipt: ${claim.id}`);
    if (!row) {
      const audits = db.prepare("SELECT evidence FROM execution_claim_reconciliations WHERE claim_id=? AND reason=?")
        .all(claim.id, claimReleaseReason) as Array<{evidence: string}>;
      const saved = audits.some(audit => {
        const evidence = JSON.parse(audit.evidence) as {receiptId?: string; claim?: ReviewedCommandClaim; originalClaim?: Record<string, unknown>};
        return evidence.receiptId === receiptId && evidence.claim && evidence.originalClaim &&
          JSON.stringify(claimIdentity(evidence.claim)) === JSON.stringify(claimIdentity(claim)) &&
          digest({claim: canonical(evidence.originalClaim), subject}) === claim.fingerprint;
      });
      if (!saved) throw new Error(`Reviewed command claim disappeared without its matching release receipt: ${claim.id}`);
      replayed++;
      continue;
    }
    const observed = current.get(claim.id);
    if (!observed || JSON.stringify(claimIdentity(observed)) !== JSON.stringify(claimIdentity(claim)))
      throw new Error(`Command claim changed after physical review: ${claim.id}`);
    const operation = db.prepare("SELECT run_id FROM console_operations WHERE id=?").get(claim.operationId) as {run_id: string};
    release.push({claim: observed, row, runId: operation.run_id});
  }
  if (admission.claims !== release.length)
    throw new Error("Unreviewed or unsupported execution claims remain; physical release is refused.");
  // Validate every subject before either auditing or deleting a claim. An insert
  // or delete failure rolls back the physical receipts and the whole release.
  for (const {claim, row, runId} of release) {
    db.prepare(`INSERT INTO execution_claim_reconciliations
      (id,claim_id,kind,owner_pid,agent_id,checkout_root,run_id,reason,evidence,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(`claimrec_${randomUUID()}`, claim.id, "command", claim.ownerPid,
        row.agent_id ?? null, row.checkout_root, runId, claimReleaseReason,
        JSON.stringify({version: 1, boundary: "reviewed_command_claim_release", receiptId, claim, originalClaim: row,
          resultReconciliation: "unchanged"}), new Date().toISOString());
    const removed = db.prepare("DELETE FROM execution_claims WHERE id=? AND owner_id=? AND owner_pid=? AND operation_id=?")
      .run(claim.id, claim.ownerId, claim.ownerPid, claim.operationId);
    if (removed.changes !== 1) throw new Error(`Reviewed command claim changed during release: ${claim.id}`);
  }
  return {released: release.length, replayed};
}

/** Read-only, one SQLite snapshot. Result uncertainty and physical activity are
 * separate: historical uncertainty remains visible after a proven drain. */
export function readMaintenanceStatus(db: Database.Database) {
  return db.transaction(() => {
    const state = db.prepare("SELECT accepting,reason,changed_at FROM qm_runtime_admission WHERE id=1").get() as
      { accepting: number; reason: string | null; changed_at: string };
    const count = (sql: string) => Number((db.prepare(sql).get() as { n: number }).n);
    const claims = count("SELECT COUNT(*) AS n FROM execution_claims");
    const waiting = count("SELECT COUNT(*) AS n FROM execution_waiters WHERE expires_at_ms>strftime('%s','now')*1000");
    const operations = count("SELECT COUNT(*) AS n FROM console_operations WHERE status IN ('running','starting')");
    const executions = count("SELECT COUNT(*) AS n FROM console_executions WHERE status IN ('running','starting')");
    const queuedOperations = count("SELECT COUNT(*) AS n FROM console_operations WHERE status='queued'");
    const queuedExecutions = count("SELECT COUNT(*) AS n FROM console_executions WHERE status='queued'");
    const rows = db.prepare(`SELECT kind,owner_pid,blocking,COUNT(*) AS count FROM qm_runtime_work
      GROUP BY kind,owner_pid,blocking ORDER BY kind,owner_pid,blocking`).all() as { kind: string; owner_pid: number; blocking:number; count: number }[];
    const owners = new Map<number, boolean>(), counts = new Map<string, {blocking:number;nonBlocking:number}>();
    let persistedRuntimeWork=0;
    for (const row of rows) {
      persistedRuntimeWork+=row.count;
      if (!owners.has(row.owner_pid)) owners.set(row.owner_pid, pidAlive(row.owner_pid));
      if (owners.get(row.owner_pid)) {
        const next=counts.get(row.kind)??{blocking:0,nonBlocking:0};
        // Older releases persisted open egress streams as non-blocking. Their
        // live owner still holds a model connection across a service cutover.
        if(row.blocking||row.kind==="egress")next.blocking+=row.count;else next.nonBlocking+=row.count;
        counts.set(row.kind,next);
      }
    }
    const work = [...counts].filter(([,value])=>value.blocking>0).map(([kind, value]) => ({ kind, count:value.blocking }));
    const allWork=[...counts].map(([kind,value])=>({kind,count:value.blocking+value.nonBlocking,...value}));
    const activeWork = work.reduce((total, value) => total + value.count, 0);
    const allRuntimeWork=allWork.reduce((total,value)=>total+value.count,0);
    const nonBlockingWork=allRuntimeWork-activeWork;
    const unresolvedOperations=count("SELECT COUNT(*) AS n FROM console_operations WHERE status IN ('unknown','reconciliation_required')");
    const unresolvedExecutions=count("SELECT COUNT(*) AS n FROM console_executions WHERE status IN ('unknown','reconciliation_required')");
    const hasReceipts = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='execution_quiescence'").get());
    const hasOwners=Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='execution_owners'").get());
    // Migration-owned invalidation triggers revoke a proof on every subject or
    // owner identity change. The 100ms drain path never hashes historical rows.
    const uncertain=`WITH subjects(domain,id) AS (
      SELECT 'operation',id FROM console_operations WHERE status IN ('unknown','reconciliation_required')
      UNION ALL SELECT 'execution',id FROM console_executions WHERE status IN ('unknown','reconciliation_required'))
      SELECT s.domain,s.id FROM subjects s ${hasReceipts?`WHERE NOT EXISTS(
        SELECT 1 FROM execution_quiescence q WHERE q.domain=s.domain AND q.object_id=s.id AND q.invalidated_at IS NULL)`:""}`;
    const physicalUnknown=count(`SELECT COUNT(*) AS n FROM (${uncertain})`);
    const sample=db.prepare(`${uncertain} ORDER BY domain,id LIMIT 20`).all() as Array<{domain:ExecutionDomain;id:string}>;
    const physicalUnknownWork=sample.map(subject=>{
        const owner=hasOwners?ownerFor(db,subject.domain,subject.id):undefined;
        return { ...subject, reason: owner
          ? processOwnerAlive(owner) ? "unresolved_live_owner" : "unresolved_physical_boundary"
          : "legacy_owner_unknown" };
      });
    const quiescent = claims + waiting + operations + executions + queuedOperations + queuedExecutions + activeWork + physicalUnknown === 0;
    return { accepting: state.accepting === 1, reason: state.reason, changedAt: state.changed_at,
      idle: quiescent, quiescent, reconciliationPending: unresolvedOperations+unresolvedExecutions > 0,
      claims, waiting, operations, executions, queuedOperations, queuedExecutions,
      unresolvedOperations, unresolvedExecutions, activeWork, allRuntimeWork, nonBlockingWork,persistedRuntimeWork,work,allWork,
      physicalUnknown,physicalUnknownWork,physicalUnknownWorkTruncated:physicalUnknown>physicalUnknownWork.length,
      reconciledPhysicalBoundaries:unresolvedOperations+unresolvedExecutions-physicalUnknown };
  }).deferred();
}
