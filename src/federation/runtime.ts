import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, createReadStream } from "node:fs";
import { readFile, writeFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { Duplex, Readable } from "node:stream";
import { PeerTransport, PeerLink, NodeUnavailableError, PeerApplicationError, RpcRequestTimeoutError, bridge, type PeerProgressNotification } from "./transport.js";
import { catalog, catalogToolSummary, chooseGateway, parseWorkspaceHandle, routedResult, selectRoot } from "./routing.js";
import { EgressListener, connectProxy, dialTcp, probeProxy } from "./egress.js";
import { capabilities } from "./capabilities.js";
import { sampleHealth } from "./health.js";
import { mapConcurrent } from "../concurrency.js";
import type { FederationConfig, NodeManifest, NodeView, JsonRecord, ConsoleReply, ToolHandler } from "./types.js";
import type { SessionFeed } from "./session-feed.js";
import { sessionToolRoute } from "./tool-routing.js";
import { safeForwardedContext } from "../request-meta.js";
import { retainLocalTaskClient } from "../tasks/task-binding.js";
import { assertTaskBindingEnvelope, type TrustedInvocationEnvelope } from "./session-types.js";
import { ExecutionCoordinator, type RuntimeWorkLease } from "../execution-coordinator.js";
import { isReadOnlyObservation, observesAcceptedWork } from "../tool-admission.js";
import { TransferStore, type TransferRequest, type TransferView } from "./transfer-store.js";
export type { TransferView } from "./transfer-store.js";


export { isTransientPeerFailure, isIdempotentPeerRequest, dispatchPeerRequest, READ_TOTAL_BUDGET_MS, READ_ATTEMPT_TIMEOUT_MS, MAX_READ_RETRIES } from "./read-retry.js";
import { toolDeadline, remainingToolTime, TOOL_DEADLINE_META } from "../tool-request-budget.js";
import { jsonReply } from "../bounded-reply.js";
import { currentInvocation } from "../session/invocations.js";
import { errorCode, toolErrorResult } from "../session/outcome.js";
import { WorkspaceAccessError } from "../workspaces.js";
import { dispatchPeerRequest, isTransientPeerFailure, isIdempotentPeerRequest, isCancellableToolObservation } from "./read-retry.js";
import { dispatchConsoleRequest } from "./console-request.js";
import { withConsoleReadSignal } from "../console-workbench/isolated-queries.js";
import type {LocalApiPeerHooks} from "../local-user-api/service.js";

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
  diagnostics?(event: string, fields: Record<string, unknown>, level?: "info" | "warn" | "error"): void;
  providers(): unknown[];
  prepareOpen(input: JsonRecord): Promise<JsonRecord>;
  checkWorkspace(id: string, options?: { touch?: boolean }): Promise<void>;
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
  private readonly events: { time: string; kind: string; nodeId: string; message: string; details?: Record<string, unknown> }[] = [];
  private readonly egressStreams = new Set<Duplex>();
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
  private pendingCache?: NodeManifest[];
  private cacheWriting?: Promise<void>;
  private readonly releaseRecording: Promise<void>;
  private runtimeIdentity?: NodeManifest["runtime"];
  private readonly modelTools = new Set<string>();
  private sessionFeed?: SessionFeed;
  private localUserApi?: LocalApiPeerHooks;
  setLocalUserApi(api: LocalApiPeerHooks): void {this.localUserApi = api;}
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
    this.releaseRecording = runtimeIdentity().then(async identity => {
      this.runtimeIdentity=identity;
      await recordActiveRelease(hooks.stateDir, config.nodeId, this.manifest.version, identity);
    });
    void this.releaseRecording.catch(() => {});
    this.transport = new PeerTransport(config, token, (method, params, peer, context) => this.receive(method, params, peer, context?.signal, context?.notify),
      (service, metadata, stream) => this.receiveStream(service, metadata, stream));
    this.transport.on("online", (link: PeerLink) => { void this.peerOnline(link).catch((error) => this.event("connection", link.peerId, String(error))); });
    this.transport.on("offline", (id: string, details: Record<string, unknown>) => { this.event("offline", id, "节点连接断开", details); this.emit("change"); });
    this.transport.on("peerError", (id: string, error: Error) => this.event("connection_error", id, error.message, {
      code: (error as NodeJS.ErrnoException).code, ...this.transport.links.get(id)?.diagnostics() }));
    this.transport.on("rpcTimeout", (id: string, details: Record<string, unknown>) => this.event("rpc_timeout", id, "节点调用等待超时", details));
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
      ...this.componentStatus(), roots: this.config.roots, platform: process.platform, version: runtimeVersion(), runtime: this.runtimeIdentity,
      tools: [...this.modelTools].sort(), providers: this.hooks.providers(),
      egress: { ...(this.manifest?.egress ?? { enabled: this.config.capabilities.egress, healthy: this.config.capabilities.egress ? false : !this.config.egress.enabled }),
        draining: !this.execution.admissionState().accepting, activeConnections: this.egressStreams.size },
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
    await this.releaseRecording;
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
      if (!this.egress) { this.egress = new EgressListener(port, () => this.openGatewayStream("egress"), error =>
        this.event("egress_error", this.selected ?? this.localId, "出口连接建立失败", { code: error.code, phase: error.phase ?? "gateway_select" })); await this.egress.start(); }
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
    if (sessionToolRoute(name) === "task") return this.localId;
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
    return sessionToolRoute(name) === "member" ? this.sessionRouteFor(input) ?? this.localId : this.localId;
  }
  async trustedInvocation(name: string, input: JsonRecord, extra: JsonRecord): Promise<TrustedInvocationEnvelope | undefined> {
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
      nodes: this.nodes(), events: this.events.slice(-40).reverse(), transfers: this.transferStore.list(), startupError: this.startupError,
      links: [...this.transport.links.values()].map(link => ({ nodeId: link.peerId, ...link.diagnostics() })),
      activeEgressConnections: this.egressStreams.size };
  }
  private event(kind: string, nodeId: string, message: string, details?: Record<string, unknown>): void {
    this.events.push({ time: new Date().toISOString(), kind, nodeId, message, details });
    this.hooks.diagnostics?.(`federation_${kind}`, { nodeId, message, ...details },
      kind.includes("error") || kind === "offline" ? "warn" : "info");
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
    this.persistCache([...this.known.values()]);
  }
  private publishManifest(): void {
    this.manifest = this.makeManifest(); this.manifest.egress.enabled = this.config.capabilities.egress;
    for (const link of this.transport.links.values()) link.notify("manifest", this.manifest);
    this.emit("change");
  }
  refreshAdmission(): void { this.publishManifest(); }
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
      this.event("egress_probe_error", this.localId, "出口探测失败", { phase: (error as { phase?: string } | undefined)?.phase ?? "probe",
        code: (error as NodeJS.ErrnoException | undefined)?.code });
    } finally { this.probing = false; this.publishManifest(); }
  }
  private async receive(method: string, params: any, peer: string, signal?: AbortSignal,
    notify?: (notification: PeerProgressNotification) => void | Promise<void>): Promise<unknown> {
    const bound = method === "tool" ? params.extra?.trustedInvocation : method === "artifact.copy" ? params.context : undefined;
    assertTaskBindingEnvelope(bound);
    if (bound?.task_binding_version === 1 && peer !== this.localId
      && (!this.config.coordinatorId || peer !== this.config.coordinatorId)) {
      throw Object.assign(new Error("TASK_BINDING_COORDINATOR_REQUIRED"), { code: "TASK_BINDING_COORDINATOR_REQUIRED", effect: "not_started" });
    }
    switch (method) {
      case "local-user.call": case "local-user.terminal": case "local-user.install": case "local-user.describe": {
        if (!this.localUserApi) throw Object.assign(new Error("LOCAL_API_UNAVAILABLE"), {code: "LOCAL_API_UNAVAILABLE", effect: "not_started"});
        return this.localUserApi.receive(peer, method.slice("local-user.".length) as "call" | "terminal" | "install" | "describe", params, signal);
      }
      case "hello": this.remember(params.manifest, peer); return { manifest: this.makeManifest() };
      case "manifest": this.remember(params, peer); this.notePeerSuccess(peer); this.emit("change"); return null;
      case "tool": return this.invokeLocal(params.name, params.input, { ...(params.extra ?? {}), signal, sendNotification: notify });
      case "session.binding-capabilities": return { node_id: this.localId, task_binding: this.sessionFeed ? 1 : 0 };
      case "session.feed": {
        if (!this.sessionFeed) throw new Error("SESSION_FEED_UNAVAILABLE");
        return this.sessionFeed.handleRequest(params, peer, signal);
      }
      case "session.feed.update": {
        if (!this.sessionFeed) throw new Error("SESSION_FEED_UNAVAILABLE");
        return this.sessionFeed.receiveUpdate(params, peer);
      }
      case "console": {
        const request = () => this.hooks.console(params.method, params.path, params.body);
        if (["GET", "HEAD"].includes(String(params.method ?? "GET").toUpperCase()))
          return signal ? withConsoleReadSignal(signal, request) : request();
        return this.execution.withWork({kind: "console"}, request);
      }
      case "console.request": {
        const manifest = this.known.get(peer);
        if (!manifest?.capabilities?.consoleRelay) throw new Error("CONSOLE_RELAY_CAPABILITY_REQUIRED");
        const request = () => dispatchConsoleRequest(this.hooks.httpPort, peer, params ?? {}, signal);
        return ["GET", "HEAD"].includes(String(params.method ?? "GET").toUpperCase())
          ? request() : this.execution.withWork({kind: "console"}, request);
      }
      case "settings.get": return this.hooks.settings();
      case "settings.update": await this.hooks.updateSettings(params); return this.hooks.settings();
      case "mihomo.import": {
        if (!this.config.capabilities.egress) throw new Error("EGRESS_CAPABILITY_REQUIRED"); const result = await this.hooks.mihomoImport(params.text, params.reload); if (this.config.egress.enabled) void this.probe(); return result; }
      case "mihomo.read":
        if (!this.config.capabilities.egress) throw new Error("EGRESS_CAPABILITY_REQUIRED"); return this.hooks.mihomoRead();
      case "transfers.list": return params.paged === true ? this.transferStore.page({
        limit: Number(params.limit ?? 25), offset: Number(params.offset ?? 0),
        q: typeof params.q === "string" ? params.q : undefined, status: typeof params.status === "string" ? params.status : undefined,
      }) : this.transferStore.list();
      case "artifact.stat": return this.hooks.artifactStat(params);
      case "artifact.lookup": return this.transferStore.lookup(params);
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
  private readonly bindingPeers = new WeakMap<PeerLink, Promise<void>>();

  private bindingUnavailable(nodeId: string, cause?: unknown): Error {
    return Object.assign(new NodeUnavailableError(nodeId,
      "NODE_UNAVAILABLE: Task binding negotiation did not complete before dispatch. No work was sent; retry later with the same operation key."), {
      cause, effect: "not_started", retryHint: "retry_later",
      details: { phase: "task_binding_negotiation", dispatch_state: "not_sent", ...(cause ? { cause_code: errorCode(cause) } : {}) },
    });
  }

  /** Negotiate on the actual connection that will receive the work, never from a stale directory entry. */
  private taskBindingPeer(link: PeerLink, timeout: number): Promise<void> {
    const saved = this.bindingPeers.get(link);
    if (saved) return saved;
    const probe = link.call<{ node_id: string; task_binding: number }>("session.binding-capabilities", {}, Math.min(timeout, 2000))
      .then(result => {
        if (!result || typeof result !== "object" || result.node_id !== link.peerId) throw new PeerApplicationError(link.peerId, "Task binding capability identity mismatch.",
          "TASK_BINDING_CAPABILITY_INVALID", { message: "Capability identity mismatch; no work was sent.", effect: "not_started", retryHint: "fix_input" });
        if (result.task_binding !== 1) {
          throw new PeerApplicationError(link.peerId, "The Worker does not support explicit Task bindings.", "TASK_BINDING_PEER_UPGRADE_REQUIRED",
            { message: "The Worker does not support explicit Task bindings.", effect: "not_started", retryHint: "fix_input" });
        }
      }).catch(error => {
        this.bindingPeers.delete(link);
        if (error instanceof PeerApplicationError && error.code === "TASK_BINDING_CAPABILITY_INVALID") throw error;
        if (error instanceof PeerApplicationError && (error.code === "TASK_BINDING_PEER_UPGRADE_REQUIRED"
          || error.code === "METHOD_NOT_FOUND" || error.code === "RPC_METHOD_NOT_FOUND"
          // Published legacy peers did not assign a code to unknown methods.
          || error.message === "未知节点方法 session.binding-capabilities")) {
          throw new PeerApplicationError(link.peerId, `TASK_BINDING_PEER_UPGRADE_REQUIRED: ${link.peerId} must support Task binding before resumed work is sent.`,
            "TASK_BINDING_PEER_UPGRADE_REQUIRED", { message: "Task binding negotiation rejected; no work was sent.", effect: "not_started", retryHint: "fix_input" });
        }
        throw this.bindingUnavailable(link.peerId, error);
      });
    this.bindingPeers.set(link, probe);
    return probe;
  }
  private notePeerSuccess(node: string): void {
    this.peerHealth.set(node, { lastSuccessAt: Date.now(), consecutiveFailures: 0 });
  }
  private notePeerFailure(node: string, error: unknown): void {
    const previous = this.peerHealth.get(node) ?? { consecutiveFailures: 0 };
    const message = error instanceof Error ? error.message : String(error);
    this.peerHealth.set(node, { lastSuccessAt: previous.lastSuccessAt, lastError: message.slice(0, 300), consecutiveFailures: previous.consecutiveFailures + 1 });
  }
  private linkAdapter<T>(node: string, method: string, params: unknown,
    onProgress?: (notification: PeerProgressNotification) => void | Promise<void>, signal?: AbortSignal) {
    const link = this.transport.links.get(node);
    if (!link) return undefined;
    return { get connected() { return link.connected; }, call: async (timeout: number) => {
      const started = performance.now();
      const invocation = method === "tool" ? (params as { extra?: { trustedInvocation?: TrustedInvocationEnvelope } }).extra?.trustedInvocation
        : method === "artifact.copy" ? (params as { context?: TrustedInvocationEnvelope }).context : undefined;
      if (invocation?.task_binding_version === 1) await this.taskBindingPeer(link, timeout);
      const remaining = timeout - (performance.now() - started);
      if (remaining <= 0) throw this.bindingUnavailable(node);
      let request = params;
      if (method === "tool" && isIdempotentPeerRequest(method, params)) {
        const input = params as { extra?: JsonRecord };
        const extra = input.extra ?? {};
        const meta = extra._meta as JsonRecord | undefined;
        const declared = Number(meta?.[TOOL_DEADLINE_META]);
        // 每次只读尝试共享调用者期限，同时不得在该次 RPC 超时后继续堆积远端观察。
        request = { ...input, extra: { ...extra, _meta: { ...meta,
          [TOOL_DEADLINE_META]: Math.min(Number.isFinite(declared) ? declared : Infinity, Date.now() + remaining) } } };
      }
      return link.call<T>(method, request, remaining, onProgress, signal);
    }, close: () => link.close() };
  }
  async request<T = unknown>(node: string, method: string, params: unknown, timeoutMs?: number,
    onProgress?: (notification: PeerProgressNotification) => void | Promise<void>, signal?: AbortSignal): Promise<T> {
    if (node === this.localId) return this.receive(method, params, this.localId, signal, onProgress) as Promise<T>;
    try {
      const result = await dispatchPeerRequest<T>({
        node, method, params, timeoutMs, rpcTimeoutMs: this.config.rpcTimeoutMs, signal,
        getLink: () => this.linkAdapter<T>(node, method, params, onProgress, signal),
        waitForLink: async (waitMs) => {
          const link = await this.transport.waitForLink(node, waitMs);
          return link ? this.linkAdapter<T>(node, method, params, onProgress, signal) : undefined;
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
    // 历史观察仍经过身份准备与原 handler，不为读取另建持久执行租约。
    if (isReadOnlyObservation(name, input)) return this.invokeAcceptedTool(name, input, extra);
    return this.execution.withWork({kind:"tool",allowWhilePaused:observesAcceptedWork(name,input),
      taskId:(extra.trustedInvocation as TrustedInvocationEnvelope | undefined)?.task_id},
      () => this.invokeAcceptedTool(name,input,extra));
  }

  private async invokeAcceptedTool(name: string, input: JsonRecord, extra: JsonRecord): Promise<unknown> {
    const deadlineAt=toolDeadline(name,input,extra._meta);
    remainingToolTime(deadlineAt);
    // Accepted durable work outlives the transport that returned its receipt.
    if (!isCancellableToolObservation(name, input)) {
      const { signal: _transportSignal, ...durableExtra } = extra;
      return this.invokeToolBody(name, input, durableExtra, deadlineAt);
    }
    const controller = new AbortController();
    const inherited = extra.signal instanceof AbortSignal ? extra.signal : undefined;
    const abort = () => controller.abort(inherited?.reason ?? new RpcRequestTimeoutError(this.localId, String(extra.requestId ?? "read"), "读取已取消"));
    if (inherited?.aborted) abort(); else inherited?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(new RpcRequestTimeoutError(this.localId, String(extra.requestId ?? "read"), "读取期限已到")), remainingToolTime(deadlineAt));
    timer.unref();
    let onAbort: (() => void) | undefined;
    try {
      controller.signal.throwIfAborted();
      const work = this.invokeToolBody(name, input, { ...extra, signal: controller.signal }, deadlineAt);
      const expired = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener("abort", onAbort, { once: true });
        if (controller.signal.aborted) onAbort();
      });
      return await Promise.race([work, expired]);
    } finally {
      clearTimeout(timer);
      inherited?.removeEventListener("abort", abort);
      if (onAbort) controller.signal.removeEventListener("abort", onAbort);
    }
  }
  private async invokeToolBody(name: string, input: JsonRecord, extra: JsonRecord, deadlineAt: number): Promise<unknown> {
    if (!this.config.capabilities.worker && (typeof input.workspace_id === "string" || name === "open_workspace" || name === "attach_workspace")) {
      throw new Error(`节点 ${this.localId} 未启用执行能力`);
    }
    const handler = this.handlers.get(name); if (!handler) throw new Error(`节点 ${this.config.nickname} 没有启用 ${name}`);
    const progressToken = (extra._meta as JsonRecord | undefined)?.progressToken;
    const canNotify = (typeof progressToken === "string" || typeof progressToken === "number") && typeof extra.sendNotification === "function";
    const sendNotification = extra.sendNotification as ((notification: PeerProgressNotification) => void | Promise<void>) | undefined;
    let progress = 0;
    const notify = async (notification: unknown): Promise<void> => {
      if (!canNotify || !notification || typeof notification !== "object") return;
      const value = notification as { method?: unknown; params?: { message?: unknown } };
      if (value.method !== "notifications/progress") return;
      try { await sendNotification?.({ method: "notifications/progress", params: {
        progressToken: progressToken as string | number, progress: progress++,
        ...(typeof value.params?.message === "string" ? { message: value.params.message.slice(0, 512) } : {}),
      } }); } catch { /* Host notification delivery does not change the tool's committed outcome. */ }
    };
    const phase = (stage: string, message: string) => {
      const trusted = extra.trustedInvocation as TrustedInvocationEnvelope | undefined;
      this.hooks.diagnostics?.("tool_phase", { nodeId: this.localId, tool: name, stage,
        requestId: extra.requestId, operationId: trusted?.operation_id, taskId: trusted?.task_id });
      void notify({ method: "notifications/progress", params: { message } });
    };
    phase("received", "节点已接收调用，正在准备身份与工作区");
    const prepared = await this.sessionFeed?.prepareLocalTool(name, input, extra.trustedInvocation as TrustedInvocationEnvelope | undefined);
    if (extra.signal instanceof AbortSignal) extra.signal.throwIfAborted();
    if (prepared) extra = {...extra, trustedInvocation: prepared};
    const opensWorkspace = name === "open_workspace" || name === "attach_workspace";
    const args = opensWorkspace ? await this.hooks.prepareOpen(input) : input;
    // 查询原工作区的历史记录无需重新打开已经删除的文件目录。
    const historical = name === "read_output" || name === "workspace_context" &&
      (args.action === "recovery" || args.action === "status" && args.environment !== true);
    if (typeof args.workspace_id === "string" && !historical && !opensWorkspace) {
      try { await this.hooks.checkWorkspace(args.workspace_id,
        name === "wait_agent" || name === "list_agents" ? {touch: false} : undefined); }
      catch (error) {
        // 恢复提示属于工具回执；先保留节点句柄和参数，再跨节点传输。
        if (error instanceof WorkspaceAccessError) return routedResult(toolErrorResult(error), this.localId, { textReferences: true });
        throw error;
      }
    }
    this.activeCalls++;
    try {
      remainingToolTime(deadlineAt);
      if (extra.signal instanceof AbortSignal) extra.signal.throwIfAborted();
      const controller = new AbortController();
      phase("executing", "身份与工作区已就绪，正在执行工具");
      const result = await handler(args, { signal: controller.signal, ...extra,
        sendNotification: notify, sendRequest: async () => { throw new Error("该工具需要交互式宿主请求"); } });
      phase("result_ready", "工具已返回结果，正在交付回执");
      return routedResult(result, this.localId, { textReferences: opensWorkspace, jsonText: false });
    } finally { this.activeCalls--; }
  }
  async tool(name: string, input: JsonRecord, extra: JsonRecord = {}): Promise<unknown> {
    if (name === "workspace_catalog") {
      let currentNodes: NodeView[];
      try { currentNodes = this.nodes(); } catch { currentNodes = []; }
      const structured = catalog(currentNodes, String(input.query ?? ""), input.include_offline !== false);
      return jsonReply(structured, catalogToolSummary(structured, catalog(currentNodes, "", true)));
    }
    if ((name === "open_workspace" || name === "attach_workspace")
        && this.config.capabilities.coordinator && !this.config.capabilities.worker
        && typeof input.root_id !== "string" && typeof input.workspace_id !== "string") {
      const known = catalog(this.nodes(), "", true);
      const roots = (known.workspaces as Array<{root_id:string}>).map(root => root.root_id);
      throw Object.assign(new Error(
        `WORKSPACE_ROOT_REQUIRED: Cloud is a Coordinator with no file execution capability. `
        + `Choose an exported worker root_id and call ${name}({root_id:"..."}). `
        + `Available root_id values: ${roots.join(", ") || "(none registered)"}.`),
      { code: "WORKSPACE_ROOT_REQUIRED", effect: "not_started", retryHint: "fix_input",
        details: { available_root_ids: roots } });
    }
    let node = this.localId; let args = { ...input };
    if (name === 'read_diagnostics' && typeof input.node_id === 'string') {
      node = input.node_id;
    } else if (name === "open_workspace" && typeof input.root_id === "string") {
      const selected = selectRoot(this.nodes(), input.root_id); node = selected.node.id; args.root_id = selected.root.id;
    } else if (name === "attach_workspace" && typeof input.root_id === "string") {
      const selected = selectRoot(this.nodes(), input.root_id); node = selected.node.id; args.root_id = selected.root.id;
    } else if (sessionToolRoute(name) === "member") {
      const detail = await this.sessionFeed?.fetchDetail(name, input, extra);
      if (detail !== undefined) return detail;
      const routedNode = this.sessionRouteFor(input);
      if (routedNode) node = routedNode;
    } else if (sessionToolRoute(name) !== "task" && typeof input.workspace_id === "string") {
      const handle = parseWorkspaceHandle(input.workspace_id);
      if (handle) { node = handle.node; args.workspace_id = handle.local; }
    }
    // Credentials and transport callbacks never become RPC arguments.
    const trusted = extra.trustedInvocation as TrustedInvocationEnvelope | undefined
      ?? await this.trustedInvocation(name, input, extra);
    const attempt = currentInvocation();
    const trustedInvocation = trusted && attempt?.tool_name === name && attempt.owner_id === trusted.owner_id
      && String(attempt.request_id) === trusted.request_id
      ? {...trusted, invocation_id: attempt.invocation_id, operation_id: attempt.operation_id}
      : trusted;
    const identity = safeForwardedContext(extra);
    const requestedProgress = (extra._meta as JsonRecord | undefined)?.progressToken;
    const progressToken = typeof requestedProgress === "string" && requestedProgress.length <= 1024
      || typeof requestedProgress === "number" && Number.isFinite(requestedProgress) ? requestedProgress : undefined;
    const deadlineAt=toolDeadline(name,args,extra._meta);
    const context = { _meta: { ...(identity.conversation_id ? { "openai/session": identity.conversation_id } : {}),
        [TOOL_DEADLINE_META]:deadlineAt, ...(progressToken !== undefined ? { progressToken } : {}) },
      requestId: identity.request_id,
      sessionId: identity.transport_session_id,
      ...(trustedInvocation ? { trustedInvocation } : {}),
      ...(identity.owner_id ? { authInfo: retainLocalTaskClient(node === this.localId ? extra.authInfo as {clientId?: string; extra?: Record<string, unknown>} : undefined,
        { clientId: identity.client_id as string | undefined, extra: {
        owner_id: identity.owner_id, transport_instance_id: identity.transport_instance_id,
      } }) } : {}) };
    let progress = 0;
    const onProgress = progressToken !== undefined && typeof extra.sendNotification === "function"
      ? (notification: PeerProgressNotification) => (extra.sendNotification as (notification: PeerProgressNotification) => Promise<void>)({
        method: "notifications/progress", params: { progressToken, progress: progress++,
          ...(notification.params.message ? { message: notification.params.message } : {}) },
      }) : undefined;
    // A stateless MCP response can close while the recorder still owns this RPC.
    // Propagate caller cancellation only for observations; durable work keeps its
    // original operation identity and bounded RPC deadline until its result is saved.
    const signal = isCancellableToolObservation(name, args) && extra.signal instanceof AbortSignal
      ? extra.signal : undefined;
    const query=()=>this.request(node, "tool", { name, input: args, extra: context }, remainingToolTime(deadlineAt), onProgress, signal);
    const dispatch = async () => {
      if (name === "exec_command" && trustedInvocation) await this.localUserApi?.beforeExec(node, trustedInvocation);
      const result = name==="workspace_context" && this.sessionFeed
        ? await this.sessionFeed.recoverOperationStatus(input,trustedInvocation,node,query)
        : await query();
      if ((result as JsonRecord | null)?.isError !== true) {
        await this.sessionFeed?.afterRemoteResult(name, args, result, node, trustedInvocation);
        if (node !== this.localId && this.sessionFeed && trustedInvocation?.task_id
          && (name === "open_workspace" || name === "attach_workspace")) {
          return this.sessionFeed.workspaceResultForEntry(result, extra, trustedInvocation.task_id);
        }
      }
      return result;
    };
    if (node !== this.localId && this.sessionFeed && trustedInvocation?.task_id
      && (name === "open_workspace" || name === "attach_workspace")) {
      // The first remote member does not exist at the authority until its reply.
      // Keep the captured Task busy through that reply and validate it before
      // dispatch, so finalization cannot close or remirror it during first open.
      return this.execution.withWork({ kind: "tool", taskId: trustedInvocation.task_id }, async () => {
        await this.sessionFeed!.admitTaskWork(trustedInvocation);
        return dispatch();
      });
    }
    return dispatch();
  }
  private async openGatewayStream(service: "ingress" | "egress"): Promise<Duplex> {
    const node = service === "ingress"
      ? this.nodes().find(candidate => candidate.id === this.config.coordinatorId && candidate.online)
      : this.gateway();
    if (!node) throw Object.assign(new Error(service === "ingress" ? "Coordinator 当前不可用" : "暂无可用出口"),
      { code: service === "ingress" ? "COORDINATOR_UNAVAILABLE" : "EGRESS_UNAVAILABLE", phase: "gateway_select" });
    return this.openNodeStream(node.id, service);
  }
  async openNodeStream(node: string, service: string, metadata: unknown = {}): Promise<Duplex> {
    if (node === this.localId) {
      if (service === "ingress") return dialTcp("127.0.0.1", this.hooks.httpPort);
      if (service === "egress") {
        if (!this.config.capabilities.egress || !this.manifest.egress.healthy)
          throw Object.assign(new Error("EGRESS_CAPABILITY_UNAVAILABLE"), { code: "EGRESS_CAPABILITY_UNAVAILABLE", phase: "gateway_admission" });
        const lease=this.execution.beginWork({kind:"egress"});
        try { return this.trackStream(await lease.run(()=>connectProxy(this.proxyUrl)),lease,true); }
        catch(error) { lease.release(); throw error; }
      }
      throw new Error(`本地传输 ${service} 应调用本地文件接口`);
    }
    const link = this.transport.links.get(node); if (!link) throw new NodeUnavailableError(node);
    if(service!=="egress")return link.openStream(service, metadata);
    const lease=this.execution.beginWork({kind:"egress"});
    try { return this.trackStream(await lease.run(()=>link.openStream(service,metadata)),lease,true); }
    catch(error) { lease.release(); throw error; }
  }

  private trackStream(stream: Duplex, lease: RuntimeWorkLease, egress = false): Duplex {
    if (egress) this.egressStreams.add(stream);
    const release = () => {
      this.egressStreams.delete(stream);
      void lease.releaseAsync().catch(error => this.event("stream_release_error", this.localId, String(error)));
    };
    stream.once("close", release);
    if(stream.destroyed) release();
    return stream;
  }
  private async receiveStream(service: string, metadata: JsonRecord, stream: Duplex): Promise<void> {
    stream.on("error", () => {});
    if (service === "ingress") {
      if (!this.config.capabilities.coordinator) throw new Error("本节点未启用 Coordinator");
      bridge(stream, await dialTcp("127.0.0.1", this.hooks.httpPort)); return;
    }
    if (service === "egress") {
      if (!this.config.capabilities.egress || !this.manifest.egress.healthy)
        throw Object.assign(new Error("本机 mihomo 出口当前不可用"), { code: "EGRESS_CAPABILITY_UNAVAILABLE", phase: "gateway_admission" });
      const lease=this.execution.beginWork({kind:"egress"});
      this.trackStream(stream,lease,true);
      try { bridge(stream,await lease.run(()=>connectProxy(this.proxyUrl))); }
      catch(error) {
        lease.release();
        this.event("egress_connect_error", this.localId, "出口代理连接失败", {
          code: (error as NodeJS.ErrnoException)?.code, phase: (error as { phase?: string })?.phase ?? "proxy_connect" });
        throw error;
      }
      return;
    }
    if (service === "artifact.read") {
      if(!this.config.capabilities.worker)throw new Error("WORKER_CAPABILITY_DISABLED");
      const lease=this.execution.beginWork({kind:"transfer"});
      this.trackStream(stream,lease);
      try {
        const file=await lease.run(()=>this.hooks.artifactRead(metadata));
        if (stream.destroyed) { file.destroy(); return; }
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
    const context=extra ? await this.trustedInvocation("copy_artifact",{workspace_id:input.destination_workspace_id},extra) : undefined;
    if(extra && !context)throw new Error("COPY_TASK_CONTEXT_REQUIRED");
    const request = { sourceNode: source.node, sourceWorkspace: source.local,
      sourcePath: input.source_path, destinationWorkspace: destination.local, destinationPath: input.destination_path,
      overwrite: input.overwrite === true, requestKey, context };
    if (context) {
      // A saved copy key is a receipt replay, not a new decision to continue the
      // Task. Resolve it before safe-intent retirement, just like executeRecorded.
      let saved: TransferView | null;
      try {
        saved = await this.request<TransferView | null>(destination.node, "artifact.lookup", request);
      } catch (error) {
        if (errorCode(error) === "COPY_REQUEST_KEY_REUSED")
          throw Object.assign(error as Error, { effect: "not_started" });
        throw Object.assign(
          new Error("COPY_RECEIPT_LOOKUP_FAILED: No new copy was sent; check the original key and destination before retrying.", { cause: error }),
          {
            code: "COPY_RECEIPT_LOOKUP_FAILED",
            effect: "not_started",
            details: {
              task_id: context.task_id,
              owner_node_id: destination.node,
              lookup_error: errorCode(error)
            }
          }
        );
      }
      if (saved) return saved;
    }
    const dispatch = async () => {
      if (context) {
        try {
          await this.sessionFeed?.recordTaskWork(context);
        } catch (admissionError) {
          const code = errorCode(admissionError);
          if (code !== "TASK_NOT_ACTIVE" && code !== "TASK_FINISHING") throw admissionError;
          // 结束任务只查询原回执；旧节点不支持查询时也绝不回退为启动复制。
          let saved: TransferView | null;
          try {
            saved = await this.request<TransferView | null>(destination.node, "artifact.lookup", request);
          } catch (lookupError) {
            if (errorCode(lookupError) === "COPY_REQUEST_KEY_REUSED")
              throw Object.assign(lookupError as Error, { effect: "not_started" });
            throw Object.assign(
              new Error("COPY_RECEIPT_LOOKUP_FAILED: 未发送新的复制请求；原回执暂时无法查询，请检查目标节点连接和版本。", { cause: lookupError }),
              {
                code: "COPY_RECEIPT_LOOKUP_FAILED",
                effect: "not_started",
                details: {
                  task_id: context.task_id,
                  owner_node_id: destination.node,
                  admission_error: code,
                  lookup_error: errorCode(lookupError)
                }
              }
            );
          }
          if (saved) return saved;
          throw admissionError;
        }
      }
      return this.request(destination.node, "artifact.copy", request);
    };
    // Cover authority admission through the owner receipt. The Worker separately
    // owns its accepted transfer lease until the copy itself reaches a terminal state.
    return context?.task_id
      ? this.execution.withWork({ kind: "transfer", taskId: context.task_id }, dispatch)
      : dispatch();
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
        failure=error instanceof PeerApplicationError
          ? `${error.code ?? "NODE_OPERATION_FAILED"} (${error.nodeId}): ${error.message}${error.details ? " " + JSON.stringify(error.details) : ""}`
          : error instanceof Error?error.message:String(error);
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
  private persistCache(value: NodeManifest[]): void {
    // 一次写入加一份最新快照，慢磁盘不会累积整个心跳历史。
    this.pendingCache=value;
    if(this.cacheWriting)return;
    this.cacheWriting=(async()=>{
      while(this.pendingCache){
        const snapshot=this.pendingCache;this.pendingCache=undefined;
        const temporary=temporaryPath(this.cacheFile);
        try{await writeFile(temporary,JSON.stringify(snapshot),{mode:0o600});await rename(temporary,this.cacheFile);}
        finally{await rm(temporary,{force:true});}
      }
    })().catch(error=>this.event("cache_error",this.localId,String(error))).finally(()=>{
      this.cacheWriting=undefined;
      if(this.pendingCache)this.persistCache(this.pendingCache);
    });
  }
  async close(): Promise<void> {
    if (this.stopped) return; this.stopped = true;
    clearInterval(this.heartbeat); clearInterval(this.probeTimer);
    for (const abort of this.aborts.values()) abort.abort();
    await Promise.allSettled(this.pendingTransfers.values());
    await this.sessionFeed?.close();
    await Promise.all([this.egress?.close(), this.ingress?.close()]);
    await this.transport.close();
    while(this.cacheWriting)await this.cacheWriting;
    await Promise.allSettled([this.releaseRecording]);
    this.transferStore.close();
    if(this.ownsExecution)await this.execution.close();
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

const moduleRequire=createRequire(import.meta.url);
let identityPromise: Promise<NonNullable<NodeManifest["runtime"]>> | undefined;
function runtimeIdentity(): Promise<NonNullable<NodeManifest["runtime"]>> {
  return identityPromise??=(async()=>{
    const packageFile=moduleRequire.resolve("better-sqlite3/package.json");
    const installed=JSON.parse(await readFile(packageFile,"utf8")) as {version:string};
    // Hash the addon this process loaded. The package may select a platform
    // prebuild, a Debug build or a Release build; a guessed path can identify
    // an unused binary, or prevent an otherwise healthy Core from starting.
    const entry=moduleRequire.cache[moduleRequire.resolve("better-sqlite3")];
    const pending=entry?[entry]:[];
    const visited=new Set<NodeModule>();
    const addons=new Set<string>();
    while(pending.length){
      const current=pending.pop()!;
      if(visited.has(current))continue;
      visited.add(current);
      if(current.filename.endsWith(".node"))addons.add(current.filename);
      pending.push(...current.children);
    }
    if(addons.size!==1)throw new Error("无法唯一识别本进程已加载的 SQLite 原生模块");
    const [sqliteNativeSha256,nodeSha256,packageLockSha256]=await Promise.all([
      hashFile([...addons][0]), hashFile(process.execPath), hashFile(moduleRequire.resolve("../../pnpm-lock.yaml")),
    ]);
    return {nodeVersion:process.versions.node,nodeAbi:process.versions.modules,sqlitePackageVersion:installed.version,
      sqliteNativeSha256,nodeSha256,packageLockSha256};
  })();
}
async function hashFile(path: string): Promise<string> {
  const hash=createHash("sha256");
  for await(const chunk of createReadStream(path))hash.update(chunk);
  return hash.digest("hex");
}
async function recordActiveRelease(stateDir: string, nodeId: string, version: string | undefined, runtime: NodeManifest["runtime"]): Promise<void> {
  if (!version) return;
  const path = join(stateDir, "active-release.json");
  const temporary = temporaryPath(path);
  let previous: { commit?: string; activatedAt?: string } | undefined;
  try { previous = JSON.parse(await readFile(path, "utf8")); } catch (error) { if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error; }
  const startedAt=new Date().toISOString();
  const value = {
    nodeId,
    commit: version,
    activatedAt: previous?.commit===version ? previous.activatedAt??startedAt : startedAt,
    startedAt,
    entrypoint: process.argv[1] ?? null,
    pid: process.pid,
    runtime,
  };
  try{await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });await rename(temporary, path);}
  finally{await rm(temporary,{force:true});}
}

function temporaryPath(path: string): string {
  return `${path}.${process.pid}.${randomUUID()}.tmp`;
}
