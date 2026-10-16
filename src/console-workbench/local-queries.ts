import type { ServerConfig } from "../config.js";
import { WorkLedger, type ExecutionRow } from "../work-ledger.js";
import { permitted, readLocalIndex, convertUsage } from "./local.js";
import { dayAt, totals, type Query } from "./query.js";
import { runQuery, selectRunPage } from "./run-query.js";
import { workspaceHandle } from "../federation/routing.js";
import type { TaskLifecycle } from "../console-task-state.js";

export interface TaskPhaseIndex {
  id: string;
  localId: string;
  nodeId: string;
  sessionId: string | null;
  taskId: string | null;
  title: string;
  projectId: string;
  projectName: string;
  root: string;
  executionStatus: string;
  acceptanceStatus: string;
  startedAt: number;
  finishedAt: number | null;
  lastActivityAt: number;
  tokens: number | null;
  changed: boolean;
  actionableInterruption: boolean;
  currentPhase: boolean;
}

export interface SessionTitleIndex {
  id: string;
  title: string;
  revision: number;
  lastActivityAt: number;
}

function scope(config: ServerConfig, ledger: WorkLedger) {
  return { node: config.federation?.nodeId ?? "local", projects: ledger.projects().filter((project) => permitted(config, project.root)).map((project) => project.id) };
}

export function readLocalMetadata(config: ServerConfig) {
  const metadata = readLocalIndex(config, []);
  const ledger = new WorkLedger(config.stateDir);
  try {
    const own = scope(config, ledger);
    const query = runQuery(ledger, own.node, own.projects, { days: "0" }, Date.now());
    const summaries = ledger.db.prepare(`${query.sql} SELECT project_id,COUNT(DISTINCT COALESCE(task_id,session_id,id)) total,
      COUNT(DISTINCT CASE WHEN execution IN ('running','queued','stopping') THEN COALESCE(task_id,session_id,id) END) active,
      COUNT(DISTINCT CASE WHEN stage='review' THEN COALESCE(task_id,session_id,id) END) review,
      MAX(COALESCE(last_activity_at,finished_at,created_at)) updated FROM selected GROUP BY project_id`).all(...query.params) as Array<{ project_id: string; total: number; active: number; review: number; updated: string }>;
    const byProject = new Map(summaries.map((row) => [row.project_id, row]));
    const { runs: _runs, ...result } = metadata;
    return { ...result, projects: metadata.projects.map((project) => {
      const row = byProject.get(project.localId);
      return row ? { ...project, active: row.active, review: row.review, total: row.total, updatedAt: Date.parse(row.updated) } : project;
    }) };
  } finally { ledger.close(); }
}

export function readLocalPage(config: ServerConfig, query: Query) {
  const ledger = new WorkLedger(config.stateDir);
  try {
    const own = scope(config, ledger);
    const page = selectRunPage(ledger, own.node, own.projects, query);
    const records = readLocalIndex(config, page.ids).runs;
    return { ...page, items: page.ids.flatMap((id) => records.filter((run) => run.localId === id)), observedAt: Date.now() };
  } finally { ledger.close(); }
}

/** Small task-phase index used by the controller for exact cross-node task paging. */
export function readLocalTaskIndex(config: ServerConfig, at = Date.now()): { items: TaskPhaseIndex[]; observedAt: number } {
  const ledger = new WorkLedger(config.stateDir);
  try {
    const own = scope(config, ledger);
    const base = runQuery(ledger, own.node, own.projects, { days: "0" }, at);
    const rows = ledger.db.prepare(`${base.sql} SELECT id,reference,session_id,task_id,title,project_id,project_name,root,execution,acceptance,status,task_result,
      started_ms,finished_ms,last_activity_at,tokens,changed,unresolved,failed_child,summary,latest FROM selected ORDER BY started_ms DESC,reference`)
      .all(...base.params) as Array<Record<string, unknown>>;
    return { items: rows.map((row) => ({
      id: String(row.reference),
      localId: String(row.id),
      nodeId: own.node,
      sessionId: row.session_id === null ? null : String(row.session_id),
      taskId: row.task_id === null ? null : String(row.task_id),
      title: String(row.title ?? row.project_name ?? "QuayMesh task"),
      projectId: workspaceHandle(own.node, String(row.project_id)),
      projectName: String(row.project_name),
      root: String(row.root),
      executionStatus: String(row.execution),
      acceptanceStatus: row.task_result === 'completed' && row.status !== 'completed' ? 'not_required' : row.acceptance === "passed" ? "accepted" : row.acceptance === "failed" ? "rejected"
        : row.acceptance === "not_applicable" ? "not_required" : String(row.acceptance ?? "unknown"),
      startedAt: Number(row.started_ms),
      finishedAt: row.finished_ms === null ? null : Number(row.finished_ms),
      lastActivityAt: Date.parse(String(row.last_activity_at)),
      tokens: row.tokens === null ? null : Number(row.tokens),
      changed: Number(row.changed) === 1,
      actionableInterruption: Number(row.unresolved) === 1 || Number(row.failed_child) === 1,
      currentPhase: row.session_id === null || Number(row.latest) === 1,
    })), observedAt: Date.now() };
  } finally { ledger.close(); }
}

export function readLocalSessionTitles(config: ServerConfig): { items: SessionTitleIndex[]; tasks: TaskLifecycle[]; authoritative:boolean; observedAt: number } {
  const ledger = new WorkLedger(config.stateDir);
  try {
    const rows = ledger.db.prepare(`SELECT id,title,revision,last_activity_at FROM qm_sessions ORDER BY last_activity_at DESC,id`)
      .all() as Array<{ id: string; title: string; revision: number; last_activity_at: string }>;
    const tasks = ledger.db.prepare('SELECT id,session_id,title,state,result_status,revision,finished_at,last_activity_at,source_task_id FROM qm_tasks').all() as Array<{
      id:string; session_id:string; source_task_id:string|null; title:string; state:string; result_status:string|null; revision:number; finished_at:string|null; last_activity_at:string;
    }>;
    return { authoritative:config.federation?.capabilities.coordinator ?? true,
      tasks:tasks.map(row=>({id:row.id,sessionId:row.session_id,sourceTaskId:row.source_task_id,title:row.title,state:row.state,resultStatus:row.result_status,
      revision:row.revision,finishedAt:row.finished_at ? Date.parse(row.finished_at) : null,lastActivityAt:Date.parse(row.last_activity_at)})),
      items: rows.map((row) => ({ id: row.id, title: row.title, revision: row.revision,
      lastActivityAt: Date.parse(row.last_activity_at) })), observedAt: Date.now() };
  } finally { ledger.close(); }
}

export function readLocalRunSummaries(config: ServerConfig, ids: readonly string[]) {
  const unique = [...new Set(ids)].filter(Boolean);
  if (unique.length > 100) throw new Error("RUN_SUMMARY_BATCH_TOO_LARGE");
  return { items: readLocalIndex(config, unique).runs, observedAt: Date.now() };
}

function usageRows(ledger: WorkLedger, query: ReturnType<typeof runQuery>) {
  const rows = ledger.db.prepare(`${query.sql} SELECT r.id runId,r.project_id projectId,r.started_ms startedAt,
    e.id,e.run_id,e.agent_id,e.provider,e.status,e.requested,e.provider_turn_id,e.provider_finished,
    e.cumulative IS NOT NULL AS has_cumulative,e.delta,e.usage_quality,e.boundary_reason
    FROM selected r LEFT JOIN console_executions e ON e.run_id=r.id ORDER BY r.id,e.rowid`).all(...query.params) as Array<ExecutionRow & { runId: string; projectId: string; startedAt: number; has_cumulative: number }>;
  const groups = new Map<string, { id: string; projectId: string; startedAt: number; executions: ExecutionRow[] }>();
  for (const row of rows) {
    let group = groups.get(row.runId);
    if (!group) { group = { id: row.runId, projectId: row.projectId, startedAt: row.startedAt, executions: [] }; groups.set(row.runId, group); }
    if (row.id) group.executions.push({ ...row, cumulative: row.has_cumulative ? "present" : null });
  }
  return [...groups.values()].map(({ executions, ...row }) => ({ ...row, usage: convertUsage(executions) }));
}

export function readLocalUsage(config: ServerConfig, input: Query, at = Date.now()) {
  const ledger = new WorkLedger(config.stateDir);
  try {
    const own = scope(config, ledger), zone = input.tz || "UTC";
    const days = Math.min(30, Math.max(1, Number(input.days) || 14));
    const dates = Array.from({ length: days }, (_, index) => dayAt(at - (days - index - 1) * 86400000, zone));
    const allowedDates = new Set(dates);
    // 只取本次统计期间的数据；历史列表和健康刷新不经过这条统计查询。
    const query = runQuery(ledger, own.node, own.projects, { ...input, days: String(days + 1), status: undefined }, at);
    const rows = usageRows(ledger, query).filter((row) => allowedDates.has(dayAt(row.startedAt, zone)));
    const metadata = readLocalMetadata(config);
    const topIds = rows.filter((row) => row.usage.total !== null && row.usage.total > 0)
      .sort((a, b) => b.usage.total! - a.usage.total!).slice(0, 8).map((row) => row.id);
    return { ...totals(rows), daily: dates.map((day) => ({ day, ...totals(rows.filter((row) => dayAt(row.startedAt, zone) === day)) })),
      projects: metadata.projects.map((project) => ({ ...project, ...totals(rows.filter((row) => row.projectId === project.localId)) })).filter((project) => project.records > 0),
      top: readLocalIndex(config, topIds).runs, observedAt: Date.now() };
  } finally { ledger.close(); }
}

export function readLocalOverview(config: ServerConfig, zone = "UTC", at = Date.now()) {
  const ledger = new WorkLedger(config.stateDir);
  try {
    const own = scope(config, ledger), base = runQuery(ledger, own.node, own.projects, { days: "0" }, at);
    const ids = (condition: string, order: string, limit?: number) => (ledger.db.prepare(`${base.sql} SELECT id FROM selected WHERE ${condition} ORDER BY ${order}${limit === undefined ? "" : ` LIMIT ${limit}`}`).all(...base.params) as Array<{ id: string }>).map((row) => row.id);
    const activeIds = ids("execution IN ('running','queued','stopping')", "created_at,id", 12);
    const recentIds = ids("execution NOT IN ('running','queued','stopping','waiting')", "COALESCE(finished_at,last_activity_at,created_at) DESC,id", 6);
    const attentionFilter = `(execution='interrupted_recoverable' AND (unresolved=1 OR failed_child=1)) OR execution='unknown'
      OR (execution='failed' AND COALESCE(last_activity_at,finished_at,created_at)>='${new Date(at - 86400000).toISOString()}')`;
    const attentionIds = ids(attentionFilter, "COALESCE(last_activity_at,finished_at,created_at) DESC,id", 6);
    const all = new Map(readLocalIndex(config, [...new Set([...activeIds, ...recentIds, ...attentionIds])]).runs.map((run) => [run.localId, run]));
    const take = (values: string[]) => values.flatMap((id) => all.has(id) ? [all.get(id)!] : []);
    const today = dayAt(at, zone);
    ledger.db.function("workbench_day", { deterministic: true }, (time: unknown) => typeof time === "number" ? dayAt(time, zone) : null);
    const counts = ledger.db.prepare(`${base.sql} SELECT SUM(execution='running' OR execution='stopping') runningCount,
      SUM(execution='queued') queuedCount,SUM(stage='review') reviewCount,
      SUM(execution='completed' AND workbench_day(finished_ms)=?) completedToday,
      SUM(execution='failed' AND workbench_day(COALESCE(finished_ms,started_ms))=?) failedToday,
      SUM(${attentionFilter}) attentionCount FROM selected`).get(...base.params, today, today) as Record<string, number | null>;
    const usage = readLocalUsage(config, { days: "1", tz: zone }, at);
    const { daily: _daily, top: _top, projects, observedAt: _observedAt, ...todayUsage } = usage;
    return { active: take(activeIds), recent: take(recentIds),
      attention: take(attentionIds).map((run) => ({ id: run.id, kind: run.executionStatus, title: run.title, detail: run.reason ?? "查看保存的执行记录", nodeId: run.nodeId })),
      runningCount: counts.runningCount ?? 0, queuedCount: counts.queuedCount ?? 0, reviewCount: counts.reviewCount ?? 0,
      completedToday: counts.completedToday ?? 0, failedToday: counts.failedToday ?? 0, attentionCount: counts.attentionCount ?? 0,
      todayUsage, projects: projects.map((project) => ({ ...project, usage: project.total })), observedAt: Date.now() };
  } finally { ledger.close(); }
}
