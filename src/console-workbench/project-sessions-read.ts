import type { ServerConfig } from "../config.js";
import { openReadonlyDatabase } from "../db/client.js";
import { WorkLedger } from "../work-ledger.js";
import { workspaceHandle } from "../federation/routing.js";
import { readExecutionClaims, readExecutionWaitingState } from "../execution-inspection.js";
import { activeExecution } from "../console-task-state.js";
import { taskView } from "../task-view.js";
import { permitted, readLocalIndex } from "./local.js";
import { aggregateTasks, taskReference } from "./task-aggregation.js";
import { stage } from "./query.js";
import { WorkbenchError } from "./types.js";

/** Saved project/session/thread/claim metadata in one explicitly readonly snapshot.
 * No runtime, scheduler, recovery, claim cleanup or migration is constructed here.
 */
export function readProjectSessions(config: ServerConfig, projectId: string) {
  if (typeof projectId !== "string" || !projectId || projectId.length > 512)
    throw new WorkbenchError("项目读取参数无效", 400, "invalid_read", "none");
  const database = openReadonlyDatabase(config.stateDir);
  const ledger = new WorkLedger(config.stateDir, database);
  try {
    database.sqlite.exec("BEGIN");
    const project = ledger.getProject(projectId);
    if (!permitted(config, project.root)) throw new WorkbenchError("项目不在允许访问的范围内", 403, "project_scope", "none");
    const node = config.federation?.nodeId ?? "local";
    const projectRunIds = (ledger.db.prepare("SELECT id FROM console_work_runs WHERE project_id=?").all(projectId) as Array<{ id: string }>).map((row) => row.id);
    const runs = readLocalIndex(config, projectRunIds, ledger).runs;
    const sessionRows = ledger.db.prepare(`SELECT DISTINCT s.id,s.title,s.last_activity_at,s.created_at FROM qm_sessions s
      JOIN qm_session_members m ON m.session_id=s.id
      WHERE m.node_id=? AND m.root=? ORDER BY s.last_activity_at DESC,s.id`).all(node,project.root) as Array<{
        id:string;title:string;last_activity_at:string;created_at:string;
      }>;
    const conversations=sessionRows.map(row=>{
      const actual=aggregateTasks(runs.filter(run=>run.sessionId===row.id));
      const taskRows=ledger.db.prepare(`SELECT DISTINCT t.id,t.title,t.state,t.result_status,t.created_at,t.finished_at,t.last_activity_at
        FROM qm_tasks t JOIN qm_task_members tm ON tm.task_id=t.id JOIN qm_session_members m ON m.id=tm.member_id
        WHERE t.session_id=? AND m.node_id=? AND m.root=?`).all(row.id,node,project.root) as Array<{
          id:string;title:string;state:string;result_status:string|null;created_at:string;finished_at:string|null;last_activity_at:string;
        }>;
      const tasks=actual.map(task=>({id:task.id,taskId:task.taskId,title:task.title,status:stage(task),root:task.root,workspaces:task.workspaces,
        executionStatus:task.executionStatus,acceptanceStatus:task.acceptanceStatus,lastActivityAt:task.lastActivityAt,
        requestState:task.requestState,resultStatus:task.resultStatus,phaseExecutionStatus:task.phaseExecutionStatus,finalization:task.finalization,
        startedAt:task.startedAt,finishedAt:task.finishedAt,hasRun:true}));
      for(const task of taskRows)if(!tasks.some(value=>value.taskId===task.id)){
        const execution=taskView({requestState:task.state,result:task.result_status,execution:'waiting',lastProgressAt:Date.parse(task.last_activity_at),now:Date.now()}).status;
        tasks.push({id:taskReference(task.id),taskId:task.id,title:task.title,status:stage({executionStatus:execution,acceptanceStatus:'not_required'}),
          root:project.root,workspaces:[{nodeId:node,projectId:workspaceHandle(node,projectId),memberId:null,name:project.name,root:project.root}],
          executionStatus:execution,acceptanceStatus:'not_required',lastActivityAt:Date.parse(task.last_activity_at),startedAt:Date.parse(task.created_at),
          requestState:task.state,resultStatus:task.result_status,phaseExecutionStatus:undefined,finalization:undefined,
          finishedAt:task.finished_at ? Date.parse(task.finished_at) : null,hasRun:false});
      }
      tasks.sort((a,b)=>b.startedAt-a.startedAt);
      return {id:row.id,title:row.title,projectId:workspaceHandle(node,projectId),nodeId:node,
        createdAt:Date.parse(row.created_at),updatedAt:Date.parse(row.last_activity_at),
        taskCount:tasks.length,activeCount:tasks.filter(task=>activeExecution(task.executionStatus)).length,
        tasks};
    });
    const items = ledger.threads(projectId).map((thread) => {
      const agent = ledger.db.prepare(`SELECT control_state AS controlState,provider_turn_id AS providerTurnId,
        control_revision AS controlRevision FROM local_agent_sessions WHERE id=?`).get(thread.agent_id) as {
          controlState: string; providerTurnId: string | null; controlRevision: number;
        } | undefined;
      const nativeRuns = ledger.db.prepare(`SELECT DISTINCT run_id AS id FROM console_executions
        WHERE managed_thread_id=?`).all(thread.id) as Array<{ id: string }>;
      const mapped = nativeRuns.flatMap((run) => { const visible = runs.find((item) => item.localId === run.id); return visible ? [visible] : []; });
      const control = agent?.controlState === "desktop_owned" || agent?.controlState === "desktop_pending" ? "desktop"
        : agent?.controlState === "qm_active" || agent?.controlState === "interrupting" ? "quaymesh" : "idle";
      const reason = thread.protected ? "已设置保留" : !thread.identity_verified ? "归属未核实"
        : thread.external_activity ? "存在外部续写" : control !== "idle" ? "当前会话仍在执行" : mapped.some((run) => stage(run) === "review") ? "执行结果待验收" : null;
      return { id: workspaceHandle(node, thread.id), localId: thread.id, projectId: workspaceHandle(node, projectId), title: thread.title,
        runIds: mapped.map((run) => run.id), runs: mapped.map((run) => ({ id: run.id, title: run.title, status: stage(run) })),
        control, turnId: agent?.providerTurnId ?? null, revision: agent?.controlRevision ?? thread.revision,
        protectRevision: thread.revision, protected: Boolean(thread.protected), verified: Boolean(thread.identity_verified),
        external: Boolean(thread.external_activity), archiveState: thread.archive_state,
        updatedAt: Date.parse(thread.updated_at), skipReason: reason };
    });
    const batches = ledger.db.prepare("SELECT id,mode,status,created_at FROM console_archive_batches WHERE project_id=? ORDER BY created_at DESC LIMIT 50").all(projectId) as Array<{ id: string; mode: string; status: string; created_at: string }>;
    const executionClaims = readExecutionClaims(ledger.db, project.root).map(claim => ({ ...claim,
      ...(claim.state === "queued" && claim.agentId
        ? { waiting: readExecutionWaitingState(ledger.db, project.root, claim.agentId) } : {}) }));
    return { conversations,executionClaims,items, batches: batches.map((batch) => ({ id: workspaceHandle(node, batch.id), mode: batch.mode,
      status: batch.status === "succeeded" ? "completed" : batch.status, createdAt: Date.parse(batch.created_at) })),
      claims: items.filter((thread) => thread.control !== "idle").map((thread) => ({ id: thread.id, owner: thread.control, turnId: thread.turnId, updatedAt: thread.updatedAt })) };
  } finally {
    try { if (database.sqlite.inTransaction) database.sqlite.exec("ROLLBACK"); }
    finally { ledger.close(); }
  }
}
