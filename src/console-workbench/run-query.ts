import type { WorkLedger } from "../work-ledger.js";
import { LAST_RUN_OUTCOME_SQL } from "../work-outcome.js";
import { workspaceHandle, parseWorkspaceHandle } from "../federation/routing.js";
import { dayAt, type Query } from "./query.js";
import { WorkbenchError, type Run } from "./types.js";

import { runExecutionStatus } from "../task-view.js";
import { executionTimeEnd } from "../console-task-state.js";

export interface PageBoundary {
  value: number;
  id: string;
  direction: "next" | "previous";
  offset: number;
  at: number;
  snapshot?: string;
}

export function decodeBoundary(cursor?: string): PageBoundary | null {
  if (!cursor || cursor === "0") return null;
  try {
    if (!/^[A-Za-z0-9_-]+$/u.test(cursor) || cursor.length > 8192) throw new Error("invalid encoding");
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    const b = value as Partial<PageBoundary> | null;
    if (!b || typeof b !== "object" || Array.isArray(b) || !Number.isFinite(b.value) || typeof b.id !== "string"
      || !Number.isSafeInteger(b.offset) || b.offset! < 0 || !Number.isFinite(b.at)
      || !["next", "previous"].includes(b.direction ?? "") || b.snapshot !== undefined && typeof b.snapshot !== "string") throw new Error("invalid boundary");
    return b as PageBoundary;
  } catch {
    throw new WorkbenchError("任务分页游标无效，请从第一页重新读取", 400, "invalid_cursor", "none");
  }
}

export function runSortValue(run: Run, query: Query, at: number): number {
  const end = executionTimeEnd(run, at);
  return query.sort === "tokens" ? run.usage.total ?? -1
    : query.sort === "duration" ? end === null ? -1 : Math.max(0, end - run.startedAt) : run.startedAt;
}

export function compareRuns(a: Run, b: Run, query: Query, at: number): number {
  const delta = runSortValue(a, query, at) - runSortValue(b, query, at);
  return (query.sort === "oldest" ? delta : -delta) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function pageCursor(run: Run, query: Query, at: number, offset: number, direction: PageBoundary["direction"]): string {
  return Buffer.from(JSON.stringify({ value: runSortValue(run, query, at), id: run.id, at, offset, direction })).toString("base64url");
}

export interface RunQueryOptions { ids?: readonly string[]; counts?: boolean }
interface RunSelection { sql: string; params: Array<string | number> }
interface CountedRunSelection extends RunSelection { total: number; counts: Record<string, number> }

// 摘要与聚合可跳过未使用的计数；指定 ID 必须在关联和状态分类前限制候选。
export function runQuery(ledger: WorkLedger, nodeId: string, projectIds: string[], query: Query, at: number,
  options: RunQueryOptions & { counts: false }): RunSelection;
export function runQuery(ledger: WorkLedger, nodeId: string, projectIds: string[], query: Query, at: number,
  options?: RunQueryOptions & { counts?: true }): CountedRunSelection;
export function runQuery(ledger: WorkLedger, nodeId: string, projectIds: string[], query: Query, at: number,
  options: RunQueryOptions = {}): RunSelection | CountedRunSelection {
  const db = ledger.db;
  db.function("quaymesh_execution_status", {deterministic:true},
    (state: unknown, result: unknown, status: unknown, working: unknown, queued: unknown, unresolved: unknown,progress:unknown,finalizing:unknown,lastOutcome:unknown) =>
      runExecutionStatus(state as string|null, result as string|null, String(status), working === 1, queued === 1, unresolved === 1,
        typeof progress==='string'?Date.parse(progress):null,at,finalizing===1,typeof lastOutcome==='string'?lastOutcome:null));
  const allowed = projectIds.length ? `r.project_id IN (${projectIds.map(() => "?").join(",")})` : "0";
  const requested = options.ids === undefined ? "1" : options.ids.length ? "r.id IN (SELECT value FROM json_each(?))" : "0";
  const prefix = workspaceHandle(nodeId, "");
  const sql = `WITH base AS (
    SELECT r.*,COALESCE(t.title,s.title,i.title) title,p.root,p.name project_name,?||r.id reference,
      l.session_id,l.task_id,l.member_id,
      t.state task_state,t.result_status task_result,t.finished_at task_finished_at,
      f.requested_at finalization_requested_at,f.error finalization_error,
      CASE WHEN f.task_id IS NOT NULL AND (f.completed_at IS NULL OR t.state='active') THEN 1 ELSE 0 END finalizing,
      CASE WHEN l.run_id=(SELECT run_id FROM qm_run_links WHERE member_id=l.member_id AND task_id IS l.task_id ORDER BY rowid DESC LIMIT 1) THEN 1 ELSE 0 END latest,
      CASE WHEN EXISTS(SELECT 1 FROM console_operations o WHERE o.run_id=r.id AND o.status IN ('running','starting') AND o.observed_at>='${new Date(at-30_000).toISOString()}')
        OR EXISTS(SELECT 1 FROM console_executions e WHERE e.run_id=r.id AND e.status IN ('running','starting') AND e.observed_at>='${new Date(at-30_000).toISOString()}') THEN 1 ELSE 0 END working,
      CASE WHEN EXISTS(SELECT 1 FROM console_operations o WHERE o.run_id=r.id AND o.status='queued' AND o.observed_at>='${new Date(at-30_000).toISOString()}')
        OR EXISTS(SELECT 1 FROM console_executions e WHERE e.run_id=r.id AND e.status='queued' AND e.observed_at>='${new Date(at-30_000).toISOString()}') THEN 1 ELSE 0 END queued,
      CASE WHEN r.status='reconciliation_required' OR EXISTS(SELECT 1 FROM console_operations o WHERE o.run_id=r.id AND (o.status IN ('unknown','reconciliation_required')
          OR (o.status IN ('running','starting','queued') AND (o.observed_at IS NULL OR o.observed_at<'${new Date(at-30_000).toISOString()}'))))
        OR EXISTS(SELECT 1 FROM console_executions e WHERE e.run_id=r.id AND (e.status IN ('unknown','reconciliation_required')
          OR (e.status IN ('running','starting','queued') AND (e.observed_at IS NULL OR e.observed_at<'${new Date(at-30_000).toISOString()}')))) THEN 1 ELSE 0 END unresolved,
      ${LAST_RUN_OUTCOME_SQL} last_outcome,
      (SELECT SUM(json_extract(e.delta,'$.totalTokens')) FROM console_executions e WHERE e.run_id=r.id) tokens,
      k.files_json archived_files
    FROM console_work_runs r JOIN console_work_items i ON i.id=r.item_id
      JOIN console_projects p ON p.id=r.project_id
      LEFT JOIN qm_run_links l ON l.run_id=r.id
      LEFT JOIN qm_session_members m ON m.id=l.member_id
      LEFT JOIN qm_sessions s ON s.id=l.session_id
      LEFT JOIN qm_tasks t ON t.id=l.task_id
      LEFT JOIN qm_task_finalizations f ON f.task_id=t.id
      LEFT JOIN qm_run_checkpoints k ON k.run_id=r.id
    WHERE ${allowed} AND (l.run_id IS NULL OR m.node_id=?) AND ${requested}
  ), classified AS (
    SELECT *,quaymesh_execution_status(task_state,task_result,status,working,queued,unresolved,last_activity_at,finalizing,last_outcome) execution,
      CASE WHEN last_outcome IN ('failed','stopped','cancelled') THEN 1 ELSE 0 END failed_child,
      CASE WHEN task_state='closed' AND EXISTS(
        SELECT 1 FROM qm_task_snapshots snap WHERE snap.task_id=base.task_id AND snap.member_id=base.member_id AND json_array_length(snap.files_json)>0
      ) THEN 1 WHEN task_id IS NOT NULL AND EXISTS(
        SELECT 1 FROM qm_task_file_changes f JOIN qm_task_change_baselines b
          ON b.task_id=f.task_id AND b.member_id=f.member_id AND b.latest_ref=f.version_ref
        WHERE f.task_id=base.task_id AND f.member_id=base.member_id
      ) THEN 1 WHEN task_id IS NULL AND latest=1 AND EXISTS(
        SELECT 1 FROM qm_file_changes f
        JOIN qm_change_baselines b ON b.session_id=f.session_id AND b.member_id=f.member_id AND b.latest_ref=f.version_ref
        WHERE f.member_id=base.member_id
      ) THEN 1
        WHEN json_array_length(archived_files)>0 THEN 1
        WHEN EXISTS(SELECT 1 FROM console_operations o,json_each(o.evidence) j WHERE o.run_id=base.id AND json_extract(j.value,'$.label')='console.changes') THEN 1 ELSE 0 END changed
    FROM base
  ), states AS (
    SELECT *,CASE WHEN execution='interrupted_recoverable' THEN 'interrupted'
      WHEN execution!='completed' THEN execution
      WHEN task_result='completed' AND status!='completed' THEN 'done'
      WHEN acceptance='pending' THEN 'review' WHEN acceptance='passed' THEN 'accepted'
      WHEN acceptance='failed' THEN 'rejected' ELSE 'done' END stage,
      CAST(ROUND((julianday(created_at)-2440587.5)*86400000) AS INTEGER) started_ms,
      CAST(ROUND((julianday(CASE WHEN finalizing=1 THEN NULL WHEN execution IN ('running','queued','stopping','waiting','stalled','unknown') THEN finished_at ELSE COALESCE(task_finished_at,finished_at) END)-2440587.5)*86400000) AS INTEGER) finished_ms
    FROM classified
  )`;
  // 占位参数按照 SQL 中出现的顺序排列。
  const ordered = [prefix, ...projectIds, nodeId, ...(options.ids?.length ? [JSON.stringify(options.ids)] : [])];
  const where: string[] = [];
  const filters: Array<string | number> = [];
  const condition = (expression: string, value?: string | number) => { where.push(expression); if (value !== undefined) filters.push(value); };
  if (query.project) {
    const project = parseWorkspaceHandle(query.project);
    if (project && project.node !== nodeId) condition("0");
    condition("project_id=?", project?.local ?? query.project);
  }
  if (query.root) condition("root=?", query.root);
  if (query.session) condition("session_id=?", query.session);
  if (query.changed) condition("changed=1");
  if (query.execution) condition("execution=?", query.execution);
  if (query.stage) {
    const stages = query.stage.split(',').filter(Boolean);
    if (stages.length) {where.push(`stage IN (${stages.map(()=>'?').join(',')})`); filters.push(...stages);}
  }
  if (query.attention) condition("(execution IN ('failed','unknown','stalled','finalizing') OR finalizing=1 OR acceptance='failed' OR (execution='interrupted_recoverable' AND (unresolved=1 OR failed_child=1)))");
  if (query.q?.trim()) condition("instr(lower(title||' '||id||' '||reference||' '||project_name),?)>0", query.q.trim().toLocaleLowerCase());
  if (query.date || query.finishedDay) {
    const zone = query.tz || "UTC";
    dayAt(at, zone);
    db.function("workbench_day", { deterministic: true }, (value: unknown) => typeof value === "number" ? dayAt(value, zone) : null);
    if (query.date) condition("workbench_day(started_ms)=?", query.date);
    if (query.finishedDay) condition("workbench_day(finished_ms)=?", query.finishedDay);
  }
  const days = Number(query.days ?? 7);
  if (days) condition("(started_ms>=? OR execution IN ('running','queued','stopping','waiting','stalled','finalizing','unknown') OR finalizing=1 OR (execution='interrupted_recoverable' AND (unresolved=1 OR failed_child=1)))", at - days * 86400000);
  const filter = where.length ? where.join(" AND ") : "1";
  const scope = `${sql}, scoped AS (SELECT * FROM states WHERE ${filter})`;
  const values = [...ordered, ...filters];
  const selected = query.status ? "stage=?" : "1";
  const selectedValues = query.status ? [...values, query.status] : values;
  const selectedSql = `${scope}, selected AS (SELECT * FROM scoped WHERE ${selected})`;
  if (options.counts === false) return { sql: selectedSql, params: selectedValues };
  const counts = Object.fromEntries((db.prepare(`${scope} SELECT stage,COUNT(*) count FROM scoped GROUP BY stage`).all(...values) as Array<{ stage: string; count: number }>).map((row) => [row.stage, row.count]));
  counts.all = Object.values(counts).reduce((a, b) => a + b, 0);
  const total = query.status ? counts[query.status] ?? 0 : counts.all;
  return { sql: selectedSql, params: selectedValues, total, counts };
}

export function selectRunPage(ledger: WorkLedger, nodeId: string, projectIds: string[], query: Query) {
  const boundary = decodeBoundary(query.cursor);
  const at = boundary?.at ?? Date.now();
  const base = runQuery(ledger, nodeId, projectIds, query, at);
  const limit = Math.min(100, Math.max(1, Number(query.limit ?? 25)));
  const ascending = query.sort === "oldest";
  const reverse = boundary?.direction === "previous";
  if (query.sort === "duration") ledger.db.function("quaymesh_execution_duration", { deterministic: true },
    (execution: unknown, started: unknown, finished: unknown, progress: unknown) => {
      const end = executionTimeEnd({ executionStatus: String(execution), finishedAt: typeof finished === "number" ? finished : null,
        lastActivityAt: typeof progress === "string" ? Date.parse(progress) : NaN }, at);
      return end === null || typeof started !== "number" || !Number.isFinite(started) ? -1 : Math.max(0, end - started);
    });
  const sort = query.sort === "tokens" ? "COALESCE(tokens,-1)" : query.sort === "duration"
    ? "quaymesh_execution_duration(execution,started_ms,finished_ms,COALESCE(last_activity_at,finished_at,created_at))" : "started_ms";
  const sign = ascending !== reverse ? ">" : "<";
  const tieSign = reverse ? "<" : ">";
  const condition = boundary ? `(sort_key${sign}? OR (sort_key=? AND reference${tieSign}?))` : "1";
  const values = [...base.params, ...(boundary ? [boundary.value, boundary.value, boundary.id] : []), limit];
  const rows = ledger.db.prepare(`${base.sql}, ordered AS (SELECT *,${sort} sort_key FROM selected)
    SELECT id,sort_key FROM ordered WHERE ${condition}
    ORDER BY sort_key ${ascending !== reverse ? "ASC" : "DESC"},reference ${reverse ? "DESC" : "ASC"} LIMIT ?`).all(...values) as Array<{ id: string; sort_key: number }>;
  return { ids: rows.map((row) => row.id), total: base.total, counts: base.counts, at, limit, offset: boundary?.offset ?? 0 };
}
