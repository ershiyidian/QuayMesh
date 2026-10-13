import type { ServerConfig } from "../config.js";
import { withTaskLifecycle,activeExecution,type TaskLifecycle } from '../console-task-state.js';
import type { LocalActions } from './actions.js';
import type { FederationRuntime } from "../federation/runtime.js";
import type { ConsoleReply, NodeView } from "../federation/types.js";
import { mapConcurrent } from "../concurrency.js";
import { parseWorkspaceHandle } from "../federation/routing.js";
import { sampleHealth } from "../federation/health.js";
import { capabilities, capabilityLabels } from "../federation/capabilities.js";
import { readLocalMetadata, readLocalOverview, readLocalRunSummaries, readLocalSessionTitles, readLocalTaskIndex, readLocalUsage } from "./local-queries.js";
import { decodeBoundary, pageCursor } from "./run-query.js";
import { dayAt, mergeTotals, type Query } from "./query.js";
import { aggregateTaskIndex, aggregateTasks, applyRunTitles, applyTaskTitles, compareTaskIndex, fallbackTask, filterTaskIndex, resolveSessionTitles, taskKey, taskStage, type TaskIndex } from "./task-aggregation.js";
import { WorkbenchError, type Run, type SourceReadState, type SourceState } from "./types.js";

interface CachedResource { data: unknown; loadedAt: number; error: string | null; wait: boolean; retryAt: number; failures: number }
interface NodeResource<T> { source: SourceState; data: T | null }
type NodeIdentity = { id: string; nickname: string; online: boolean };

export class WorkbenchFeed {
  private readonly cache = new Map<string, CachedResource>();
  private readonly pending = new Map<string, Promise<NodeResource<unknown>>>();
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
    for (const cached of this.cache.values()) {
      cached.loadedAt = 0;
      cached.retryAt = 0;
      cached.wait = true;
    }
  }

  async call<T>(nodeId: string, path: string, body?: unknown): Promise<T> {
    if (!this.runtime) throw new WorkbenchError("当前未启用节点转发", 503, "federation_unavailable");
    // The read transport supports a bounded retry window. Five seconds was
    // shorter than healthy Desktop reads after Modern Standby (6–10 seconds).
    const reply = await this.runtime.request<ConsoleReply>(nodeId, "console", { method: body === undefined ? "GET" : "POST", path, body }, body === undefined ? 20_000 : undefined);
    if (reply.status >= 400) {
      const error = reply.body as { message?: string; code?: string } | null;
      throw new WorkbenchError(error?.message || "节点操作失败", reply.status, error?.code || "node_operation_failed");
    }
    return reply.body as T;
  }

  private async load<T>(node: NodeIdentity, path: string, local: () => T, ttl: number): Promise<NodeResource<T>> {
    const key = node.id + ":" + path;
    const cached = this.cache.get(key);
    // Console commonly polls every eight seconds. A one-second per-node TTL
    // otherwise makes every page paint report all sources as "refreshing".
    const effectiveTtl = Math.max(ttl, 12_000);
    const previous = (state: SourceReadState, error: string | null): NodeResource<T> => ({ data: cached?.data as T ?? null,
      source: { nodeId: node.id, name: node.nickname, online: node.online, state, observedAt: cached?.loadedAt || null, stale: state === "refreshing" || state === "offline" || state === "error", error } });
    if (!node.online) return previous("offline", "节点离线");
    if (cached?.error && Date.now() < cached.retryAt) return previous("error", cached.error);
    if (cached && !cached.error && Date.now() - cached.loadedAt < effectiveTtl) return previous("ready", null);
    const existing = this.pending.get(key) as Promise<NodeResource<T>> | undefined;
    if (existing) {
      // Do not hold a page refresh on a slow remote request when usable
      // previously observed data exists. Freshness remains explicit.
      return cached?.data != null ? previous("refreshing", cached.error) : existing;
    }
    {
      const job: Promise<NodeResource<T>> = Promise.resolve().then(async () => {
        try {
          const data = node.id === this.localId ? local() : await this.call<T>(node.id, path);
          const loadedAt = Date.now();
          this.cache.delete(key); this.cache.set(key, { data, loadedAt, error: null, wait: false, retryAt: 0, failures: 0 });
          while (this.cache.size > 160) this.cache.delete(this.cache.keys().next().value!);
          const source: SourceState = { nodeId: node.id, name: node.nickname, online: true, state: "ready", observedAt: loadedAt, stale: false, error: null };
          return { data, source };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const failures = Math.min((cached?.failures ?? 0) + 1, 6);
          // A disconnected or sleeping node should not be hammered on every
          // Console poll. Per-node/path backoff is bounded and resets on success.
          const retryDelay = Math.min(60_000, 3000 * 2 ** (failures - 1));
          this.cache.set(key,{data:cached?.data ?? null,loadedAt:cached?.loadedAt ?? 0,
            error:message,wait:false,retryAt:Date.now()+retryDelay,failures});
          return previous("error", message);
        }
      }).finally(() => this.pending.delete(key));
      this.pending.set(key, job);
      if (cached) cached.wait = false;
      if (cached?.data != null) {
        // Background refresh owns its error handling; response uses an
        // acknowledged stale snapshot rather than blocking for an RPC.
        void job;
        return previous("refreshing", cached.error);
      }
      return job;
    }
  }

  private async collect<T>(path: string, local: () => T, query: Query = {}, ttl = 5000) {
    const projectNode = query.project ? parseWorkspaceHandle(query.project)?.node : undefined;
    const nodes = this.nodes().filter((node) => (!query.node || node.id === query.node) && (!projectNode || node.id === projectNode));
    // A single offline node must not delay a fifth, healthy machine behind
    // another complete 20-second read window on a cold Console load.
    const results = await mapConcurrent(nodes, 8, (node) => this.load(node, path, local, ttl));
    return { values: results.flatMap((result) => result.data === null ? [] : [result.data]),
      sources: results.map((result) => result.source),
      // "complete" measures coverage of all node snapshots. A source being
      // refreshed is still represented by its last complete, timestamped
      // snapshot; sources[].state/stale describe freshness independently.
      complete: results.every((result) => result.data !== null && result.source.online
        && (result.source.state === "ready" || result.source.state === "refreshing")
        && !result.source.error), observedAt: Date.now() };
  }

  async metadata() {
    const group = await this.collect("/workbench/metadata", () => readLocalMetadata(this.config), {}, 1000);
    return { projects: group.values.flatMap((value) => value.projects), roots: group.values.flatMap((value) => value.roots),
      sources: group.sources, complete: group.complete, observedAt: group.observedAt };
  }

  async runs(query: Query) {
    const boundary = decodeBoundary(query.cursor), at = boundary?.at ?? Date.now();
    const limit = Math.min(100, Math.max(1, Number(query.limit ?? 25)));
    const index = await this.collect("/workbench/task-index", () => readLocalTaskIndex(this.config), {}, 1000);
    const titles = await this.sessionTitles();
    const scoped = filterTaskIndex(applyTaskTitles(aggregateTaskIndex(index.values.flatMap((value) => value.items)), titles.map)
      .map(task=>withTaskLifecycle(task,titles.tasks.get(task.taskId ?? ''))), query, at);
    const counts: Record<string, number> = {};
    for (const task of scoped) {
      const state = taskStage(task.executionStatus, task.acceptanceStatus);
      counts[state] = (counts[state] ?? 0) + 1;
    }
    counts.all = scoped.length;
    const selected = scoped.filter((task) => !query.status || taskStage(task.executionStatus, task.acceptanceStatus) === query.status)
      .sort((a, b) => compareTaskIndex(a, b, query, at));
    const offset = boundary?.offset ?? 0;
    const pageIndex = selected.slice(offset, offset + limit);
    const summaries = await this.runSummaries(pageIndex.flatMap((task) => task.phaseRefs));
    const detailed = new Map(applyRunTitles(aggregateTasks(summaries.values), titles.map).map((run) => [taskKey(run), run]));
    const items = pageIndex.map(task=>this.resolvedRun(task,detailed.get(task.key)));
    return { items,
      total: selected.length, counts, offset, limit,
      nextCursor: items.length && offset + items.length < selected.length ? pageCursor(items.at(-1)!, query, at, offset + items.length, "next") : null,
      previousCursor: items.length && offset > 0 ? pageCursor(items[0], query, at, Math.max(0, offset - limit), "previous") : null,
      sources: mergeSources(mergeSources(index.sources, summaries.sources), titles.sources),
      complete: index.complete && summaries.complete && titles.complete, observedAt: Date.now() };
  }

  private async sessionTitles() {
    const group = await this.collect("/workbench/session-titles", () => readLocalSessionTitles(this.config), {}, 1000);
    const tasks = new Map<string,TaskLifecycle>();
    const authority = new Set<string>();
    for (const source of group.values) for (const task of source.tasks ?? []) {
      const previous=tasks.get(task.id);
      if (!previous || source.authoritative || !authority.has(task.id) && task.revision > previous.revision) tasks.set(task.id,task);
      if (source.authoritative) authority.add(task.id);
    }
    return { map: resolveSessionTitles(group.values.flatMap((value) => value.items)),
      tasks,observedAt:group.observedAt,
      sources: group.sources, complete: group.complete };
  }

  private resolvedRun(task:TaskIndex,detail?:Run):Run {
    const run=detail ?? fallbackTask(task);
    return {...run,title:task.title,executionStatus:task.executionStatus,acceptanceStatus:task.acceptanceStatus,
      finishedAt:task.finishedAt,lastActivityAt:task.lastActivityAt,
      actions:{...run.actions,complete:task.executionStatus==='waiting' && run.actions.complete,
        review:task.executionStatus==='completed' && task.acceptanceStatus==='pending'}};
  }

  async projectConversations(data:ReturnType<LocalActions['sessions']>) {
    if (!Array.isArray(data.conversations)) throw new WorkbenchError('该节点尚未提供对话会话数据，请更新节点服务',503,'node_capability_unavailable');
    const lifecycle=await this.sessionTitles();
    return {...data,complete:lifecycle.complete,sources:lifecycle.sources,observedAt:lifecycle.observedAt,
      conversations:data.conversations.map(conversation=>{
      const tasks=conversation.tasks.map(task=>{
        const state=withTaskLifecycle(task,lifecycle.tasks.get(task.taskId ?? ''));
        return {...state,status:taskStage(state.executionStatus,state.acceptanceStatus)};
      });
      return {...conversation,tasks,activeCount:tasks.filter(task=>activeExecution(task.executionStatus)).length};
    })};
  }

  private async runSummaries(references: string[]) {
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
        return this.load(node, path, () => readLocalRunSummaries(this.config, batch), 5000);
      });
      return { data: { items: resources.flatMap((resource) => resource.data?.items ?? []) },
        source: resources.find((resource) => resource.source.error)?.source ?? resources.at(-1)?.source
          ?? { nodeId: node.id, name: node.nickname, online: node.online, state: "ready" as const, observedAt: Date.now(), stale: false, error: null },
        complete: resources.every((resource) => resource.data !== null) };
    });
    return {
      values: results.flatMap((result) => result.data.items),
      sources: results.map((result) => result.source),
      complete: results.every((result) => result.complete),
    };
  }

  async sessionRuns(sessionId: string): Promise<{ runs: Run[]; complete: boolean; sources: SourceState[] }> {
    const index = await this.collect("/workbench/task-index", () => readLocalTaskIndex(this.config), {}, 1000);
    const references = index.values.flatMap((value) => value.items)
      .filter((phase) => phase.sessionId === sessionId)
      .map((phase) => phase.id);
    const summaries = await this.runSummaries(references);
    const titles = await this.sessionTitles();
    return { runs: applyRunTitles(summaries.values.filter((run) => run.sessionId === sessionId), titles.map)
      .map(run=>withTaskLifecycle(run,titles.tasks.get(run.taskId ?? ''))),
      complete: index.complete && summaries.complete && titles.complete,
      sources: mergeSources(mergeSources(index.sources, summaries.sources), titles.sources) };
  }

  async taskRuns(taskId: string): Promise<{ runs: Run[]; complete: boolean; sources: SourceState[] }> {
    const index = await this.collect("/workbench/task-index", () => readLocalTaskIndex(this.config), {}, 1000);
    const references = index.values.flatMap((value) => value.items)
      .filter((phase) => phase.taskId === taskId)
      .map((phase) => phase.id);
    const summaries = await this.runSummaries(references);
    const titles = await this.sessionTitles();
    return { runs: applyRunTitles(summaries.values.filter((run) => run.taskId === taskId), titles.map)
      .map(run=>withTaskLifecycle(run,titles.tasks.get(run.taskId ?? ''))),
      complete: index.complete && summaries.complete && titles.complete,
      sources: mergeSources(mergeSources(index.sources, summaries.sources), titles.sources) };
  }

  async overview(zone: string) {
    const at = Date.now();
    const [group,index,titles] = await Promise.all([
      this.collect("/workbench/overview?tz=" + encodeURIComponent(zone), () => readLocalOverview(this.config, zone)),
      this.collect("/workbench/task-index", () => readLocalTaskIndex(this.config), {}, 1000),
      this.sessionTitles(),
    ]);
    const tasks = applyTaskTitles(aggregateTaskIndex(index.values.flatMap((value) => value.items)), titles.map)
      .map(task=>withTaskLifecycle(task,titles.tasks.get(task.taskId ?? '')));
    const activeIndex = tasks.filter(task=>activeExecution(task.executionStatus)).sort((a,b)=>b.lastActivityAt-a.lastActivityAt);
    const visibleActive=[...activeIndex.filter(task=>task.executionStatus!=='queued').slice(0,12),
      ...activeIndex.filter(task=>task.executionStatus==='queued').slice(0,3)];
    const waitingIndex = tasks.filter(task=>task.executionStatus==='waiting').sort((a,b)=>b.lastActivityAt-a.lastActivityAt);
    const recentIndex = tasks.filter((task) => !["running", "queued", "stopping", "waiting"].includes(task.executionStatus))
      .sort((a, b) => (b.finishedAt ?? b.lastActivityAt) - (a.finishedAt ?? a.lastActivityAt)).slice(0, 6);
    const attentionIndex = tasks.filter((task) => task.executionStatus === "unknown"
      || task.executionStatus === "interrupted_recoverable" && task.actionableInterruption
      || task.executionStatus === "failed" && task.lastActivityAt >= at - 86_400_000)
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    const visibleIndex = [...visibleActive, ...waitingIndex.slice(0,6), ...recentIndex, ...attentionIndex.slice(0, 6)];
    const summaries = await this.runSummaries([...new Set(visibleIndex.flatMap((task) => task.phaseRefs))]);
    const detailed = new Map(applyRunTitles(aggregateTasks(summaries.values), titles.map).map((run) => [taskKey(run), run]));
    const resolve = (task: TaskIndex) => this.resolvedRun(task,detailed.get(task.key));
    const active = visibleActive.map(resolve);
    const recent = recentIndex.map(resolve);
    const today = dayAt(at, zone);
    const complete = group.complete && index.complete && summaries.complete && titles.complete;
    return { active,activeCount:complete ? activeIndex.length : null,
      waiting:waitingIndex.slice(0,6).map(resolve),waitingCount:complete ? waitingIndex.length : null,
      recent,
      attention: attentionIndex.slice(0, 6).map((task) => {
        const run = resolve(task);
        return { id: run.id, kind: run.executionStatus, title: run.title, detail: run.reason ?? "查看保存的执行记录", nodeId: run.nodeId };
      }),
      attentionCount: complete ? attentionIndex.length : null,
      runningCount: complete ? activeIndex.filter((task) => task.executionStatus === "running" || task.executionStatus === "stopping").length : null,
      queuedCount: complete ? activeIndex.filter((task) => task.executionStatus === "queued").length : null,
      reviewCount: complete ? tasks.filter((task) => taskStage(task.executionStatus, task.acceptanceStatus) === "review").length : null,
      completedToday: complete ? tasks.filter((task) => task.executionStatus === "completed" && task.finishedAt !== null && dayAt(task.finishedAt, zone) === today).length : null,
      failedToday: complete ? tasks.filter((task) => task.executionStatus === "failed" && dayAt(task.finishedAt ?? task.lastActivityAt, zone) === today).length : null,
      todayUsage: mergeTotals(group.values.map((value) => value.todayUsage)),
      projects: group.values.flatMap((value) => value.projects).sort((a, b) => (b.usage ?? 0) - (a.usage ?? 0)).slice(0, 4),
      sources: mergeSources(mergeSources(mergeSources(group.sources, index.sources), summaries.sources), titles.sources), complete, observedAt: Date.now() };
  }

  async usage(query: Query) {
    const search = new URLSearchParams(Object.entries(query).filter((value): value is [string, string] => value[1] !== undefined));
    const group = await this.collect("/workbench/usage?" + search, () => readLocalUsage(this.config, query), query, 30000);
    const dates = [...new Set(group.values.flatMap((value) => value.daily.map((row) => row.day)))].sort();
    return { ...mergeTotals(group.values), daily: dates.map((day) => ({ day, ...mergeTotals(group.values.flatMap((value) => value.daily.filter((row) => row.day === day))) })),
      projects: group.values.flatMap((value) => value.projects).sort((a, b) => (b.total ?? 0) - (a.total ?? 0)),
      top: group.values.flatMap((value) => value.top).sort((a, b) => (b.usage.total ?? 0) - (a.usage.total ?? 0)).slice(0, 8),
      sources: group.sources, complete: group.complete, observedAt: group.observedAt };
  }

  async fleet() {
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


function mergeSources(primary: SourceState[], secondary: SourceState[]): SourceState[] {
  const secondaryByNode = new Map(secondary.map((source) => [source.nodeId, source]));
  return primary.map((source) => {
    const detail = secondaryByNode.get(source.nodeId);
    if (!detail) return source;
    if (detail.error || detail.state === "offline") return detail;
    return { ...source, observedAt: Math.max(source.observedAt ?? 0, detail.observedAt ?? 0),
      stale: source.stale || detail.stale, state: source.stale ? source.state : detail.state, error: source.error ?? detail.error };
  });
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}
