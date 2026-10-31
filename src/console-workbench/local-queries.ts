import type { ServerConfig } from "../config.js";
import { WorkLedger, type ExecutionRow } from "../work-ledger.js";
import { permitted, readLocalIndex, convertUsage } from "./local.js";
import { dayAt, totals, type Query } from "./query.js";
import { runQuery, selectRunPage } from "./run-query.js";
import { workspaceHandle } from "../federation/routing.js";
import type { TaskLifecycle } from "../console-task-state.js";
import { basename } from "node:path";
import { placeholderTaskTitle, resolveTaskTitle, taskTitleMessage, type TaskTitleSource } from '../task-title.js';

const latestTimestamp=(values: Array<string|null|undefined>): number|null => {
  const times=values.map(value=>value ? Date.parse(value) : NaN).filter(Number.isFinite);
  return times.length ? Math.max(...times) : null;
};

export interface TaskPhaseIndex {
  id: string;
  localId: string;
  nodeId: string;
  sessionId: string | null;
  taskId: string | null;
  title: string;
  titleSource?: TaskTitleSource;
  lastProgressAt?: number | null;
  executionObservedAt?: number | null;
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
  requestState?: string;
  resultStatus?: string | null;
  finalization?: TaskLifecycle['finalization'];
  observedAt?: number | null;
  stale?: boolean;
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
    const query = runQuery(ledger, own.node, own.projects, { days: "0" }, Date.now(), { counts: false });
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
    const base = runQuery(ledger, own.node, own.projects, { days: "0" }, at, { counts: false });
    // Keep every phase for exact cross-node grouping; summary bodies belong to detail reads.
    const rows = ledger.db.prepare(`${base.sql} SELECT id,reference,session_id,task_id,title,project_id,project_name,root,execution,acceptance,status,task_result,
      started_ms,finished_ms,last_activity_at,tokens,changed,unresolved,failed_child,latest,task_state,
      finalizing,finalization_requested_at,finalization_error,
      (SELECT title FROM qm_tasks WHERE id=selected.task_id) task_title,
      (SELECT title FROM qm_sessions WHERE id=selected.session_id) session_title,
      (SELECT title FROM console_work_items WHERE id=selected.item_id) work_item_title,
      (SELECT MAX(observed_at) FROM (
        SELECT observed_at FROM console_operations WHERE run_id=selected.id AND status IN ('running','starting','queued','stopping')
        UNION ALL SELECT observed_at FROM console_executions WHERE run_id=selected.id AND status IN ('running','starting','queued','stopping')
      )) execution_observed_at,
      (SELECT MAX(at) FROM (
        SELECT MAX(created_at) at FROM console_operations WHERE run_id=selected.id
        UNION ALL SELECT MAX(finished_at) at FROM console_operations WHERE run_id=selected.id
        UNION ALL SELECT MAX(created_at) at FROM console_executions WHERE run_id=selected.id
        UNION ALL SELECT MAX(finished_at) at FROM console_executions WHERE run_id=selected.id
      )) progress_at
      FROM selected ORDER BY started_ms DESC,reference`)
      .all(...base.params) as Array<Record<string, unknown>>;
    return { items: rows.map((row) => ({
      id: String(row.reference),
      localId: String(row.id),
      nodeId: own.node,
      sessionId: row.session_id === null ? null : String(row.session_id),
      taskId: row.task_id === null ? null : String(row.task_id),
      ...resolveTaskTitle({title:typeof row.task_title==='string'?row.task_title:null,
        sessionTitle:typeof row.session_title==='string'?row.session_title:null,
        workItemTitle:typeof row.work_item_title==='string'?row.work_item_title:null,
        workspaceNames:[String(row.project_name)],createdAt:Number(row.started_ms)}),
      projectId: workspaceHandle(own.node, String(row.project_id)),
      projectName: String(row.project_name),
      root: String(row.root),
      executionStatus: String(row.execution),
      acceptanceStatus: row.task_result === 'completed' && row.status !== 'completed' ? 'not_required' : row.acceptance === "passed" ? "accepted" : row.acceptance === "failed" ? "rejected"
        : row.acceptance === "not_applicable" ? "not_required" : String(row.acceptance ?? "unknown"),
      startedAt: Number(row.started_ms),
      finishedAt: row.finished_ms === null ? null : Number(row.finished_ms),
      lastActivityAt: Date.parse(String(row.last_activity_at)),
      lastProgressAt:latestTimestamp([typeof row.progress_at==='string'?row.progress_at:null,
        typeof row.finalization_requested_at==='string'?row.finalization_requested_at:null]) ?? Number(row.started_ms),
      executionObservedAt: row.execution_observed_at == null ? null : Date.parse(String(row.execution_observed_at)),
      tokens: row.tokens === null ? null : Number(row.tokens),
      changed: Number(row.changed) === 1,
      actionableInterruption: Number(row.unresolved) === 1 || ['failed','interrupted_recoverable'].includes(String(row.execution)) && Number(row.failed_child) === 1,
      currentPhase: row.session_id === null || Number(row.latest) === 1,
      requestState: row.task_state === null ? undefined : String(row.task_state),
      resultStatus: row.task_result === null ? null : String(row.task_result),
      finalization: Number(row.finalizing) === 1 ? {status: row.finalization_error ? 'failed' as const : 'pending' as const,
        requestedAt: Date.parse(String(row.finalization_requested_at)), error: row.finalization_error === null ? null : String(row.finalization_error)} : null,
    })), observedAt: Date.now() };
  } finally { ledger.close(); }
}

export function readLocalSessionTitles(config: ServerConfig): { items: SessionTitleIndex[]; tasks: TaskLifecycle[]; authoritative:boolean; observedAt: number } {
  const ledger = new WorkLedger(config.stateDir);
  try {
    const rows = ledger.db.prepare(`SELECT id,title,revision,last_activity_at FROM qm_sessions ORDER BY last_activity_at DESC,id`)
      .all() as Array<{ id: string; title: string; revision: number; last_activity_at: string }>;
    const nodeId = config.federation?.nodeId ?? 'local';
    const tasks = ledger.db.prepare(`SELECT t.id,t.session_id,t.title,t.state,t.result_status,t.revision,t.created_at,t.finished_at,t.delivery_ended_at,t.last_activity_at,t.source_task_id,
      f.requested_at,f.completed_at,f.error,s.title session_title,
      (SELECT created_at FROM qm_task_messages WHERE task_id=t.id ORDER BY sequence DESC LIMIT 1) message_at
      FROM qm_tasks t LEFT JOIN qm_task_finalizations f ON f.task_id=t.id LEFT JOIN qm_sessions s ON s.id=t.session_id`).all() as Array<{
      id:string; session_id:string; source_task_id:string|null; title:string; state:string; result_status:string|null; revision:number;
      created_at:string; finished_at:string|null; delivery_ended_at:string|null; last_activity_at:string; requested_at:string|null; completed_at:string|null; error:string|null;
      session_title:string|null;
      message_at:string|null;
    }>;
    const members = ledger.db.prepare(`SELECT tm.task_id,m.id member_id,m.node_id,m.root,p.id project_id,p.name
      FROM qm_task_members tm JOIN qm_session_members m ON m.id=tm.member_id
      LEFT JOIN console_projects p ON p.root=m.root`).all() as Array<{
        task_id:string; member_id:string; node_id:string; root:string; project_id:string|null; name:string|null;
      }>;
    const byTask = new Map<string, typeof members>();
    for (const member of members) {
      const values = byTask.get(member.task_id) ?? [];
      values.push(member); byTask.set(member.task_id, values);
    }
    const visibleTasks = tasks.filter(task => {
      const own = byTask.get(task.id) ?? [];
      return !own.length || own.some(member => member.node_id !== nodeId || permitted(config, member.root));
    });
    const visibleSessions = new Set(visibleTasks.map(task => task.session_id));
    const taskSessions = new Set(tasks.map(task => task.session_id));
    // Only a few Task-scoped user messages; never scan invocation payloads/results.
    const titleMessages=ledger.db.prepare(`SELECT substr(body,1,1024) body FROM qm_task_messages
      WHERE task_id=? AND role='user' ORDER BY sequence LIMIT 3`);
    return { authoritative:config.federation?.capabilities.coordinator ?? true,
      tasks:visibleTasks.map(row=>{
        const own = (byTask.get(row.id) ?? []).filter(member => member.node_id !== nodeId || permitted(config, member.root));
        const finishedAt = row.result_status && row.delivery_ended_at ? row.delivery_ended_at : row.finished_at;
        const userMessage=placeholderTaskTitle(row.title) ? (titleMessages.all(row.id) as Array<{body:string}>)
          .map(message=>taskTitleMessage(message.body)).find((message): message is string=>message!==null) ?? null : null;
        return {id:row.id,sessionId:row.session_id,sourceTaskId:row.source_task_id,
          ...resolveTaskTitle({title:row.title,sessionTitle:row.session_title,userMessage,
            workspaceNames:own.map(member=>member.name??basename(member.root)),createdAt:Date.parse(row.created_at)}),
          state:row.state,resultStatus:row.result_status,
          lastProgressAt:latestTimestamp([row.created_at,row.message_at,row.requested_at,row.completed_at,row.finished_at]),
          nodeId,createdAt:Date.parse(row.created_at),memberNodeIds:[...new Set(own.map(member=>member.node_id))],
          workspaces:own.map(member=>({nodeId:member.node_id,projectId:member.project_id ? workspaceHandle(member.node_id,member.project_id) : '',
            memberId:member.member_id,name:member.name ?? basename(member.root),root:member.root})),
          finalization:row.requested_at && (!row.completed_at || row.state==='active') ? {
            status:row.error ? 'failed' as const : 'pending' as const,requestedAt:Date.parse(row.requested_at),error:row.error,
          } : null,
          revision:row.revision,finishedAt:finishedAt ? Date.parse(finishedAt) : null,lastActivityAt:Date.parse(row.last_activity_at)};
      }),
      items: rows.filter(row=>visibleSessions.has(row.id) || !taskSessions.has(row.id)).map((row) => ({ id: row.id, title: row.title, revision: row.revision,
      lastActivityAt: Date.parse(row.last_activity_at) })), observedAt: Date.now() };
  } finally { ledger.close(); }
}

export function readLocalRunSummaries(config: ServerConfig, ids: readonly string[]) {
  const unique = [...new Set(ids)].filter(Boolean);
  if (unique.length > 100) throw new Error("RUN_SUMMARY_BATCH_TOO_LARGE");
  const runs=readLocalIndex(config, unique).runs;
  if(!runs.length)return {items:runs,observedAt:Date.now()};
  const ledger=new WorkLedger(config.stateDir);
  try {
    const selected=JSON.stringify(runs.map(run=>run.localId));
    const rows=ledger.db.prepare(`SELECT run_id,MAX(created_at) created_at,MAX(finished_at) finished_at,
      MAX(CASE WHEN status IN ('running','starting','queued','stopping') THEN observed_at END) execution_observed_at
      FROM (
        SELECT run_id,created_at,finished_at,status,observed_at FROM console_operations WHERE run_id IN (SELECT value FROM json_each(?))
        UNION ALL SELECT run_id,created_at,finished_at,status,observed_at FROM console_executions WHERE run_id IN (SELECT value FROM json_each(?))
      ) GROUP BY run_id`).all(selected,selected) as Array<{
        run_id:string;created_at:string|null;finished_at:string|null;execution_observed_at:string|null;
      }>;
    const byRun=new Map(rows.map(row=>[row.run_id,row]));
    const workTitles=new Map((ledger.db.prepare(`SELECT r.id,i.title FROM console_work_runs r
      JOIN console_work_items i ON i.id=r.item_id WHERE r.id IN (SELECT value FROM json_each(?))`)
      .all(selected) as Array<{id:string;title:string}>).map(row=>[row.id,row.title]));
    return {items:runs.map(run=>{
      const row=byRun.get(run.localId);
      return {...run,...resolveTaskTitle({title:run.title,workItemTitle:workTitles.get(run.localId),
        workspaceNames:[run.projectName],createdAt:run.startedAt}),
        lastProgressAt:Math.max(run.startedAt,run.finalization?.requestedAt ?? 0,
          latestTimestamp([row?.created_at,row?.finished_at]) ?? run.startedAt),
        executionObservedAt:row?.execution_observed_at ? Date.parse(row.execution_observed_at) : null};
    }),observedAt:Date.now()};
  } finally {ledger.close();}
}

export { readLocalUsage } from "./usage-query.js";
import { readLocalUsage } from "./usage-query.js";

/** 联邦概览只需要用量；不为未使用的本地任务样本重新扫描和分类历史。 */
export function readLocalOverviewUsage(config: ServerConfig, zone = "UTC", at = Date.now()) {
  const usage = readLocalUsage(config, { days: "1", tz: zone }, at, { includeRuns: false });
  const { daily: _daily, top: _top, runIds: _runIds, projects, observedAt, ...todayUsage } = usage;
  return { todayUsage, projects: projects.map(project => ({ ...project, usage: project.total })), observedAt };
}

export function readLocalOverview(config: ServerConfig, zone = "UTC", at = Date.now()) {
  const ledger = new WorkLedger(config.stateDir);
  try {
    const own = scope(config, ledger), base = runQuery(ledger, own.node, own.projects, { days: "0" }, at, { counts: false });
    const ids = (condition: string, order: string, limit?: number) => (ledger.db.prepare(`${base.sql} SELECT id FROM selected WHERE ${condition} ORDER BY ${order}${limit === undefined ? "" : ` LIMIT ${limit}`}`).all(...base.params) as Array<{ id: string }>).map((row) => row.id);
    const activeIds = ids("execution IN ('running','queued','stopping')", "created_at,id", 12);
    const recentIds = ids("execution NOT IN ('running','queued','stopping','waiting')", "COALESCE(finished_at,last_activity_at,created_at) DESC,id", 6);
    const attentionFilter = `(execution='interrupted_recoverable' AND (unresolved=1 OR failed_child=1))
      OR execution IN ('unknown','failed','stalled','finalizing') OR finalizing=1 OR acceptance='failed'`;
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
    const { todayUsage, projects } = readLocalOverviewUsage(config, zone, at);
    return { active: take(activeIds), recent: take(recentIds),
      attention: take(attentionIds).map((run) => ({ id: run.id, kind: run.executionStatus, title: run.title, detail: run.reason ?? "查看保存的执行记录", nodeId: run.nodeId })),
      runningCount: counts.runningCount ?? 0, queuedCount: counts.queuedCount ?? 0, reviewCount: counts.reviewCount ?? 0,
      completedToday: counts.completedToday ?? 0, failedToday: counts.failedToday ?? 0, attentionCount: counts.attentionCount ?? 0,
      todayUsage, projects, observedAt: Date.now() };
  } finally { ledger.close(); }
}
