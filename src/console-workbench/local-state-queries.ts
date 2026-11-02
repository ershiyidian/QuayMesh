import type { ServerConfig } from "../config.js";
import type { TaskLifecycle } from "../console-task-state.js";
import { openReadonlySqlite, type SqliteDatabase } from "../db/readonly.js";
import { assertAllowedPath } from "../roots.js";
import { workspaceHandle } from "../federation/routing.js";
import { basename } from "node:path";
import { placeholderTaskTitle, resolveTaskTitle, taskTitleMessage, type TaskTitleSource } from "../task-title.js";
import { runQuery } from "./run-query.js";
import type { TaskReadScope } from "./task-read-scope.js";

type QueryLedger = { readonly db: SqliteDatabase };

export function permitted(config: ServerConfig, path: string): boolean {
  try { assertAllowedPath(path, config.allowedRoots); return true; }
  catch { return false; }
}

export const latestTimestamp=(values: Array<string|null|undefined>): number|null => {
  const times=values.map(value=>value ? Date.parse(value) : NaN).filter(Number.isFinite);
  return times.length ? Math.max(...times) : null;
};

export interface TaskPhaseStateIndex {
  id: string;
  localId: string;
  nodeId: string;
  sessionId: string | null;
  taskId: string | null;
  memberId?: string | null;
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
  actionableInterruption: boolean;
  currentPhase: boolean;
  requestState?: string;
  resultStatus?: string | null;
  finalization?: TaskLifecycle['finalization'];
  observedAt?: number | null;
  stale?: boolean;
}

export interface TaskPhaseIndex extends TaskPhaseStateIndex {
  tokens: number | null;
  changed: boolean;
}

export interface SessionTitleIndex {
  id: string;
  title: string;
  revision: number;
  lastActivityAt: number;
}

export interface TaskStateIndexRead {
  projection: 'state';
  phases: TaskPhaseStateIndex[];
  sessions: SessionTitleIndex[];
  tasks: TaskLifecycle[];
  authoritative: boolean;
  observedAt: number;
}

export function scope(config: ServerConfig, ledger: QueryLedger) {
  const projects = ledger.db.prepare("select * from console_projects order by name, id").all() as Array<{id:string;root:string}>;
  return { node: config.federation?.nodeId ?? "local", projects: projects.filter((project) => permitted(config, project.root)).map((project) => project.id) };
}

export function readTaskPhases(config:ServerConfig,ledger:QueryLedger,at:number,fields:'full',taskScope?:TaskReadScope,projectId?:string):TaskPhaseIndex[];
export function readTaskPhases(config:ServerConfig,ledger:QueryLedger,at:number,fields:'state',taskScope?:TaskReadScope,projectId?:string):TaskPhaseStateIndex[];
export function readTaskPhases(config:ServerConfig,ledger:QueryLedger,at:number,fields:'full'|'state',taskScope?:TaskReadScope,projectId?:string):TaskPhaseStateIndex[] {
    const own = scope(config, ledger);
    const projects=projectId===undefined?own.projects:own.projects.filter(id=>id===projectId);
    const base = runQuery(ledger, own.node, projects, { days: "0" }, at, { counts: false,taskScope,fields });
    // Keep every phase for exact cross-node grouping; summary bodies belong to detail reads.
    const rows = ledger.db.prepare(`${base.sql} SELECT id,reference,session_id,task_id,member_id,title,project_id,project_name,root,execution,acceptance,status,task_result,
      started_ms,finished_ms,last_activity_at,${fields==='full'?'tokens,changed,':''}unresolved,failed_child,latest,task_state,
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
    return rows.map((row) => ({
      id: String(row.reference),
      localId: String(row.id),
      nodeId: own.node,
      sessionId: row.session_id === null ? null : String(row.session_id),
      taskId: row.task_id === null ? null : String(row.task_id),
      memberId: row.member_id == null ? null : String(row.member_id),
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
      ...(fields==='full'?{tokens:row.tokens===null?null:Number(row.tokens),changed:Number(row.changed)===1}:{}),
      actionableInterruption: Number(row.unresolved) === 1 || ['failed','interrupted_recoverable'].includes(String(row.execution)) && Number(row.failed_child) === 1,
      currentPhase: row.session_id === null || Number(row.latest) === 1,
      requestState: row.task_state === null ? undefined : String(row.task_state),
      resultStatus: row.task_result === null ? null : String(row.task_result),
      finalization: Number(row.finalizing) === 1 ? {status: row.finalization_error ? 'failed' as const : 'pending' as const,
        requestedAt: Date.parse(String(row.finalization_requested_at)), error: row.finalization_error === null ? null : String(row.finalization_error)} : null,
    }));
}

export function readSessionTitles(config:ServerConfig,ledger:QueryLedger,taskScope?:TaskReadScope):{items:SessionTitleIndex[];tasks:TaskLifecycle[];authoritative:boolean} {
    const taskWhere=!taskScope?'1':taskScope.taskIds?'t.id IN (SELECT value FROM json_each(?))':'t.session_id=?';
    const selected=taskScope?[taskScope.taskIds?JSON.stringify(taskScope.taskIds):taskScope.sessionId]:[];
    const sessionWhere=!taskScope?'1':taskScope.taskIds
      ? 'id IN (SELECT session_id FROM qm_tasks t WHERE '+taskWhere+')':'id=?';
    const rows = ledger.db.prepare(`SELECT id,title,revision,last_activity_at FROM qm_sessions WHERE ${sessionWhere} ORDER BY last_activity_at DESC,id`)
      .all(...selected) as Array<{ id: string; title: string; revision: number; last_activity_at: string }>;
    const nodeId = config.federation?.nodeId ?? 'local';
    const tasks = ledger.db.prepare(`SELECT t.id,t.session_id,t.title,t.state,t.result_status,t.revision,t.created_at,t.finished_at,t.delivery_ended_at,t.last_activity_at,t.source_task_id,
      f.requested_at,f.completed_at,f.error,s.title session_title,
      (SELECT created_at FROM qm_task_messages WHERE task_id=t.id ORDER BY sequence DESC LIMIT 1) message_at
      FROM qm_tasks t LEFT JOIN qm_task_finalizations f ON f.task_id=t.id LEFT JOIN qm_sessions s ON s.id=t.session_id
      WHERE ${taskWhere}`).all(...selected) as Array<{
      id:string; session_id:string; source_task_id:string|null; title:string; state:string; result_status:string|null; revision:number;
      created_at:string; finished_at:string|null; delivery_ended_at:string|null; last_activity_at:string; requested_at:string|null; completed_at:string|null; error:string|null;
      session_title:string|null;
      message_at:string|null;
    }>;
    const members = ledger.db.prepare(`SELECT tm.task_id,m.id member_id,m.node_id,m.root,p.id project_id,p.name
      FROM qm_task_members tm JOIN qm_session_members m ON m.id=tm.member_id
      LEFT JOIN console_projects p ON p.root=m.root
      ${taskScope?'WHERE tm.task_id IN (SELECT t.id FROM qm_tasks t WHERE '+taskWhere+')':''}`).all(...selected) as Array<{
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
    return { authoritative:!config.federation?.enabled || config.federation.capabilities.coordinator,
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
      lastActivityAt: Date.parse(row.last_activity_at) })) };
}

/** One node observation for the homepage: lifecycle and phase state share the
 * same read snapshot, without usage, change evidence, or detail projections. */
export function readLocalTaskStateIndex(config:ServerConfig,at=Date.now()):TaskStateIndexRead {
  const db=openReadonlySqlite(config.stateDir),ledger={db};
  try {
    return ledger.db.transaction(()=>{
      const phases=readTaskPhases(config,ledger,at,'state');
      const titles=readSessionTitles(config,ledger);
      return {projection:'state' as const,phases,sessions:titles.items,tasks:titles.tasks,
        authoritative:titles.authoritative,observedAt:Date.now()};
    }).deferred();
  } finally { db.close(); }
}
