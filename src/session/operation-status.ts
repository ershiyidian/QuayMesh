import { textPage, replyBytes, REPLY_BYTES } from "../bounded-reply.js";
import type { SessionStore } from "./store.js";
import type { InvocationContext } from "./types.js";

// 入口和执行节点共用相同的回执投影；scope 始终来自已认证的会话成员。
export function savedOperationStatus(store: SessionStore, context: Pick<InvocationContext,"owner_id"|"session_id"|"member_id">,
  workspaceId: string, operationId: string, options: {offset?:number;processHandle?:string|number;agentId?:string} = {}): Record<string,unknown> | undefined {
  const session=store.requireSession(context.owner_id,context.session_id);
  const member=store.getMember(session.id,context.member_id);
  const saved=store.findInvocationResultByOperation(context.owner_id,operationId);
  if (!saved) return;
  if (saved.session_id!==session.id || saved.member_id!==member.id) throw new Error("WORKSPACE_SESSION_MISMATCH");
  const event=store.findOperationEvent(operationId);
  const envelope=saved.result_json ? JSON.parse(saved.result_json) : null;
  const hasResult=envelope?.kind==="result" && envelope.value!==undefined;
  const result=hasResult ? envelope.value : null;
  const resultJson=hasResult ? JSON.stringify(result) : null;
  const errorJson=envelope?.kind==="error" ? JSON.stringify(envelope) : null;
  const offset=options.offset??0;
  const page=resultJson && (offset>0 || Buffer.byteLength(resultJson)>4096) ? textPage(resultJson,offset,4096) : null;
  const errorPage=errorJson && (offset>0 || Buffer.byteLength(errorJson)>2048) ? textPage(errorJson,offset,4096) : null;
  const pending=["accepted","queued","running"].includes(saved.state);
  const command=["exec_command","bash"].includes(saved.tool_name);
  const error=envelope?.kind==="error" ? {code:textPage(String(envelope.errorCode??"OPERATION_ERROR"),0,128).text,
    message:textPage(String(envelope.message??"Operation failed."),0,256).text,
    next_action:"Inspect the original operation receipt before retrying."} : undefined;
  const label=String(event?.payload.label??saved.tool_name),labelPage=textPage(label,0,512);
  return {
    session_id:session.id,task_id:saved.task_id,workspace_id:workspaceId,operation_id:operationId,invocation_id:saved.id,
    lookup:"found",execution_state:session.execution_state,review_state:session.review_state,host_state:session.host_state,
    tool_name:saved.tool_name,operation_state:saved.state,effect:saved.effect,
    operations:[{operation_id:operationId,kind:textPage(String(event?.payload.kind??saved.tool_name),0,128).text,label:labelPage.text,
      ...(labelPage.nextOffset!==null?{label_truncated:true}:{}),
      state:saved.state,effect:saved.effect,created_at:saved.created_at,finished_at:saved.finished_at,
      outcome:saved.state==="succeeded"?"completed":saved.state,
      ...(options.agentId?{agent_id:options.agentId}:{}),...(options.processHandle!==undefined?{process_handle:options.processHandle}:{}),
      ...(saved.result_ref?{result_ref:saved.result_ref}:{}),...(error?{error}:{})}],
    unknown_effects:saved.effect==="unknown"?[operationId]:[],result_ready:hasResult,result_ref:saved.result_ref,
    ...(page ? {[command?"initial_receipt_page":"result_page"]:{...page,encoding:"json",next_offset:page.nextOffset}}
      : hasResult ? {[command?"initial_receipt":"result"]:result} : {}),
    ...(error?{error:errorPage ? {kind:"error",errorCode:error.code,message:error.message,effect:saved.effect,
      retryHint:textPage(String(envelope.retryHint??"query_original"),0,128).text,truncated:true} : envelope}:{}),
    ...(errorPage?{error_page:{...errorPage,encoding:"json",next_offset:errorPage.nextOffset}}:{}),
    created_at:saved.created_at,finished_at:saved.finished_at,
    poll_after_ms:pending?2000:null,
    next_action:errorPage?.nextOffset!==null&&errorPage?.nextOffset!==undefined
      ? {tool:"workspace_context",arguments:{workspace_id:workspaceId,action:"status",operation_id:operationId,offset:errorPage.nextOffset}}
      : command&&hasResult ? {tool:"read_output",arguments:{workspace_id:workspaceId,operation_id:operationId,cursor:0}}
      : pending ? {tool:"workspace_context",arguments:{workspace_id:workspaceId,action:"status",operation_id:operationId}} : null,
  };
}

export function operationReceiptSummary(receipt: Record<string,unknown>): Record<string,unknown> {
  return Object.fromEntries(["operation_id","invocation_id","task_id","tool_name","operation_state","effect","created_at","finished_at","result_ready","result_ref"]
    .filter(key=>receipt[key]!==undefined).map(key=>[key,receipt[key]]));
}

// 批量观察保留每项身份和状态；超预算的正文通过原操作单独续读。
export function operationStatusBatch(results: Record<string,unknown>[], partial: boolean,
  workspaceId: string, taskId?: string): {results: Record<string,unknown>[]; partial: boolean} {
  const batch = {results,partial};
  if (replyBytes(batch) <= REPLY_BYTES - 512) return batch;
  const deferred = results.map(row => {
    const {result:_result,initial_receipt:_receipt,result_page:_resultPage,
      initial_receipt_page:_receiptPage,error_page:_errorPage,...status} = row;
    const selectedTaskId = typeof row.task_id === "string" ? row.task_id : taskId;
    return {...status,details_deferred:true,next_action:{tool:"workspace_context",arguments:{
      workspace_id:workspaceId,action:"status",operation_id:row.operation_id,
      ...(selectedTaskId ? {task_id:selectedTaskId} : {}),
    }}};
  });
  const bounded = {results:deferred,partial};
  if (replyBytes(bounded) > REPLY_BYTES - 512) {
    throw Object.assign(new Error("STATUS_METADATA_TOO_LARGE: Query these operations individually."), {
      code:"STATUS_METADATA_TOO_LARGE",effect:"not_started",details:{operations:results.map(row =>
        Object.fromEntries(["operation_id","invocation_id","task_id","operation_state","effect"]
          .filter(key=>row[key]!==undefined).map(key=>[key,row[key]])))},
    });
  }
  return bounded;
}
