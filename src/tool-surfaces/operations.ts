import * as z from "zod/v4";
import { jsonReply, REPLY_BYTES, replyBytes } from "../bounded-reply.js";
import { currentInvocation } from "../session/invocations.js";
import { OperationState } from "../session/types.js";
import { mapConcurrent } from "../concurrency.js";
import type { ToolRegistrationContext } from "./types.js";

function outputWorkspace(context: ToolRegistrationContext, workspaceId: string) {
  const runtime = context.sessionRuntime, invocation = currentInvocation();
  if (!runtime || !invocation) throw new Error("SESSION_RUNTIME_REQUIRED");
  // 输出属于已经授权的成员，读取历史结果不依赖工作目录仍然存在。
  const member = runtime.store.getMember(invocation.session_id, invocation.member_id);
  if (member.workspace_id !== workspaceId || member.node_id !== (context.config.federation?.nodeId ?? "local")) {
    throw Object.assign(new Error("WORKSPACE_SESSION_MISMATCH"), { code: "WORKSPACE_SESSION_MISMATCH", effect: "not_started" });
  }
  return member;
}

export async function commandOutput(context:ToolRegistrationContext,workspaceId:string,operationId:string,cursor=0,limit=16384,preview=false) {
  const runtime=context.sessionRuntime,invocation=currentInvocation();
  if(!runtime||!invocation)throw new Error("SESSION_RUNTIME_REQUIRED");
  const workspace=outputWorkspace(context,workspaceId);
  const command=runtime.store.requireCommand(invocation.owner_id,context.config.federation?.nodeId??"local",workspace.root,operationId);
  const saved = runtime.store.findInvocationByOperation(invocation.owner_id, operationId)!;
  if (saved.effect === "not_started") {
    if (cursor !== 0) throw new Error("OUTPUT_RANGE_EXPIRED: command has not produced output");
    const pending = ["accepted", "queued", "running"].includes(saved.state);
    const envelope = saved.result_json ? JSON.parse(saved.result_json) : null;
    return { result: pending ? "" : String(envelope?.message ?? envelope?.error ?? ""),
      operation_id: operationId, task_id: command.task_id, operation_state: pending ? "preparing" : saved.state,
      cursor: 0, next_cursor: 0, total_bytes: 0, retained_from: 0, retained_until: null,
      done: !pending, process_done: !pending, has_more: false, truncated: false,
      exit_code: null, signal: null, poll_after_ms: pending ? 2000 : null };
  }
  if(command.retained_until&&Date.parse(command.retained_until)<Date.now())throw new Error(`OUTPUT_EXPIRED: ${command.retained_until}`);
  let page=await runtime.output.modelRead(command.session_id,operationId,cursor,limit);
  if(page.truncated&&!preview)throw new Error(`OUTPUT_RANGE_EXPIRED: operation_id=${operationId}; requested=${cursor}; retained_from=${page.retainedFrom}`);
  const attached=context.processSessions.findOperation(operationId);
  const state=!attached&&["running","queued","starting"].includes(command.status)?"reconciliation_required":command.status;
  const value=()=>({
    result:page.chunk,operation_id:operationId,task_id:command.task_id,operation_state:state,
    cursor:page.cursor,next_cursor:page.nextCursor,total_bytes:page.totalBytes,retained_from:page.retainedFrom,
    retained_until:command.retained_until,done:page.done,process_done:page.processDone,
    has_more:page.nextCursor<page.totalBytes,truncated:page.truncated,exit_code:page.exitCode,signal:page.signal,
    poll_after_ms:page.processDone||!attached?null:5000,
  });
  while(replyBytes(value())>REPLY_BYTES&&limit>4) {
    limit=Math.max(4,Math.floor(limit/2));page=await runtime.output.modelRead(command.session_id,operationId,cursor,limit);
  }
  if(replyBytes(value())>REPLY_BYTES)throw new Error("OUTPUT_METADATA_TOO_LARGE");
  return value();
}

export function registerOperationTools(context:ToolRegistrationContext):void {
  const runtime=context.sessionRuntime;
  if(!runtime)return;
  const {server,processSessions}=context;
  const id=z.string().min(1).max(256);
  const selection=z.object({operation_id:id,cursor:z.number().int().nonnegative().default(0)}).strict();
  server.registerTool("read_output",{
    title:"Read output",description:"Read durable output by byte cursor. outputs batches up to 8 commands with one total byte/wait budget.",
    inputSchema:z.object({workspace_id:z.string().min(1),operation_id:id.optional(),
      outputs:z.array(selection).min(1).max(8).optional(),cursor:z.number().int().nonnegative().optional(),
      limit_bytes:z.number().int().min(4).max(32768).default(16384),wait_ms:z.number().int().min(0).max(10000).default(0),
    }).strict().superRefine((input,ctx)=>{
      if(Boolean(input.operation_id)===Boolean(input.outputs))ctx.addIssue({code:"custom",message:"需要 operation_id 或 outputs 其中一项"});
      if(input.outputs&&input.cursor!==undefined)ctx.addIssue({code:"custom",path:["cursor"],message:"批量游标属于各个输出"});
      if(input.outputs&&input.limit_bytes<input.outputs.length*4)ctx.addIssue({code:"custom",path:["limit_bytes"],message:"每项至少需要四个字节"});
    }),
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
  },async(input,extra)=>{
    const invocation=currentInvocation();if(!invocation)throw new Error("MISSING_OPERATION_CONTEXT");
    const workspace=outputWorkspace(context,input.workspace_id);
    const items=input.outputs??[{operation_id:input.operation_id!,cursor:input.cursor??0}];
    // 身份先验证；已授权结果的过期/范围错误按对应项返回。
    for(const item of items)runtime.store.requireCommand(invocation.owner_id,context.config.federation?.nodeId??"local",workspace.root,item.operation_id);
    const signal=(extra as {signal?:AbortSignal}).signal;
    const watch=input.wait_ms?runtime.output.watch(items.map(item=>item.operation_id),input.wait_ms,signal):undefined;
    let budget=input.limit_bytes;
    const getPages=()=>mapConcurrent(items,4,async(item,index)=>{
      try{return {index,...await commandOutput(context,input.workspace_id,item.operation_id,item.cursor,Math.max(4,Math.floor(budget/items.length))) };}
      catch(error){return {index,operation_id:item.operation_id,cursor:item.cursor,error:error instanceof Error?error.message:String(error)};}
    });
    try {
      let pages=await getPages();
      const ready=()=>pages.some(page=>"error" in page||page.process_done||page.next_cursor>page.cursor||page.operation_state==="reconciliation_required");
      if(watch&&!ready()) {await watch.changed;if(signal?.aborted)throw signal.reason;pages=await getPages();}
      if(!input.outputs) {
        const page=pages[0]!;
        if("error" in page)throw new Error(page.error);
        const {index,...value}=page;return jsonReply(value);
      }
      const value=()=>({outputs:pages,partial:pages.some(page=>"error" in page),
        poll_after_ms:pages.some(page=>!("error" in page)&&page.poll_after_ms!==null)?5000:null});
      while(replyBytes(value())>REPLY_BYTES&&budget>items.length*4) {budget=Math.max(items.length*4,Math.floor(budget/2));pages=await getPages();}
      if(replyBytes(value())>REPLY_BYTES)throw new Error("OUTPUT_METADATA_TOO_LARGE");
      return jsonReply(value(),value().partial?"Some outputs failed; inspect each error.":"Outputs read.");
    } finally {watch?.dispose();}
  });

  server.registerTool("cancel_command",{
    title:"Cancel command",description:"Stop this command. A terminal command is unchanged.",
    inputSchema:{workspace_id:z.string().min(1),operation_id:id},
    annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:true,openWorldHint:false},
  },async({workspace_id,operation_id})=>{
    const invocation=currentInvocation();if(!invocation)throw new Error("MISSING_OPERATION_CONTEXT");
    const workspace=await context.workspaces.getWorkspace(workspace_id);
    const recorded=runtime.store.requireCommand(invocation.owner_id,context.config.federation?.nodeId??"local",workspace.root,operation_id);
    const active=processSessions.findOperation(operation_id);
    if(["completed","failed","cancelled"].includes(recorded.status))return jsonReply({operation_id,state:recorded.status,cancel_requested:false});
    const saved = runtime.store.findInvocationByOperation(invocation.owner_id, operation_id)!;
    if (saved.effect === "not_started" && !active) {
      const result = jsonReply({ operation_id, result: "命令在启动前已取消。", running: false,
        accepted: true, state: "cancelled", effect: "not_started" });
      runtime.store.updateInvocation({ ownerId: saved.owner_id, transportInstanceId: saved.transport_instance_id,
        requestId: saved.request_id, state: OperationState.cancelled, effect: "not_started",
        result: { kind: "result", value: result }, finished: true, responded: true });
      await runtime.service.finishOperationById(operation_id, { status: OperationState.cancelled,
        effect: "not_started", result_ref: operation_id });
      return jsonReply({ operation_id, state: "cancelled", cancel_requested: true });
    }
    if(!active?.running)throw new Error("COMMAND_NOT_ATTACHED: inspect existing process ownership before cancelling");
    processSessions.terminate(active.workspace_id,operation_id);
    return jsonReply({operation_id,state:"stopping",cancel_requested:true});
  });
}
