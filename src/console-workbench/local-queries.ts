import type { ServerConfig } from "../config.js";
import { WorkLedger } from "../work-ledger.js";
import { readLocalIndex } from "./local.js";
import { dayAt, totals, type Query } from "./query.js";
import { runQuery, selectRunPage } from "./run-query.js";
import type { TaskLifecycle } from "../console-task-state.js";
import { resolveTaskTitle } from '../task-title.js';
import {parseTaskReadScope,type TaskReadScope} from './task-read-scope.js';
import { scope, latestTimestamp, readTaskPhases, readSessionTitles,
  type TaskPhaseIndex, type TaskPhaseStateIndex, type SessionTitleIndex } from './local-state-queries.js';
export { readLocalTaskStateIndex, type TaskPhaseIndex, type TaskPhaseStateIndex,
  type SessionTitleIndex, type TaskStateIndexRead } from './local-state-queries.js';

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
export function readLocalTaskIndex(config: ServerConfig, at = Date.now(), readScope?: TaskReadScope): { items: TaskPhaseIndex[]; observedAt: number } {
  const taskScope=readScope===undefined?undefined:parseTaskReadScope(readScope);
  const ledger = new WorkLedger(config.stateDir);
  try {
    return {items:readTaskPhases(config,ledger,at,'full',taskScope),observedAt:Date.now()};
  } finally { ledger.close(); }
}

/** Reuse the caller's readonly snapshot and restrict candidates before reading history. */
export function readProjectTaskState(config:ServerConfig,ledger:WorkLedger,projectId:string,at=Date.now()):TaskPhaseStateIndex[] {
  return readTaskPhases(config,ledger,at,'state',undefined,projectId);
}

export function readLocalSessionTitles(config: ServerConfig, readScope?: TaskReadScope): { items: SessionTitleIndex[]; tasks: TaskLifecycle[]; authoritative:boolean; observedAt: number } {
  const taskScope=readScope===undefined?undefined:parseTaskReadScope(readScope);
  const ledger = new WorkLedger(config.stateDir);
  try {
    return {...readSessionTitles(config,ledger,taskScope),observedAt:Date.now()};
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
