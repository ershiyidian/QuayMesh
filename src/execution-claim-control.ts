import { WorkLedger } from "./work-ledger.js";
import { runSqliteWrite } from "./db/async-write.js";
import { samePhysicalPath } from "./physical-paths.js";
import { cancelManagedCommand } from "./managed-command-control.js";
import { createLocalAgentClient } from "./local-agent-client.js";
import type { ToolRegistrationContext } from "./tool-surfaces/types.js";
import type { InvocationContext } from "./session/types.js";
import { recoverUnstartedCommandControl } from "./execution-control-recovery.js";

/** Once control is dispatched, even a generic conflict can mean that the
 * interrupt was sent but its completion could not be confirmed. */
export async function requestClaimStop<T>(request:()=>Promise<T>):Promise<T> {
  try {return await request();}
  catch(error){throw Object.assign(error instanceof Error?error:new Error(String(error)),
    {effect:"unknown",retryHint:"query_original"});}
}

/** A workspace handle alone does not authorize another user's claim. Resolve
 * ownership through the saved Task/run/member relationship before disclosing it. */
export function requireClaimAccess(ledger: WorkLedger, input: {
  claimId: string; ownerId: string; nodeId: string; workspaceRoot: string;
}) {
  const result = ledger.inspectClaim(input.claimId);
  if (result.state === "not_found") return result;
  const links = result.runId
    ? ledger.db.prepare(`SELECT l.task_id,s.owner_id,m.node_id,m.root FROM qm_run_links l
        JOIN qm_sessions s ON s.id=l.session_id JOIN qm_session_members m ON m.id=l.member_id AND m.session_id=l.session_id
        WHERE l.run_id=?`).all(result.runId)
    : result.taskId ? ledger.db.prepare(`SELECT l.task_id,s.owner_id,m.node_id,m.root FROM qm_run_links l
        JOIN qm_sessions s ON s.id=l.session_id JOIN qm_session_members m ON m.id=l.member_id AND m.session_id=l.session_id
        WHERE l.task_id=?`).all(result.taskId) : [];
  const link = (links as Array<{task_id:string|null;owner_id:string;node_id:string;root:string}>).find(row =>
    row.owner_id === input.ownerId && row.node_id === input.nodeId && samePhysicalPath(row.root,input.workspaceRoot)
      && (!result.taskId || row.task_id === result.taskId));
  if (!link) throw Object.assign(new Error("CLAIM_SCOPE_MISMATCH: 占用不属于此用户和工作区的执行记录。"),
    {code:"CLAIM_SCOPE_MISMATCH",effect:"not_started"});
  return { ...result, taskId: result.taskId ?? link.task_id };
}

export async function recoverWorkspaceClaim(context: ToolRegistrationContext, input: {
  claim_id: string; recovery_action?: "inspect" | "release" | "stop";
}, workspace: {id:string;root:string}, invocation: InvocationContext) {
  const runtime = context.sessionRuntime;
  if (!runtime) throw new Error("SESSION_RUNTIME_REQUIRED");
  const nodeId = context.config.federation?.nodeId ?? "local", ledger = new WorkLedger(context.config.stateDir);
  try {
    const observed = requireClaimAccess(ledger, {claimId:input.claim_id,ownerId:invocation.owner_id,nodeId,workspaceRoot:workspace.root});
    const action = input.recovery_action ?? "inspect";
    let result = observed;
    let stop: unknown;
    if (action !== "inspect" && observed.state !== "not_found") {
      result = await runSqliteWrite(ledger.db, () => {
        requireClaimAccess(ledger,{claimId:input.claim_id,ownerId:invocation.owner_id,nodeId,workspaceRoot:workspace.root});
        return ledger.recoverClaim(input.claim_id);
      });
      if (action === "stop" && result.state !== "released" && result.ownerAlive && result.runId) {
        if (result.kind === "command" && result.operationId) {
          stop = await cancelManagedCommand({ runtime,processSessions:context.processSessions,ownerId:invocation.owner_id,
            nodeId,workspaceRoot:workspace.root,operationId:result.operationId });
        } else if (result.kind === "agent" && result.agentId && result.executionId) {
          const execution = ledger.execution(result.executionId);
          // Provider turn identity is the stop target. A newer turn of this
          // agent, or an unbound queued turn, must never inherit this stop.
          if (execution.provider_turn_id) {
            const client = createLocalAgentClient(context.config);
            const agentId=result.agentId,expectedTurnId=execution.provider_turn_id;
            stop = await requestClaimStop(async()=>{
              const stopped = await client.control({agentId,action:"interrupt",workRunId:execution.run_id,
                expectedTurnId,requestKey:`claim-recovery:${invocation.invocation_id}`.slice(0,128),
                scope:{workspaceId:workspace.id,workspaceRoot:workspace.root}});
              if(stopped.isErr())throw Object.assign(new Error(stopped.error.message),{code:stopped.error.code,
                details:{claim_id:input.claim_id,agent_id:agentId,execution_id:result.executionId}});
              return stopped.value;
            });
          }
        }
        if (stop) {
          const after = await runSqliteWrite(ledger.db, () => ledger.recoverClaim(input.claim_id));
          result = after.state === "not_found" ? {...result,state:"released",physicalState:"quiescent"} : after;
        }
      }
    }
    return { action:"recovery",workspace_id:workspace.id,node_id:nodeId,recovery_action:action,
      resource_recovery:{claim_id:input.claim_id,state:result.state,physical_state:result.physicalState ?? null,
        operation_id:result.operationId ?? null,execution_id:result.executionId ?? null,
        task_id:result.taskId ?? observed.taskId ?? null,agent_id:result.agentId ?? null,
        execution_status:result.executionStatus ?? null,reason:result.reason ?? null,
        result_reconciliation:"unchanged",...(stop?{stop}:{}),
        ...(result.state === "active" || result.state === "unknown" ? {next_action:{tool:"workspace_context",
          arguments:{workspace_id:workspace.id,action:"recovery",claim_id:input.claim_id,recovery_action:"inspect"}}}:{}),
      }};
  } finally { ledger.close(); }
}

export async function recoverWorkspaceOperation(context:ToolRegistrationContext,input:{
  operation_id:string;recovery_action?:"inspect"|"release";
},workspace:{id:string;root:string},invocation:InvocationContext) {
  const ledger=new WorkLedger(context.config.stateDir),nodeId=context.config.federation?.nodeId??"local";
  try {
    const apply=input.recovery_action==="release";
    const recover=()=>recoverUnstartedCommandControl(ledger.db,{operationId:input.operation_id,
      ownerId:invocation.owner_id,nodeId,workspaceRoot:workspace.root,apply});
    const result=apply?await runSqliteWrite(ledger.db,recover):recover();
    return {action:"recovery",workspace_id:workspace.id,node_id:nodeId,recovery_action:input.recovery_action??"inspect",
      operation_recovery:result};
  } finally {ledger.close();}
}
