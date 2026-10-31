import {readWorkbenchMetadata} from "./metadata.js";
import { randomUUID } from "node:crypto";
import type { ServerConfig } from "../config.js";
import { withTaskLifecycle,activeExecution,observeSourceStates,type TaskLifecycle } from '../console-task-state.js';
import type { LocalActions } from './actions.js';
import type { FederationRuntime } from "../federation/runtime.js";
import type { ConsoleReply, NodeView } from "../federation/types.js";
import { mapConcurrent } from "../concurrency.js";
import { parseWorkspaceHandle } from "../federation/routing.js";
import { sampleHealth } from "../federation/health.js";
import { capabilities, capabilityLabels } from "../federation/capabilities.js";
import { readLocalMetadata, readLocalOverviewUsage, readLocalRunSummaries, readLocalSessionTitles, readLocalTaskIndex, readLocalUsage } from "./local-queries.js";
import { decodeBoundary, pageCursor } from "./run-query.js";
import { dayAt, mergeTotals, type Query } from "./query.js";
import { aggregateTaskIndex, aggregateTasks, applyRunTitles, applyTaskTitles, compareTaskIndex, fallbackTask, taskOnlyIndex, filterTaskIndex, resolveSessionTitles, taskKey, taskStage, type TaskIndex } from "./task-aggregation.js";
import { WorkbenchError, type Run, type SourceReadState, type SourceState } from "./types.js";
import { lastObservedExecutingTasks, overviewTaskProgress, selectOverviewTasks, taskAttention } from './overview-tasks.js';
import { taskActivityView } from '../task-view.js';
import {mergeTaskWorkspaces,withTaskMembership} from './task-aggregation.js';

interface CachedResource { data: unknown; loadedAt: number; error: string | null; wait: boolean; retryAt: number; failures: number }
interface PageSnapshot { keys: string[]; counts: Record<string, number>; at: number; query: string; expiresAt: number }
interface NodeResource<T> { source: SourceState; data: T | null }
type NodeIdentity = { id: string; nickname: string; online: boolean };
const SOURCE_FRESHNESS_MS = 30_000;

export class WorkbenchFeed {
  private readonly cache = new Map<string, CachedResource>();
  private readonly pending = new Map<string, {generation:number; promise:Promise<NodeResource<unknown>>}>();
  private readonly pages = new Map<string, PageSnapshot>();
  private generation = 0;
  constructor(readonly config: ServerConfig, readonly runtime?: FederationRuntime) {}
  private get localId() { return this.config.federation?.nodeId ?? "local"; }
  private nodes(): NodeIdentity[] {
    return this.runtime?.nodes() ?? [{ id: this.localId, nickname: "本机", online: true }];
  }
  sources(): SourceState[] {
    return this.nodes().map((node) => ({ nodeId: node.id, name: node.nickname, online: node.online,
      state: node.online ? "loading" : "offline", stale: !node.online, observedAt: null, error: node.online ? null : "节点离线" }));
  }
  invalidate(): void {
    this.generation++;
    for (const cached of this.cache.values()) {
      // 失效只触发重取；保留上次真实观察时间供离线界面显示。
      cached.retryAt = 0;
      cached.wait = true;
    }
  }

  async call<T>(nodeId: string, path: string, body?: unknown): Promise<T> {
    if (!this.runtime) throw new WorkbenchError("当前未启用节点转发", 503, "federation_unavailable");
    // The read transport supports a bounded retry window. Five seconds was
    // shorter than healthy Desktop reads after Modern Standby (6–10 seconds).
    const reply = await this.runtime.request<ConsoleReply>(nodeId, "console", { method: body === undefined ? "GET" : "POST", path, body }, body === undefined ? 30_000 : undefined);
    if (reply.status >= 400) {
      const error = reply.body as { message?: string; code?: string; effect?: WorkbenchError["effect"] } | null;
      throw new WorkbenchError(error?.message || "节点操作失败", reply.status, error?.code || "node_operation_failed", error?.effect ?? "unknown");
    }
    return reply.body as T;
  }

  /** Owner Console reads share the existing cache, pending RPC and retry backoff. */
  readNode<T>(nodeId:string,path:string,local:()=>T|Promise<T>,options:{fresh?:boolean;deadline?:number}={}) {
    const node=this.nodes().find(value=>value.id===nodeId)
      ?? {id:nodeId,nickname:nodeId,online:nodeId===this.localId};
    return this.load(node,path,local,1000,options.fresh,false,options.deadline);
  }

  nodeReadPriority(nodeId:string,path:string):number {
    const key=nodeId+':'+path;
    return this.cache.get(key)?.data!=null ? 2 : this.pending.has(key) ? 1 : 0;
  }

  private async load<T>(node: NodeIdentity, path: string, local: () => T|Promise<T>, ttl: number, fresh=false, waitForFresh=false, deadline=Infinity): Promise<NodeResource<T>> {
    const key = node.id + ":" + path;
    const cached = this.cache.get(key);
    const existing = this.pending.get(key);
    const capacity=!path.startsWith('/workbench/runs/')
      || [...this.pending.keys()].filter(value=>value.startsWith(node.id+':')).length<4;
    const canStart=Date.now()<deadline&&capacity;
    // An unscheduled explicit refresh must not invalidate a successful cached
    // read forever. A write invalidation's existing wait flag is retained.
    if (fresh && cached && (existing||canStart)) { cached.wait = true; cached.retryAt = 0; }
    const effectiveTtl = Math.max(ttl, 12_000);
    const recent = Boolean(cached?.loadedAt && Date.now()-cached.loadedAt <= SOURCE_FRESHNESS_MS);
    const previous = (state: SourceReadState, error: string | null): NodeResource<T> => ({ data: cached?.data as T ?? null,
      source: { nodeId: node.id, name: node.nickname, online: node.online, state, observedAt: cached?.loadedAt || null,
        stale: state === "offline" || state === "error" || state === "refreshing" && (!recent || cached?.wait === true), error } });
    const pendingState = () => previous(cached?.data != null ? "refreshing" : "loading", cached?.error ?? null);
    // Each screen combines several node reads. Bound its wait for each wave,
    // while the one shared read continues filling the cache for the next poll.
    // A cached observation keeps its original timestamp; it is never renewed by
    // merely opening a page or by a slow refresh.
    const bounded = async (job: Promise<NodeResource<T>>): Promise<NodeResource<T>> => {
      if (waitForFresh) return job;
      const wait=Math.min(1200,Math.max(0,deadline-Date.now()));
      if(!wait)return pendingState();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([job, new Promise<NodeResource<T>>(resolve => {
          timer = setTimeout(() => resolve(pendingState()), wait);
        })]);
      } finally { if (timer) clearTimeout(timer); }
    };
    if (!node.online) return previous("offline", "节点离线");
    if (cached?.error && !cached.wait && Date.now() < cached.retryAt) return previous("error", cached.error);
    if (cached && !fresh && !cached.wait && !cached.error && Date.now() - cached.loadedAt < effectiveTtl) return previous("ready", null);
    if (existing) {
      if (existing.generation !== this.generation) {
        // A pre-write observation must finish before the replacement starts,
        // but it cannot hold a whole screen open or overwrite the new generation.
        return bounded(existing.promise.then(() => this.load(node,path,local,ttl,fresh,waitForFresh,deadline)));
      }
      return cached?.data != null && !cached.wait && !fresh
        ? pendingState() : bounded(existing.promise as Promise<NodeResource<T>>);
    }
    // A detail can contain many historical phases. Once its shared screen
    // budget is exhausted, leave the remaining reads for the next poll instead
    // of starting another wave of RPCs after the response is already partial.
    if(!canStart)return pendingState();
    const generation = this.generation;
    const job: Promise<NodeResource<T>> = Promise.resolve().then(async () => {
      try {
        const data = node.id === this.localId ? await local() : await this.call<T>(node.id, path);
        const loadedAt = Date.now();
        if (generation === this.generation) {
          this.cache.delete(key); this.cache.set(key, { data, loadedAt, error: null, wait: false, retryAt: 0, failures: 0 });
        }
        while (this.cache.size > 160) this.cache.delete(this.cache.keys().next().value!);
        const source: SourceState = { nodeId: node.id, name: node.nickname, online: true, state: "ready", observedAt: loadedAt, stale: false, error: null };
        return { data, source };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failures = Math.min((cached?.failures ?? 0) + 1, 6);
        const retryDelay = Math.min(60_000, 3000 * 2 ** (failures - 1));
        if (generation === this.generation) this.cache.set(key,{data:cached?.data ?? null,loadedAt:cached?.loadedAt ?? 0,
          error:message,wait:false,retryAt:Date.now()+retryDelay,failures});
        return previous("error", message);
      }
    }).finally(() => { if (this.pending.get(key)?.promise === job) this.pending.delete(key); });
    this.pending.set(key, { generation, promise:job });
    return cached?.data != null && !cached.wait && !fresh ? pendingState() : bounded(job);
  }

  private async collect<T>(path: string, local: () => T|Promise<T>, query: Query = {}, ttl = 5000, nodeIds?:ReadonlySet<string>, fresh=false) {
    const projectNode = query.project ? parseWorkspaceHandle(query.project)?.node : undefined;
    const known=this.nodes();
    for(const id of [...(nodeIds??[]),...(query.node?[query.node]:[]),...(projectNode?[projectNode]:[])]){
      if(!known.some(node=>node.id===id))known.push({id,nickname:id,online:false});
    }
    const nodes = known.filter((node) => (!query.node || node.id === query.node) && (!projectNode || node.id === projectNode) && (!nodeIds||nodeIds.has(node.id)));
    // A single offline node must not delay a fifth, healthy machine behind
    // another complete 20-second read window on a cold Console load.
    const results = await mapConcurrent(nodes, 8, (node) => this.load(node, path, local, ttl,fresh));
    return { values: results.flatMap((result) => result.data === null ? [] : [result.data]),
      sources: results.map((result) => result.source),
      // "complete" measures coverage of all node snapshots. A source being
      // refreshed is still represented by its last complete, timestamped
      // snapshot; sources[].state/stale describe freshness independently.
      complete: results.every((result) => result.data !== null && result.source.online
        && (result.source.state === "ready" || result.source.state === "refreshing")
        && !result.source.error), observedAt: Date.now() };
  }

  async metadata(fresh=false) {
    const group = await this.collect("/workbench/metadata", () => readWorkbenchMetadata(this.config,this.runtime), {}, 1000,undefined,fresh);
    return { projects: group.values.flatMap((value) => value.projects), roots: group.values.flatMap((value) => value.roots),
      sources: group.sources, complete: group.complete, observedAt: group.observedAt };
  }

  async nodeSettings(nodeId:string) {
    const node=this.nodes().find(node=>node.id===nodeId);
    if(!node)throw new WorkbenchError('节点不存在',404,'node_not_found','none');
    const result=await this.load(node,'/workbench/metadata',()=>readWorkbenchMetadata(this.config,this.runtime),1000,true,true);
    if(!result.data||!result.source.online||result.source.error||result.source.state!=='ready')throw new WorkbenchError(result.source.error??'正在取得节点设置，请稍后重试',503,'settings_unavailable','none');
    return {settings:result.data.settings,roots:result.data.roots,source:result.source};
  }

  private taskIndex(phases: Parameters<typeof aggregateTaskIndex>[0], titles: {map:Map<string,string>;tasks:Map<string,TaskLifecycle>;sources?:SourceState[]}, sources:SourceState[]) {
    const tasks=applyTaskTitles(aggregateTaskIndex(observeSourceStates(phases,sources)),titles.map);
    const present=new Set(tasks.map(task=>task.taskId).filter(Boolean));
    for(const task of titles.tasks.values()) if(!present.has(task.id)) {
      const fallback=taskOnlyIndex(task);
      const missing=(task.memberNodeIds??[]).some(node=>!sources.some(source=>source.nodeId===node&&source.online&&source.observedAt!==null&&!source.error));
      tasks.push(missing?{...fallback,executionStatus:'unknown',actionableInterruption:true,reason:'部分任务成员尚未取得，后台执行状态待核对'}:fallback);
    }
    const authorityObservations = titles.sources ? new Map(observeSourceStates(titles.sources.map(source => ({
      nodeId:source.nodeId,executionStatus:'waiting',
    })),titles.sources).map(source=>[source.nodeId,source])) : null;
    return tasks.map(task=>{
      const lifecycle=titles.tasks.get(task.taskId ?? '');
      const resolved=withTaskMembership(withTaskLifecycle(task,lifecycle),lifecycle);
      if(!authorityObservations||!lifecycle?.nodeId)return resolved;
      const authority=authorityObservations.get(lifecycle.nodeId);
      const observedAt=!task.phaseRefs.length ? authority?.observedAt ?? null
        : resolved.observedAt == null || authority?.observedAt == null ? null : Math.min(resolved.observedAt,authority.observedAt);
      return {...resolved,observedAt,stale:Boolean(resolved.stale)||!authority||authority.stale};
    });
  }

  async runs(query: Query) {
    const boundary = decodeBoundary(query.cursor), at = boundary?.at ?? Date.now();
    const limit = Math.min(100, Math.max(1, Number(query.limit ?? 25)));
    const {index,titles}=await this.scopedIndex(query);
    const usage = query.usageDate || query.usageDays ? await this.usageContributors(query) : null;
    const allTasks=this.taskIndex(index.values.flatMap(value=>value.items),titles,index.sources);
    const lastObservedExecuting=lastObservedExecutingTasks(index.values.flatMap(value=>value.items));
    const contributes=(task:TaskIndex)=>!usage || task.phaseRefs.some(reference=>usage.runIds.has(reference));
    const scoped = filterTaskIndex(allTasks,query,at,lastObservedExecuting).filter(contributes);
    let counts:Record<string,number>={all:scoped.length};
    for(const task of scoped){const state=taskStage(task.executionStatus,task.acceptanceStatus,task.phaseExecutionStatus);counts[state]=(counts[state]??0)+1;}
    const navigation=filterTaskIndex(allTasks,{...query,requestState:undefined,stage:undefined,attention:undefined,overviewGroup:undefined},at,lastObservedExecuting).filter(contributes);
    counts.scopeAll=navigation.length;counts.scopeOpen=0;counts.scopeClosed=0;
    counts.scopeActive=0;counts.scopeWaiting=0;counts.scopeResults=0;counts.scopeAttention=0;
    for(const task of navigation){
      const state=taskStage(task.executionStatus,task.acceptanceStatus);
      if(task.requestState==='active')counts.scopeOpen++;
      if(task.requestState==='closed')counts.scopeClosed++;
      if(activeExecution(task.executionStatus))counts.scopeActive++;
      if(['waiting','stalled','finalizing'].includes(state))counts.scopeWaiting++;
      if(['done','accepted','rejected','review','failed','ended','cancelled','handed_off'].includes(state))counts.scopeResults++;
      if(taskAttention(task))counts.scopeAttention++;
    }
    const selected=scoped.filter(task=>!query.status||taskStage(task.executionStatus,task.acceptanceStatus,task.phaseExecutionStatus)===query.status)
      .sort((a,b)=>compareTaskIndex(a,b,query,at));
    const signature=JSON.stringify(Object.entries(query).filter(([name])=>!['cursor','limit','fresh'].includes(name)).sort(([a],[b])=>a.localeCompare(b)));
    let snapshotId=(boundary as typeof boundary & {snapshot?:string})?.snapshot;
    let snapshot=snapshotId?this.pages.get(snapshotId):undefined;
    if(snapshotId && (!snapshot || snapshot.expiresAt<Date.now() || snapshot.query!==signature))
      throw new WorkbenchError('任务分页已过期，请返回第一页刷新',409,'cursor_expired','none');
    if(!snapshot){
      snapshotId=randomUUID();snapshot={keys:selected.map(task=>task.key),counts,at,query:signature,expiresAt:Date.now()+15*60_000};
      this.pages.set(snapshotId,snapshot);
      for(const [id,value] of this.pages)if(value.expiresAt<Date.now())this.pages.delete(id);
      while(this.pages.size>32)this.pages.delete(this.pages.keys().next().value!);
    }
    counts=snapshot.counts;
    const offset=boundary?.offset??0;
    const byKey=new Map(allTasks.map(task=>[task.key,task]));
    const keys=snapshot.keys.slice(offset,offset+limit);
    const pageIndex=keys.flatMap(key=>byKey.has(key)?[byKey.get(key)!]:[]);
    const summaries=await this.runSummaries(pageIndex.flatMap(task=>task.phaseRefs),query.fresh==='1');
    const detailed=new Map(applyRunTitles(aggregateTasks(observeSourceStates(summaries.values,summaries.sources)),titles.map).map(run=>[taskKey(run),run]));
    const items=pageIndex.map(task=>this.resolvedRun(task,detailed.get(task.key)));
    const cursor=(run:Run,next:number,direction:'next'|'previous')=>Buffer.from(JSON.stringify({
      ...JSON.parse(Buffer.from(pageCursor(run,query,at,next,direction),'base64url').toString('utf8')),snapshot:snapshotId,
    })).toString('base64url');
    const taskCoverage=index.complete&&titles.complete&&(!usage||usage.complete);
    return {items,total:snapshot.keys.length,counts,offset,limit,snapshotAt:snapshot.at,coverage:{tasks:taskCoverage,details:summaries.complete},
      nextCursor:taskCoverage&&items.length&&offset+keys.length<snapshot.keys.length?cursor(items.at(-1)!,offset+keys.length,'next'):null,
      previousCursor:items.length&&offset>0?cursor(items[0],Math.max(0,offset-limit),'previous'):null,
      sources:mergeSources(mergeSources(mergeSources(index.sources,summaries.sources),titles.sources),usage?.sources??[]),
      complete:index.complete&&summaries.complete&&titles.complete&&(!usage||usage.complete),observedAt:Date.now()};
  }

  private async sessionTitles(nodeIds?:ReadonlySet<string>,fresh=false) {
    const group = await this.collect("/workbench/session-titles", () => readLocalSessionTitles(this.config), {}, 1000,nodeIds,fresh);
    const tasks = new Map<string,TaskLifecycle>();
    const authority = new Set<string>();
    for (const source of group.values) for (const task of source.tasks ?? []) {
      const previous=tasks.get(task.id);
      if (!previous || source.authoritative && !authority.has(task.id)
        || source.authoritative === authority.has(task.id) && task.revision > previous.revision) tasks.set(task.id,task);
      if (source.authoritative) authority.add(task.id);
    }
    return { map: resolveSessionTitles(group.values.flatMap((value) => value.items)),
      tasks,items:group.values.flatMap(value=>value.items),observedAt:group.observedAt,
      sources: group.sources, complete: group.complete };
  }

  private async scopedIndex(query:Query) {
    const scoped=Boolean(query.node||query.project);
    const fresh=query.fresh==='1';
    const [initial,titles]=await Promise.all([
      this.collect('/workbench/task-index',()=>readLocalTaskIndex(this.config),scoped?query:{},1000,undefined,fresh),this.sessionTitles(undefined,fresh),
    ]);
    if(!scoped)return {index:initial,titles};
    const required=new Set(initial.sources.map(source=>source.nodeId));
    const taskIds=new Set(initial.values.flatMap(value=>value.items).map(phase=>phase.taskId).filter(Boolean));
    for(const task of titles.tasks.values()){
      const matches=taskIds.has(task.id)||(task.workspaces??[]).some(workspace=>(!query.node||workspace.nodeId===query.node)&&(!query.project||workspace.projectId===query.project));
      if(!matches)continue;
      for(const node of task.memberNodeIds??[])required.add(node);
      if(task.nodeId)required.add(task.nodeId);
    }
    const additional=new Set([...required].filter(node=>!initial.sources.some(source=>source.nodeId===node)));
    const extra=await this.collect('/workbench/task-index',()=>readLocalTaskIndex(this.config),{},1000,additional,fresh);
    const sources=titles.sources.filter(source=>required.has(source.nodeId));
    return {index:{...initial,values:[...initial.values,...extra.values],sources:[...initial.sources,...extra.sources],complete:initial.complete&&extra.complete},
      titles:{...titles,sources,complete:sources.every(source=>source.online&&source.observedAt!==null&&!source.error&&['ready','refreshing'].includes(source.state))}};
  }

  private resolvedRun(task:TaskIndex,detail?:Run):Run {
    const run=detail ?? fallbackTask(task);
    const workspaces=mergeTaskWorkspaces(run.workspaces,task.workspaces);
    const canComplete=task.requestState==='active' && !activeExecution(task.executionStatus)
      && task.executionStatus!=='unknown' && !(task.executionStatus==='interrupted_recoverable'&&task.actionableInterruption);
    return {...run,title:task.title,titleSource:task.titleSource,lastProgressAt:task.lastProgressAt ?? task.lastActivityAt,
      ...(workspaces.length?{workspaces,workspaceCount:workspaces.length,
        projectName:workspaces.length===1?workspaces[0]!.name:`${workspaces.length} 个工作区`}:{}),
      nodeIds:[...new Set([...(run.nodeIds??[run.nodeId]),...task.nodeIds])],
      executionObservedAt:task.executionObservedAt ?? null,
      executionStatus:task.executionStatus,acceptanceStatus:task.acceptanceStatus,sourceTaskId:task.sourceTaskId??null,
      requestState:task.requestState,resultStatus:task.resultStatus,phaseExecutionStatus:task.phaseExecutionStatus,finalization:task.finalization,actionableInterruption:task.actionableInterruption,
      revision:run.revision+(task.taskRevision??0),taskRevision:task.taskRevision,
      reason:task.reason ?? (run.executionStatus === task.executionStatus ? run.reason : null),
      startedAt:task.startedAt,finishedAt:task.finishedAt,lastActivityAt:task.lastActivityAt,
      observedAt:task.observedAt===undefined ? run.observedAt : task.observedAt,
      stale:task.stale===true||run.stale===true,
      actions:{...run.actions,complete:canComplete,review:task.acceptanceStatus==='pending'&&run.actions.review}};
  }

  async projectConversations(data:ReturnType<LocalActions['sessions']>,fresh=false) {
    if (!Array.isArray(data.conversations)) throw new WorkbenchError('该节点尚未提供对话会话数据，请更新节点服务',503,'node_capability_unavailable');
    const {index,titles}=await this.scopedIndex({project:data.conversations[0]?.projectId,fresh:fresh?'1':undefined});
    const aggregate=new Map(this.taskIndex(index.values.flatMap(value=>value.items),titles,index.sources).map(task=>[task.taskId,task]));
    return {...data,complete:index.complete&&titles.complete,sources:mergeSources(index.sources,titles.sources),observedAt:Date.now(),
      conversations:data.conversations.map(conversation=>{
      const tasks=conversation.tasks.map(task=>{
        // 项目决定会话归属；任务状态仍需包含它在其他工作区的执行。
        const full=aggregate.get(task.taskId);
        const state=full?{...task,title:full.title,titleSource:full.titleSource,
          lastProgressAt:full.lastProgressAt ?? full.lastActivityAt,executionObservedAt:full.executionObservedAt ?? null,
          observedAt:full.observedAt,stale:full.stale,executionStatus:full.executionStatus,acceptanceStatus:full.acceptanceStatus,
          requestState:full.requestState,resultStatus:full.resultStatus,phaseExecutionStatus:full.phaseExecutionStatus,
          finalization:full.finalization,startedAt:full.startedAt,finishedAt:full.finishedAt,lastActivityAt:full.lastActivityAt,workspaces:full.workspaces}
          :withTaskLifecycle({...task,phaseExecutionStatus:task.executionStatus},titles.tasks.get(task.taskId ?? ''));
        return {...state,status:taskStage(state.executionStatus,state.acceptanceStatus,state.phaseExecutionStatus)};
      });
      return {...conversation,tasks,activeCount:tasks.filter(task=>activeExecution(task.executionStatus)).length};
    })};
  }

  async conversations(query:Query) {
    const {index,titles}=await this.scopedIndex(query);
    const tasks=filterTaskIndex(this.taskIndex(index.values.flatMap(value=>value.items),titles,index.sources),{...query,q:undefined,days:query.days??'0'},Date.now());
    const search=(query.q??'').trim().toLocaleLowerCase();
    const sessions=new Map(titles.items.map(row=>[row.id,row]));
    const groups=new Map<string,TaskIndex[]>();
    for(const task of tasks)if(task.sessionId){const values=groups.get(task.sessionId)??[];values.push(task);groups.set(task.sessionId,values);}
    const items=[...groups].flatMap(([sessionId,values])=>{
      const title=titles.map.get(sessionId)??sessionId;
      if(search&&![title,sessionId,...values.flatMap(task=>[task.title,task.taskId??''])].some(value=>value.toLocaleLowerCase().includes(search)))return [];
      const session=sessions.get(sessionId);
      const current=values.sort((a,b)=>b.startedAt-a.startedAt);
      return [{id:sessionId,title,projectId:current[0]?.projectIds[0]??'',nodeId:current[0]?.nodeIds[0]??'',
        createdAt:Math.min(...current.map(task=>task.startedAt)),updatedAt:session?.lastActivityAt??Math.max(...current.map(task=>task.lastActivityAt)),
        taskCount:current.length,activeCount:current.filter(task=>activeExecution(task.executionStatus)).length,
        tasks:current.map(task=>{const run=this.resolvedRun(task);return {id:run.id,taskId:task.taskId,title:task.title,status:taskStage(task.executionStatus,task.acceptanceStatus,task.phaseExecutionStatus),
          titleSource:task.titleSource,lastProgressAt:task.lastProgressAt ?? task.lastActivityAt,
          executionObservedAt:task.executionObservedAt ?? null,observedAt:task.observedAt,stale:task.stale,
          root:run.root,workspaces:run.workspaces,executionStatus:task.executionStatus,acceptanceStatus:task.acceptanceStatus,
          requestState:task.requestState,resultStatus:task.resultStatus,phaseExecutionStatus:task.phaseExecutionStatus,finalization:task.finalization,
          lastActivityAt:task.lastActivityAt,startedAt:task.startedAt,finishedAt:task.finishedAt,hasRun:task.phaseRefs.length>0};})}];
    }).sort((a,b)=>b.updatedAt-a.updatedAt||a.id.localeCompare(b.id));
    return {items,total:items.length,sources:mergeSources(index.sources,titles.sources),complete:index.complete&&titles.complete};
  }

  private async runSummaries(references: string[],fresh=false) {
    const byNode = new Map<string, string[]>();
    for (const reference of references) {
      const parsed = parseWorkspaceHandle(reference);
      if (!parsed) continue;
      const values = byNode.get(parsed.node) ?? [];
      values.push(parsed.local);
      byNode.set(parsed.node, values);
    }
    const nodes = this.nodes().filter((node) => byNode.has(node.id));
    const results = await mapConcurrent(nodes, 4, async (node) => {
      const ids = [...new Set(byNode.get(node.id) ?? [])];
      const chunks = chunk(ids, 100);
      const resources = await mapConcurrent(chunks, 2, (batch) => {
        const path = "/workbench/run-summaries?ids=" + encodeURIComponent(batch.join(","));
        return this.load(node, path, () => readLocalRunSummaries(this.config, batch), 5000,fresh);
      });
      return { data: { items: resources.flatMap((resource) => resource.data?.items ?? []) },
        source: resources.reduce<SourceState[]>((values,resource)=>mergeSources(values,[resource.source]),[])[0]
          ?? { nodeId: node.id, name: node.nickname, online: node.online, state: "ready" as const, observedAt: Date.now(), stale: false, error: null },
        complete: resources.every((resource) => resource.data !== null) };
    });
    return {
      values: results.flatMap((result) => result.data.items),
      sources: results.map((result) => result.source),
      complete: results.every((result) => result.complete),
    };
  }

  async phaseSummary(reference:string,fresh=false) {
    const group=await this.runSummaries([reference],fresh);
    return {run:group.values.find(value=>value.id===reference),sources:group.sources};
  }

  async sessionRuns(sessionId:string,fresh=false) {
    return this.relatedRuns({sessionId},fresh);
  }

  async taskRuns(taskId:string,fresh=false) {
    return this.relatedRuns({taskId},fresh);
  }

  /** Exact requested Tasks, using the same owner observations as the console.
   * Peer traffic and API receipt time never renew an execution proof. */
  async taskActivities(taskIds:readonly string[]) {
    const selected=new Set(taskIds);
    const [index,titles]=await Promise.all([
      this.collect('/workbench/task-index',()=>readLocalTaskIndex(this.config),{},1000),this.sessionTitles(),
    ]);
    const scoped={...titles,tasks:new Map([...titles.tasks].filter(([id])=>selected.has(id)))};
    return this.taskIndex(index.values.flatMap(value=>value.items).filter(phase=>phase.taskId!==null&&selected.has(phase.taskId)),scoped,index.sources)
      .filter(task=>task.taskId!==null&&selected.has(task.taskId)).map(task=>({taskId:task.taskId!,title:task.title,executionStatus:task.executionStatus,
        lastProgressAt:task.lastProgressAt??null,executionObservedAt:task.executionObservedAt??null,stale:task.stale===true}));
  }

  private async relatedRuns(identity:{taskId?:string;sessionId?:string},fresh=false) {
    const known=identity.taskId?[...this.cache.entries()].filter(([key])=>key.endsWith(':/workbench/session-titles'))
      .flatMap(([,cached])=>{const value=cached.data as ReturnType<typeof readLocalSessionTitles>|null;
        return (value?.tasks??[]).filter(task=>task.id===identity.taskId).map(task=>({task,authoritative:value!.authoritative}));})
      .sort((a,b)=>Number(b.authoritative)-Number(a.authoritative)||b.task.revision-a.task.revision)[0]?.task:undefined;
    const [titles,index]=await Promise.all([
      this.sessionTitles(known?.nodeId?new Set([known.nodeId]):undefined,fresh),
      this.collect('/workbench/task-index',()=>readLocalTaskIndex(this.config),{},1000,undefined,fresh),
    ]);
    const lifecycle=identity.taskId?titles.tasks.get(identity.taskId):undefined;
    const matches=(phase:{taskId:string|null;sessionId:string|null})=>identity.taskId?phase.taskId===identity.taskId:phase.sessionId===identity.sessionId;
    const phases=index.values.flatMap(value=>value.items).filter(matches);
    const required=new Set([...phases.map(phase=>phase.nodeId),...(lifecycle?.memberNodeIds??[]),...(lifecycle?.nodeId?[lifecycle.nodeId]:[])]);
    const summaries=await this.runSummaries(phases.map(phase=>phase.id),fresh);
    const sources=mergeSources(mergeSources(index.sources,summaries.sources),titles.sources).filter(source=>required.has(source.nodeId));
    const authoritative=Boolean(lifecycle&&lifecycle.nodeId&&sources.some(source=>source.nodeId===lifecycle.nodeId));
    const complete=(authoritative?required.size>0&&[...required].every(node=>sources.some(source=>source.nodeId===node&&source.online&&source.observedAt!==null
      &&['ready','refreshing'].includes(source.state)&&!source.error))
      :index.complete&&titles.complete)&&summaries.complete;
    const runs=applyRunTitles(observeSourceStates(summaries.values.filter(matches),sources),titles.map).map(run=>withTaskLifecycle(run,titles.tasks.get(run.taskId??'')));
    const task=lifecycle?this.resolvedRun(withTaskMembership(withTaskLifecycle(phases.length?aggregateTaskIndex(observeSourceStates(phases,sources))[0]!:taskOnlyIndex(lifecycle),lifecycle),lifecycle),runs.length?aggregateTasks(runs)[0]:undefined)
      :runs.length?aggregateTasks(runs)[0]:undefined;
    return {runs,task,lifecycle,complete,sources,missingNodes:[...required].filter(node=>!sources.some(source=>source.nodeId===node&&source.online&&!source.error&&source.observedAt!==null))};
  }

  taskFromPhases(phases:Run[],lifecycle?:TaskLifecycle) {
    const detail=phases.length?aggregateTasks(phases)[0]:undefined;
    if(!lifecycle)return detail;
    const index=phases.length?aggregateTaskIndex(phases.map(run=>({...run,tokens:run.usage.total,changed:Boolean(run.diff),
      currentPhase:run.currentPhase!==false,actionableInterruption:run.actionableInterruption===true})))[0]!:taskOnlyIndex(lifecycle);
    return this.resolvedRun(withTaskMembership(withTaskLifecycle({...index,title:lifecycle.title},lifecycle),lifecycle),detail);
  }

  async overview(zone: string,fresh=false) {
    const at = Date.now();
    const [group,index,titles] = await Promise.all([
      this.collect("/workbench/overview-usage?tz=" + encodeURIComponent(zone), () => readLocalOverviewUsage(this.config, zone),{},5000,undefined,fresh),
      this.collect("/workbench/task-index", () => readLocalTaskIndex(this.config), {}, 1000,undefined,fresh),
      this.sessionTitles(undefined,fresh),
    ]);
    const tasks = this.taskIndex(index.values.flatMap(value=>value.items),titles,index.sources);
    // Current work needs dated progress or an execution-owner observation.
    const lastObservedExecuting = lastObservedExecutingTasks(index.values.flatMap(value=>value.items));
    const today = dayAt(at, zone);
    const taskGroups = selectOverviewTasks(tasks,at,time=>dayAt(time,zone)===today,lastObservedExecuting);
    const activeIndex = tasks.filter(task=>taskActivityView({requestState:task.requestState,result:task.resultStatus,
      execution:task.executionStatus,lastProgressAt:task.lastProgressAt ?? task.lastActivityAt,
      executionObservedAt:task.executionObservedAt,now:at}).state==='executing').sort((a,b)=>b.lastActivityAt-a.lastActivityAt);
    const visibleActive=[...activeIndex.filter(task=>task.executionStatus!=='queued').slice(0,12),
      ...activeIndex.filter(task=>task.executionStatus==='queued').slice(0,3)];
    const waitingIndex = tasks.filter(task=>['waiting','stalled','finalizing'].includes(task.executionStatus)).sort((a,b)=>b.lastActivityAt-a.lastActivityAt);
    const recentIndex = taskGroups.recent.slice(0,6);
    const attentionIndex = taskGroups.attention;
    const visibleCurrent = taskGroups.current.slice(0,12), visibleOlder = taskGroups.olderOpen.slice(0,6);
    const visibleIndex = [...visibleCurrent, ...visibleOlder, ...recentIndex, ...attentionIndex.slice(0, 6)];
    const summaries = await this.runSummaries([...new Set(visibleIndex.flatMap((task) => task.phaseRefs))],fresh);
    const detailed = new Map(applyRunTitles(aggregateTasks(observeSourceStates(summaries.values,summaries.sources)), titles.map).map((run) => [taskKey(run), run]));
    const resolve = (task: TaskIndex) => this.resolvedRun(task,detailed.get(task.key));
    const active = visibleActive.map(resolve);
    const recent = recentIndex.map(task=>({...resolve(task),...overviewTaskProgress(task,'recent')}));
    const complete = group.complete && index.complete && summaries.complete && titles.complete;
    const taskCoverage=index.complete&&titles.complete;
    const sourceGroups=overviewSourceStates({tasks:index.sources,titles:titles.sources,details:summaries.sources,usage:group.sources});
    const taskIndexSources=mergeSources(index.sources,titles.sources);
    const nodeCounts=Object.fromEntries(taskIndexSources.map(source=>{
      // 节点卡片统计本节点阶段；同一 Task 在其它节点运行不能增加本节点运行数。
      const own=aggregateTaskIndex(observeSourceStates(index.values.flatMap(value=>value.items).filter(phase=>phase.nodeId===source.nodeId),[source]));
      const known=source.online&&source.observedAt!==null&&!source.error;
      return [source.nodeId,{running:known?own.filter(task=>['running','stopping'].includes(task.executionStatus)).length:null,
        queued:known?own.filter(task=>task.executionStatus==='queued').length:null,
        waiting:known?own.filter(task=>['waiting','stalled','finalizing'].includes(task.executionStatus)).length:null,complete:known}];
    }));
    return { active,activeCount:taskCoverage ? activeIndex.length : null,nodeCounts,
      current:visibleCurrent.map(task=>({...resolve(task),...overviewTaskProgress(task,'current')})),
      currentCount:taskCoverage ? taskGroups.current.length : null,
      olderOpen:visibleOlder.map(task=>({...resolve(task),...overviewTaskProgress(task,'older')})),
      olderOpenCount:taskCoverage ? taskGroups.olderOpen.length : null,
      knownCounts:{active:activeIndex.length,current:taskGroups.current.length,olderOpen:taskGroups.olderOpen.length,
        waiting:waitingIndex.length,attention:attentionIndex.length},
      coverage:{tasks:taskCoverage,usage:group.complete,details:summaries.complete},
      waiting:waitingIndex.slice(0,6).map(resolve),waitingCount:taskCoverage ? waitingIndex.length : null,
      recent,
      attention: attentionIndex.slice(0, 6).map((task) => {
        const run = resolve(task);
        const issue=taskAttention(task)!;
        return { id: run.id, title: run.title, nodeId: run.nodeId, ...issue,
          ...(task.stale ? {detail:`状态待更新；上次记录：${issue.detail}`,actionLabel:'查看任务记录'} : {}),
          observedAt:task.observedAt ?? null,stale:task.stale===true };
      }),
      attentionCount: taskCoverage ? attentionIndex.length : null,
      runningCount: taskCoverage ? activeIndex.filter((task) => task.executionStatus === "running" || task.executionStatus === "stopping").length : null,
      queuedCount: taskCoverage ? activeIndex.filter((task) => task.executionStatus === "queued").length : null,
      reviewCount: taskCoverage ? taskGroups.reviewCount : null,
      completedToday: taskCoverage ? taskGroups.completedToday : null,
      failedToday: taskCoverage ? taskGroups.failedToday : null,
      todayUsage: mergeTotals(group.values.map((value) => value.todayUsage)),
      projects: group.values.flatMap((value) => value.projects).sort((a, b) => (b.usage ?? 0) - (a.usage ?? 0)).slice(0, 4),
      ...sourceGroups, complete, observedAt: Date.now() };
  }

  async usage(query: Query) {
    const search = new URLSearchParams(Object.entries(query).filter((value): value is [string, string] => value[1] !== undefined&&value[0]!=='fresh'));
    const group = await this.collect("/workbench/usage?" + search, () => readLocalUsage(this.config, query), query, 30000,undefined,query.fresh==='1');
    const dates = [...new Set(group.values.flatMap((value) => value.daily.map((row) => row.day)))].sort();
    return { ...mergeTotals(group.values), daily: dates.map((day) => ({ day, ...mergeTotals(group.values.flatMap((value) => value.daily.filter((row) => row.day === day))) })),
      projects: group.values.flatMap((value) => value.projects).sort((a, b) => (b.total ?? 0) - (a.total ?? 0)),
      top: aggregateTasks(group.values.flatMap(value=>value.top)).sort((a,b)=>(b.usage.total??0)-(a.usage.total??0)).slice(0,8),
      basis:'execution_finished_at' as const,unit:'execution' as const,
      pendingUsage:mergeTotals(group.values.map(value=>value.pendingUsage)),undatedUsage:mergeTotals(group.values.map(value=>value.undatedUsage)),
      sources: group.sources, complete: group.complete, observedAt: group.observedAt };
  }

  private async usageContributors(query:Query) {
    const input:Query={...query,days:query.usageDays??'30',date:query.usageDate};
    for(const name of ['cursor','limit','requestState','resultStatus','overviewGroup','status','stage','execution','attention','changed','usageDate','usageDays','fresh'])delete input[name];
    const search=new URLSearchParams(Object.entries(input).filter((value):value is [string,string]=>value[1]!==undefined));
    const group=await this.collect('/workbench/usage?'+search,()=>readLocalUsage(this.config,input),input,30000,undefined,query.fresh==='1');
    return {runIds:new Set(group.values.flatMap(value=>value.runIds)),sources:group.sources,complete:group.complete};
  }

  async fleet(fresh=false) {
    if(fresh)await this.metadata(true);
    const status = this.runtime?.status();
    const nodes: NodeView[] = this.runtime?.nodes() ?? [{ id: this.localId, nickname: "本机", capabilities: capabilities({worker:true}), priority: 0,
      online: true, roots: [], platform: process.platform, tools: [], providers: [],
      egress: { enabled: false, healthy: false }, health: await sampleHealth(0, [this.config.stateDir]), updatedAt: Date.now(), latencyMs: 0 }];
    const short = (node: NodeView) => node.id === "desktop" ? "PC" : node.capabilities.coordinator ? "HUB" : node.nickname.slice(0, 3);
    const ingress = this.config.console?.mcpIngress;
    return { nodes: nodes.map((node) => {
      const saved = this.cache.get(node.id + ":/workbench/metadata")?.data as ReturnType<typeof readLocalMetadata> | undefined;
      const settings = saved?.settings, health = node.health, egress = node.egress, GiB = 1024 ** 3;
      return { id: node.id, short: short(node), name: settings?.nickname ?? node.nickname,
        os: node.platform === "win32" ? "windows" : node.platform, role: capabilityLabels(node.capabilities).join(" · "), capabilities: node.capabilities, components: node.components ?? [], discovery: node.discovery ?? null, online: node.online,
        cpu: health.cpu ?? null, memoryUsed: (health.memoryTotal - health.memoryFree) / GiB, memoryTotal: health.memoryTotal / GiB,
        disks: (health.disks ?? []).map((disk) => ({ mount: disk.mount, used: (disk.total - disk.free) / GiB, total: disk.total / GiB })),
        gpus: health.gpus.map((gpu) => ({ name: gpu.name, util: gpu.utilization, used: gpu.memoryUsedMiB / 1024, total: gpu.memoryTotalMiB / 1024, temp: gpu.temperature ?? null })),
        gpuSampled: health.gpuSampled ?? null,
        latency: node.latencyMs ?? null, version: node.version ?? null, priority: settings?.priority ?? node.priority, revision: settings?.revision ?? null,
        settingsState:{savedRevision:settings?.savedRevision??settings?.revision??null,appliedRevision:settings?.appliedRevision??null,pending:settings?.pending??null,error:settings?.error??null},
        egress: { enabled: egress.enabled, healthy: egress.healthy, ip: null, region: null, latency: egress.latencyMs ?? null,
          config: settings?.egress.config ?? null, port: settings?.egress.port ?? null, probe: settings?.egress.probe ?? null,
          recovery: settings?.egress.recovery ?? null, inherit: settings?.egress.inherit ?? false }, lastSeen: node.lastSeen ?? node.updatedAt };
    }), gatewayId: typeof status?.gatewayId === "string" ? status.gatewayId : null,
      gatewayReason: typeof status?.gatewayReason === "string" ? status.gatewayReason : null,
      consoleNodeId: this.localId, ingressNodeId: ingress?.nodeId ?? null, mcpUrl: ingress?.url ?? null,
      ingressLabel: ingress?.label ?? null,
      localMcpUrl: new URL("/mcp", this.config.publicBaseUrl).href,
      observedAt: Date.now(), sources: nodes.map((node) => ({ nodeId: node.id, name: node.nickname, online: node.online,
        state: node.online ? "ready" as const : "offline" as const, stale: !node.online,
        observedAt: node.online ? node.lastSuccessAt ?? node.lastSeen ?? node.updatedAt : node.lastSeen ?? node.updatedAt,
        error: node.online ? null : node.lastError ?? "节点离线" })), complete: true };
  }
}


export function mergeSources(primary:SourceState[],secondary:SourceState[]):SourceState[] {
  const result=new Map(primary.map(source=>[source.nodeId,source]));
  const rank:Record<SourceReadState,number>={ready:0,refreshing:1,loading:2,error:3,offline:4};
  for(const source of secondary){
    const previous=result.get(source.nodeId);
    if(!previous){result.set(source.nodeId,source);continue;}
    const state=rank[previous.state]>=rank[source.state]?previous.state:source.state;
    result.set(source.nodeId,{...previous,online:previous.online&&source.online,state,
      observedAt:previous.observedAt===null||source.observedAt===null?null:Math.min(previous.observedAt,source.observedAt),
      stale:previous.stale||source.stale,error:previous.error??source.error});
  }
  return [...result.values()];
}

export function overviewSourceStates(input: {tasks:SourceState[];titles:SourceState[];details:SourceState[];usage:SourceState[]}) {
  return {
    taskSources:mergeSources(mergeSources(input.tasks,input.titles),input.details),
    usageSources:input.usage,
    // Retain the legacy combined observation for existing clients.
    sources:mergeSources(mergeSources(mergeSources(input.usage,input.tasks),input.details),input.titles),
  };
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}
