import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Duplex, Readable } from "node:stream";
import { PeerTransport, PeerLink, NodeUnavailableError, PeerApplicationError, bridge } from "./transport.js";
import { catalog, chooseGateway, parseWorkspaceHandle, routedResult, selectRoot } from "./routing.js";
import { EgressListener, connectProxy, dialTcp, probeProxy } from "./egress.js";
import { capabilities } from "./capabilities.js";
import { sampleHealth } from "./health.js";
import { mapConcurrent } from "../concurrency.js";
import type { FederationConfig, NodeManifest, NodeView, JsonRecord, ConsoleReply, ToolHandler } from "./types.js";
import type { SessionFeed } from "./session-feed.js";
import { safeForwardedContext } from "../request-meta.js";
import type { TrustedInvocationEnvelope } from "./session-types.js";
import { ExecutionCoordinator, type RuntimeWorkLease } from "../execution-coordinator.js";
import { observesAcceptedWork } from "../tool-admission.js";
import { TransferStore, type TransferRequest, type TransferView } from "./transfer-store.js";
export type { TransferView } from "./transfer-store.js";


export { isTransientPeerFailure, isIdempotentPeerRequest, dispatchPeerRequest, READ_TOTAL_BUDGET_MS, READ_ATTEMPT_TIMEOUT_MS, MAX_READ_RETRIES } from "./read-retry.js";
import { toolDeadline, remainingToolTime, TOOL_DEADLINE_META } from "../tool-request-budget.js";
import { jsonReply } from "../bounded-reply.js";
import { currentInvocation } from "../session/invocations.js";
import { dispatchPeerRequest, isTransientPeerFailure } from "./read-retry.js";
import { dispatchConsoleRequest } from "./console-request.js";

export interface ArtifactWriteLifecycle {
  temporaryPath: string;
  claimId?: string;
  finish(status: "completed" | "failed" | "cancelled", error?: string): Promise<void>;
  release(): void;
}
export interface FederationHooks {
  stateDir: string;
  httpPort: number;
  ingressPort: number;
  publicBaseUrl: string;
  execution?: ExecutionCoordinator;
  providers(): unknown[];
  prepareOpen(input: JsonRecord): Promise<JsonRecord>;
  checkWorkspace(id: string): Promise<void>;
  console(method: string, path: string, body?: unknown): Promise<ConsoleReply>;
  settings(): unknown;
  updateSettings(input: JsonRecord): Promise<void>;
  mihomoImport(text: string, reload: boolean): Promise<unknown>;
  mihomoRead(): Promise<string>;
  resolveProxy(): Promise<string>;
  artifactStat(input: JsonRecord): Promise<{ size: number }>;
  artifactRead(input: JsonRecord): Promise<Readable>;
  artifactWrite(input: JsonRecord, source: Readable, signal: AbortSignal, progress: (bytes: number) => void): Promise<void>;
  artifactPrepare?(input: JsonRecord, context: TrustedInvocationEnvelope | undefined): Promise<ArtifactWriteLifecycle>;
  artifactRecover?(input: JsonRecord): Promise<void>;
}

export class FederationRuntime extends EventEmitter {
  readonly transport: PeerTransport;
  readonly handlers = new Map<string, ToolHandler>();
  readonly execution: ExecutionCoordinator;
  private readonly ownsExecution: boolean;
  private readonly transferStore: TransferStore;
  private readonly pendingTransfers = new Map<string, Promise<void>>();
  private readonly activeTransfers = new Map<string, TransferView>();
  private readonly aborts = new Map<string, AbortController>();
  private readonly known = new Map<string, NodeManifest>();
  private readonly events: { time: string; kind: string; nodeId: string; message: string }[] = [];
  private manifest: NodeManifest;
  private activeCalls = 0;
  private heartbeat?: NodeJS.Timeout;
  private probeTimer?: NodeJS.Timeout;
  private sampling = false;
  private probing = false;
  private proxyUrl: string;
  private selected?: string;
  private egress?: EgressListener;
  private ingress?: EgressListener;
  private readonly cacheFile: string;
  private readonly modelTools = new Set<string>();
  private sessionFeed?: SessionFeed;
  private stopped = false;
  ready: Promise<void> = Promise.resolve();
  startupError?: string;

  constructor(readonly config: FederationConfig, token: string, readonly hooks: FederationHooks) {
    super();
    mkdirSync(hooks.stateDir, { recursive: true, mode: 0o700 });
    this.execution = hooks.execution ?? new ExecutionCoordinator(hooks.stateDir);
    this.ownsExecution = !hooks.execution;
    this.transferStore = new TransferStore(hooks.stateDir, config.nodeId);
    this.cacheFile = join(hooks.stateDir, "federation-nodes.json");
    if (existsSync(this.cacheFile)) {
      try {
        for (const node of JSON.parse(readFileSync(this.cacheFile, "utf8")) as NodeManifest[]) this.known.set(node.id, node);
      } catch (error) {
        this.event("cache", this.localId, `节点缓存读取失败，已忽略：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.proxyUrl = config.egress.proxyUrl;
    this.manifest = this.makeManifest();
    recordActiveRelease(hooks.stateDir, config.nodeId, this.manifest.version);
    this.transport = new PeerTransport(config, token, (method, params, peer) => this.receive(method, params, peer),
      (service, metadata, stream) => this.receiveStream(service, metadata, stream));
    this.transport.on("online", (link: PeerLink) => { void this.peerOnline(link).catch((error) => this.event("connection", link.peerId, String(error))); });
    this.transport.on("offline", (id: string) => { this.event("offline", id, "节点连接断开"); this.emit("change"); });
    this.transport.on("fault", (error) => this.event("error", config.nodeId, String(error)));

  }

  private refreshMembership(): void {
    const file = this.config.membershipFile;
    if (!file || !existsSync(file)) return;
    const directory = JSON.parse(readFileSync(file,"utf8")) as {
      coordinatorId:string;
      nodes:Array<{id:string;nickname:string;endpoint:string;capabilities:NodeManifest["capabilities"]}>;
    };
    if (directory.coordinatorId !== this.config.coordinatorId) throw new Error("节点目录的 Coordinator 身份不一致");
    const peers = directory.nodes.filter(node => node.id !== this.localId)
      .map(node => ({id:node.id,nickname:node.nickname,url:node.endpoint})).sort((a,b) => a.id.localeCompare(b.id));
    if (JSON.stringify(peers) !== JSON.stringify(this.config.peers)) this.transport.updatePeers(peers);
    for (const member of directory.nodes) {
      if (member.id === this.localId || this.known.has(member.id)) continue;
      this.known.set(member.id, {
        id:member.id,nickname:member.nickname,capabilities:member.capabilities,priority:0,
        roots:[],platform:"unknown",tools:[],providers:[],updatedAt:0,egress:{enabled:false,healthy:false},
        health:{cpuCount:0,load:[],memoryFree:0,memoryTotal:0,uptime:0,gpus:[],activeCalls:0},
      });
    }
  }
  private componentStatus(): Pick<NodeManifest,"components"|"discovery"> {
    const file = this.config.statusFile;
    if (!file || !existsSync(file)) return {};
    const status = JSON.parse(readFileSync(file,"utf8")) as Pick<NodeManifest,"components"|"discovery">;
    return { components:status.components, discovery:status.discovery };
  }

  private makeManifest(): NodeManifest {
    return { id: this.config.nodeId, nickname: this.config.nickname, capabilities: this.config.capabilities, priority: this.config.priority,
      ...this.componentStatus(), roots: this.config.roots, platform: process.platform, version: runtimeVersion(), tools: [...this.modelTools].sort(), providers: this.hooks.providers(),
      egress: this.manifest?.egress ?? { enabled: this.config.capabilities.egress, healthy: this.config.capabilities.egress ? false : !this.config.egress.enabled },
      health: this.manifest?.health ?? { cpuCount: 0, load: [], memoryFree: 0, memoryTotal: 0, uptime: 0, gpus: [], activeCalls: 0 }, updatedAt: Date.now() };
  }
  start(): Promise<void> {
    this.ready = this.startServices().catch(async (error) => {
      this.startupError = error instanceof Error ? error.message : String(error);
      await this.close(); throw error;
    });
    return this.ready;
  }
  private async startServices(): Promise<void> {
    await this.transport.start();
    for (const transfer of this.transferStore.active()) {
      try {
        await this.hooks.artifactRecover?.(this.transferStore.recoveryRequest(transfer));
        this.transferStore.finish(transfer.id, "interrupted", transfer.bytes, "传输所属进程已经结束，请检查目标文件与操作记录。");
      } catch(error) {
        const message=error instanceof Error?error.message:String(error);
        this.transferStore.finish(transfer.id,"interrupted",transfer.bytes,`恢复检查失败：${message}`,false);
        this.event("transfer",this.localId,message);
      }
    }
    this.refreshMembership();
    await this.configureEgress();
    await this.sample();
    this.heartbeat = setInterval(() => { void this.sample().catch(error => this.event("health",this.localId,String(error))); }, Math.max(1000, this.config.heartbeatMs)); this.heartbeat.unref();
  }
  private async configureEgress(): Promise<void> {
    clearInterval(this.probeTimer);
    const port = this.config.egress.listenPort;
    if (this.egress && (!this.config.egress.enabled || this.egress.address !== port)) { await this.egress.close(); this.egress = undefined; }
    if (this.config.egress.enabled) {
      if (!this.egress) { this.egress = new EgressListener(port, () => this.openGatewayStream("egress")); await this.egress.start(); }
      if (this.config.capabilities.egress) {
        void this.probe();
        this.probeTimer = setInterval(() => void this.probe(), this.config.egress.probeIntervalMs); this.probeTimer.unref();
      } else this.manifest.egress = { enabled:false, healthy:false };
    } else this.manifest.egress = { enabled: false, healthy: true };
  }
  get localId(): string { return this.config.nodeId; }
  addModelTool(name: string): void { this.modelTools.add(name); }
  setSessionFeed(feed: SessionFeed): void { this.sessionFeed = feed; }
  sessionRouteFor(input: JsonRecord): string | undefined {
    return this.sessionFeed?.routeNodeFor(input);
  }
  routeNode(name: string, input: JsonRecord): string {
    if (name === 'read_diagnostics') return typeof input.node_id === 'string' ? input.node_id : this.localId;
    if (name === "open_workspace" && typeof input.root_id === "string") {
      return selectRoot(this.nodes(), input.root_id).node.id;
    }
    if (name === "attach_workspace" && typeof input.root_id === "string") {
      return selectRoot(this.nodes(), input.root_id).node.id;
    }
    if (typeof input.workspace_id === "string") {
      const handle = parseWorkspaceHandle(input.workspace_id);
      if (handle) return handle.node;
    }
    return this.sessionRouteFor(input) ?? this.localId;
  }
  trustedInvocation(name: string, input: JsonRecord, extra: JsonRecord): TrustedInvocationEnvelope | undefined {
    return this.sessionFeed?.trustedInvocation(name, input, extra);
  }
  nodes(): NodeView[] {
    const local = { ...this.manifest, health: { ...this.manifest.health, activeCalls: this.activeCalls }, online: !this.stopped && !this.startupError, connectedVia: "local", latencyMs: 0, lastSeen: Date.now() };
    const nodes: NodeView[] = [local];
    for (const peer of this.config.peers) {
      const known = this.known.get(peer.id);
      const link = this.transport.links.get(peer.id);
      const probe = this.peerHealth.get(peer.id);
      const linkUp = Boolean(link?.connected && known);
      const failures = probe?.consecutiveFailures ?? 0;
      const lastOk = link?.lastSeen ?? probe?.lastSuccessAt;
      const heartbeatStale = typeof lastOk === "number" && lastOk > 0 && Date.now() - lastOk > 45_000;
      nodes.push({ ...(known ?? { ...this.makeManifest(), id: peer.id, nickname: peer.nickname ?? peer.id, capabilities: capabilities(), roots: [], tools: [], providers: [], priority: 0,
        health: { cpuCount: 0, load: [], memoryFree: 0, memoryTotal: 0, uptime: 0, gpus: [], activeCalls: 0 }, egress: { enabled: false, healthy: false }, updatedAt: 0 }),
        online: linkUp && !heartbeatStale, connectedVia: link ? peer.id : undefined, latencyMs: link?.latencyMs, onlineSince: link?.connectedAt, lastSeen: link?.lastSeen ?? known?.updatedAt,
        lastSuccessAt: probe?.lastSuccessAt, lastError: probe?.lastError, consecutiveFailures: failures });
    }
    return nodes;
  }
  gateway(): NodeView | undefined {
    const next = chooseGateway(this.nodes(), Date.now(), this.config.egress.recoveryDelayMs, this.selected);
    if (next?.id !== this.selected) { this.selected = next?.id; this.event("gateway", next?.id ?? "", next ? `发信端切换至 ${next.nickname}` : "暂无可用发信端"); }
    return next;
  }
  status(): JsonRecord {
    const gateway = this.gateway();
    return { enabled: true, localNodeId: this.localId, capabilities: this.config.capabilities, gatewayId: gateway?.id ?? null,
      publicMcpUrl: `${this.hooks.publicBaseUrl.replace(/\/$/, "")}/mcp`, ingressPort: this.hooks.ingressPort,
      proxyUrl: this.config.egress.enabled ? `http://127.0.0.1:${this.config.egress.listenPort}` : null,
      nodes: this.nodes(), events: this.events.slice(-40).reverse(), transfers: this.transferStore.list(), startupError: this.startupError };
  }
  private event(kind: string, nodeId: string, message: string): void {
    this.events.push({ time: new Date().toISOString(), kind, nodeId, message });
    if (this.events.length > 100) this.events.shift(); this.emit("change");
  }
  private async peerOnline(link: PeerLink): Promise<void> {
    // 工具注册完成后发布节点清单。
    const maxRetries = 3;
    const baseDelayMs = 50;
    let attempt = 0;
    let remote: { manifest: NodeManifest };
    for (;;) {
      try {
        remote = await link.call<{ manifest: NodeManifest }>("hello", { manifest: this.makeManifest() });
        break;
      } catch (error) {
        if (attempt < maxRetries && isTransientPeerFailure(error) && link.connected) {
          attempt++;
          await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** (attempt - 1)));
          continue;
        }
        throw error;
      }
    }
    this.remember(remote.manifest, link.peerId);
    this.notePeerSuccess(link.peerId);
    this.event("online", link.peerId, `${remote.manifest.nickname} 已连接`); this.emit("change");
  }
  private remember(manifest: NodeManifest, peerId: string): void {
    if (manifest.id !== peerId) throw new Error("节点身份与目录清单不匹配");
    this.known.set(peerId, manifest);
    this.persist(this.cacheFile, [...this.known.values()]);
  }
  private publishManifest(): void {
    this.manifest = this.makeManifest(); this.manifest.egress.enabled = this.config.capabilities.egress;
    for (const link of this.transport.links.values()) link.notify("manifest", this.manifest);
    this.emit("change");
  }
  private async sample(): Promise<void> {
    if (this.sampling || this.stopped) return; this.sampling = true;
    try {
      this.refreshMembership();
      this.manifest.health = await sampleHealth(this.activeCalls, [this.hooks.stateDir, ...this.config.roots.map((root) => root.path)]);
      this.publishManifest();
    }
    finally { this.sampling = false; }
  }
  private async probe(): Promise<void> {
    if (!this.config.capabilities.egress || this.probing || this.stopped) return; this.probing = true;
    try {
      this.proxyUrl = await this.hooks.resolveProxy();
      const started = performance.now();
      await probeProxy(this.proxyUrl, this.config.egress.probeUrl);
      this.manifest.egress = { enabled: true, healthy: true, healthySince: this.manifest.egress.healthySince ?? Date.now(),
        checkedAt: Date.now(), latencyMs: Math.round(performance.now() - started) };
    } catch (error) {
      this.manifest.egress = { enabled: true, healthy: false, checkedAt: Date.now(), error: error instanceof Error ? error.message : String(error) };
    } finally { this.probing = false; this.publishManifest(); }
  }
  private async receive(method: string, params: any, peer: string): Promise<unknown> {
    switch (method) {
      case "hello": this.remember(params.manifest, peer); return { manifest: this.makeManifest() };
      case "manifest": this.remember(params, peer); this.notePeerSuccess(peer); this.emit("change"); return null;
      case "tool": return this.invokeLocal(params.name, params.input, params.extra ?? {});
      case "session.feed": {
        if (!this.sessionFeed) throw new Error("SESSION_FEED_UNAVAILABLE");
        return this.sessionFeed.handleRequest(params, peer);
      }
      case "session.feed.update": {
        if (!this.sessionFeed) throw new Error("SESSION_FEED_UNAVAILABLE");
        return this.sessionFeed.receiveUpdate(params, peer);
      }
      case "console": return this.execution.withWork({kind:"console",allowWhilePaused:["GET","HEAD"].includes(String(params.method??"GET").toUpperCase())},
        () => this.hooks.console(params.method, params.path, params.body));
      case "console.request": {
        const manifest = this.known.get(peer);
        if (!manifest?.capabilities?.consoleRelay) throw new Error("CONSOLE_RELAY_CAPABILITY_REQUIRED");
        return this.execution.withWork({kind:"console",allowWhilePaused:["GET","HEAD"].includes(String(params.method??"GET").toUpperCase())},
          () => dispatchConsoleRequest(this.hooks.httpPort, peer, params ?? {}));
      }
      case "settings.get": return this.hooks.settings();
      case "settings.update": await this.hooks.updateSettings(params); return this.hooks.settings();
      case "mihomo.import": {
        if (!this.config.capabilities.egress) throw new Error("EGRESS_CAPABILITY_REQUIRED"); const result = await this.hooks.mihomoImport(params.text, params.reload); if (this.config.egress.enabled) void this.probe(); return result; }
      case "mihomo.read":
        if (!this.config.capabilities.egress) throw new Error("EGRESS_CAPABILITY_REQUIRED"); return this.hooks.mihomoRead();
      case "transfers.list": return this.transferStore.list();
      case "artifact.stat": return this.hooks.artifactStat(params);
      case "artifact.copy": return this.startCopy(params);
      // SQLite is the source of truth; transient progress must not mask completion.
      case "artifact.observe": return this.transferStore.get(params.id);
      case "artifact.cancel": {
        this.aborts.get(params.id)?.abort();
        // A cancellation request must not wait on a stalled stream or metadata.
        return this.transferStore.get(params.id);
      }
      default: throw new Error(`未知节点方法 ${method}`);
    }
  }
  private readonly peerHealth = new Map<string, { lastSuccessAt?: number; lastError?: string; consecutiveFailures: number }>();
  private notePeerSuccess(node: string): void {
    this.peerHealth.set(node, { lastSuccessAt: Date.now(), consecutiveFailures: 0 });
  }
  private notePeerFailure(node: string, error: unknown): void {
    const previous = this.peerHealth.get(node) ?? { consecutiveFailures: 0 };
    const message = error instanceof Error ? error.message : String(error);
    this.peerHealth.set(node, { lastSuccessAt: previous.lastSuccessAt, lastError: message.slice(0, 300), consecutiveFailures: previous.consecutiveFailures + 1 });
  }
  private linkAdapter<T>(node: string, method: string, params: unknown) {
    const link = this.transport.links.get(node);
    if (!link) return undefined;
    return { get connected() { return link.connected; }, call: (timeout: number) => link.call<T>(method, params, timeout), close: () => link.close() };
  }
  async request<T = unknown>(node: string, method: string, params: unknown, timeoutMs?: number): Promise<T> {
    if (node === this.localId) return this.receive(method, params, this.localId) as Promise<T>;
    try {
      const result = await dispatchPeerRequest<T>({
        node, method, params, timeoutMs, rpcTimeoutMs: this.config.rpcTimeoutMs,
        getLink: () => this.linkAdapter<T>(node, method, params),
        waitForLink: async (waitMs) => {
          const link = await this.transport.waitForLink(node, waitMs);
          return link ? this.linkAdapter<T>(node, method, params) : undefined;
        },
      });
      this.notePeerSuccess(node);
      return result;
    } catch (error) {
      if (error instanceof PeerApplicationError) this.notePeerSuccess(node);
      else this.notePeerFailure(node, error);
      throw error;
    }
  }
  async invokeLocal(name: string, input: JsonRecord, extra: JsonRecord = {}): Promise<unknown> {
    return this.execution.withWork({kind:"tool",allowWhilePaused:observesAcceptedWork(name,input),
      taskId:(extra.trustedInvocation as TrustedInvocationEnvelope | undefined)?.task_id},
      () => this.invokeAcceptedTool(name,input,extra));
  }

  private async invokeAcceptedTool(name: string, input: JsonRecord, extra: JsonRecord): Promise<unknown> {
    const deadlineAt=toolDeadline(name,input,extra._meta);
    remainingToolTime(deadlineAt);
    if (!this.config.capabilities.worker && (typeof input.workspace_id === "string" || name === "open_workspace" || name === "attach_workspace")) {
      throw new Error(`节点 ${this.localId} 未启用执行能力`);
    }
    const handler = this.handlers.get(name); if (!handler) throw new Error(`节点 ${this.config.nickname} 没有启用 ${name}`);
    await this.sessionFeed?.prepareLocalTool(name, input, extra.trustedInvocation as TrustedInvocationEnvelope | undefined);
    const opensWorkspace = name === "open_workspace" || name === "attach_workspace";
    const args = opensWorkspace ? await this.hooks.prepareOpen(input) : input;
    // 查询原工作区的历史记录无需重新打开已经删除的文件目录。
    const historical = name === "read_output" || name === "workspace_context" &&
      (args.action === "recovery" || args.action === "status" && args.environment !== true);
    if (typeof args.workspace_id === "string" && !historical) await this.hooks.checkWorkspace(args.workspace_id);
    this.activeCalls++;
    try {
      remainingToolTime(deadlineAt);
      const controller = new AbortController();
      const result = await handler(args, { signal: controller.signal, ...extra,
        sendNotification: async () => {}, sendRequest: async () => { throw new Error("该工具需要交互式宿主请求"); } });
      return routedResult(result, this.localId, { textReferences: opensWorkspace, jsonText: false });
    } finally { this.activeCalls--; }
  }
  async tool(name: string, input: JsonRecord, extra: JsonRecord = {}): Promise<unknown> {
    if (name === "workspace_catalog") {
      let currentNodes: NodeView[];
      try { currentNodes = this.nodes(); } catch { currentNodes = []; }
      const structured = catalog(currentNodes, String(input.query ?? ""), input.include_offline !== false);
      return jsonReply(structured);
    }
    let node = this.localId; let args = { ...input };
    if (name === 'read_diagnostics' && typeof input.node_id === 'string') {
      node = input.node_id;
    } else if (name === "open_workspace" && typeof input.root_id === "string") {
      const selected = selectRoot(this.nodes(), input.root_id); node = selected.node.id; args.root_id = selected.root.id;
    } else if (name === "attach_workspace" && typeof input.root_id === "string") {
      const selected = selectRoot(this.nodes(), input.root_id); node = selected.node.id; args.root_id = selected.root.id;
    } else if (name.startsWith("qm_")) {
      const detail = await this.sessionFeed?.fetchDetail(name, input, extra);
      if (detail !== undefined) return detail;
      if (name !== "qm_session") {
        const routedNode = this.sessionRouteFor(input);
        if (routedNode) node = routedNode;
      }
    } else if (typeof input.workspace_id === "string") {
      const handle = parseWorkspaceHandle(input.workspace_id);
      if (handle) { node = handle.node; args.workspace_id = handle.local; }
    }
    // Credentials and transport callbacks never become RPC arguments.
    const trusted = extra.trustedInvocation as TrustedInvocationEnvelope | undefined
      ?? this.trustedInvocation(name, input, extra);
    const attempt = currentInvocation();
    const trustedInvocation = trusted && attempt?.tool_name === name && attempt.owner_id === trusted.owner_id
      && String(attempt.request_id) === trusted.request_id
      ? {...trusted, invocation_id: attempt.invocation_id, operation_id: attempt.operation_id}
      : trusted;
    const identity = safeForwardedContext(extra);
    const deadlineAt=toolDeadline(name,args,extra._meta);
    const context = { _meta: { ...(identity.conversation_id ? { "openai/session": identity.conversation_id } : {}),
        [TOOL_DEADLINE_META]:deadlineAt },
      requestId: identity.request_id,
      sessionId: identity.transport_session_id,
      ...(trustedInvocation ? { trustedInvocation } : {}),
      ...(identity.owner_id ? { authInfo: { clientId: identity.client_id, extra: {
        owner_id: identity.owner_id, transport_instance_id: identity.transport_instance_id,
      } } } : {}) };
    const result = await this.request(node, "tool", { name, input: args, extra: context }, remainingToolTime(deadlineAt));
    await this.sessionFeed?.afterRemoteResult(name, args, result, node, trustedInvocation);
    return result;
  }
  private async openGatewayStream(service: "ingress" | "egress"): Promise<Duplex> {
    const node = service === "ingress"
      ? this.nodes().find(candidate => candidate.id === this.config.coordinatorId && candidate.online)
      : this.gateway();
    if (!node) throw new Error(service === "ingress" ? "Coordinator 当前不可用" : "暂无可用出口");
    return this.openNodeStream(node.id, service);
  }
  async openNodeStream(node: string, service: string, metadata: unknown = {}): Promise<Duplex> {
    if (node === this.localId) {
      if (service === "ingress") return dialTcp("127.0.0.1", this.hooks.httpPort);
      if (service === "egress") {
        if (!this.config.capabilities.egress || !this.manifest.egress.healthy) throw new Error("EGRESS_CAPABILITY_UNAVAILABLE");
        const lease=this.execution.beginWork({kind:"egress",blocking:false});
        try { return this.trackStream(await lease.run(()=>connectProxy(this.proxyUrl)),lease); }
        catch(error) { lease.release(); throw error; }
      }
      throw new Error(`本地传输 ${service} 应调用本地文件接口`);
    }
    const link = this.transport.links.get(node); if (!link) throw new NodeUnavailableError(node);
    if(service!=="egress")return link.openStream(service, metadata);
    const lease=this.execution.beginWork({kind:"egress",blocking:false});
    try { return this.trackStream(await lease.run(()=>link.openStream(service,metadata)),lease); }
    catch(error) { lease.release(); throw error; }
  }

  private trackStream(stream: Duplex, lease: RuntimeWorkLease): Duplex {
    stream.once("close",()=>lease.release());
    if(stream.destroyed)lease.release();
    return stream;
  }
  private async receiveStream(service: string, metadata: JsonRecord, stream: Duplex): Promise<void> {
    stream.on("error", () => {});
    if (service === "ingress") {
      if (!this.config.capabilities.coordinator) throw new Error("本节点未启用 Coordinator");
      bridge(stream, await dialTcp("127.0.0.1", this.hooks.httpPort)); return;
    }
    if (service === "egress") {
      if (!this.config.capabilities.egress || !this.manifest.egress.healthy) throw new Error("本机 mihomo 出口当前不可用");
      const lease=this.execution.beginWork({kind:"egress",blocking:false});
      this.trackStream(stream,lease);
      try { bridge(stream,await lease.run(()=>connectProxy(this.proxyUrl))); }
      catch(error) { lease.release(); throw error; }
      return;
    }
    if (service === "artifact.read") {
      if(!this.config.capabilities.worker)throw new Error("WORKER_CAPABILITY_DISABLED");
      const lease=this.execution.beginWork({kind:"transfer"});
      this.trackStream(stream,lease);
      try {
        const file=await lease.run(()=>this.hooks.artifactRead(metadata));
        file.on("error",error=>stream.destroy(error));stream.on("close",()=>file.destroy());file.pipe(stream);
      } catch(error) { lease.release();throw error; }
      return;
    }
    throw new Error(`未知传输服务 ${service}`);
  }
  async copyArtifact(input: JsonRecord, extra?: JsonRecord): Promise<unknown> {
    if (input.action === "observe" || input.action === "cancel") {
      const handle = parseWorkspaceHandle(String(input.copy_id ?? "")); if (!handle) throw new Error("请提供 copy_id");
      return this.request(handle.node, `artifact.${input.action}`, { id: String(input.copy_id) });
    }
    const source = parseWorkspaceHandle(String(input.source_workspace_id ?? ""));
    const destination = parseWorkspaceHandle(String(input.destination_workspace_id ?? ""));
    if (!source || !destination) throw new Error("请从 open_workspace 获取源和目标 workspace_id");
    const requestKey=typeof input.request_key==="string"?input.request_key:undefined;
    if(!requestKey || requestKey.length>128)throw new Error("COPY_REQUEST_KEY_REQUIRED");
    const context=extra ? this.trustedInvocation("copy_artifact",{workspace_id:input.destination_workspace_id},extra) : undefined;
    if(extra && !context)throw new Error("COPY_TASK_CONTEXT_REQUIRED");
    return this.request(destination.node, "artifact.copy", { sourceNode: source.node, sourceWorkspace: source.local,
      sourcePath: input.source_path, destinationWorkspace: destination.local, destinationPath: input.destination_path,
      overwrite: input.overwrite === true, requestKey, context });
  }
  private async startCopy(input: JsonRecord): Promise<TransferView> {
    if(this.stopped || !this.config.capabilities.worker)throw new Error("WORKER_CAPABILITY_UNAVAILABLE");
    for(const key of ["requestKey","sourceNode","sourceWorkspace","sourcePath","destinationWorkspace","destinationPath"])
      if(typeof input[key]!=="string" || !input[key])throw new Error(`COPY_ARGUMENT_REQUIRED: ${key}`);
    const request=input as unknown as TransferRequest;
    const lease=this.execution.beginWork({kind:"transfer",taskId:request.context?.task_id});
    let reserved: ReturnType<TransferStore["reserve"]>;
    try { reserved=this.transferStore.reserve(request); } catch(error) {lease.release();throw error;}
    if(!reserved.created){lease.release();return reserved.view;}
    const view=reserved.view,id=view.id,controller=new AbortController();
    this.activeTransfers.set(id,view);this.aborts.set(id,controller);
    const pending=lease.run(async()=>{
      let lifecycle:ArtifactWriteLifecycle|undefined;
      let outcome:"completed"|"failed"|"cancelled"="failed";
      let failure:string|undefined;
      try {
        await this.sessionFeed?.prepareLocalTool("copy_artifact",{workspace_id:request.destinationWorkspace},request.context);
        lifecycle=await this.hooks.artifactPrepare?.({workspace_id:request.destinationWorkspace,path:request.destinationPath,
          operation_id:view.operationId,request_key:request.requestKey,source_node:request.sourceNode,
          source_workspace:request.sourceWorkspace,source_path:request.sourcePath,overwrite:request.overwrite},request.context);
        const read={workspace_id:request.sourceWorkspace,path:request.sourcePath,operation_id:view.operationId};
        const stat=await this.request<{size:number}>(request.sourceNode,"artifact.stat",read);
        controller.signal.throwIfAborted();
        view.totalBytes=stat.size;
        this.transferStore.prepared(id,lifecycle?.temporaryPath??"",stat.size);
        const source=request.sourceNode===this.localId
          ? await this.hooks.artifactRead({...read,owned_write_claim:lifecycle?.claimId})
          : await this.openNodeStream(request.sourceNode,"artifact.read",read);
        let lastSaved=0;
        try {
          await this.hooks.artifactWrite({workspace_id:request.destinationWorkspace,path:request.destinationPath,
            overwrite:request.overwrite,expectedBytes:stat.size,temporary_path:lifecycle?.temporaryPath},source,controller.signal,bytes=>{
              view.bytes=bytes;
              if(Date.now()-lastSaved>=500){this.transferStore.progress(id,bytes);lastSaved=Date.now();this.emit("change");}
            });
        } finally {source.destroy();}
        outcome="completed";
      } catch(error) {
        failure=error instanceof Error?error.message:String(error);
        outcome=controller.signal.aborted?"cancelled":"failed";
      } finally {
        // Do not publish a terminal transfer until its operation receipt has
        // settled and *both* execution leases have been released. Consumers
        // may immediately finish the Task after seeing a terminal transfer.
        try { await lifecycle?.finish(outcome,failure); }
        catch(error) { this.event("transfer-finalization",this.localId,error instanceof Error?error.message:String(error)); }
        finally {
          try { lifecycle?.release(); } finally { lease.release(); }
        }
        try {
          this.transferStore.finish(id,outcome,view.bytes,failure);
          view.status=outcome;
        } finally {
          this.aborts.delete(id);this.activeTransfers.delete(id);this.pendingTransfers.delete(id);this.emit("change");
        }
      }
    });
    this.pendingTransfers.set(id,pending);
    void pending.catch(error=>this.event("transfer",this.localId,error instanceof Error?error.message:String(error)));
    return {...view};
  }
  private persist(path: string, value: unknown): void {
    const temporary = temporaryPath(path);
    try {
      writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
      renameSync(temporary, path);
    } catch (error) {
      try { rmSync(temporary, { force: true }); } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "节点缓存写入失败，临时文件也未能删除");
      }
      throw error;
    }
  }
  async close(): Promise<void> {
    if (this.stopped) return; this.stopped = true;
    clearInterval(this.heartbeat); clearInterval(this.probeTimer);
    for (const abort of this.aborts.values()) abort.abort();
    await Promise.allSettled(this.pendingTransfers.values());
    await this.sessionFeed?.close();
    await Promise.all([this.egress?.close(), this.ingress?.close()]);
    await this.transport.close();
    this.transferStore.close();
    if(this.ownsExecution)this.execution.close();
  }
}

function runtimeVersion(): string | undefined {
  const explicit = process.env.QUAYMESH_RELEASE_COMMIT?.trim();
  if (explicit) return explicit;
  const entrypoint = process.argv[1];
  if (!entrypoint) return undefined;
  try {
    const root = dirname(dirname(resolve(entrypoint)));
    const releasePath = join(root, "release.json");
    if (!existsSync(releasePath)) return undefined;
    const release = JSON.parse(readFileSync(releasePath, "utf8")) as { sourceCommit?: unknown };
    return typeof release.sourceCommit === "string" && release.sourceCommit.trim() ? release.sourceCommit.trim() : undefined;
  } catch {
    return undefined;
  }
}

function recordActiveRelease(stateDir: string, nodeId: string, version: string | undefined): void {
  if (!version) return;
  const path = join(stateDir, "active-release.json");
  const temporary = temporaryPath(path);
  const value = {
    nodeId,
    commit: version,
    activatedAt: new Date().toISOString(),
    entrypoint: process.argv[1] ?? null,
    pid: process.pid,
  };
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function temporaryPath(path: string): string {
  return `${path}.${process.pid}.${randomUUID()}.tmp`;
}
