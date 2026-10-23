import { contextPage, listDirectories } from "./context-pages.js";
import {workspaceEnvironment} from "../workspace-environment.js";
import {mapConcurrent} from "../concurrency.js";
import { realpath } from "node:fs/promises";
import { relative, isAbsolute, sep } from "node:path";
import * as z from "zod/v4";
import type { ToolRegistrationContext } from "./types.js";
import { jsonReply, replyBytes, REPLY_BYTES } from "../bounded-reply.js";
import { currentInvocation } from "../session/invocations.js";
import type { InvocationContext } from "../session/types.js";
import { currentOperationEvents } from "../session/activity.js";
import { savedOperationStatus } from "../session/operation-status.js";
import { observationBudget, observeWithSignal } from "../observation-budget.js";

const id = z.string().min(1).max(256);
const fileSelectionSchema = z.object({
  path:z.string().min(1).max(1024),start_line:z.number().int().min(1).max(1_000_000).optional(),
  max_lines:z.number().int().min(1).max(250).optional(),
}).strict();

export const workspaceContextInputSchema = z.object({
  workspace_id:id,action:z.enum(["list","capture","search","status","recovery"]),
  files:z.array(fileSelectionSchema).min(1).max(24).optional(),
  directory:z.string().optional(),depth:z.number().int().min(1).max(4).optional(),
  offset:z.number().int().min(0).max(100_000).optional(),
  result_ref:id.optional(),cursor:z.string().max(4096).optional(),
  query:z.string().min(1).max(256).optional(),queries:z.array(z.string().min(1).max(256)).min(1).max(8).optional(),
  patterns:z.array(z.string().min(1).max(256)).min(1).max(8).optional(),
  context_lines:z.number().int().min(0).max(20).optional(),
  file_offset:z.number().int().nonnegative().optional(),max_files:z.number().int().min(1).max(500).optional(),
  selection_index:z.number().int().min(0).max(499).optional(),line_offset:z.number().int().min(0).max(4*1024*1024).optional(),
  operation_id:id.optional(),operation_ids:z.array(id).min(1).max(8).optional(),
  session_id:id.optional(),task_id:id.optional(),limit:z.number().int().min(1).max(20).optional(),
  environment:z.boolean().optional(),python:z.string().min(1).optional(),
}).strict().superRefine((input,context)=>{
  const allowed:Record<string,string[]>={
    list:["directory","depth","offset"],
    capture:["files","result_ref","cursor","selection_index","line_offset"],
    search:["files","result_ref","cursor","query","queries","directory","patterns","context_lines","file_offset","max_files","selection_index","line_offset"],
    status:["operation_id","operation_ids","limit","environment","python","offset"],
    recovery:["session_id","task_id","cursor","limit"],
  };
  const error=(message:string,path:string)=>context.addIssue({code:"custom",path:[path],message});
  for(const key of Object.keys(input))if(!["workspace_id","action",...allowed[input.action]!].includes(key))error("参数不适用于当前 action",key);
  if(input.action==="capture"&&!input.files&&!input.result_ref)error("capture 需要 files 或 result_ref","files");
  if(input.action==="search"&&!input.result_ref&&!input.query&&!input.queries)error("search 需要 query 或 queries","queries");
  if(input.query&&input.queries)error("query 与 queries 只能选择一项","query");
  if(input.files&&input.result_ref)error("已有结果续读不重复传 files","files");
  if(input.action!=="recovery"&&input.cursor&&!input.result_ref)error("cursor 需要 result_ref","cursor");
  if(input.files&&(input.directory||input.patterns||input.file_offset))error("明确选区与目录搜索范围只能选择一项","files");
  if(input.operation_id&&input.operation_ids)error("单项与批量只能选择一项","operation_ids");
  if(input.python&&!input.environment)error("python 只用于 environment 查询","python");
});

export function registerWorkspaceContextTool({ server, config, workspaces, processSessions, sessionRuntime }: ToolRegistrationContext): void {
  server.registerTool("workspace_context", {
    title: "Inspect workspace",
    description: "Batch file ranges or literal searches. Continue with result_ref and cursor. status/recovery inspect saved work.",
    inputSchema: workspaceContextInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (rawInput, extra) => {
    const input = workspaceContextInputSchema.parse(rawInput);
    const historical = input.action === "recovery" || (input.action === "status" && !input.environment);
    const observation = currentInvocation();
    // 历史任务读取已经有授权成员身份，工作树删除后仍从数据库查询原始记录。
    const member = historical && observation && sessionRuntime
      ? sessionRuntime.store.getMember(observation.session_id, observation.member_id) : null;
    if (member && member.workspace_id !== input.workspace_id) throw new Error("WORKSPACE_SESSION_MISMATCH");
    const liveWorkspace = member ? undefined : await workspaces.getWorkspace(input.workspace_id,{touch:false});
    const workspace = liveWorkspace ?? { id: member!.workspace_id, root: member!.root };
    if (input.action === "status") {
      if (!sessionRuntime) throw new Error("SESSION_RUNTIME_REQUIRED");
      if(input.environment)return jsonReply(await workspaceEnvironment({server,config,workspaces,processSessions,sessionRuntime},workspace.id,input.python));
      if(input.operation_ids){
        const results=await mapConcurrent(input.operation_ids,4,async operation_id=>{
          try{return {operation_id,...await statusReply(sessionRuntime,processSessions,workspace,operation_id,input.limit)};}
          catch(error){return {operation_id,error:error instanceof Error?error.message:String(error)};}
        });
        return jsonReply({results,partial:results.some(result=>"error" in result)});
      }
      return jsonReply(await statusReply(sessionRuntime, processSessions, workspace, input.operation_id, input.limit, input.offset));
    }
    if (input.action === "recovery") {
      if (!sessionRuntime) throw new Error("SESSION_RUNTIME_REQUIRED");
      if (input.task_id) {
        const invocation=currentInvocation();
        if(!invocation)throw new Error("MISSING_OPERATION_CONTEXT");
        return jsonReply(sessionRuntime.recovery.taskDetail(invocation.owner_id,workspace.root,input.task_id,
          config.federation?.nodeId ?? "local",input.limit));
      }
      return jsonReply(await recoveryReply(sessionRuntime, workspace, input, currentInvocation()));
    }
    if (!liveWorkspace) throw new Error("WORKSPACE_OBSERVATION_MODE_REQUIRED");
    const invocation = currentInvocation();
    const budget=observationBudget("workspace_context",input,extra as {signal?:AbortSignal;_meta?:unknown});
    const capture = () => processSessions.readWorkspace(workspace.root, async () => {
      budget.signal.throwIfAborted();
      const receipt = {
        hostAcknowledgment: "unknown" as const,
        ...(invocation?.operation_id ? { operation_id: invocation.operation_id } : {}),
        ...(invocation?.run_id ? { work_run_id: invocation.run_id } : {}),
      };
      if (input.action === "list") {
        const base = await realpath(workspace.root);
        const path = await workspaces.resolvePath(liveWorkspace, input.directory ?? ".");
        const resolved = await realpath(path);
        const rest = relative(base, resolved);
        if (isAbsolute(rest) || rest === ".." || rest.startsWith(`..${sep}`)) throw new Error("Directory is outside this workspace.");
        const offset = input.offset ?? 0;
        const entries = await listDirectories(resolved,input.depth??1,offset+101,budget.signal);
        const page = entries.slice(offset,offset+100);
        const complete=entries.length<offset+101;
        const value = { ...receipt, providerInvoked: false, entries: page, total:complete?entries.length:null,enumeration_complete:complete,
          nextOffset: offset + page.length < entries.length ? offset + page.length : null };
        while (replyBytes(value) > REPLY_BYTES && page.length > 1) {
          page.pop(); value.nextOffset = offset + page.length;
        }
        return value;
      }
      return contextPage({server,workspaces,processSessions,sessionRuntime,config},liveWorkspace,{...input,action:input.action as "capture"|"search"},budget.signal);
    });
    try {
      const result=await observeWithSignal(capture(),budget.signal);
      return jsonReply(result, "partial" in result && result.partial ? "部分选区失败，错误与成功内容均已保留。" : undefined);
    } finally {budget.dispose();}
  });
}

type StatusOperationRow = {
  operation_id: string;
  kind: string;
  label: string;
  state: string;
  effect: string;
  created_at: string;
  finished_at: string | null;
  process_handle?: string;
  agent_id?: string;
  result_ref?: string;
  outcome: string;
  error?: { code: string; message: string; next_action: string };
};

async function statusReply(
  runtime: NonNullable<ToolRegistrationContext["sessionRuntime"]>,
  processSessions: ToolRegistrationContext["processSessions"],
  workspace: { id: string; root: string },
  operationId?: string,
  limit = 10,
  offset = 0,
): Promise<Record<string, unknown>> {
  const invocation = currentInvocation();
  if (!invocation) throw new Error("MISSING_OPERATION_CONTEXT");
  const session = runtime.store.requireSession(invocation.owner_id, invocation.session_id);
  const member = runtime.store.getMember(session.id, invocation.member_id);
  if (member.workspace_id !== workspace.id && member.workspace_id !== invocation.workspace_id) {
    throw new Error("WORKSPACE_SESSION_MISMATCH");
  }
  if (operationId) {
    const saved=savedOperationStatus(runtime.store,invocation,workspace.id,operationId,{offset,
      agentId:runtime.store.agentForOperation(operationId,session.id,member.id)?.agentId,
      processHandle:processSessions.findOperation(operationId)?.session_id});
    if (saved) return saved;
  }
  const events = operationId ? runtime.store.eventsForOperation(operationId,session.id,member.id) : runtime.store.eventsForSession(session.id);
  const byOperation = new Map<string, StatusOperationRow>();
  for (const event of currentOperationEvents(events)) {
    if (event.member_id !== member.id) continue;
    if (event.type !== "operation_started" && event.type !== "operation_finished") continue;
    const id = String(event.payload.operation_id ?? event.source_id);
    if (operationId && id !== operationId) continue;
    const previous = byOperation.get(id);
    const running = event.type === "operation_started";
    const state = String(event.payload.status ?? (running ? "running" : "unknown"));
    const errorCode = event.payload.error_code === null || event.payload.error_code === undefined ? null : String(event.payload.error_code);
    const errorMessage = event.payload.error_message === null || event.payload.error_message === undefined ? null : String(event.payload.error_message);
    const mappedAgentId = runtime.store.agentForOperation(id, session.id, member.id)?.agentId;
    const eventAgentId = event.payload.agent_id === null || event.payload.agent_id === undefined ? undefined : String(event.payload.agent_id);
    const agentId = mappedAgentId ?? eventAgentId ?? previous?.agent_id;
    const processHandle = processSessions.findOperation(id)?.session_id;
    byOperation.set(id, {
      operation_id: id,
      kind: String(event.payload.kind ?? previous?.kind ?? "unknown"),
      label: String(event.payload.label ?? previous?.label ?? ""),
      state: running ? "running" : state,
      effect: String(event.payload.effect ?? previous?.effect ?? (running ? "started" : "unknown")),
      created_at: previous?.created_at ?? event.timestamp,
      finished_at: running ? null : event.timestamp,
      ...(processHandle === undefined ? {} : { process_handle: processHandle }),
      ...(agentId === undefined ? {} : { agent_id: agentId }),
      ...(typeof event.payload.result_ref === "string" ? { result_ref: event.payload.result_ref } : previous?.result_ref ? { result_ref: previous.result_ref } : {}),
      outcome: running ? "unknown" : state === "succeeded" ? "completed" : state === "failed" ? "failed" : state === "cancelled" ? "cancelled" : "unknown",
      ...(errorCode || errorMessage ? { error: {
        code: errorCode ?? "OPERATION_ERROR",
        message: errorMessage ?? "Operation failed without a stored message.",
        next_action: "Inspect stored evidence; do not repeat a side effect until its effect is known.",
      } } : {}),
    });
  }
  const operations = [...byOperation.values()].slice(-limit).reverse();
  return {
    session_id: session.id,
    workspace_id: workspace.id,
    execution_state: session.execution_state,
    review_state: session.review_state,
    host_state: session.host_state,
    operations,
    ...(operationId ? {operation_id:operationId,lookup:operations.length?"found":"not_found",
      ...(!operations.length?{operation_state:"unknown",effect:"unknown",result_ready:false}: {})} : {}),
    unknown_effects: operationId&&!operations.length ? [operationId] : operations.filter((row) => row.effect === "unknown" || row.state === "unknown").map((row) => row.operation_id),
    note: "This read does not change execution state. Use read, write_stdin, wait_agent or Console for detailed evidence.",
  };
}

async function recoveryReply(
  runtime: NonNullable<ToolRegistrationContext["sessionRuntime"]>,
  workspace: { id: string; root: string },
  input: { session_id?: string; cursor?: string; limit?: number },
  invocation: InvocationContext | undefined,
): Promise<Record<string, unknown>> {
  if (!invocation) throw new Error("MISSING_OPERATION_CONTEXT");
  const sessionId = input.session_id;
  if (sessionId) {
    const detail = runtime.recovery.detail(invocation.owner_id, workspace.root, sessionId);
    return { action: "recovery", workspace_id: workspace.id, detail };
  }
  const page = await runtime.service.recoverSummary(
    { owner_id: invocation.owner_id },
    workspace.root,
    input.limit ?? 5,
    input.cursor,
  );
  return {
    action: "recovery",
    workspace_id: workspace.id,
    rows: page.rows,
    next_cursor: page.nextCursor,
    note: "Recorded facts only; liveness is current at read time.",
  };
}
