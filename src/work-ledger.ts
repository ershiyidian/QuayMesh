import { createHash, randomUUID } from "node:crypto";
import { basename } from "node:path";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import { pidAlive } from "./process-liveness.js";
import { canonicalExecutionRoot, overlaps } from "./execution-coordinator.js";
import { canonicalWorkspaceRoot } from "./roots.js";
import type { AgentUsageObservation, TokenCounts } from "./agent-usage.js";
import { managedSessionTitle } from "./managed-session-title.js";
import { runChangeSets, runOperations, runPresentation, runTimeline } from "./console-run-data.js";
import { retryableAdmission } from "./session/outcome.js";

export type UsageQuality = "complete" | "partial" | "unavailable" | "not_used";
export type WorkOrigin = {
  entryPoint: "chatgpt_mcp" | "other_mcp" | "qm_cli" | "console" | "legacy_unknown";
  clientLabel?: string; clientIdHash?: string; conversationHash?: string;
  modelLabel?: string; evidence: "server_entry" | "client_reported" | "historical_association";
};
export interface Evidence { label: string; reference: string; outcome: "passed" | "failed" | "not_run" }
export interface WorkRunRow {
  id: string; project_id: string; item_id: string; workspace_id: string | null;
  run_key: string; request_hash: string; origin: string; status: string; acceptance: string;
  summary: string; evidence: string; revision: number; created_at: string; finished_at: string | null;
  last_activity_at: string | null; lease_expires_at: string | null; interrupted_at: string | null; resume_count: number;
  title?: string;
}
export interface ProjectRow { id: string; root: string; name: string; created_at: string }
export interface ManagedThreadRow {
  id: string; project_id: string; agent_id: string; instance_id: string; thread_id: string;
  created_here: number; identity_verified: number; origin: string; title: string; name_status: string;
  external_activity: number; protected: number; archive_state: string; revision: number;
  created_at: string; updated_at: string;
}
export interface ExecutionRow {
  id: string; run_id: string; agent_id: string; provider: string; managed_thread_id: string | null;
  provider_turn_id: string | null; status: string; requested: number; provider_finished: number;
  baseline: string | null; cumulative: string | null; delta: string | null; usage_quality: UsageQuality;
  boundary_reason: string; requested_model: string | null; requested_effort: string | null;
  created_at: string; finished_at: string | null;
}
export interface ProviderThreadObservation {
  instanceId: string; identityVerified: boolean; threadId: string; createdHere: boolean;
  priorTurnIds: string[] | null; priorTurnsClosed: boolean; title?: string;
}
export interface UsageSummary {
  usageStatus: UsageQuality; codexUsage: TokenCounts | null; missingExecutions: number;
  executions: number; pendingExecutions: number;
}
const now = () => new Date().toISOString();
export const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const id = (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "")}`;
const countKeys = ["inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"] as const;
const zero = (): TokenCounts => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
const active = (status: string) => ["starting", "queued", "running"].includes(status);
export const WORK_RUN_LEASE_MS = 15 * 60 * 1000;
export const EXECUTION_OBSERVATION_MS = 30_000;
const leaseExpiry = (at = Date.now()) => new Date(at + WORK_RUN_LEASE_MS).toISOString();

export class WorkFinishBlockedError extends Error {
  readonly nextAction = "Observe this run's children until terminal, then retry finish. For unresolved claims/waiters, ask their owner to reconcile and release them; never steal a lock.";
  constructor(readonly blocking: "active_execution" | "active_operation" | "same_run_claim" | "unproven_claim", message: string) {
    super(message);
  }
}

/** Absence of a callback is not proof that no request was sent. Old pooled
 * executions can have a successful result with all lifecycle fields missing. */
export function executionUsage(row: ExecutionRow): { usageStatus: UsageQuality; codexUsage: TokenCounts | null } {
  const possiblyUsed = row.requested !== 0 || row.provider_turn_id !== null || row.provider_finished !== 0 ||
    row.cumulative !== null || row.delta !== null || row.usage_quality !== "not_used" ||
    row.status === "completed" || row.boundary_reason === "provider_dispatch_unconfirmed";
  if (!possiblyUsed) return { usageStatus: "not_used", codexUsage: zero() };
  if (!row.delta) return { usageStatus: "unavailable", codexUsage: null };
  return { usageStatus: row.usage_quality === "complete" ? "complete" : "partial", codexUsage: JSON.parse(row.delta) as TokenCounts };
}

export function summarizeExecutions(rows: ExecutionRow[]): UsageSummary {
  const codex = rows.filter((row) => row.provider === "codex");
  const requested = codex.filter((row) => executionUsage(row).usageStatus !== "not_used");
  const contributing = requested.filter((row) => row.delta !== null);
  const missing = requested.filter((row) => executionUsage(row).usageStatus !== "complete").length;
  let totals: TokenCounts | null = requested.length === 0 ? zero() : contributing.length === 0 ? null : zero();
  if (contributing.length) {
    const values = contributing.map((row) => JSON.parse(row.delta!) as TokenCounts);
    totals = Object.fromEntries(countKeys.flatMap((key) => values.every((value) => value[key] !== undefined)
      ? [[key, values.reduce((sum, value) => sum + value[key]!, 0)]] : [])) as TokenCounts;
  }
  return { usageStatus: !requested.length ? "not_used" : !contributing.length ? "unavailable" : missing ? "partial" : "complete",
    codexUsage: totals, missingExecutions: missing, executions: codex.length,
    pendingExecutions: codex.filter((row) => active(row.status)).length };
}

/** Work/task accounting is separate from model sessions. No model calls occur here. */
export class WorkLedger {
  readonly database: DatabaseHandle;
  constructor(readonly stateDir: string) { this.database = openDatabase(stateDir); }
  close(): void { this.database.close(); }
  get db() { return this.database.sqlite; }

  project(root: string, name?: string): ProjectRow {
    if (name !== undefined && (!name.trim() || name.length > 200)) throw new Error("Project name must contain 1–200 characters.");
    const canonical = canonicalWorkspaceRoot(root);
    const projectId = `prj_${digest(canonical).slice(0, 24)}`;
    this.db.prepare("insert or ignore into console_projects(id, root, name, created_at) values (?,?,?,?)")
      .run(projectId, canonical, basename(root), now());
    if (name !== undefined) this.db.prepare("update console_projects set name = ? where id = ?").run(name.trim(), projectId);
    return this.getProject(projectId);
  }
  getProject(projectId: string): ProjectRow {
    const row = this.db.prepare("select * from console_projects where id=?").get(projectId) as ProjectRow | undefined;
    if (!row) throw new Error("Project not found.");
    return row;
  }
  projects(): ProjectRow[] { return this.db.prepare("select * from console_projects order by name, id").all() as ProjectRow[]; }

  begin(input: { root: string; workspaceId?: string; workItemId: string; runKey: string; title: string; origin: WorkOrigin }): WorkRunRow {
    for (const key of [input.workItemId, input.runKey]) if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(key)) throw new Error("Invalid work identity.");
    const title = input.title.trim().slice(0, 200);
    if (!title) throw new Error("A work title is required.");
    return this.db.transaction(() => {
      const project = this.project(input.root);
      const itemId = `work_${digest([project.id, input.workItemId]).slice(0, 24)}`;
      const requestHash = digest([project.id, input.workItemId, input.runKey, title, input.workspaceId ?? null, input.origin]);
      const existing = this.db.prepare("select * from console_work_runs where item_id=? and run_key=?").get(itemId, input.runKey) as WorkRunRow | undefined;
      if (existing) {
        this.reconcileRun(existing.id);
        const current = this.rawRun(existing.id);
        if (current.status === "interrupted") {
          if (!this.hasActiveChild(current.id)) {
            this.db.prepare("update console_work_runs set request_hash=? where id=?").run(requestHash, current.id);
            return this.resume(current.id);
          }
          return current;
        }
        if (current.status === "running") {
          if (current.request_hash !== requestHash) throw new Error("Work request key belongs to different inputs.");
          this.touch(current.id);
          return this.rawRun(current.id);
        }
        if (current.request_hash !== requestHash) throw new Error("Work request key belongs to different inputs.");
        return current;
      }
      this.db.prepare("insert or ignore into console_work_items(id,project_id,item_key,title,created_at) values (?,?,?,?,?)")
        .run(itemId, project.id, input.workItemId, title, now());
      const runId = id("run");
      const createdAt = now();
      this.db.prepare(`insert into console_work_runs(id,project_id,item_id,workspace_id,run_key,request_hash,origin,created_at,last_activity_at,lease_expires_at)
        values(?,?,?,?,?,?,?,?,?,?)`).run(runId, project.id, itemId, input.workspaceId ?? null, input.runKey, requestHash,
          JSON.stringify(input.origin), createdAt, createdAt, leaseExpiry());
      return this.rawRun(runId);
    }).immediate();
  }
  private rawRun(runId: string): WorkRunRow {
    const row = this.db.prepare(`select r.*, i.title from console_work_runs r join console_work_items i on r.item_id=i.id where r.id=?`)
      .get(runId) as WorkRunRow | undefined;
    if (!row) throw new Error("Work run not found.");
    return row;
  }
  run(runId: string): WorkRunRow {
    return this.rawRun(runId);
  }
  setRunTitle(runId: string, title: string): void {
    const value = title.trim().slice(0, 200);
    if (!value) throw new Error("A work title is required.");
    const row = this.rawRun(runId);
    if (row.title === value) return;
    this.db.transaction(() => {
      this.db.prepare("update console_work_items set title=? where id=?").run(value, row.item_id);
      this.touch(runId);
    }).immediate();
  }
  requireScope(runId: string, root: string, workspaceId?: string): WorkRunRow {
    const row = this.run(runId);
    if (this.getProject(row.project_id).root !== canonicalWorkspaceRoot(root) ||
      (row.workspace_id !== null && row.workspace_id !== workspaceId)) throw new Error("Work run is outside this workspace scope.");
    return row;
  }
  touch(runId: string): void {
    const at = now();
    this.db.prepare(`update console_work_runs set revision=revision+1,
      last_activity_at=case when status='running' then ? else last_activity_at end,
      lease_expires_at=case when status='running' then ? else lease_expires_at end where id=?`)
      .run(at, leaseExpiry(), runId);
  }

  heartbeat(runId: string): void {
    this.db.prepare("update console_work_runs set lease_expires_at=? where id=? and status='running'")
      .run(leaseExpiry(), runId);
  }

  // 仅由拥有内存中执行句柄的监督器调用；观察本身不改变进展、输出或任务修订。
  observeOperations(operationIds: readonly string[], at = now()): void {
    if (!operationIds.length) return;
    this.db.transaction(() => {
      const update=this.db.prepare("update console_operations set observed_at=? where id=? and status in ('starting','queued','running')");
      for (const operationId of operationIds) update.run(at,operationId);
    })();
  }

  observeAgent(agentId: string, at = now()): void {
    this.db.prepare("update console_executions set observed_at=? where agent_id=? and status in ('starting','queued','running')").run(at,agentId);
  }

  hasConfirmedAgent(agentId: string, at = Date.now()): boolean {
    return Boolean(this.db.prepare("select 1 from console_executions where agent_id=? and status in ('starting','queued','running') and observed_at>=? limit 1")
      .get(agentId,new Date(at-EXECUTION_OBSERVATION_MS).toISOString()));
  }

  hasConfirmedChild(runId: string, at = Date.now()): boolean {
    const after = new Date(at - EXECUTION_OBSERVATION_MS).toISOString();
    return Boolean(this.db.prepare(`select 1 from console_operations where run_id=? and status in ('starting','queued','running') and observed_at>=?
      union all select 1 from console_executions where run_id=? and status in ('starting','queued','running') and observed_at>=? limit 1`)
      .get(runId,after,runId,after));
  }

  hasActiveChild(runId: string): boolean {
    if (this.db.prepare("select 1 from console_executions where run_id=? and status in ('starting','queued','running') limit 1").get(runId)) return true;
    if (this.db.prepare("select 1 from console_operations where run_id=? and status in ('starting','queued','running') limit 1").get(runId)) return true;
    const claims = this.db.prepare(`select owner_pid from execution_claims where agent_id in
      (select distinct agent_id from console_executions where run_id=?)`).all(runId) as { owner_pid: number }[];
    return claims.some((claim) => pidAlive(claim.owner_pid));
  }

  reconcileRun(runId: string): boolean {
    const row = this.rawRun(runId);
    if (row.status !== "running") return false;
    // 状态查询和定期核对不伪造进展；活性租约由执行所有者续期。
    const linked = this.db.prepare("select t.state from qm_run_links l join qm_tasks t on t.id=l.task_id where l.run_id=?").get(runId) as {state:string}|undefined;
    return linked?.state === "closed" ? this.interruptIdleRun(runId) : false;
  }

  reconcileTerminalOperations(): number {
    return this.db.transaction(() => {
      const rows = this.db.prepare(`select o.id,o.run_id,i.state,i.finished_at from console_operations o
        join qm_invocations i on i.operation_id=o.id
          and not exists(select 1 from qm_invocations n where n.retry_of_invocation_id=i.id)
          and (i.retry_of_invocation_id is null or i.id=o.request_key)
        where o.status in ('starting','queued','running') and i.finished_at is not null
        and i.state in ('succeeded','failed','cancelled')`).all() as Array<{id:string;run_id:string;state:string;finished_at:string}>;
      for (const row of rows) {
        this.db.prepare("update console_operations set status=?,finished_at=? where id=?")
          .run(row.state === "succeeded" ? "completed" : row.state, row.finished_at, row.id);
        this.db.prepare(`update console_work_runs set revision=revision+1,
          last_activity_at=case when last_activity_at is null or last_activity_at<? then ? else last_activity_at end where id=?`)
          .run(row.finished_at,row.finished_at,row.run_id);
      }
      return rows.length;
    }).immediate();
  }

  reconcileStaleRuns(projectId?: string): number {
    const rows = (projectId
      ? this.db.prepare("select id from console_work_runs where project_id=? and status='running'").all(projectId)
      : this.db.prepare("select id from console_work_runs where status='running'").all()) as { id: string }[];
    let changed = 0;
    for (const row of rows) if (this.reconcileRun(row.id)) changed++;
    return changed;
  }

  // 任务进入归档/接力状态时，结束已经没有受管子任务的旧卡片计时。
  // 未确认结束的进程和操作保留原状态，绝不伪造完成或取消结果。
  archiveTaskRuns(taskId: string): number {
    let changed = 0;
    for (const row of this.db.prepare(`select id from console_work_runs
      where status='running' and substr(run_key,6,37)=? and run_key like 'task-task_%'`).all(taskId) as { id: string }[]) {
      if (this.interruptIdleRun(row.id)) changed++;
    }
    return changed;
  }

  // 持续回收已经关闭任务的悬挂运行；仍有未闭合子操作时保留核对入口。
  reconcileArchivedTaskRuns(): number {
    const rows = this.db.prepare(`select r.id from console_work_runs r
      left join qm_run_links l on l.run_id=r.id
      join qm_tasks t on t.id=COALESCE(l.task_id,case when r.run_key like 'task-task_%' then substr(r.run_key,6,37) end)
      where r.status='running' and t.state='closed'`).all() as { id: string }[];
    let changed = 0;
    for (const row of rows) if (this.interruptIdleRun(row.id)) changed++;
    return changed;
  }

  private interruptIdleRun(runId: string): boolean {
    const row = this.rawRun(runId);
    if (row.status !== "running" || this.hasActiveChild(runId)) return false;
    const at = now();
    return this.db.prepare(`update console_work_runs set status='interrupted', interrupted_at=?,
      lease_expires_at=?,revision=revision+1 where id=? and status='running'`).run(at, at, runId).changes > 0;
  }

  resume(runId: string): WorkRunRow {
    return this.db.transaction(() => {
      const row = this.rawRun(runId);
      if (row.status === "running") { this.touch(runId); return this.rawRun(runId); }
      if (!["interrupted", "reconciliation_required"].includes(row.status)) throw new Error("Only interrupted or reconciliation-required work can be resumed.");
      if (this.hasActiveChild(runId)) throw new Error("Work still has active managed children; reconcile them before resuming.");
      const at = now();
      this.db.prepare(`update console_work_runs set status='running',finished_at=null,last_activity_at=?,lease_expires_at=?,
        interrupted_at=null,resume_count=resume_count+1,revision=revision+1 where id=?`).run(at, leaseExpiry(), runId);
      return this.rawRun(runId);
    }).immediate();
  }

  operation(input: { id?: string; runId: string; requestKey: string; kind: string; label: string; status: string; evidence?: Evidence[]; retryOfInvocationId?: string }): string {
    return this.db.transaction(() => {
      const run = this.run(input.runId);
      if (run.status !== "running") throw new Error("Cannot add operations to a closed work run.");
      const evidence = validateEvidence(input.evidence ?? []);
      if (input.retryOfInvocationId && input.id) {
        const refused = this.db.prepare(`SELECT p.state,p.effect,p.result_json FROM qm_invocations i
          JOIN qm_invocations p ON p.id=i.retry_of_invocation_id JOIN qm_tasks t ON t.id=i.task_id
          JOIN qm_run_links l ON l.run_id=? AND l.task_id=i.task_id AND l.member_id=i.member_id
          WHERE i.id=? AND i.operation_id=? AND p.id=? AND i.state='accepted' AND i.effect='not_started'
            AND t.state='active' AND NOT EXISTS(SELECT 1 FROM qm_invocations n WHERE n.retry_of_invocation_id=i.id)`)
          .get(input.runId,input.requestKey,input.id,input.retryOfInvocationId) as Parameters<typeof retryableAdmission>[0] | undefined;
        if (!refused || !retryableAdmission(refused)) throw new Error("OPERATION_RETRY_NOT_ALLOWED");
        const resumed = this.db.prepare(`UPDATE console_operations SET run_id=?,request_key=?,status=?,evidence=?,finished_at=NULL,observed_at=?
          WHERE id=? AND request_key=? AND kind=? AND label=? AND status IN ('starting','queued','running','failed')`)
          .run(input.runId,input.requestKey,input.status,JSON.stringify(evidence),now(),input.id,input.retryOfInvocationId,input.kind.slice(0,64),input.label.slice(0,200));
        if (resumed.changes) {this.touch(input.runId); return input.id;}
        if (this.db.prepare("SELECT 1 FROM console_operations WHERE id=?").get(input.id)) throw new Error("OPERATION_RETRY_SUPERSEDED");
      }
      const previous = this.db.prepare("select * from console_operations where run_id=? and request_key=?")
        .get(input.runId, input.requestKey) as { id: string; kind: string; label: string; status: string; evidence: string } | undefined;
      if (previous) {
        if (previous.kind !== input.kind || previous.label !== input.label || previous.status !== input.status || previous.evidence !== JSON.stringify(evidence)) {
          throw new Error("Operation request key cannot be reused with different evidence.");
        }
        return previous.id;
      }
      const operationId = input.id ?? id("op");
      this.db.prepare(`insert into console_operations(id,run_id,request_key,kind,label,status,evidence,created_at,finished_at) values(?,?,?,?,?,?,?,?,?)`)
        .run(operationId, input.runId, input.requestKey.slice(0, 160), input.kind.slice(0, 64), input.label.slice(0, 200),
          input.status, JSON.stringify(evidence), now(), active(input.status) ? null : now());
      this.db.prepare("update console_operations set observed_at=? where id=?").run(now(),operationId);
      this.touch(input.runId); return operationId;
    }).immediate();
  }
  endOperation(operationId: string, status: "completed" | "failed" | "cancelled" | "reconciliation_required", evidence: Evidence[] = [], requestKey?: string): void {
    const op = this.db.prepare("select run_id,status from console_operations where id=?").get(operationId) as { run_id: string; status: string } | undefined;
    if (!op || !active(op.status)) return;
    const updated = this.db.prepare(`update console_operations set status=?, evidence=?, finished_at=? where id=?
      and status in ('starting','queued','running') and (? is null or request_key=?)`)
      .run(status, JSON.stringify(validateEvidence(evidence)), now(), operationId, requestKey ?? null, requestKey ?? null);
    if (!updated.changes) return;
    if (status === "reconciliation_required") this.markRunReconciliationRequired(op.run_id);
    this.touch(op.run_id);
  }

  markRunReconciliationRequired(runId: string): void {
    this.db.prepare("update console_work_runs set status='reconciliation_required', revision=revision+1 where id=? and status in ('running','interrupted')").run(runId);
  }

  beginExecution(input: { runId: string; agentId: string; provider: string; model?: string; effort?: string }): string {
    return this.db.transaction(() => {
    const run = this.run(input.runId);
    if (run.status !== "running") throw new Error("Work run has closed; begin a new run before invoking a provider.");
    this.assertAgentUsable(input.agentId);
    const executionId = id("exec");
    this.db.prepare(`insert into console_executions(id,run_id,agent_id,provider,status,requested_model,requested_effort,created_at)
      values(?,?,?,?,?,?,?,?)`).run(executionId, run.id, input.agentId, input.provider, "queued", input.model ?? null, input.effort ?? null, now());
    this.db.prepare("update console_executions set observed_at=? where id=?").run(now(),executionId);
    this.touch(run.id); return executionId;
    }).immediate();
  }
  execution(executionId: string): ExecutionRow {
    const row = this.db.prepare("select * from console_executions where id=?").get(executionId) as ExecutionRow | undefined;
    if (!row) throw new Error("Execution not found.");
    return row;
  }
  latestExecution(agentId: string): ExecutionRow | undefined {
    return this.db.prepare("select * from console_executions where agent_id=? order by rowid desc limit 1").get(agentId) as ExecutionRow | undefined;
  }

  saveResponse(executionId: string, response: string): void {
    this.execution(executionId);
    this.db.prepare("insert or ignore into execution_responses(execution_id,response,sha256,bytes) values(?,?,?,?)")
      .run(executionId, response, createHash("sha256").update(response).digest("hex"), Buffer.byteLength(response));
  }

  successfulExecution(agentId: string, runId: string) {
    return this.db.prepare(`select e.id executionId,e.run_id workRunId,e.provider_turn_id providerTurnId,
      e.managed_thread_id managedThreadId,e.finished_at finishedAt,r.sha256,r.bytes,
      r.execution_id is not null responseAvailable from console_executions e
      left join execution_responses r on r.execution_id=e.id
      where e.agent_id=? and e.run_id=? and e.status='completed' order by e.rowid desc limit 1`)
      .get(agentId, runId) as { executionId: string; workRunId: string; providerTurnId: string | null;
        managedThreadId: string | null; finishedAt: string | null; sha256: string | null; bytes: number | null; responseAvailable: number } | undefined;
  }

  providerNotRequested(executionId: string): void {
    const row = this.execution(executionId);
    // Positive adapter evidence cannot erase a lifecycle/usage observation.
    this.db.prepare(`update console_executions set usage_quality='not_used',boundary_reason='confirmed_before_inference'
      where id=? and requested=0 and provider_turn_id is null and provider_finished=0 and delta is null and cumulative is null`).run(executionId);
    this.touch(row.run_id);
  }

  reconcileInterruptedExecutions(): number {
    return this.db.transaction(() => {
      const rows = this.db.prepare("select * from console_executions where status in ('starting','queued','running')").all() as ExecutionRow[];
      for (const row of rows) {
        this.db.prepare("update console_executions set status='reconciliation_required',finished_at=? where id=?").run(now(), row.id);
        this.db.prepare("update console_work_runs set status='reconciliation_required',revision=revision+1 where id=?").run(row.run_id);
      }
      return rows.length;
    }).immediate();
  }

  reconcileOrphanedOperations(): number {
    return this.db.transaction(() => {
      const rows = this.db.prepare("select id, run_id, evidence from console_operations where status in ('starting','queued','running')").all() as { id: string; run_id: string; evidence: string }[];
      const at = now();
      for (const row of rows) {
        let list: Evidence[] = [];
        try {
          const parsed = JSON.parse(row.evidence) as unknown;
          if (Array.isArray(parsed)) list = parsed as Evidence[];
        } catch { list = []; }
        list.push({ label: "In-flight operation lost its owner process", outcome: "not_run",
          reference: JSON.stringify({ version: 1, boundary: "process_restart", operationId: row.id, retry: "reconcile_before_replay" }) });
        this.db.prepare("update console_operations set status='reconciliation_required', finished_at=?, evidence=? where id=?").run(at, JSON.stringify(list), row.id);
        this.db.prepare("update console_work_runs set status='reconciliation_required', revision=revision+1 where id=? and status='running'").run(row.run_id);
      }
      return rows.length;
    }).immediate();
  }

  /**
   * Release only claims whose owner pid is gone. Terminal agent claims are deleted after an evidence row.
   * Command/process claims, and agent claims that still look active, first mark the run reconciliation_required.
   * Never `DELETE FROM execution_claims`.
   */
  reconcileDeadExecutionClaims(isAlive: (pid: number) => boolean = pidAlive): { released: number; reconciled: number } {
    return this.db.transaction(() => {
      const claims = this.db.prepare("select id, owner_pid, kind, checkout_root, agent_id from execution_claims").all() as { id: string; owner_pid: number; kind: string; checkout_root: string; agent_id: string | null }[];
      let released = 0;
      let reconciled = 0;
      for (const claim of claims) {
        if (isAlive(claim.owner_pid)) continue;
        const latest = claim.agent_id
          ? this.db.prepare("select id, run_id, status from console_executions where agent_id=? order by rowid desc limit 1").get(claim.agent_id) as { id: string; run_id: string; status: string } | undefined
          : undefined;
        const agent = claim.agent_id
          ? this.db.prepare("select status from local_agent_sessions where id=?").get(claim.agent_id) as { status: string } | undefined
          : undefined;
        const executionHot = Boolean(latest && ["starting", "queued", "running"].includes(latest.status));
        const terminalAgent = claim.kind === "agent" && Boolean(agent) && ["error", "stopped", "idle"].includes(agent!.status) && !executionHot;
        const runIds = new Set<string>();
        if (latest?.run_id) runIds.add(latest.run_id);
        if (!terminalAgent) {
          const rootRuns = this.db.prepare(`select r.id from console_work_runs r join console_projects p on p.id=r.project_id
            where r.status='running' and p.root=?`).all(claim.checkout_root) as { id: string }[];
          for (const row of rootRuns) runIds.add(row.id);
        }
        const reason = terminalAgent ? "dead_owner_terminal_agent" : claim.kind === "agent" ? "dead_owner_unproven_agent" : "dead_owner_command";
        this.db.prepare(`insert into execution_claim_reconciliations(id, claim_id, kind, owner_pid, agent_id, checkout_root, run_id, reason, evidence, created_at)
          values(?,?,?,?,?,?,?,?,?,?)`).run(id("claimrec"), claim.id, claim.kind, claim.owner_pid, claim.agent_id, claim.checkout_root,
            [...runIds][0] ?? null, reason, JSON.stringify({ version: 1, retry: "reconcile_before_replay", runIds: [...runIds], executionId: latest?.id ?? null, executionStatus: latest?.status ?? null, agentStatus: agent?.status ?? null }), now());
        if (!terminalAgent) {
          for (const runId of runIds) {
            const changed = this.db.prepare("update console_work_runs set status='reconciliation_required', revision=revision+1 where id=? and status in ('running','interrupted')").run(runId);
            if (changed.changes > 0) reconciled++;
          }
          if (latest && executionHot) {
            this.db.prepare("update console_executions set status='reconciliation_required', finished_at=? where id=? and status in ('starting','queued','running')").run(now(), latest.id);
          }
        }
        this.db.prepare("delete from execution_claims where id=?").run(claim.id);
        released++;
      }
      const waiters = this.db.prepare("select id, owner_pid, kind, checkout_root, agent_id from execution_waiters").all() as { id: string; owner_pid: number; kind: string; checkout_root: string; agent_id: string | null }[];
      for (const waiter of waiters) {
        if (isAlive(waiter.owner_pid)) continue;
        this.db.prepare(`insert into execution_claim_reconciliations(id, claim_id, kind, owner_pid, agent_id, checkout_root, run_id, reason, evidence, created_at)
          values(?,?,?,?,?,?,?,?,?,?)`).run(id("claimrec"), waiter.id, waiter.kind, waiter.owner_pid, waiter.agent_id, waiter.checkout_root, null, "dead_waiter",
            JSON.stringify({ version: 1, boundary: "waiter", retry: "not_started" }), now());
        this.db.prepare("delete from execution_waiters where id=?").run(waiter.id);
        released++;
      }
      return { released, reconciled };
    }).immediate();
  }

  assertAgentUsable(agentId: string): void {
    const locked = this.db.prepare("select archive_state from console_threads where agent_id=? and archive_state != 'active'").get(agentId);
    if (locked) throw new Error("The managed Codex thread is archived or needs reconciliation; restore it before resuming.");
  }

  attachThread(executionId: string, observation: ProviderThreadObservation): string {
    return this.db.transaction(() => {
      const execution = this.execution(executionId); const run = this.run(execution.run_id);
      const threadKey = `thr_${digest([observation.instanceId, observation.threadId]).slice(0, 32)}`;
      const found = this.db.prepare("select * from console_threads where id=?").get(threadKey) as ManagedThreadRow | undefined;
      if (!observation.createdHere && this.db.prepare("select id from console_threads where agent_id=? and instance_id!=?").get(execution.agent_id, observation.instanceId)) {
        throw new Error("The provider instance changed; a registered conversation cannot be resumed under another identity.");
      }
      if (found && (found.project_id !== run.project_id || found.agent_id !== execution.agent_id || found.archive_state !== "active")) {
        throw new Error("Provider thread identity is already owned elsewhere or is not active.");
      }
      if (!found) this.db.prepare(`insert into console_threads(id,project_id,agent_id,instance_id,thread_id,created_here,
        identity_verified,origin,title,protected,created_at,updated_at) values(?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(threadKey, run.project_id, execution.agent_id, observation.instanceId, observation.threadId,
          observation.createdHere ? 1 : 0, observation.identityVerified ? 1 : 0, run.origin,
          observation.title ?? this.sessionTitle(run.id, execution.agent_id), observation.createdHere ? 0 : 1, now(), now());
      const prior = this.db.prepare("select * from console_executions where managed_thread_id=? and id!=? order by rowid desc")
        .all(threadKey, executionId) as ExecutionRow[];
      const knownIds = new Set(prior.flatMap((row) => row.provider_turn_id ? [row.provider_turn_id] : []));
      const ids = observation.priorTurnIds;
      const cleanHistory = ids !== null && observation.priorTurnsClosed &&
        ids.length === knownIds.size && ids.every((value) => knownIds.has(value));
      const external = ids !== null && ids.some((value) => !knownIds.has(value));
      if (external) this.db.prepare("update console_threads set external_activity=1,revision=revision+1,updated_at=? where id=?").run(now(), threadKey);
      let baseline: TokenCounts | null = observation.createdHere && ids?.length === 0 ? zero() : null;
      let reason = baseline ? "new_managed_thread" : external ? "unmapped_external_turns" : "unverified_history_boundary";
      const last = prior[0];
      if (!baseline && cleanHistory && last?.provider_finished && last.cumulative && last.usage_quality === "complete") {
        baseline = JSON.parse(last.cumulative) as TokenCounts; reason = "continuous_managed_history";
      }
      this.db.prepare("update console_executions set managed_thread_id=?,baseline=?,boundary_reason=? where id=?")
        .run(threadKey, baseline ? JSON.stringify(baseline) : null, reason, executionId);
      this.touch(run.id); return threadKey;
    }).immediate();
  }
  sessionTitle(runId: string, agentId: string): string {
    const run = this.run(runId); const project = this.getProject(run.project_id);
    // A run may have several independent contexts. Its ID cannot distinguish
    // their sidebar titles; the persisted agent identity survives continuations.
    return managedSessionTitle(project.name, agentId.replace(/^agt_/, ""), run.title ?? "Task");
  }
  nameResult(executionId: string, success: boolean): void {
    const execution = this.execution(executionId);
    if (execution.managed_thread_id) this.db.prepare("update console_threads set name_status=?,updated_at=? where id=?")
      .run(success ? "named" : "failed", now(), execution.managed_thread_id);
  }
  requestStarted(executionId: string): void {
    const row = this.execution(executionId);
    this.db.prepare("update console_executions set requested=1,status='running',usage_quality='unavailable' where id=?").run(executionId);
    this.touch(row.run_id);
  }
  providerDispatchStarted(executionId: string): void {
    const row = this.execution(executionId);
    // Written by the manager BEFORE entering the pool, independent of adapter
    // callbacks. If the process/adapter fails, uncertainty must not become zero.
    this.db.prepare("update console_executions set usage_quality='unavailable',boundary_reason='provider_dispatch_unconfirmed' where id=? and requested=0")
      .run(executionId);
    this.touch(row.run_id);
  }
  requestedConfiguration(executionId: string, model?: string, effort?: string): void {
    this.db.prepare("update console_executions set requested_model=?,requested_effort=? where id=?").run(model ?? null, effort ?? null, executionId);
  }
  turnStarted(executionId: string, turnId: string): void {
    if (!turnId || turnId.length > 256) throw new Error("Invalid provider turn identity.");
    const row = this.execution(executionId);
    if (row.provider_turn_id && row.provider_turn_id !== turnId) throw new Error("Execution already belongs to another provider turn.");
    this.db.prepare("update console_executions set provider_turn_id=?,requested=1 where id=?").run(turnId, executionId);
    this.touch(row.run_id);
  }
  usage(executionId: string, observation: AgentUsageObservation): void {
    this.db.transaction(() => {
      const execution = this.execution(executionId);
      if (!execution.managed_thread_id || execution.provider_turn_id !== observation.turnId) return;
      const thread = this.thread(execution.managed_thread_id);
      if (thread.thread_id !== observation.threadId) return;
      const total = observation.total;
      if (![total.inputTokens, total.outputTokens, total.totalTokens].every((value) => Number.isSafeInteger(value) && value >= 0)) return;
      const previous = execution.cumulative ? JSON.parse(execution.cumulative) as TokenCounts : undefined;
      if (previous && (total.totalTokens < previous.totalTokens || total.inputTokens < previous.inputTokens || total.outputTokens < previous.outputTokens)) return;
      if (execution.cumulative === JSON.stringify(total)) return;
      const baseline = execution.baseline ? JSON.parse(execution.baseline) as TokenCounts : undefined;
      let delta: TokenCounts | null = null;
      if (baseline && ["inputTokens", "outputTokens", "totalTokens"].every((key) => total[key as keyof TokenCounts]! >= baseline[key as keyof TokenCounts]!)) {
        delta = Object.fromEntries(countKeys.flatMap((key) => {
          const initial = baseline[key] ?? (execution.boundary_reason === "new_managed_thread" ? 0 : undefined);
          return initial !== undefined && total[key] !== undefined && total[key]! >= initial ? [[key, total[key]! - initial]] : [];
        })) as TokenCounts;
      }
      this.db.prepare("update console_executions set cumulative=?,delta=?,usage_quality=? where id=?")
        .run(JSON.stringify(total), delta ? JSON.stringify(delta) : null, delta ? (execution.provider_finished ? "complete" : "partial") : "unavailable", executionId);
      this.touch(execution.run_id);
      // If a predecessor's terminal usage arrived late, correct its direct successor's
      // saved baseline instead of billing that predecessor a second time to the successor.
      if (previous) {
        const followers = this.db.prepare(`select * from console_executions where managed_thread_id=? and id!=?
          and baseline=? and boundary_reason='continuous_managed_history'`)
          .all(execution.managed_thread_id, executionId, JSON.stringify(previous)) as ExecutionRow[];
        for (const follower of followers) {
          const cumulative = follower.cumulative ? JSON.parse(follower.cumulative) as TokenCounts : null;
          let corrected: TokenCounts | null = null;
          if (cumulative && ["inputTokens", "outputTokens", "totalTokens"].every((key) => cumulative[key as keyof TokenCounts]! >= total[key as keyof TokenCounts]!)) {
            corrected = Object.fromEntries(countKeys.flatMap((key) => cumulative[key] !== undefined && total[key] !== undefined && cumulative[key]! >= total[key]!
              ? [[key, cumulative[key]! - total[key]!]] : [])) as TokenCounts;
          }
          this.db.prepare("update console_executions set baseline=?,delta=?,usage_quality=? where id=?")
            .run(JSON.stringify(total), corrected ? JSON.stringify(corrected) : null, corrected ? (follower.provider_finished ? "complete" : "partial") : "unavailable", follower.id);
          this.touch(follower.run_id);
        }
      }
    }).immediate();
  }
  providerFinished(executionId: string): void {
    const row = this.execution(executionId);
    this.db.prepare("update console_executions set provider_finished=1,usage_quality=case when delta is not null then 'complete' else usage_quality end where id=?").run(executionId);
    this.touch(row.run_id);
  }
  endExecution(executionId: string, status: string): void {
    const row = this.execution(executionId);
    this.db.prepare("update console_executions set status=?,finished_at=? where id=?").run(status, now(), executionId);
    if (row.provider === "codex" && status === "completed" && !row.requested && !row.delta) {
      this.db.prepare("update console_executions set usage_quality='unavailable',boundary_reason='missing_lifecycle_events' where id=?").run(executionId);
    }
    this.touch(row.run_id);
  }

  executions(runId: string): ExecutionRow[] {
    return this.db.prepare("select * from console_executions where run_id=? order by rowid").all(runId) as ExecutionRow[];
  }
  receipt(runId: string) {
    const run = this.run(runId); const executions = this.executions(runId);
    const summary = summarizeExecutions(executions);
    const threadIds = [...new Set(executions.flatMap((execution) => execution.managed_thread_id ? [execution.managed_thread_id] : []))];
    const createdThreads = threadIds.filter((threadKey) => {
      const first = this.db.prepare("select run_id from console_executions where managed_thread_id=? order by rowid limit 1").get(threadKey) as { run_id: string } | undefined;
      return first?.run_id === runId && this.thread(threadKey).created_here === 1;
    }).length;
    return { workItemId: run.item_id, workRunId: run.id, projectId: run.project_id, title: run.title,
      executionStatus: run.status, acceptanceStatus: run.acceptance, ...summary,
      usageQualityReason: summary.missingExecutions ? `${summary.missingExecutions} 次执行缺少完整用量记录` : null,
      codexThreads: threadIds.length, codexThreadsCreated: createdThreads,
      codexThreadsReused: threadIds.length - createdThreads, receiptRevision: run.revision,
      accountingScope: "managed_codex_executions",
      evidence: JSON.parse(run.evidence) as Evidence[],
      origin: JSON.parse(run.origin) as WorkOrigin, finishedAt: run.finished_at,
      lastActivityAt: run.last_activity_at, leaseExpiresAt: run.lease_expires_at,
      interruptedAt: run.interrupted_at, resumeCount: run.resume_count,
      resumeAvailable: ["interrupted", "reconciliation_required"].includes(run.status),
      note: "Provider token observations, not a subscription balance or invoice. Cache input and reasoning output are already included in totals. Missing boundaries are never counted as zero." };
  }
  finish(runId: string, input: { status: "completed" | "failed" | "cancelled"; acceptance: "passed" | "failed" | "not_applicable";
    summary: string; evidence: Evidence[] }): ReturnType<WorkLedger["receipt"]> {
    return this.db.transaction(() => {
      const run = this.run(runId);
      const evidence = validateEvidence(input.evidence);
      if (input.acceptance === "passed" && !evidence.some((entry) => entry.outcome === "passed")) throw new Error("Passing acceptance requires explicit evidence, not just a model final response.");
      if (input.acceptance === "passed" && (input.status !== "completed" || evidence.some((entry) => entry.outcome === "failed"))) {
        throw new Error("Failed work/evidence cannot be recorded as passing acceptance.");
      }
      if (run.status !== "running") {
        if (run.status !== input.status || run.acceptance !== input.acceptance || run.summary !== input.summary || run.evidence !== JSON.stringify(evidence)) throw new Error("Closed work receipt cannot be silently rewritten.");
        return this.receipt(runId);
      }
      if (this.executions(runId).some((execution) => active(execution.status))) throw new WorkFinishBlockedError("active_execution", "Managed agent executions are not terminal.");
      if (this.db.prepare("select id from console_operations where run_id=? and status in ('starting','queued','running')").get(runId)) throw new WorkFinishBlockedError("active_operation", "Managed operations are still active.");
      const project = this.getProject(run.project_id);
      // Keep admission evidence and the terminal write in this immediate transaction.
      // Only a currently active execution can prove foreign ownership. In particular,
      // endExecution precedes release: a completed latest record is not such proof.
      const ownTask = this.db.prepare("select task_id from qm_run_links where run_id=?").get(runId) as {task_id:string|null}|undefined;
      const claims = this.db.prepare(`select kind,agent_id,checkout_root,acquired_at,task_id,operation_id from execution_claims
        union all select kind,agent_id,checkout_root,null as acquired_at,task_id,operation_id from execution_waiters where expires_at_ms > ?`)
        .all(Date.now()) as { kind:string; agent_id:string|null; checkout_root:string; acquired_at:string|null; task_id:string|null; operation_id:string|null }[];
      for (const claim of claims) {
        if (!overlaps(project.root, claim.checkout_root)) continue;
        // 普通命令与 Agent 都按持久身份归属核对，目录重叠不改变任务所有权。
        if (ownTask?.task_id && claim.task_id && claim.task_id !== ownTask.task_id &&
          this.db.prepare("select 1 from qm_tasks where id=?").get(claim.task_id)) continue;
        if (claim.operation_id) {
          const operationOwner = this.db.prepare("select run_id from console_operations where id=?").get(claim.operation_id) as {run_id:string}|undefined;
          if (operationOwner && operationOwner.run_id !== runId &&
            (!ownTask?.task_id || !this.db.prepare("select 1 from qm_run_links where run_id=? and task_id=?").get(operationOwner.run_id,ownTask.task_id))) continue;
        }
        const execution = claim.kind === "agent" && claim.agent_id ? this.latestExecution(claim.agent_id) : undefined;
        const owner = execution ? this.run(execution.run_id) : undefined;
        if (execution && owner && owner.id !== runId && owner.status === "running" && active(execution.status)
          && canonicalExecutionRoot(this.getProject(owner.project_id).root) === claim.checkout_root
          && (claim.acquired_at === null || Date.parse(execution.created_at) <= Date.parse(claim.acquired_at))) continue;
        throw new WorkFinishBlockedError(owner?.id === runId ? "same_run_claim" : "unproven_claim",
          "Source or process claims/waiters remain without proven active foreign ownership; reconcile them before finishing.");
      }
      this.db.prepare("update console_work_runs set status=?,acceptance=?,summary=?,evidence=?,finished_at=?,revision=revision+1 where id=?")
        .run(input.status, input.acceptance, input.summary.slice(0, 4000), JSON.stringify(evidence), now(), runId);
      return this.receipt(runId);
    }).immediate();
  }

  thread(threadKey: string): ManagedThreadRow {
    const row = this.db.prepare("select * from console_threads where id=?").get(threadKey) as ManagedThreadRow | undefined;
    if (!row) throw new Error("Managed thread not found.");
    return row;
  }
  threadRuns(threadKey: string): WorkRunRow[] {
    return this.db.prepare(`select distinct r.* from console_work_runs r join console_executions e on e.run_id=r.id where e.managed_thread_id=?`)
      .all(threadKey) as WorkRunRow[];
  }
  threads(projectId: string): ManagedThreadRow[] {
    return this.db.prepare("select * from console_threads where project_id=? order by updated_at desc,id").all(projectId) as ManagedThreadRow[];
  }
  expectedTurnIds(threadKey: string): string[] {
    return (this.db.prepare("select provider_turn_id as id from console_executions where managed_thread_id=? and provider_turn_id is not null").all(threadKey) as { id: string }[]).map((row) => row.id);
  }
  protectThread(projectId: string, threadKey: string, protect: boolean): void {
    const thread = this.thread(threadKey);
    if (thread.project_id !== projectId) throw new Error("Thread is outside this project.");
    this.db.prepare("update console_threads set protected=?,revision=revision+1,updated_at=? where id=?").run(protect ? 1 : 0, now(), threadKey);
  }
  listRuns(projectId: string, options: { limit?: number; offset?: number; source?: string; status?: string; after?: string } = {}) {
    const limit = Math.min(100, Math.max(1, options.limit ?? 50)); const offset = Math.max(0, options.offset ?? 0);
    const rows = this.db.prepare(`select r.*,i.title from console_work_runs r join console_work_items i on r.item_id=i.id
      where r.project_id=? and (?='' or r.status=?) and (?='' or r.created_at>=?)
      and (?='' or json_extract(r.origin,'$.entryPoint')=?) order by r.created_at desc,r.id limit ? offset ?`)
      .all(projectId, options.status ?? "", options.status ?? "", options.after ?? "", options.after ?? "",
        options.source ?? "", options.source ?? "", limit + 1, offset) as WorkRunRow[];
    return { entries: rows.slice(0, limit).map((row) => ({ ...this.receipt(row.id), ...runPresentation(this, row) })),
      nextOffset: rows.length > limit ? offset + limit : null };
  }
  detail(projectId: string, runId: string) {
    const run = this.run(runId); if (run.project_id !== projectId) throw new Error("Run is outside this project.");
    const operations = runOperations(this, runId);
    const executions = this.executions(runId);
    const changeSets = runChangeSets(this, operations);
    return { ...this.receipt(runId), ...runPresentation(this, run, operations), summary: run.summary, evidence: JSON.parse(run.evidence) as Evidence[],
      operations, events: runTimeline(run, operations, executions), changeSets,
      changes: changeSets.length === 1 ? changeSets[0] : null,
      turns: executions.map((row) => ({ executionId: row.id, agentId: row.agent_id, providerTurnId: row.provider_turn_id,
        managedThreadId: row.managed_thread_id, status: row.status, ...executionUsage(row), boundary: row.boundary_reason,
        requestedModel: row.requested_model, requestedEffort: row.requested_effort, createdAt: row.created_at, startedAt: row.created_at, finishedAt: row.finished_at })) };
  }
  projectUsage(projectId: string, after = "") {
    const rows = this.db.prepare(`select e.* from console_executions e join console_work_runs r on r.id=e.run_id where r.project_id=? and r.created_at>=?`)
      .all(projectId, after) as ExecutionRow[];
    const runs = this.db.prepare("select id,status,acceptance from console_work_runs where project_id=? and created_at>=?").all(projectId, after) as { id: string; status: string; acceptance: string }[];
    const missing = new Set(rows.filter((row) => row.provider === "codex" && ["unavailable", "partial"].includes(executionUsage(row).usageStatus)).map((row) => row.run_id));
    const at=Date.now();
    const liveIds = new Set(runs.filter(run => run.status === "running" && this.hasConfirmedChild(run.id,at)).map(run => run.id));
    return { ...summarizeExecutions(rows), taskCount: runs.length,
      activeTasks: runs.filter((run) => liveIds.has(run.id)).length,
      pendingAcceptance: runs.filter((run) => run.acceptance === "pending").length,
      needsAttention: runs.filter((run) => ["failed", "reconciliation_required", "interrupted"].includes(run.status) || run.acceptance === "failed" || (run.status !== "running" && missing.has(run.id))).length,
      dateBasis: "work_run_created_at" };
  }

  /** Imports association only: historical provider IDs are not proof of exclusive ownership. */
  importLegacy(root: string): void {
    const project = this.project(root);
    const records = this.db.prepare(`select id,workspace_root,workspace_id,provider_session_id,provider,created_at from local_agent_sessions
      where ${process.platform === "win32" ? "lower(workspace_root)=lower(?)" : "workspace_root=?"} and status in ('idle','error','stopped')`)
      .all(root) as { id: string; workspace_root: string; workspace_id: string | null; provider_session_id: string | null; provider: string; created_at: string }[];
    for (const record of records) {
      if (this.db.prepare("select id from console_executions where agent_id=? limit 1").get(record.id)) continue;
      const run = this.begin({ root, workspaceId: record.workspace_id ?? undefined, workItemId: `legacy-${record.id}`, runKey: "historical",
        title: `历史 QuayMesh 会话 · ${record.id}`, origin: { entryPoint: "legacy_unknown", evidence: "historical_association" } });
      const executionId = this.beginExecution({ runId: run.id, agentId: record.id, provider: record.provider });
      if (record.provider_session_id && record.provider === "codex") {
        this.attachThread(executionId, { instanceId: "legacy-unverified", identityVerified: false, threadId: record.provider_session_id,
          createdHere: false, priorTurnIds: null, priorTurnsClosed: false, title: "历史会话（创建来源待核实）" });
        this.requestStarted(executionId);
      }
      this.endExecution(executionId, "reconciliation_required");
      this.db.prepare("update console_work_runs set status='reconciliation_required',summary=? where id=?")
        .run("历史记录仅能证明 QuayMesh 关联；实际创建来源、执行边界与完整用量未确认，不自动归档。", run.id);
    }
    void project;
  }
}

export function validateEvidence(value: Evidence[]): Evidence[] {
  if (!Array.isArray(value) || value.length > 40 || value.some((entry) => !entry ||
    typeof entry.label !== "string" || entry.label.length > 200 || typeof entry.reference !== "string" || entry.reference.length > 1200 ||
    !["passed", "failed", "not_run"].includes(entry.outcome))) throw new Error("Invalid bounded acceptance evidence.");
  return value.map(({ label, reference, outcome }) => ({ label, reference, outcome }));
}


