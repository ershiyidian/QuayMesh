import {ConsoleReadError} from "./read-process.js";
import {isolatedConsoleReadPath,isolatedReadUpgradeRequired,READ_UPGRADE_MESSAGE} from "./isolated-routes.js";
import {readWorkbenchMetadata} from "./metadata.js";
import type { Request, Response, Router } from "express";
import * as z from "zod/v4";
import {isDeepStrictEqual} from "node:util";
import {createHash} from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";
import type { ServerConfig } from "../config.js";
import type { FederationRuntime, TransferView } from "../federation/runtime.js";
import type { ConsoleOperations } from "../federation/console-dispatch.js";
import type { ConsoleReply, JsonRecord } from "../federation/types.js";
import { parseWorkspaceHandle, workspaceHandle } from "../federation/routing.js";
import { WorkLedger } from "../work-ledger.js";
import { LocalAgentStore } from "../local-agent-store.js";
import type { ProcessSessionManager } from "../process-sessions.js";
import type { TaskLifecycle } from "../console-task-state.js";
import { activeExecution, relevantExecution, observeSourceStates } from "../console-task-state.js";
import type { SessionRuntime } from "../session/runtime.js";
import { mapConcurrent } from "../concurrency.js";
import { WorkbenchFeed, mergeSources } from "./feed.js";
import { aggregateTasks, parseTaskReference, parseSessionReference } from "./task-aggregation.js";
import { LocalActions } from "./actions.js";
import { permitted } from "./local.js";
import {readLocalActivity,readLocalTaskMessageState,withConsoleReadSignal} from "./isolated-queries.js";
import { readLocalMetadata, readLocalPage, readLocalOverview, readLocalOverviewUsage, readLocalRunSummaries, readLocalSessionTitles, readLocalTaskIndex, readLocalUsage } from "./isolated-queries.js";
import type {readRunDetail} from "./detail.js";
import {readSummaryDetail,detailTemporarilyUnavailable} from "./read-summary-detail.js";
import type { Query } from "./query.js";
import type { Run, SourceState, TaskMessageConfirmation } from "./types.js";
import { WorkbenchError } from "./types.js";
import { HANDOFF_FINALIZATION_CODE } from "../session/task-completion.js";
import { WriteReceipts, writeEffect, type WriteReceipt, type VerifiedReceipt, type WriteEffect } from "./receipts.js";

const id = z.string().min(1).max(2048);
const key = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const revision = z.number().nonnegative();
const text = (value: unknown): string => typeof value === "string" ? value : "";
const taskMessageConfirmationSchema = z.object({ available: z.literal(true), taskId: id, ownerNodeId: id,
  taskRevision: z.number().int().nonnegative(), taskState: z.enum(["active", "closed"]),
  sequence: z.number().int().nonnegative(), pending: z.number().int().nonnegative(), observedAt: z.number() });

const querySchema = z.object({
  fresh:z.enum(['0','1']).optional(),
  node: z.string().optional(), project: z.string().optional(), q: z.string().max(1000).optional(),
  session: z.string().optional(), root: z.string().optional(),
  requestState: z.enum(["active", "closed"]).optional(),
  overviewGroup: z.enum(["current", "olderOpen"]).optional(),
  resultStatus: z.enum(["completed", "failed", "cancelled", "handed_off"]).optional(),
  days: z.coerce.number().int().min(0).max(36500).optional().transform((value) => value === undefined ? undefined : String(value)),
  stage: z.string().max(300).optional(), status: z.string().optional(), sort: z.enum(["newest", "oldest", "tokens", "duration"]).optional(),
  cursor: z.string().max(8192).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().transform((value) => value === undefined ? undefined : String(value)),
  changed: z.string().optional(), execution: z.string().optional(), date: z.string().optional(), finishedDay: z.string().optional(),
  usageDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  usageDays:z.coerce.number().int().min(1).max(30).optional().transform(value=>value===undefined?undefined:String(value)),
  after:z.coerce.number().int().nonnegative().optional().transform(value=>value===undefined?undefined:String(value)),afterId:z.string().max(2048).optional(),attention: z.string().optional(),
  tz:z.string().max(100).refine(value=>{try{new Intl.DateTimeFormat('en',{timeZone:value});return true;}catch{return false;}},'时区无效').optional(),
  kind: z.string().optional(), level: z.string().optional(), hour: z.string().optional(),
});

export const workbenchSession = (csrf: string, settings: boolean, revert: boolean) => ({
  contract: "quaymesh.console.v4", csrf, user: { name: "Owner", role: "owner" },
  capabilities: { read: true, write: true, archive: true, revert, settings, notifications: true, rootReadOnly: false,
    conversations:true,taskLifecycle:true,workspaceLocations:true },
});

export function mountConsoleWorkbench(router: Router, operations: ConsoleOperations, config: ServerConfig, runtime?: FederationRuntime, session?: SessionRuntime, processSessions?: ProcessSessionManager) {
  const feed = new WorkbenchFeed(config, runtime);
  const actions = new LocalActions(config, session, processSessions);
  const receipts = new WriteReceipts(config.stateDir);
  const localId = config.federation?.nodeId ?? "local";
  const safe = (fn: (req: Request) => unknown | Promise<unknown>, isolatedRead=false) => async (req: Request, res: Response) => {
    const controller=isolatedRead?new AbortController():null;
    const cancel=()=>{if(!res.writableFinished)controller?.abort();};
    if(controller){req.once?.('aborted',cancel);res.once?.('close',cancel);}
    try { res.json(await (controller?withConsoleReadSignal(controller.signal,()=>fn(req)):fn(req))); }
    catch (error) {
      const status = (error instanceof WorkbenchError || error instanceof ConsoleReadError) ? error.status : error instanceof z.ZodError ? 422 : 500;
      res.status(status).json({ code: (error instanceof WorkbenchError || error instanceof ConsoleReadError) ? error.code : error instanceof z.ZodError ? "invalid_input" : "console_read_failed",
        message: error instanceof Error ? error.message : String(error),effect:error instanceof z.ZodError?"none":writeEffect(error) });
    }
    finally{if(controller){req.off?.('aborted',cancel);res.off?.('close',cancel);}}
  };
  // Node-local reads do not own the shared controller cache. Only these reads
  // inherit request abort; feed refresh jobs retain their hard query deadline.
  const localGet = (path: string, fn: (req: Request) => unknown | Promise<unknown>) => {
    const oldPath=`/workbench${path}`,isolated=isolatedConsoleReadPath(oldPath);
    operations.get(`/api${oldPath}`,safe(fn,true));
    if(isolated!==oldPath)operations.get(`/api${isolated}`,safe(fn,true));
  };
  const recorded = (scope: string, fn: (req: Request) => unknown | Promise<unknown>) => (req: Request) => {
    const requestKey = key.parse(req.body?.requestKey);
    const target = req.body?.id ?? req.body?.projectId ?? req.body?.previewId ?? "";
    return receipts.execute(`${scope}:${req.path}:${target}`, requestKey, req.path, req.body, () => fn(req));
  };
  const localPost = (path: string, fn: (req: Request) => unknown | Promise<unknown>, authorize?: (req: Request) => void) =>
    operations.post(`/api/workbench${path}`, safe(req => {
      authorize?.(req); // Replayed receipts still require the current authority and caller scope.
      return recorded("node", fn)(req);
    }));
  const get = (path: string, fn: (req: Request) => unknown | Promise<unknown>) => router.get(`/api/v4${path}`, safe(fn));
  const post = (path: string, fn: (req: Request) => unknown | Promise<unknown>) => router.post(`/api/v4${path}`, safe(recorded("console", async (req) => {
    feed.invalidate();
    try { return await fn(req); } finally { feed.invalidate(); }
  })));
  const decode = (reference: string) => {
    const result = parseWorkspaceHandle(reference);
    if (!result) throw new WorkbenchError('任务或项目引用缺少所属节点',400,'invalid_reference','none');
    return result;
  };
  const call = async <T>(node: string, path: string, body?: unknown): Promise<T> => {
    if (node !== localId) return feed.call<T>(node, path, body);
    const target=body===undefined?isolatedConsoleReadPath(path):path;
    const reply = await operations.dispatch(body === undefined ? "GET" : "POST", target, body);
    if(isolatedReadUpgradeRequired(target,reply.status,reply.body))
      throw new WorkbenchError(READ_UPGRADE_MESSAGE,503,'node_read_upgrade_required','none');
    if (reply.status >= 400) {
      const error = reply.body as { message?: string; code?: string; effect?:WorkbenchError["effect"] };
      throw new WorkbenchError(error.message || "操作失败", reply.status, error.code || "operation_failed",error.effect??"unknown");
    }
    return reply.body as T;
  };
  const taskAuthority = (): string => {
    // Standalone Owner consoles retain their local lifecycle. A configured mesh
    // must never fall back from its fixed Coordinator to a Worker or mirror.
    if (!config.federation?.enabled) return localId;
    const coordinator = config.federation.coordinatorId;
    if (!coordinator) throw new WorkbenchError('尚未配置任务权威节点，不能确认或结束任务',503,'task_authority_required','none');
    return coordinator;
  };
  const consoleTask = (taskId: string) => {
    if (taskAuthority() !== localId || config.federation?.enabled && !config.federation.capabilities.coordinator) {
      throw new WorkbenchError('任务消息和结束操作必须由配置的 Coordinator 确认',503,'task_authority_required','none');
    }
    if (!session) throw new WorkbenchError('当前节点没有任务生命周期服务',503,'task_service_unavailable','none');
    // Browser routes have Owner-token session + CSRF middleware; internal calls
    // arrive through authenticated mesh RPC. Never accept an owner ID in the body.
    const task = session.store.getTask(taskId), owner = session.store.getSession(task.session_id);
    if (task.source_kind === 'federation_mirror') throw new WorkbenchError('镜像记录不能作为任务权威',409,'task_owner_mismatch','none');
    const members = session.store.taskMemberIds(task.id).map(memberId => session.store.getMember(task.session_id,memberId));
    if (members.some(member => member.node_id === localId && !permitted(config,member.root))) {
      throw new WorkbenchError('任务不在允许访问的项目内',403,'task_scope','none');
    }
    return { task, owner };
  };
  type MessageObservation={confirmation:TaskMessageConfirmation;sources:SourceState[]};
  const taskMessagesFor = async (taskId: string,fresh=false): Promise<MessageObservation> => {
    let authority: string | null = null;
    let source: SourceState | undefined;
    try {
      authority = taskAuthority();
      const path=`/workbench/tasks/${encodeURIComponent(taskId)}/messages-state`;
      const resource=await feed.readNode<unknown>(authority,path,()=>call(authority!,path),{fresh});
      source=resource.source;
      if(!resource.data||source.state!=='ready'||source.error)return {
        confirmation:{available:false,taskId,ownerNodeId:authority,
          error:source.error??'任务消息状态正在读取，尚不能确认是否有待处理消息'},sources:[source],
      };
      const state = taskMessageConfirmationSchema.parse(resource.data);
      if (state.taskId !== taskId || state.ownerNodeId !== authority) throw new Error('任务消息状态与权威身份不一致');
      return {confirmation:state,sources:[source]};
    } catch (error) {
      const message=error instanceof Error?error.message:String(error);
      return {confirmation:{available:false,taskId,ownerNodeId:authority,error:message},
        sources:source?[{...source,state:'error',stale:true,error:message}]:[]};
    }
  };
  const withTaskMessages = async (detail:RunDetail,fresh=false,pending?:Promise<MessageObservation>):Promise<RunDetail> => {
    if(!detail.run.taskId)return detail;
    const {confirmation,sources}=await (pending??taskMessagesFor(detail.run.taskId,fresh));
    return {...detail,taskMessages:confirmation,complete:detail.complete&&confirmation.available,
      sources:mergeSources(detail.sources,sources),
      run:{...detail.run,actions:{...detail.run.actions,complete:confirmation.available&&detail.run.actions.complete===true}}};
  };
  const routeRun = (req: Request) => decode(text(req.params.id));
  const rawRunDetail = async (reference: string) => {
    const target = decode(reference);
    return call<Awaited<ReturnType<typeof readRunDetail>>>(target.node, `/workbench/runs/${encodeURIComponent(target.local)}`);
  };
  const readPhaseDetail = async (reference:string,fresh:boolean,deadline:number) => {
    const target=decode(reference),path=`/workbench/runs/${encodeURIComponent(target.local)}`;
    const resource=await feed.readNode<RunDetail>(target.node,path,()=>rawRunDetail(reference),{fresh,deadline});
    return {phase:reference,detail:resource.data,source:resource.source};
  };
  type TaskPhases={task:Run;phases:Run[];complete:boolean;sources:SourceState[];lifecycle?:TaskLifecycle;missingNodes:string[]};
  const taskPhases=async(reference:string,fresh=false):Promise<TaskPhases>=>{
    const taskId=parseTaskReference(reference),sessionId=parseSessionReference(reference);
    if(taskId){
      const result=await feed.taskRuns(taskId,fresh);
      if(result.task)return {task:result.task,phases:result.runs,complete:result.complete,sources:result.sources,lifecycle:result.lifecycle,missingNodes:result.missingNodes};
      // 旧版会话链接曾使用 Task 前缀，仅在没有同名 Task 时查旧会话。
      const legacy=await feed.sessionRuns(taskId,fresh);
      const phases=legacy.runs.filter(run=>run.taskId===null);
      if(phases.length)return {task:aggregateTasks(phases)[0]!,phases,complete:legacy.complete,sources:legacy.sources,missingNodes:legacy.missingNodes};
      throw new WorkbenchError('任务不存在',404,'task_not_found','none');
    }
    if(sessionId){
      const result=await feed.sessionRuns(sessionId,fresh),phases=result.runs.filter(run=>run.taskId===null);
      if(!phases.length)throw new WorkbenchError('历史会话执行不存在',404,'session_run_not_found','none');
      return {task:aggregateTasks(phases)[0]!,phases,complete:result.complete,sources:result.sources,missingNodes:result.missingNodes};
    }
    const detail=await rawRunDetail(reference);
    return {task:detail.run,phases:[detail.run],complete:true,sources:[],missingNodes:[]};
  };
  const aggregateRunDetail=async(reference:string,fresh=false)=>{
    if(!parseTaskReference(reference)&&!parseSessionReference(reference)){
      const observed=await readPhaseDetail(reference,fresh,Date.now()+1200);
      if(!observed.detail){
        const summary=await feed.phaseSummary(reference,fresh);
        if(!summary.run)throw new WorkbenchError(observed.source.error??'执行详情正在读取，请稍后重试',503,
          observed.source.error?'detail_unavailable':'detail_pending','none');
        return withTaskMessages(mergeTaskDetails(summary.run,[],{complete:false,
          sources:mergeSources(summary.sources,[observed.source]),missing:[{id:reference,nodeId:observed.source.nodeId,
            error:observed.source.error??'阶段详情正在读取',pending:observed.source.online&&!observed.source.error}]}),fresh);
      }
      const detail=observed.detail,complete=detail.complete&&observed.source.online&&!observed.source.error;
      const confirmed=complete&&observed.source.state==='ready'&&!observed.source.stale;
      return withTaskMessages({...detail,complete,sources:mergeSources(detail.sources,[observed.source]),
        run:{...detail.run,actions:{...detail.run.actions,review:confirmed&&detail.run.actions.review,
          complete:confirmed&&detail.run.actions.complete===true,revert:confirmed&&detail.run.actions.revert,
          patch:confirmed&&detail.run.actions.patch!==false}}},fresh);
    }
    const taskId=parseTaskReference(reference);
    const messages=taskId?taskMessagesFor(taskId,fresh):undefined;
    const related=await taskPhases(reference,fresh);
    const byNode=new Map<string,string[]>();
    for(const phase of related.task.phaseRefs??related.phases.map(value=>value.id)){
      const node=decode(phase).node,phases=byNode.get(node)??[];
      phases.push(phase);byNode.set(node,phases);
    }
    // Share one screen deadline across all phases, with independent node lanes.
    // A sleeping node must not hold a healthy node behind another RPC window.
    const deadline=Date.now()+1200;
    const observed=(await mapConcurrent([...byNode],8,([node,phases])=>{
      const priority=(phase:string)=>feed.nodeReadPriority(node,`/workbench/runs/${encodeURIComponent(decode(phase).local)}`);
      // Start previously unread phases before refreshing a successful prefix.
      // The shared node budget still caps actual in-flight detail reads.
      phases.sort((left,right)=>priority(left)-priority(right));
      return mapConcurrent(phases,4,phase=>readPhaseDetail(phase,fresh,deadline));
    })).flat();
    const details:RoutedTaskDetail[]=observed.flatMap(value=>value.detail?[{phase:value.phase,detail:value.detail}]:[]);
    const missing=observed.filter(value=>!value.detail||value.source.error||!value.source.online).map(value=>({
      id:value.phase,nodeId:value.source.nodeId,error:value.source.error??'阶段详情正在读取',
      pending:value.source.online&&!value.source.error,
    }));
    const byPhase=new Map(details.map(value=>[value.phase,value.detail.run]));
    const sources=mergeSources(related.sources,observed.map(value=>value.source));
    const phases=observeSourceStates(related.phases.map(phase=>byPhase.get(phase.id)??phase),sources);
    const task=feed.taskFromPhases(phases,related.lifecycle)??related.task;
    return withTaskMessages(mergeTaskDetails(task,details,{complete:related.complete&&missing.length===0,sources,missing}),fresh,messages);
  };
  const search = (req: Request): Query => querySchema.parse(req.query);
  const queryString = (req: Request) => new URLSearchParams(Object.entries(search(req)).filter((pair): pair is [string, string] => pair[1] !== undefined)).toString();

  localGet("/metadata", () => readWorkbenchMetadata(config,runtime));
  localGet("/runs", (req) => readLocalPage(config, search(req)));
  localGet("/task-index", () => readLocalTaskIndex(config));
  localGet("/session-titles", () => readLocalSessionTitles(config));
  localGet("/run-summaries", (req) => {
    const raw = text(req.query.ids);
    const ids = raw ? raw.split(",").map((value) => decodeURIComponent(value)).filter(Boolean) : [];
    return readLocalRunSummaries(config, ids);
  });
  localGet("/overview", (req) => readLocalOverview(config, search(req).tz || "UTC"));
  localGet("/overview-usage", (req) => readLocalOverviewUsage(config, search(req).tz || "UTC"));
  localGet("/usage", (req) => readLocalUsage(config, search(req)));
  localGet("/runs/:id", (req) => readSummaryDetail(config, text(req.params.id)));
  localGet("/runs/:id/files/:file", detailTemporarilyUnavailable);
  localGet("/runs/:id/patch", detailTemporarilyUnavailable);
  localGet("/runs/:id/commands/:command", detailTemporarilyUnavailable);
  localGet("/projects/:id/sessions", () => {
    throw new WorkbenchError('工作区历史会话暂不可用，请稍后重试；可继续从任务列表查看任务摘要',
      503,'console_sessions_temporarily_unavailable','none');
  });
  localGet("/activity", async (req) => {
    const kind = text(req.query.kind);
    if(kind==="audit")throw new WorkbenchError('审计记录暂不可用，请稍后重试',503,'console_audit_temporarily_unavailable','none');
    const query = { limit: Math.min(1_000_100, Number(req.query.limit) || 100), q: text(req.query.q), level: text(req.query.level), hour: text(req.query.hour),after:typeof req.query.after==='string'?req.query.after:undefined,afterId:text(req.query.afterId) };
    const saved = await readLocalActivity(config, kind, query);
    if (kind !== "events" || !runtime) return saved;
    const recent = (runtime.status().events as Array<{ time: string; kind: string; message: string; nodeId?: string }>).map((event) => ({
      id: `network:${localId}:${createHash('sha256').update(JSON.stringify(event)).digest('hex')}`, time: Date.parse(event.time),
      nodeId: localId, level: event.kind.includes("error") ? "error" : event.kind.includes("warn") ? "warn" : "info",
      message: event.message, details: { source: "federation", kind: event.kind, peer: event.nodeId ?? null },
    })).filter((event) => (!query.q || event.message.toLocaleLowerCase().includes(query.q.toLocaleLowerCase()))
      && (!query.level || event.level === query.level));
    const selected = recent.filter((event) => (!query.hour || Math.floor(event.time / 3600000) === Number(query.hour))
      &&(query.after===undefined||event.time>Number(query.after)||event.time===Number(query.after)&&event.id>(query.afterId??'')));
    const bins = [...saved.bins, ...recent.map((event) => ({ start: Math.floor(event.time / 3600000) * 3600000,
      count: 1, errors: Number(event.level === "error"), warnings: Number(event.level === "warn") }))];
    const items=[...saved.items,...selected].sort((a,b)=>{const order=a.time-b.time||(a.id<b.id?-1:a.id>b.id?1:0);return query.after===undefined?-order:order;}).slice(0,query.limit);
    return {items,total:saved.total+selected.length,bins,nextAfter:query.after!==undefined&&items.length?{after:items.at(-1)!.time,afterId:items.at(-1)!.id}:null};
  });

  localGet('/tasks/:id/messages-state',req=>{
    if(taskAuthority()!==localId||config.federation?.enabled&&!config.federation.capabilities.coordinator)
      throw new WorkbenchError('任务消息和结束操作必须由配置的 Coordinator 确认',503,'task_authority_required','none');
    if(!session)throw new WorkbenchError('当前节点没有任务生命周期服务',503,'task_service_unavailable','none');
    return readLocalTaskMessageState(config,id.parse(req.params.id));
  });
  localPost('/tasks/finish',async req=>{
    const input=z.object({taskId:id,expectedTaskRevision:revision,messageSequence:z.number().int().nonnegative().optional(),
      result:z.enum(['completed','failed','cancelled','handed_off']),summary:z.string().max(4000),requestKey:key}).parse(req.body);
    const { task, owner } = consoleTask(input.taskId);
    let finished;
    try {
      finished=await session!.service.finishTask(owner.owner_id,task.id,input.result,input.summary,input.expectedTaskRevision,input.messageSequence ?? 0);
    } catch (error) {
      const failure=error as { code?: unknown; effect?: unknown };
      if (failure.effect==='not_started' && failure.code===HANDOFF_FINALIZATION_CODE) {
        throw new WorkbenchError('交接不会结束工作目标。请用 checkpoint_task 保存进度，再在接收入口用 task_resume 恢复同一任务；目标保持开放。',409,HANDOFF_FINALIZATION_CODE,'none');
      }
      if (failure.effect==='not_started' && typeof failure.code==='string' && failure.code.startsWith('TASK_MAILBOX_')) {
        throw new WorkbenchError(failure.code==='TASK_MAILBOX_INPUT_PENDING'
          ? '仍有用户消息未由模型确认，请处理后重新打开结束确认'
          : '任务消息已更新，请关闭确认框，刷新并核对消息后重新确认',409,failure.code,'none');
      }
      throw error;
    }
    actions.audit.record('task.finish',task.id,{state:task.state,result:task.result_status},
      {state:finished.state,result:finished.result_status,messageSequence:input.messageSequence ?? 0},input.requestKey);
    return {taskId:task.id,state:finished.state,result:finished.result_status,status:'completed',effect:'applied'};
  },req=>{consoleTask(id.parse(req.body?.taskId));});

  localPost("/runs/review", (req) => {
    const input = z.object({ id, expectedRevision: revision, completeExecution: z.boolean().optional(), verdict: z.enum(["accept", "reject"]), note: z.string().max(4000), requestKey: key }).parse(req.body);
    if (input.verdict === "reject" && !input.note.trim()) throw new WorkbenchError('请填写驳回原因',422,'note_required','none');
    return actions.review(input, input.verdict, input.note, input.requestKey);
  });
  localPost("/runs/:id/control", (req) => actions.runControl(text(req.params.id), z.object({ action: z.enum(["interrupt", "resume"]), expectedRevision: revision, requestKey: key }).parse(req.body)));
  localPost("/revert/preview", (req) => {
    const input = z.object({ id, files: z.array(id).min(1).max(1000), expectedRevision: revision }).parse(req.body);
    return actions.revertPreview(input.id, input.files, input.expectedRevision);
  });
  localPost("/revert/commit", (req) => {
    const input = z.object({ previewId: id, confirmationHash: id, requestKey: key }).parse(req.body);
    return actions.revertCommit(input.previewId, input.confirmationHash, input.requestKey);
  });
  localPost("/archive", (req) => {
    const input = z.object({ projectId: id, mode: z.enum(["archive", "restore"]).optional(), ids: z.array(id).max(100).optional(), batchId: id.optional(), confirmationHash: id.optional(), externalIdleConfirmed: z.boolean().optional(),acceptPartial:z.boolean().optional(),requestKey:key }).parse(req.body);
    return actions.archive(input.projectId, input);
  });
  localPost("/sessions/:id/protect", (req) => {
    const input = z.object({ protected: z.boolean(), expectedRevision: revision, requestKey: key }).parse(req.body);
    const ledger = new WorkLedger(config.stateDir);
    try {
      const thread = ledger.thread(text(req.params.id));
      if (!permitted(config, ledger.getProject(thread.project_id).root)) throw new WorkbenchError('此会话不在允许访问的项目内',403,'operation_rejected','none');
      if (thread.revision !== input.expectedRevision) throw new WorkbenchError('会话已经更新',409,'revision_conflict','none');
      ledger.protectThread(thread.project_id, thread.id, input.protected);
      actions.audit.record("session.protect", thread.id, Boolean(thread.protected), input.protected, input.requestKey);
      return { saved: true };
    } finally { ledger.close(); }
  });
  localPost("/sessions/:id/control", async (req) => {
    const input = z.object({ action: z.enum(["steer", "takeover", "return"]), expectedRevision: revision, expectedTurnId: z.string().nullable().optional(), prompt: z.string().max(12000).optional(), requestKey: key }).parse(req.body);
    const ledger = new WorkLedger(config.stateDir);
    const store = new LocalAgentStore(config.stateDir);
    try {
      const thread = ledger.thread(text(req.params.id));
      const agent = store.getById(thread.agent_id);
      if (!agent || agent.controlRevision !== input.expectedRevision) throw new WorkbenchError('会话控制状态已变化',409,'revision_conflict','none');
      const run = ledger.threadRuns(thread.id).sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
      if (!run) throw new WorkbenchError('会话没有可控制的执行记录',409,'operation_rejected','none');
      const receipt = await call<JsonRecord>(localId, `/projects/${encodeURIComponent(thread.project_id)}/threads/${encodeURIComponent(thread.id)}/control`, {
        action: input.action === "return" ? "returnControl" : input.action, workRunId: run.id, requestKey: input.requestKey,
        ...(input.expectedTurnId ? { expectedTurnId: input.expectedTurnId } : {}), ...(input.prompt ? { prompt: input.prompt } : {}),
      });
      actions.audit.record(`session.${input.action}`, thread.id, null, { controlState: receipt.controlState }, input.requestKey);
      return { status: "completed",effect:"applied",receipt };
    } finally { store.close(); ledger.close(); }
  });
  localPost("/settings", async (req) => {
    if (!runtime) throw new WorkbenchError('此节点未启用集群设置',409,'operation_rejected','none');
    const input = z.object({ expectedRevision: revision, settings: z.record(z.string(), z.unknown()), requestKey: key }).parse(req.body);
    const before = await runtime.request<JsonRecord>(localId, "settings.get", {});
    if(before.revision!==input.expectedRevision)throw new WorkbenchError('节点持久设置已经更新，请刷新后重试',409,'revision_conflict','none');
    const result = await runtime.request<JsonRecord>(localId, "settings.update", {...input.settings,expectedRevision:input.expectedRevision});
    actions.audit.record("node.settings.update", localId, { nickname: before.nickname, priority: before.priority }, { nickname: result.nickname, priority: result.priority }, input.requestKey);
    return { saved:true,revision:result.savedRevision??result.revision,appliedRevision:result.appliedRevision??null,pending:result.pending===true };
  });

  const reconcileLocal=async(scope:string,requestKey:string)=>receipts.reconcile(scope,requestKey,async({path,body,receipt})=>{
    const input=body as Record<string,any>;
    const control=path.match(/\/runs\/([^/]+)\/control$/);
    if(control)return actions.reconcileControl(decodeURIComponent(control[1]),requestKey);
    if(path.endsWith('/runs/review'))return actions.reconcileReview(String(input.id),input.verdict,String(input.note??''));
    if(path.endsWith('/archive')&&input.batchId)return actions.reconcileArchive(String(input.projectId),String(input.batchId),requestKey);
    if(path.endsWith('/settings')&&runtime){
      const current=await runtime.request<Record<string,any>>(localId,'settings.get',{});
      const saved=receipt.response as {saved?:boolean;revision?:number}|undefined;
      if(receipt.effect==='applied'&&saved?.saved&&typeof saved.revision==='number'&&Number(current.revision)>saved.revision)
        return {verified:true,effect:'applied',response:{saved:true,revision:saved.revision,pending:false,superseded:true,currentRevision:current.revision,
          appliedRevision:current.appliedRevision??null,note:'此保存版本已被后续配置取代，请在节点设置中查看当前应用状态'}};
      const matches=Number(current.revision)>Number(input.expectedRevision)&&Object.entries(input.settings??{}).every(([name,value])=>isDeepStrictEqual(current[name],value));
      return {verified:matches,effect:'applied',response:{saved:true,revision:current.revision,appliedRevision:current.appliedRevision??null,pending:current.pending===true}};
    }
    const protect=path.match(/\/sessions\/([^/]+)\/protect$/);
    if(protect){
      const ledger=new WorkLedger(config.stateDir);
      try{const thread=ledger.thread(decodeURIComponent(protect[1]));
        return {verified:Boolean(thread.protected)===input.protected&&thread.revision>input.expectedRevision,effect:'applied',response:{saved:true}};
      }finally{ledger.close();}
    }
    const sessionControl=path.match(/\/sessions\/([^/]+)\/control$/);
    if(sessionControl){
      const ledger=new WorkLedger(config.stateDir);
      try{
        const thread=ledger.thread(decodeURIComponent(sessionControl[1]));
        if(!permitted(config,ledger.getProject(thread.project_id).root))throw new WorkbenchError('会话不在允许访问的项目内',403,'project_scope','none');
        const action=input.action==='return'?'returnControl':input.action;
        const saved=ledger.db.prepare('SELECT status,receipt FROM agent_control_requests WHERE agent_id=? AND request_key=? AND action=?')
          .get(thread.agent_id,requestKey,action) as {status:string;receipt:string|null}|undefined;
        if(!saved?.receipt||saved.status!=='completed')return {verified:false};
        return {verified:true,effect:'applied',response:{status:'completed',effect:'applied',receipt:JSON.parse(saved.receipt)}};
      }finally{ledger.close();}
    }
    if(path.endsWith('/revert/commit')){
      const ledger=new WorkLedger(config.stateDir);
      try{const row=ledger.db.prepare("SELECT after_json FROM console_audit WHERE action='run.revert' AND request_key=? AND json_extract(after_json,'$.previewId')=? ORDER BY time DESC LIMIT 1").get(requestKey,String(input.previewId)) as {after_json:string}|undefined;
        if(!row)return {verified:false};const saved=JSON.parse(row.after_json);
        return {verified:true,effect:'applied',response:{status:'completed',files:saved.files,revision:saved.revision}};
      }finally{ledger.close();}
    }
    if(path.endsWith('/tasks/finish')&&session){
      const {task}=consoleTask(String(input.taskId));
      const intent=session.store.taskData.finalization(task.id);
      return {verified:task.state==='closed'&&task.result_status===input.result&&task.summary===input.summary
        &&intent?.mailbox_sequence===(input.messageSequence ?? 0),effect:'applied',response:{taskId:task.id,state:task.state,result:task.result_status,status:'completed',effect:'applied'}};
    }
    return {verified:false};
  });
  localGet('/receipts/:key',req=>{
    const path=text(req.query.path),target=text(req.query.target);
    if(!path.startsWith('/api/workbench/'))throw new WorkbenchError('回执路径无效',400,'invalid_receipt_path','none');
    return reconcileLocal(`node:${path}:${target}`,key.parse(req.params.key));
  });
  get('/receipts',req=>({items:receipts.list('console:',Math.min(200,Math.max(1,Number(req.query.limit)||50)))}));
  get('/receipts/:key',async req=>{
    const path=text(req.query.path),target=text(req.query.target),requestKey=key.parse(req.params.key);
    if(!path.startsWith('/api/v4/'))throw new WorkbenchError('回执路径无效',400,'invalid_receipt_path','none');
    return receipts.reconcile(`console:${path}:${target}`,requestKey,async({body})=>{
      const input=body as Record<string,any>;
      const forward=async(node:string,childPath:string,childTarget:string,wrap=false):Promise<VerifiedReceipt>=>{
        const child=await call<WriteReceipt|null>(node,`/workbench/receipts/${encodeURIComponent(requestKey)}?${new URLSearchParams({path:childPath,target:childTarget})}`);
        if(!child||['started','unknown'].includes(child.state))return {verified:false};
        return {verified:true,effect:child.effect,...(child.error?{error:child.error}:{response:wrap?{batch:child.response,effect:child.effect}:child.response})};
      };
      const finish=path.match(/\/runs\/([^/]+)\/finish$/);
      if(finish){
        const related=await taskPhases(decodeURIComponent(finish[1]),true);
        return related.task.taskId?forward(taskAuthority(),'/api/workbench/tasks/finish',''):{verified:false};
      }
      const settings=path.match(/\/nodes\/([^/]+)\/settings$/);
      if(settings)return forward(decodeURIComponent(settings[1]),'/api/workbench/settings','');
      if(path.endsWith('/roots/save'))return forward(String(input.root.nodeId),'/api/workbench/settings','');
      const sessionAction=path.match(/\/sessions\/([^/]+)\/(protect|control)$/);
      if(sessionAction){const target=decode(decodeURIComponent(sessionAction[1]));return forward(target.node,`/api/workbench/sessions/${encodeURIComponent(target.local)}/${sessionAction[2]}`,'');}
      if(path.endsWith('/runs/revert/commit')){const target=decode(String(input.previewId));return forward(target.node,'/api/workbench/revert/commit',target.local);}
      if(path.endsWith('/archive/commit')){const target=decode(String(input.previewId));const [projectId]=z.tuple([id,id]).parse(JSON.parse(target.local));return forward(target.node,'/api/workbench/archive',projectId,true);}
      if(path.endsWith('/transfers/cancel')&&runtime){const transfer=await runtime.copyArtifact({action:'observe',copy_id:String(input.id)}) as TransferView;
        return {verified:transfer.status==='cancelled',effect:'applied',response:{transfer,status:'completed',effect:'applied'}};}
      const plan=receipts.get(`console-plan:${path}`,requestKey)?.response as DispatchPlan|undefined;
      if(!plan)return {verified:false};
      const outcomes=await mapConcurrent(plan.targets,4,async target=>{
        const childPath='/api'+target.path;
        try{return await call<WriteReceipt|null>(target.node,`/workbench/receipts/${encodeURIComponent(requestKey)}?${new URLSearchParams({path:childPath,target:target.receiptTarget})}`);}
        catch{return null;}
      });
      if(outcomes.some(value=>!value||['started','unknown'].includes(value.state)))return {verified:false};
      const response=dispatchResponse(plan,outcomes.map((value,index)=>{
        const receipt=value!,target=plan.targets[index]!;
        return {phaseId:target.phaseId,nodeId:target.node,ok:receipt.effect==='applied',effect:receipt.effect,
          receipt:receipt.response,...(receipt.error?{error:receipt.error.message,code:receipt.error.code}: {})};
      }));
      return {verified:true,effect:response.effect,response};
    });
  });
  get('/conversations',req=>feed.conversations(search(req)));
  get("/fleet/status", req => feed.fleet(search(req).fresh==='1'));
  get("/nodes/:id/settings",req=>feed.nodeSettings(text(req.params.id)));
  get("/overview", (req) => {const query=search(req);return feed.overview(query.tz || "UTC",query.fresh==='1');});
  get("/projects", async req => { const value = await feed.metadata(search(req).fresh==='1'); return { items: value.projects, sources: value.sources, complete: value.complete }; });
  get("/roots", async req => { const value = await feed.metadata(search(req).fresh==='1'); return { items: value.roots, sources: value.sources, complete: value.complete }; });
  get("/runs", (req) => feed.runs(search(req)));
  get("/usage", (req) => feed.usage(search(req)));
  get("/runs/:id", (req) => aggregateRunDetail(text(req.params.id),search(req).fresh==='1'));
  // Gate at the controller too: a rolling upgrade must not send these reads to
  // an older node whose native database work still runs on its Core event loop.
  get("/runs/:id/files/:file", detailTemporarilyUnavailable);
  get("/runs/:id/commands/:command", detailTemporarilyUnavailable);
  get("/runs/:id/patch", detailTemporarilyUnavailable);
  get("/projects/:id/sessions", () => {
    throw new WorkbenchError('工作区历史会话暂不可用，请稍后重试；可继续从任务列表查看任务摘要',
      503,'console_sessions_temporarily_unavailable','none');
  });
  get("/activity", async (req) => {
    const query = search(req);
    if(query.kind==='audit')throw new WorkbenchError('审计记录暂不可用，请稍后重试',503,'console_audit_temporarily_unavailable','none');
    const sources = feed.sources().filter(source => !query.node || source.nodeId === query.node);
    const observed = new Map<string, number>();
    const index = { sources, complete: sources.every((source) => !source.stale) };
    if(query.after!==undefined&&!Number.isFinite(Number(query.after)))throw new WorkbenchError("活动游标无效",400,"invalid_cursor","none");
    z.coerce.number().int().min(0).max(1_000_000).parse(query.cursor ?? 0);
    const offset = Number(query.cursor ?? 0), limit = Math.min(100,Number(query.limit)||25), kind = query.kind ?? "events";
    let items: Array<Record<string, any>> = [];
    let databaseTotal: number | null = null;
    const databaseBins: Array<{ start: number; count: number; errors: number; warnings: number }> = [];
    const errors: Array<{ nodeId: string; message: string }> = [];
    if (kind === "transfers") {
      const transfers = runtime ? (await mapConcurrent(index.sources.filter((source) => source.online), 4, async (source) => {
        try {
          const result = await runtime.request<{items:TransferView[];total:number}>(source.nodeId, "transfers.list", {paged:true,limit:offset+limit,q:query.q??""}, 8000);
          databaseTotal=(databaseTotal??0)+result.total;
          observed.set(source.nodeId,Date.now()); return result.items;
        }
        catch (error) { errors.push({ nodeId: source.nodeId, message: error instanceof Error ? error.message : String(error) }); return []; }
      })).flat() : [];
      items = transfers.map((transfer) => ({ id: transfer.id, nodeId: transfer.nodeId, source: transfer.source, destination: transfer.destination,
        bytes: transfer.bytes, total: transfer.totalBytes, status: transfer.status,
        speed: null, startedAt: Date.parse(transfer.startedAt), revision: transfer.finishedAt ?? transfer.startedAt, error: transfer.error ?? null }));
    } else {
      const results = await mapConcurrent(index.sources.filter((source) => source.online && (!query.node || source.nodeId === query.node)), 4, async (source) => {
        try {
          const result = await call<{ items: Array<Record<string, any>>; total: number; bins?: typeof databaseBins }>(source.nodeId,
            `/workbench/activity?${new URLSearchParams({ kind, limit: String(offset + limit), q: query.q ?? "", level: query.level ?? "", hour: query.hour ?? "",...(query.after!==undefined?{after:query.after,afterId:query.afterId??""}:{}) })}`);
          observed.set(source.nodeId,Date.now()); return result;
        }
        catch (error) { errors.push({ nodeId: source.nodeId, message: error instanceof Error ? error.message : String(error) }); return { items: [], total: 0 }; }
      });
      items = results.flatMap((result) => result.items);
      databaseTotal = results.reduce((sum,result)=>sum+result.total,0);databaseBins.push(...results.flatMap(result=>result.bins??[]));
    }
    const selected = items.filter((item) => (!query.node || item.nodeId === query.node)
      && (!query.q || JSON.stringify(item).toLocaleLowerCase().includes(query.q.toLocaleLowerCase()))
      && (!query.level || item.level === query.level));
    const bins = Array.from({ length: 24 }, (_, index) => {
      const start = Math.floor(Date.now() / 3600000) * 3600000 - (23 - index) * 3600000;
      const values = databaseBins.filter((bin) => bin.start === start);
      return { start, count: values.reduce((sum, bin) => sum + bin.count, 0), errors: values.reduce((sum, bin) => sum + bin.errors, 0), warnings: values.reduce((sum, bin) => sum + bin.warnings, 0) };
    });
    const filtered = selected.filter((item) => (!query.hour || Math.floor(item.time / 3600000) === Number(query.hour))
      && (query.after===undefined||(item.time??item.startedAt)>Number(query.after)||(item.time??item.startedAt)===Number(query.after)&&item.id>(query.afterId??"")))
      .sort((a,b)=>{const order=(a.time??a.startedAt??0)-(b.time??b.startedAt??0)||(a.id<b.id?-1:a.id>b.id?1:0);return query.after===undefined?-order:order;});
    const total = databaseTotal ?? filtered.length;
    const page=filtered.slice(offset,offset+limit);
    return {items:page,total,offset,limit,hasMore:offset+page.length<total,nextAfter:query.after!==undefined&&page.length?{after:page.at(-1)!.time,afterId:page.at(-1)!.id}:null,
      nextCursor:offset+limit<total?String(offset+limit):null,bins,observedAt:Date.now(),
      sources: index.sources.map(source => {
        const error=errors.find(item=>item.nodeId===source.nodeId);
        return error ? {...source,state:"error",stale:true,error:error.message}
          : observed.has(source.nodeId) ? {...source,state:"ready",stale:false,observedAt:observed.get(source.nodeId),error:null}
          : source;
      }),
      complete: errors.length === 0 && sources.every(source=>source.online) };
  });

  const outcomeError=(error:unknown)=>({ok:false,effect:writeEffect(error),error:error instanceof Error?error.message:String(error),code:error instanceof WorkbenchError?error.code:'operation_failed'});
  post('/runs/:id/finish',async req=>{
    const input=z.object({expectedRevision:revision,expectedTaskRevision:revision.optional(),messageSequence:z.number().int().nonnegative().optional(),
      result:z.enum(['completed','failed','cancelled','handed_off']),summary:z.string().max(4000),requestKey:key}).parse(req.body);
    const related=await taskPhases(text(req.params.id));
    if(related.task.revision!==input.expectedRevision)throw new WorkbenchError('任务已更新，请刷新后再次确认',409,'revision_conflict','none');
    if(!related.task.taskId)throw new WorkbenchError('此历史执行没有独立请求，请使用阶段验收',409,'task_identity_missing','none');
    const owned=related.lifecycle?related:await feed.taskRuns(related.task.taskId);
    const lifecycle=owned.lifecycle;
    if(!lifecycle)throw new WorkbenchError('尚未取得请求所属节点',503,'task_owner_unavailable','none');
    if(!owned.complete)throw new WorkbenchError('任务相关节点尚未全部确认，请先核对缺失来源',409,'task_incomplete','none');
    return call(taskAuthority(),'/workbench/tasks/finish',{taskId:related.task.taskId,
      expectedTaskRevision:input.expectedTaskRevision ?? lifecycle.revision,messageSequence:input.messageSequence ?? 0,
      result:input.result,summary:input.summary,requestKey:input.requestKey});
  });
  const savePlan=(req:Request,plan:DispatchPlan)=>receipts.execute(`console-plan:${req.path}`,key.parse(req.body.requestKey),req.path,req.body,()=>plan);
  const dispatchPlan=async(plan:DispatchPlan)=>dispatchResponse(plan,await mapConcurrent(plan.targets,4,async target=>{
    try{
      const receipt=await call<Record<string,unknown>>(target.node,target.path,target.body);
      const effect=(['none','applied','partial','unknown'].includes(String(receipt.effect))?receipt.effect:receipt.status==='rejected'?'none':'applied') as WriteEffect;
      return {phaseId:target.phaseId,nodeId:target.node,ok:effect==='applied',effect,receipt,...(typeof receipt.error==='string'?{error:receipt.error}:{})};
    }catch(error){return {phaseId:target.phaseId,nodeId:target.node,...outcomeError(error)};}
  }));
  post('/runs/review',async req=>{
    const input=z.object({refs:z.array(z.object({id,expectedRevision:revision,completeExecution:z.boolean().optional()})).min(1).max(100),verdict:z.enum(['accept','reject']),note:z.string().max(4000),requestKey:key}).parse(req.body);
    if(input.verdict==='reject'&&!input.note.trim())throw new WorkbenchError('请填写驳回原因',422,'note_required','none');
    const prepared=await mapConcurrent(input.refs,4,async ref=>{
      try{
        const related=await taskPhases(ref.id);
        if(!related.complete)throw new WorkbenchError('任务相关工作区状态尚未取得，请刷新后再验收',409,'task_incomplete','none');
        if(related.task.revision!==ref.expectedRevision)throw new WorkbenchError('任务已更新，请刷新后再次确认',409,'revision_conflict','none');
        const actionable=related.phases.filter(phase=>phase.currentPhase!==false&&(phase.actions.review||ref.completeExecution&&phase.actions.complete));
        if(!actionable.length)throw new WorkbenchError('所选任务没有可验收的阶段结果',409,'review_unavailable','none');
        return {id:ref.id,targets:actionable.map(phase=>{
          const target=decode(phase.id);
          return {reference:ref.id,phaseId:phase.id,node:target.node,path:'/workbench/runs/review',receiptTarget:target.local,
            body:{id:target.local,expectedRevision:phase.revision,completeExecution:ref.completeExecution===true&&phase.actions.complete===true,
              verdict:input.verdict,note:input.note,requestKey:input.requestKey}};
        })};
      }catch(error){return {id:ref.id,targets:[],failure:{id:ref.id,...outcomeError(error),effect:'none' as const}};}
    });
    const plan=await savePlan(req,{kind:'review',references:input.refs.map(ref=>ref.id),targets:prepared.flatMap(value=>value.targets),
      failures:prepared.flatMap(value=>'failure'in value?[value.failure!]:[]),missingNodes:[]});
    return dispatchPlan(plan);
  });
  post('/runs/:id/control',async req=>{
    const input=z.object({action:z.enum(['interrupt','resume']),expectedRevision:revision,requestKey:key}).parse(req.body);
    const reference=text(req.params.id),related=await taskPhases(reference);
    if(input.action==='resume'&&!related.complete)throw new WorkbenchError('任务相关工作区尚未确认，请刷新后恢复',409,'task_incomplete','none');
    if(related.task.revision!==input.expectedRevision)throw new WorkbenchError('任务已更新，请刷新后继续',409,'revision_conflict','none');
    const actionable=related.phases.filter(phase=>relevantExecution(phase)&&(input.action==='interrupt'?phase.actions.interrupt:phase.actions.resume));
    if(!actionable.length)throw new WorkbenchError(input.action==='interrupt'?'当前已确认的阶段没有可停止执行':'当前任务没有可恢复执行',409,'control_unavailable','none');
    const plan=await savePlan(req,{kind:'control',references:[reference],failures:[],missingNodes:related.missingNodes,
      incomplete:!related.complete,targets:actionable.map(phase=>{
        const target=decode(phase.id);
        return {reference,phaseId:phase.id,node:target.node,path:`/workbench/runs/${encodeURIComponent(target.local)}/control`,receiptTarget:'',body:{...input,expectedRevision:phase.revision}};
      })});
    return dispatchPlan(plan);
  });
  post("/runs/revert/preview", async (req) => {
    const reference = text(req.body.id);
    const taskRef = parseTaskReference(reference);
    let target;
    let files: string[] = Array.isArray(req.body.files) ? req.body.files.map(String) : [];
    let expectedRevision = Number(req.body.expectedRevision);
    if (taskRef) {
      const { task, phases, complete } = await taskPhases(reference);
      if (!complete) throw new WorkbenchError('部分工作区状态尚未取得，请刷新后再还原文件',409,'task_incomplete','none');
      if (task.revision !== expectedRevision) throw new WorkbenchError('任务已更新，请刷新后再次确认',409,'revision_conflict','none');
      const current = phases.filter((phase) => phase.currentPhase !== false);
      if (current.length !== 1) throw new WorkbenchError('跨工作区任务请进入具体工作区后再还原文件',409,'cross_workspace_revert_not_supported','none');
      target = decode(current[0]!.id);
      expectedRevision = current[0]!.revision;
      files = files.map((file) => {
        const routed = decodeTaskPart(file);
        if (!routed || routed.run !== current[0]!.id) throw new WorkbenchError('所选文件不属于当前工作区阶段',400,'invalid_file_reference','none');
        return routed.id;
      });
    } else {
      target = decode(reference);
    }
    const result = await call<Record<string, unknown>>(target.node, "/workbench/revert/preview", { ...req.body, id: target.local, files, expectedRevision });
    return { ...result, id: workspaceHandle(target.node, String(result.id)) };
  });
  post("/runs/revert/commit", (req) => { const target = decode(text(req.body.previewId)); return call(target.node, "/workbench/revert/commit", { ...req.body, previewId: target.local }); });
  for (const action of ["protect", "control"]) post(`/sessions/:id/${action}`, (req) => {
    const target = routeRun(req); return call(target.node, `/workbench/sessions/${encodeURIComponent(target.local)}/${action}`, req.body);
  });
  post("/archive/preview", async (req) => {
    const target = decode(text(req.body.projectId));
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map((value: string) => { const ref = decode(value); if (ref.node !== target.node) throw new WorkbenchError('归档会话必须属于同一个项目节点',409,'operation_rejected','none'); return ref.local; }) : undefined;
    const result = await call<Record<string, unknown>>(target.node, "/workbench/archive", { ...req.body, projectId: target.local, ids: ids?.length ? ids : undefined });
    return { ...result, id: workspaceHandle(target.node, JSON.stringify([target.local, result.id])) };
  });
  post("/archive/commit", async (req) => {
    const target = decode(text(req.body.previewId));
    const [projectId, batchId] = z.tuple([id, id]).parse(JSON.parse(target.local));
    const batch = await call<Record<string,unknown>>(target.node, "/workbench/archive", { ...req.body, projectId, batchId });
    return {batch,effect:batch.effect??'applied'};
  });
  post("/nodes/:id/settings", async (req) => {
    if (!runtime) throw new WorkbenchError('集群设置未启用',409,'operation_rejected','none');
    const input = z.object({ expectedRevision: revision, requestKey: key, settings: z.object({ name: z.string().min(1), priority: z.number().int().min(0).max(1000), egress: z.object({ enabled: z.boolean(), inherit: z.boolean(), config: z.string(), port: z.number().int().min(1).max(65535), probe: z.url(), recovery: z.number().min(0).max(300) }) }) }).parse(req.body);
    const node = text(req.params.id);
    const current = await runtime.request<any>(node, "settings.get", {});
    const proxy = new URL(current.egress.proxyUrl); proxy.port = String(input.settings.egress.port);
    return call(node, "/workbench/settings", { expectedRevision: input.expectedRevision, requestKey: input.requestKey,
      settings: { nickname: input.settings.name, priority: input.settings.priority, egress: { ...current.egress,
        enabled: input.settings.egress.enabled, inheritProxy: input.settings.egress.inherit,
        mihomoConfig: input.settings.egress.config || null, proxyUrl: proxy.href, probeUrl: input.settings.egress.probe, recoveryDelayMs: input.settings.egress.recovery * 1000 } } });
  });
  post("/roots/save", async (req) => {
    if (!runtime) throw new WorkbenchError('根目录管理需要启用集群配置',409,'operation_rejected','none');
    const input = z.object({ requestKey: key, expectedRevision: revision, create:z.boolean().optional(), root: z.object({ id, nodeId: id, name: z.string().min(1).max(100), path: z.string().min(1), description: z.string().max(1000), tags: z.array(z.string()), enabled: z.boolean(), readOnly: z.boolean() }) }).parse(req.body);
    if (input.root.readOnly) throw new WorkbenchError('当前执行节点不支持根目录级只读设置',422,'root_readonly_unsupported','none');
    const localRoot = parseWorkspaceHandle(input.root.id)?.local ?? input.root.id;
    const current = await runtime.request<any>(input.root.nodeId, "settings.get", {});
    const root = { id: localRoot, nickname: input.root.name, path: input.root.path, description: input.root.description, tags: input.root.tags, enabled: input.root.enabled };
    const roots = [...current.roots.filter((value: { id: string }) => value.id !== localRoot), root];
    if (input.create === true && current.roots.some((value:{id:string}) => value.id === localRoot)) throw new WorkbenchError('这个根目录标识已经存在',409,'root_exists','none');
    return call(input.root.nodeId, "/workbench/settings", { expectedRevision: input.expectedRevision, requestKey: input.requestKey, settings: { roots } });
  });
  post("/egress/sync", async (req) => {
    const input = z.object({ sourceNodeId: z.string().optional(), text: z.string().max(256 * 1024).optional(), nodeIds: z.array(id).min(1).max(20), reload: z.boolean(), requestKey: key }).parse(req.body);
    if (!runtime) throw new WorkbenchError('统一出口设置未启用',409,'operation_rejected','none');
    const source = input.text ?? await runtime.request<string>(input.sourceNodeId!, "mihomo.read", {});
    const results = await mapConcurrent(input.nodeIds, 3, async (nodeId) => {
      try { const result = await runtime.request<any>(nodeId, "mihomo.import", { text: source, reload: input.reload });
        return { nodeId, ...result, ok: result.saved === true, reloaded: result.reloaded === true }; }
      catch (error) { return { nodeId, ok: false, error: error instanceof Error ? error.message : String(error) }; }
    });
    actions.audit.record("egress.sync", input.nodeIds.join(","), null, { results }, input.requestKey);
    const effect=combinedEffect(results.map(result=>({ok:result.ok,effect:result.ok?'applied':'unknown'})));
    return {results,effect};
  });
  post("/transfers/cancel", async (req) => {
    if (!runtime) throw new WorkbenchError('文件传输未启用',409,'operation_rejected','none');
    const result = await runtime.copyArtifact({ action: "cancel", copy_id: text(req.body.id) });
    return { transfer: result, status: "accepted" };
  });
  return { feed };
}

type RunDetail = Awaited<ReturnType<typeof readRunDetail>> & { taskMessages?: TaskMessageConfirmation };
type RoutedTaskDetail = { phase: string; detail: RunDetail };

const TASK_PART_PREFIX = "tqpart:";

function encodeTaskPart(run: string, id: string): string {
  return TASK_PART_PREFIX + Buffer.from(JSON.stringify([run, id]), "utf8").toString("base64url");
}

function decodeTaskPart(value: string): { run: string; id: string } | null {
  if (!value.startsWith(TASK_PART_PREFIX)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value.slice(TASK_PART_PREFIX.length), "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== "string" || typeof parsed[1] !== "string") {
      throw new Error("shape");
    }
    return { run: parsed[0], id: parsed[1] };
  } catch {
    throw new WorkbenchError('任务详情引用无效，请重新打开任务',400,'invalid_task_detail_reference','none');
  }
}

function mergeTaskDetails(task: Run, phases: RoutedTaskDetail[], observation:{complete:boolean;sources:SourceState[];missing:Array<{id:string;nodeId:string;error:string;pending?:boolean}>}): RunDetail {
  const complete=observation.complete&&phases.every(({detail})=>detail.complete);
  const missing=uniqueBy([...observation.missing,...phases.flatMap(({phase,detail})=>detail.complete?[]:
    detail.missingPhases.length?detail.missingPhases:[{id:phase,nodeId:detail.run.nodeId,error:'阶段记录尚未完整读取',pending:true}])],value=>value.id);
  const confirmed=complete&&observation.sources.every(source=>source.online&&source.state==='ready'&&!source.stale&&!source.error);
  const currentRefs = new Set(task.currentPhaseRefs ?? task.phaseRefs ?? phases.map((item) => item.phase));
  const current = phases.filter((item) => currentRefs.has(item.phase));
  const singleCurrentPhase = current.length === 1;
  const changeCaptures = current.flatMap(({phase,detail}) => (detail.changeCaptures ?? [])
    .map(capture => ({...capture,runId:phase})));
  const captureBlocked = changeCaptures.some(capture => capture.state === 'pending' || capture.state === 'failed');
  const files = current.flatMap(({ phase, detail }) => detail.files.map((file) => ({
    ...file,
    id: encodeTaskPart(phase, file.id),
    revertible: singleCurrentPhase && file.revertible,
    source:{runId:phase,nodeId:detail.run.nodeId,projectName:detail.run.projectName,root:detail.run.root},
  })));
  const commands = phases.flatMap(({ phase, detail }) => detail.commands.map((command) => ({
    ...command,
    id: encodeTaskPart(phase, command.id),
  }))).sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  const agents = uniqueBy(phases.flatMap(({ detail }) => detail.agents), (agent) => `${agent.provider}:${agent.id}`);
  const evidence = phases.flatMap(({ detail }) => detail.evidence);
  const timeline = phases.flatMap(({ detail }) => detail.timeline).sort((a, b) => a.time - b.time);
  const instructions = uniqueBy(phases.flatMap(({ detail }) => detail.instructions), (item) => item.path);
  const skills = uniqueBy(phases.flatMap(({ detail }) => detail.skills), (item) => `${item.name}:${item.path}`);
  const pendingOnly=observation.sources.some(source=>source.state==='loading'||source.state==='refreshing')
    &&!observation.sources.some(source=>source.error||!source.online);
  const warnings = [...new Set([...task.warnings.filter(value=>!pendingOnly||value!=='部分节点详情暂未取得'),
    ...phases.flatMap(({ detail }) => detail.warnings),
    ...observation.missing.filter(value=>!value.pending).map(value=>`${value.nodeId} 阶段读取失败：${value.error}`)])];
  const saved=current.map(({detail})=>detail.summary.trim()).filter(Boolean);
  const summary=saved.length===1?saved[0]:saved.length?saved.join('\n\n'):task.reason??'任务已创建，尚未登记执行阶段';
  return {
    run: {
      ...task,
      actions: {
        interrupt: task.actions.interrupt,
        resume: task.actions.resume,
        review: confirmed && !captureBlocked && task.actions.review,
        complete: confirmed && !captureBlocked && task.actions.complete,
        revert: confirmed && !captureBlocked && singleCurrentPhase && task.actions.revert,
        patch: confirmed && !captureBlocked && singleCurrentPhase && task.actions.patch !== false,
      },
    },
    summary,
    changeCaptures,
    phases:phases.map(({phase,detail})=>({id:phase,run:detail.run,summary:detail.summary})),
    complete,sources:observation.sources,missingPhases:missing,
    evidence,
    files,
    commands,
    agents,
    timeline,
    instructions,
    skills,
    warnings,
    revision: task.revision,
  };
}

function uniqueBy<T>(values: T[], key: (value: T) => string): T[] {
  const result = new Map<string, T>();
  for (const value of values) result.set(key(value), value);
  return [...result.values()];
}

interface DispatchTarget {reference:string;phaseId:string;node:string;path:string;receiptTarget:string;body:Record<string,unknown>}
interface DispatchOutcome {phaseId?:string;nodeId?:string;id?:string;ok:boolean;effect:WriteEffect;receipt?:unknown;error?:string;code?:string}
interface DispatchPlan {kind:'control'|'review';references:string[];targets:DispatchTarget[];failures:DispatchOutcome[];missingNodes:string[];incomplete?:boolean}

function combinedEffect(outcomes:DispatchOutcome[],incomplete=false):WriteEffect {
  const applied=outcomes.some(value=>value.effect==='applied'||value.effect==='partial');
  const unknown=incomplete||outcomes.some(value=>value.effect==='unknown');
  if(applied&&(unknown||outcomes.some(value=>!value.ok)))return 'partial';
  if(unknown)return 'unknown';
  return applied?'applied':'none';
}

function dispatchResponse(plan:DispatchPlan,outcomes:DispatchOutcome[]) {
  const effect=combinedEffect([...outcomes,...plan.failures],plan.incomplete);
  const results=plan.kind==='control'?outcomes.map(value=>({...value,...(value.receipt&&typeof value.receipt==='object'?value.receipt:{}),ok:value.ok,effect:value.effect}))
    :plan.references.map(id=>{
      const failure=plan.failures.find(value=>value.id===id);
      if(failure)return failure;
      const children=outcomes.filter((_,index)=>plan.targets[index]?.reference===id),childEffect=combinedEffect(children);
      return {id,ok:childEffect==='applied',phases:children.length,receipts:children,effect:childEffect,
        ...(children.some(child=>!child.ok)?{error:children.filter(child=>!child.ok).map(child=>child.error??'部分阶段结果待核对').join('；')}: {})};
    });
  const finished=outcomes.every(value=>!value.receipt||typeof value.receipt!=='object'||(value.receipt as {status?:string}).status!=='accepted');
  return {status:effect==='partial'?'partial':effect==='unknown'?'unknown':effect==='none'?'rejected':finished?'completed':'accepted',effect,results,missingNodes:plan.missingNodes};
}
