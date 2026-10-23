import { randomUUID } from "node:crypto";
import { ExecutionCoordinator } from "./execution-coordinator.js";
import { canonicalWorkspaceRoot } from "./roots.js";
import { WorkLedger, digest, type ManagedThreadRow } from "./work-ledger.js";
import type { ThreadControl, ThreadSnapshot } from "./codex-thread-control.js";

interface BatchRow {
  id: string; project_id: string; mode: "archive" | "restore"; status: string; request_hash: string;
  accept_partial: number; external_idle: number; created_at: string; expires_at: string; updated_at: string;
}
interface EntryRow { batch_id: string; managed_thread_id: string; expected_revision: number; expected_snapshot: string | null; status: string; reason: string | null; updated_at: string }
interface StepRow { managed_thread_id: string | null; before_status: string; expected_revision: number | null }
const at = () => new Date().toISOString();
const snapshotHash = (snapshot: ThreadSnapshot) => digest([snapshot.instanceId, snapshot.threadId,
  canonicalWorkspaceRoot(snapshot.cwd), snapshot.turnIds.slice().sort(), snapshot.archived,
  snapshot.openDescendantIds.slice().sort(), snapshot.inventoryComplete, snapshot.turnsClosed]);

export class ProjectArchive {
  private readonly coordinator: ExecutionCoordinator;
  constructor(private readonly ledger: WorkLedger, private readonly provider: ThreadControl) { this.coordinator = new ExecutionCoordinator(ledger.stateDir); }
  async close(): Promise<void> { this.coordinator.close(); await this.provider.close(); }

  private localReason(thread: ManagedThreadRow, mode: BatchRow["mode"], acceptPartial: boolean, reconciling = false): string | undefined {
    if (!thread.created_here) return "unproven_creation";
    if (!thread.identity_verified) return "unverified_provider_instance";
    if (thread.external_activity) return "external_turns_detected";
    if (mode === "archive" && thread.protected) return "user_protected";
    if (!reconciling && thread.archive_state !== (mode === "archive" ? "active" : "archived")) return "archive_state_ineligible";
    const active = this.ledger.db.prepare("select id from local_agent_sessions where id=? and status in ('starting','queued','running')").get(thread.agent_id);
    if (active) return "managed_agent_active";
    const runs = this.ledger.threadRuns(thread.id);
    if (!runs.length || runs.some(run => !["completed", "failed", "cancelled"].includes(run.status)
      || run.status === "completed" && !["passed", "failed", "not_applicable"].includes(run.acceptance))) return "open_or_unaccepted_work";
    if (runs.some(run => this.unfinishedChild(run.id) || this.ledger.hasUnresolvedChild(run.id))) return "thread_execution_unresolved";
    if (!acceptPartial && runs.some((run) => !["complete", "not_used"].includes(this.ledger.receipt(run.id).usageStatus))) return "usage_incomplete";
    if (this.coordinator.inspect(this.ledger.getProject(thread.project_id).root).some(claim => claim.agentId === thread.agent_id)) return "active_execution_claim";
    if (mode === "restore" && !this.ledger.db.prepare(`select e.batch_id from console_archive_entries e
      join console_archive_batches b on e.batch_id=b.id where e.managed_thread_id=? and e.status='succeeded' and b.mode='archive'`).get(thread.id)) return "not_archived_by_quaymesh";
    return undefined;
  }
  private remoteReason(thread: ManagedThreadRow, snapshot: ThreadSnapshot): string | undefined {
    if (!snapshot.identityVerified || snapshot.instanceId !== thread.instance_id || snapshot.threadId !== thread.thread_id) return "provider_instance_changed";
    if (!snapshot.inventoryComplete) return "incomplete_descendant_inventory";
    if (canonicalWorkspaceRoot(snapshot.cwd) !== this.ledger.getProject(thread.project_id).root) return "provider_project_mismatch";
    if (!["idle", "notLoaded"].includes(snapshot.status) || !snapshot.turnsClosed) return "provider_thread_active_or_unknown";
    if (snapshot.openDescendantIds.length) return "unarchived_descendants_require_review";
    const expected = this.ledger.expectedTurnIds(thread.id).sort();
    if (digest(expected) !== digest(snapshot.turnIds.slice().sort())) {
      this.ledger.db.prepare("update console_threads set external_activity=1,revision=revision+1,updated_at=? where id=?").run(at(), thread.id);
      return "external_or_unmapped_turns";
    }
    return undefined;
  }

  async plan(projectId: string, input: { mode: "archive" | "restore"; threadKeys?: string[]; acceptPartial?: boolean }) {
    this.ledger.getProject(projectId);
    let threads = this.ledger.threads(projectId);
    if (input.threadKeys) {
      if (input.threadKeys.length > 100 || new Set(input.threadKeys).size !== input.threadKeys.length) throw new Error("Select up to 100 distinct managed threads.");
      threads = input.threadKeys.map((key) => {
        const thread = this.ledger.thread(key); if (thread.project_id !== projectId) throw new Error("Thread is outside this project."); return thread;
      });
    } else if (threads.length > 100) throw new Error("This project has more than 100 sessions; select a bounded batch.");
    const planned: { thread: ManagedThreadRow; reason?: string; snapshot?: string }[] = [];
    const deadline = Date.now() + 20_000;
    for (const thread of threads) {
      let reason = this.localReason(thread, input.mode, input.acceptPartial === true); let snapshot: string | undefined;
      if (!reason && Date.now() > deadline) reason = "preview_budget_exhausted";
      if (!reason) {
        try {
          const remote = await this.provider.inspect(thread.thread_id);
          reason = this.remoteReason(thread, remote);
          if (!reason && remote.archived !== (input.mode === "restore")) reason = "provider_archive_state_changed";
          if (!reason) snapshot = snapshotHash(remote);
        } catch { reason = "provider_state_unavailable"; }
      }
      planned.push({ thread, reason, snapshot });
    }
    const batchId = `archive_${randomUUID().replaceAll("-", "")}`;
    const hash = digest([projectId, input.mode, input.acceptPartial === true, planned.map((entry) => [entry.thread.id, entry.thread.revision, entry.snapshot, entry.reason])]);
    this.ledger.db.transaction(() => {
      this.ledger.db.prepare(`insert into console_archive_batches(id,project_id,mode,status,request_hash,accept_partial,external_idle,created_at,expires_at,updated_at)
        values(?,?,?,?,?,?,?,?,?,?)`).run(batchId, projectId, input.mode, "planned", hash, input.acceptPartial ? 1 : 0, 0, at(), new Date(Date.now() + 10 * 60_000).toISOString(), at());
      const insert = this.ledger.db.prepare("insert into console_archive_entries(batch_id,managed_thread_id,expected_revision,expected_snapshot,status,reason,updated_at) values(?,?,?,?,?,?,?)");
      for (const entry of planned) insert.run(batchId, entry.thread.id, entry.thread.revision, entry.snapshot ?? null, entry.reason ? "skipped" : "ready", entry.reason ?? null, at());
    }).immediate();
    return this.view(projectId, batchId);
  }
  view(projectId: string, batchId: string) {
    const batch = this.ledger.db.prepare("select * from console_archive_batches where id=? and project_id=?").get(batchId, projectId) as BatchRow | undefined;
    if (!batch) throw new Error("Archive batch not found for this project.");
    const entries = this.ledger.db.prepare(`select e.*,t.title,t.thread_id from console_archive_entries e join console_threads t on t.id=e.managed_thread_id where e.batch_id=? order by t.title`)
      .all(batchId) as (EntryRow & { title: string; thread_id: string })[];
    const succeededCount = entries.filter(entry => entry.status === "succeeded").length;
    const reconciliationCount = entries.filter(entry => ["executing", "reconciliation_required"].includes(entry.status)).length;
    return { batchId: batch.id, projectId, mode: batch.mode, status: batch.status, confirmationHash: batch.request_hash,
      effect: reconciliationCount ? succeededCount ? "partial" as const : "unknown" as const : "applied" as const,
      expiresAt: batch.expires_at, acceptPartial: Boolean(batch.accept_partial),
      requiresExternalIdleConfirmation: true,
      entries: entries.map((entry) => ({ managedThreadId: entry.managed_thread_id, title: entry.title, status: entry.status, reason: entry.reason })),
      readyCount: entries.filter((entry) => entry.status === "ready").length,
      succeededCount, reconciliationCount,
      skippedCount: entries.filter(entry => entry.status === "skipped").length,
      warning: "This changes only proven QuayMesh chats using Codex archive APIs; it is not task cancellation. Independent Codex clients must be idle. Active, mixed, unverified and descendant-bearing sessions are skipped." };
  }

  step(projectId: string, batchId: string, requestKey: string) {
    return this.ledger.db.prepare(`SELECT s.managed_thread_id,s.before_status,s.expected_revision,e.status
      FROM console_archive_steps s JOIN console_archive_batches b ON b.id=s.batch_id
      LEFT JOIN console_archive_entries e ON e.batch_id=s.batch_id AND e.managed_thread_id=s.managed_thread_id
      WHERE b.project_id=? AND s.batch_id=? AND s.request_key=?`).get(projectId,batchId,requestKey) as (StepRow & {status:string|null}) | undefined;
  }

  /** One entry per HTTP step: bounded, resumable and tied to the exact confirmed plan. */
  async execute(projectId: string, batchId: string, confirmationHash: string, externalIdle: boolean, requestKey?: string) {
    const batch = this.ledger.db.prepare("select * from console_archive_batches where id=? and project_id=?").get(batchId, projectId) as BatchRow | undefined;
    if (!batch || batch.request_hash !== confirmationHash || !externalIdle) throw new Error("Exact batch confirmation and external-client quiescence are required.");
    if (batch.status === "planned" && batch.expires_at <= at()) throw new Error("The preview expired; create a new plan.");
    // 批次按步串行，归档只占用目标代理及批次，不阻塞同项目的独立工作。
    const root = this.ledger.getProject(projectId).root;
    const prior = requestKey ? this.step(projectId,batchId,requestKey) : undefined;
    const selected = prior ? prior.managed_thread_id ? this.ledger.db.prepare("SELECT * FROM console_archive_entries WHERE batch_id=? AND managed_thread_id=?")
      .get(batchId,prior.managed_thread_id) as EntryRow | undefined : undefined
      : this.ledger.db.prepare("select * from console_archive_entries where batch_id=? and status in ('ready','executing','reconciliation_required') order by case status when 'ready' then 0 else 1 end,updated_at,managed_thread_id limit 1")
        .get(batchId) as EntryRow | undefined;
    const thread = selected ? this.ledger.thread(selected.managed_thread_id) : undefined;
    const claim = this.coordinator.acquire({ workspaceRoot: root, kind: "mutation", scopes: [],
      agentId: thread?.agent_id, resources: [`archive:${batchId}`] });
    try {
      const saved = requestKey ? this.step(projectId,batchId,requestKey) : undefined;
      if (saved && saved.managed_thread_id !== (selected?.managed_thread_id ?? null)) throw Object.assign(
        new Error("Archive step was reserved by another request; read the original receipt."), { effect: "not_started" });
      const entry = selected ? this.ledger.db.prepare("select * from console_archive_entries where batch_id=? and managed_thread_id=? and status in ('ready','executing','reconciliation_required')")
        .get(batchId, selected.managed_thread_id) as EntryRow | undefined : undefined;
      if (requestKey && !saved) this.ledger.db.prepare(`INSERT INTO console_archive_steps
        (batch_id,request_key,managed_thread_id,before_status,expected_revision,created_at) VALUES(?,?,?,?,?,?)`)
        .run(batchId,requestKey,selected?.managed_thread_id ?? null,selected?.status ?? "none",selected?.expected_revision ?? null,at());
      this.ledger.db.prepare("update console_archive_batches set status='executing',external_idle=1,updated_at=? where id=?").run(at(), batchId);
      if (entry) {
        const thread = this.ledger.thread(entry.managed_thread_id);
        const reconciling = entry.status !== "ready";
        let reason: string | undefined;
        if (!reason) {
          const local = this.localReasonWithoutClaim(thread, batch.mode, Boolean(batch.accept_partial), reconciling);
          if (local) reason = local;
        }
        if (!reason && !reconciling && thread.revision !== entry.expected_revision) reason = "managed_state_changed_since_preview";
        let remote: ThreadSnapshot | undefined;
        if (!reason) {
          try { remote = await this.provider.inspect(thread.thread_id); reason = this.remoteReason(thread, remote); }
          catch { reason = "provider_state_unavailable"; }
        }
        if (reason) this.updateEntry(batchId, thread.id, reconciling ? "reconciliation_required" : "skipped", reason);
        else if (remote) {
          const targetArchived = batch.mode === "archive";
          if (reconciling && remote.archived !== targetArchived) {
            this.updateEntry(batchId, thread.id, "reconciliation_required", "unknown_prior_side_effect_not_replayed");
          } else if (reconciling && remote.archived === targetArchived) {
            this.markSucceeded(batch, thread);
          } else if (snapshotHash(remote) !== entry.expected_snapshot) {
            this.updateEntry(batchId, thread.id, "skipped", "provider_state_changed_since_preview");
          } else {
            this.ledger.db.transaction(() => {
              this.updateEntry(batchId, thread.id, "executing", undefined);
              this.ledger.db.prepare("update console_threads set archive_state=?,revision=revision+1,updated_at=? where id=?")
                .run(targetArchived ? "archiving" : "restoring", at(), thread.id);
            }).immediate();
            try {
              if (targetArchived) await this.provider.archive(thread.thread_id); else await this.provider.unarchive(thread.thread_id);
              const after = await this.provider.inspect(thread.thread_id);
              const invalid = this.remoteReason(thread, after);
              if (invalid || after.archived !== targetArchived) throw new Error("Post-action state could not be verified.");
              this.markSucceeded(batch, thread);
            } catch {
              this.ledger.db.prepare("update console_threads set archive_state='unknown',revision=revision+1,updated_at=? where id=?").run(at(), thread.id);
              this.updateEntry(batchId, thread.id, "reconciliation_required", "provider_acknowledgement_or_verification_missing");
            }
          }
        }
      }
      const states = this.ledger.db.prepare("select status from console_archive_entries where batch_id=?").all(batchId) as { status: string }[];
      const status = states.some(row => row.status === "ready") ? "executing"
        : states.some(row => row.status === "reconciliation_required" || row.status === "executing") ? "reconciliation_required"
          : states.every(row => row.status === "succeeded") ? "succeeded" : "partial";
      this.ledger.db.prepare("update console_archive_batches set status=?,updated_at=? where id=?").run(status, at(), batchId);
      return this.view(projectId, batchId);
    } finally { claim.release(); }
  }
  private localReasonWithoutClaim(thread: ManagedThreadRow, mode: BatchRow["mode"], acceptPartial: boolean, reconciling: boolean) {
    // 目标代理的占用由 execute 持有，检查资格时保留该占用。
    if (!thread.created_here || !thread.identity_verified) return "unproven_creation_or_instance";
    if (thread.external_activity || (mode === "archive" && thread.protected)) return "externally_changed_or_protected";
    if (!reconciling && thread.archive_state !== (mode === "archive" ? "active" : "archived")) return "archive_state_ineligible";
    if (this.ledger.db.prepare("select id from local_agent_sessions where id=? and status in ('starting','queued','running')").get(thread.agent_id)) return "managed_agent_active";
    const runs = this.ledger.threadRuns(thread.id);
    if (!runs.length || runs.some(run => !["completed", "failed", "cancelled"].includes(run.status)
      || run.status === "completed" && !["passed", "failed", "not_applicable"].includes(run.acceptance))) return "open_or_unaccepted_work";
    if (runs.some(run => this.unfinishedChild(run.id) || this.ledger.hasUnresolvedChild(run.id))) return "thread_execution_unresolved";
    if (!acceptPartial && runs.some((run) => !["complete", "not_used"].includes(this.ledger.receipt(run.id).usageStatus))) return "usage_incomplete";
    if (mode === "restore" && !this.ledger.db.prepare(`select e.batch_id from console_archive_entries e join console_archive_batches b on b.id=e.batch_id
      where e.managed_thread_id=? and e.status='succeeded' and b.mode='archive'`).get(thread.id)) return "not_archived_by_quaymesh";
    return undefined;
  }
  private updateEntry(batch: string, thread: string, status: string, reason?: string) {
    this.ledger.db.prepare("update console_archive_entries set status=?,reason=?,updated_at=? where batch_id=? and managed_thread_id=?")
      .run(status, reason ?? null, at(), batch, thread);
  }
  private unfinishedChild(runId: string): boolean {
    return Boolean(this.ledger.db.prepare(`SELECT 1 FROM console_operations WHERE run_id=? AND status IN ('starting','queued','running')
      UNION ALL SELECT 1 FROM console_executions WHERE run_id=? AND status IN ('starting','queued','running') LIMIT 1`).get(runId, runId));
  }
  private markSucceeded(batch: BatchRow, thread: ManagedThreadRow) {
    this.ledger.db.transaction(() => {
      this.updateEntry(batch.id, thread.id, "succeeded");
      this.ledger.db.prepare("update console_threads set archive_state=?,revision=revision+1,updated_at=? where id=?")
        .run(batch.mode === "archive" ? "archived" : "active", at(), thread.id);
    }).immediate();
  }
}
