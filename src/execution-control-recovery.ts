import type Database from "better-sqlite3";
import { samePhysicalPath } from "./physical-paths.js";
import { quiescenceSubject, recordExecutionQuiescence } from "./maintenance-status.js";

type ControlAttempt = {
  status:string; request_key:string; run_id:string; session_id:string; member_id:string; task_id:string;
  owner_id:string; node_id:string; root:string; workspace_id:string;
};
type SavedInvocation = {
  id:string; operation_id:string; owner_id:string; session_id:string; member_id:string; task_id:string|null;
  tool_name:string; arguments_json:string; result_json:string|null; state:string; effect:string; finished_at:string|null;
};
const object = (json:string|null):Record<string,unknown> => {
  try {const value:unknown=JSON.parse(json??"null");return value&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:{};}
  catch {return {};}
};

/** A saved local pre-effect rejection can certify the control request itself.
 * It cannot certify the command named in that request. Accept an existing
 * connection so the same recovery works on v16 without opening/migrating it. */
export function recoverUnstartedCommandControl(db:Database.Database,input:{
  operationId:string; ownerId:string; nodeId:string; workspaceRoot:string; apply?:boolean;
}) {
  const recover=()=>{
    const row=db.prepare(`SELECT o.status,o.request_key,o.run_id,l.session_id,l.member_id,l.task_id,
      s.owner_id,m.node_id,m.root,m.workspace_id FROM console_operations o
      JOIN qm_run_links l ON l.run_id=o.run_id
      JOIN qm_sessions s ON s.id=l.session_id
      JOIN qm_tasks t ON t.id=l.task_id AND t.session_id=l.session_id
      JOIN qm_session_members m ON m.id=l.member_id AND m.session_id=l.session_id
      WHERE o.id=?`).get(input.operationId) as ControlAttempt|undefined;
    if(!row||row.owner_id!==input.ownerId||row.node_id!==input.nodeId||!samePhysicalPath(row.root,input.workspaceRoot))
      throw Object.assign(new Error("OPERATION_SCOPE_MISMATCH: 操作不属于此用户和工作区。"),
        {code:"OPERATION_SCOPE_MISMATCH",effect:"not_started"});
    const result={operation_id:input.operationId,task_id:row.task_id,execution_status:row.status,
      state:"unknown",physical_state:"unknown",result_reconciliation:"unchanged",
      reason:"No exact local pre-effect control receipt is available."};
    if(!["unknown","reconciliation_required"].includes(row.status))return result;
    const invocation=db.prepare("SELECT * FROM qm_invocations WHERE id=? AND operation_id=?")
      .get(row.request_key,input.operationId) as SavedInvocation|undefined;
    const owner=db.prepare("SELECT generation,owner_token,owner_pid,process_start FROM execution_owners WHERE domain='operation' AND id=?")
      .get(input.operationId) as {generation:string;owner_token:string;owner_pid:number;process_start:string|null}|undefined;
    if(!invocation||invocation.owner_id!==input.ownerId||invocation.session_id!==row.session_id
      ||invocation.member_id!==row.member_id||invocation.task_id!==row.task_id||invocation.tool_name!=="cancel_command"
      ||invocation.state!=="unknown"||invocation.effect!=="unknown"||!invocation.finished_at
      ||!Number.isFinite(Date.parse(invocation.finished_at))||!owner||owner.generation!==invocation.id
      ||!owner.owner_token||!Number.isInteger(owner.owner_pid)||owner.owner_pid<=0||!owner.process_start)return result;
    const envelope=object(invocation.result_json),args=object(invocation.arguments_json);
    if(envelope.kind!=="error"||envelope.errorCode!=="COMMAND_NOT_ATTACHED"||envelope.effect!=="unknown"
      ||typeof args.operation_id!=="string"||!args.operation_id||args.operation_id.length>256
      ||args.operation_id===input.operationId)return result;
    // Forwarded first replies have no local operation-finished event. Require
    // the exact handler's saved finish, not a timeout or an error text match.
    const finished=db.prepare(`SELECT 1 FROM qm_events WHERE session_id=? AND member_id=? AND task_id=?
      AND event_type='operation_finished' AND json_extract(data_json,'$.operation_id')=?
      AND json_extract(data_json,'$.invocation_id')=? AND json_extract(data_json,'$.error_code')='COMMAND_NOT_ATTACHED'
      AND json_extract(data_json,'$.effect')='unknown' LIMIT 1`)
      .get(row.session_id,row.member_id,row.task_id,input.operationId,invocation.id);
    if(!finished)return result;
    const subject=quiescenceSubject(db,"operation",input.operationId);
    const saved=db.prepare(`SELECT receipt_id FROM execution_quiescence
      WHERE domain='operation' AND object_id=? AND generation=? AND fingerprint=? AND invalidated_at IS NULL LIMIT 1`)
      .get(input.operationId,subject.generation,subject.fingerprint) as {receipt_id:string}|undefined;
    const receiptId=`control-not-started:${invocation.id}:COMMAND_NOT_ATTACHED`;
    if(input.apply&&!saved)recordExecutionQuiescence(db,[subject],{
      id:receiptId,verifiedAt:new Date().toISOString(),evidence:{version:1,boundary:"cancel_command_guard_not_started",
        operationId:input.operationId,invocationId:invocation.id,targetOperationId:args.operation_id,
        sessionId:row.session_id,taskId:row.task_id,memberId:row.member_id,runId:row.run_id,
        nodeId:row.node_id,workspaceId:row.workspace_id,ownerToken:owner.owner_token,ownerPid:owner.owner_pid,
        processStart:owner.process_start,generation:owner.generation,settledAt:invocation.finished_at,
        errorCode:"COMMAND_NOT_ATTACHED",resultReconciliation:"unchanged"},
    });
    return {...result,state:input.apply||saved?"quiescent":"recoverable",physical_state:input.apply||saved?"quiescent":"unknown",
      receipt_id:saved?.receipt_id??(input.apply?receiptId:null),target_operation_id:args.operation_id,
      reason:"The saved local cancellation guard returned before signal delivery; the target command is unchanged."};
  };
  return input.apply?db.transaction(recover).immediate():db.transaction(recover).deferred();
}
