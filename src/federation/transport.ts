import { EventEmitter } from "node:events";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { connect, createServer, createSecureServer, constants,
  type ClientHttp2Session, type Http2Server, type Http2SecureServer,
  type ServerHttp2Stream, type ClientHttp2Stream, type Http2Session } from "node:http2";
import { Duplex, finished } from "node:stream";
import { connect as tlsConnect } from "node:tls";
import { isIP, type Socket } from "node:net";
import { posix, win32 } from "node:path";
import { connectSocket } from "../../node/network.mjs";
import type { FederationConfig, PeerConfig } from "./types.js";

export class NodeUnavailableError extends Error {
  readonly code = "NODE_UNAVAILABLE";
  constructor(readonly nodeId: string, message = `节点 ${nodeId} 当前离线。该节点的工作区和运行仍归原节点所有。`) { super(message); }
}
export class PeerApplicationError extends Error {
  readonly effect?: string;
  readonly retryHint?: string;
  readonly details?: Record<string, unknown>;
  constructor(readonly nodeId: string, message: string, readonly code?: string, envelope?: PeerErrorEnvelope) {
    super(message);
    this.name = "PeerApplicationError";
    this.effect = envelope?.effect;
    this.retryHint = envelope?.retryHint;
    this.details = envelope?.details;
  }
}
export class RpcInterruptedError extends Error {
  readonly code: string = "RPC_INTERRUPTED";
  constructor(readonly nodeId: string, readonly requestId: string, detail: string) {
    super(`${nodeId}: ${detail}。调用可能已在目标节点执行；使用原工作区查询进程或任务状态。`);
  }
}
export class RpcRequestTimeoutError extends RpcInterruptedError {
  readonly code = "REQUEST_TIMEOUT";
  constructor(nodeId: string, requestId: string, detail = "等待返回超时") {
    super(nodeId, requestId, detail);
    this.name = "RpcRequestTimeoutError";
    this.message = `REQUEST_TIMEOUT: ${this.message}`;
  }
}
interface PeerErrorEnvelope { message: string; code?: string; effect?: string; retryHint?: string; details?: Record<string, unknown> }
interface Frame { id?: string; method?: string; params?: unknown; result?: unknown; error?: PeerErrorEnvelope; }
export interface PeerProgressNotification {
  method: "notifications/progress";
  params: { progressToken: string | number; progress: number; total?: number; message?: string };
}
interface Pending { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; startedAt: number;
  onProgress?: (notification: PeerProgressNotification) => void | Promise<void> }
type H2Stream = ServerHttp2Stream | ClientHttp2Stream;
export type RpcHandler = (method: string, params: any, peerId: string,
  context?: { signal: AbortSignal; requestId?: string; notify(notification: unknown): void }) => unknown | Promise<unknown>;
export type StreamHandler = (service: string, metadata: any, stream: Duplex, peerId: string) => void | Promise<void>;
const MAX_FRAME = 8 * 1024 * 1024;
const MAX_STREAM_FRAME = 16 * 1024 * 1024;
const CONTROL_FRAME_BYTES = 64 * 1024;
const MAX_QUEUED_CONTROL_BYTES = 2 * 1024 * 1024;
const MAX_PENDING_CALLS = 256;
const MAX_LARGE_FRAMES = 8;
const FRAME_SERVICE = "$frame.v1";
const FEATURES = "frame-stream-v1";

function progressNotification(value: unknown): PeerProgressNotification | undefined {
  if (!value || typeof value !== "object") return;
  const notification = value as Record<string, unknown>;
  if (notification.method !== "notifications/progress" || !notification.params || typeof notification.params !== "object") return;
  const params = notification.params as Record<string, unknown>;
  const token = params.progressToken;
  if (!(typeof token === "string" && token.length <= 1024 || typeof token === "number" && Number.isFinite(token))) return;
  if (typeof params.progress !== "number" || !Number.isFinite(params.progress) || params.progress < 0) return;
  return { method: "notifications/progress", params: { progressToken: token, progress: params.progress,
    ...(typeof params.total === "number" && Number.isFinite(params.total) && params.total >= params.progress ? { total: params.total } : {}),
    ...(typeof params.message === "string" ? { message: params.message.slice(0, 512) } : {}) } };
}

function executionConflictDetails(error: Record<string, unknown>, recovery: Record<string, unknown>): Record<string, unknown> {
  const source = error.details && typeof error.details === "object" && !Array.isArray(error.details)
    ? error.details as Record<string, unknown> : {};
  const details: Record<string, unknown> = {};
  const text = (value: unknown, maximum: number): value is string => typeof value === "string"
    && value.length > 0 && value.length <= maximum && Buffer.byteLength(value) <= maximum && !/[\u0000-\u001f\u007f]/u.test(value);
  const identity = (value: unknown): value is string => text(value, 256) && /^[A-Za-z0-9][A-Za-z0-9_.:%~-]*$/u.test(value);
  // Keep the existing recovery identities, but do not forward opaque legacy
  // resource containers or arbitrary next_action bodies for this typed error.
  for (const [key, value] of Object.entries(recovery)) {
    if (!["claim_id", "conflicts", "resources", "scope", "next_action"].includes(key) && identity(value)) details[key] = value;
  }
  const next = recovery.next_action as { tool?: unknown; arguments?: Record<string, unknown> } | undefined;
  if (next?.tool === "workspace_context" && next.arguments?.action === "status"
    && identity(next.arguments.operation_id) && identity(next.arguments.workspace_id)) details.next_action = {
      tool: "workspace_context", arguments: { action: "status", operation_id: next.arguments.operation_id, workspace_id: next.arguments.workspace_id },
    };
  const claimId = error.claimId ?? source.claim_id;
  if (identity(claimId)) details.claim_id = claimId;
  if (text(source.type, 64) && /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u.test(source.type)) details.type = source.type;
  for (const key of ["operationId", "taskId"]) {
    if (source[key] === null || identity(source[key])) details[key] = source[key];
  }
  if (source.acquiredAt === null || text(source.acquiredAt, 64) && Number.isFinite(Date.parse(source.acquiredAt))) details.acquiredAt = source.acquiredAt;
  if (typeof source.queued === "boolean") details.queued = source.queued;
  // Remote paths are opaque identities; never resolve them on this node.
  // A malformed/oversized list is omitted as a whole, never presented as a partial scope.
  for (const key of ["blockedResources", "requested"]) {
    const values = source[key];
    if (!Array.isArray(values) || values.length > 128) continue;
    const resources: Record<string, unknown>[] = [];
    for (const raw of values) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) break;
      const resource = raw as Record<string, unknown>;
      if (resource.access !== "read" && resource.access !== "write") break;
      if (resource.kind === "named" && text(resource.key, 512)) resources.push({ kind: resource.kind, key: resource.key, access: resource.access });
      else if ((resource.kind === "file" || resource.kind === "tree") && text(resource.path, 4096)
        && (posix.isAbsolute(resource.path) || win32.isAbsolute(resource.path))) resources.push({ kind: resource.kind, path: resource.path, access: resource.access });
      else break;
    }
    if (resources.length === values.length && Buffer.byteLength(JSON.stringify({ ...details, [key]: resources })) <= 16 * 1024) details[key] = resources;
  }
  return details;
}

function peerError(error: unknown): PeerErrorEnvelope {
  const value = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const envelope: PeerErrorEnvelope = {
    message: (error instanceof Error ? error.message : String(error)).slice(0, 8192),
    code: typeof value.code === "string" ? value.code.slice(0, 128) : "NODE_OPERATION_FAILED",
  };
  // ExecutionConflictError's local message embeds its full details, including a
  // private task title. Cross-node recovery uses the typed projection below.
  if (envelope.code === "EXECUTION_CONFLICT") envelope.message = "执行资源暂时不可用；占用身份见错误详情。";
  if (["not_started", "started", "completed", "partial", "unknown"].includes(String(value.effect))) envelope.effect = String(value.effect);
  if (["retry_later", "query_original", "do_not_retry", "fix_input", "retry_same_key"].includes(String(value.retryHint))) envelope.retryHint = String(value.retryHint);
  if ((value.details && typeof value.details === "object") || envelope.code === "EXECUTION_CONFLICT") {
    // 只传递恢复和资源身份；绝不把任意异常对象、凭据或循环引用放入跨节点帧。
    const allowed = ["operation_id", "owner_node_id", "receipt_node_id", "task_id", "session_id", "member_id", "stage", "dispatch_state", "next_action", "leaseId", "conflicts", "resources", "scope", "claim_id"];
    try {
      const recovery = Object.fromEntries(Object.entries(value.details ?? {}).filter(([key]) => allowed.includes(key)));
      const details = envelope.code === "EXECUTION_CONFLICT" ? executionConflictDetails(value, recovery) : recovery;
      const encoded = JSON.stringify(details);
      if (Buffer.byteLength(encoded) <= 16 * 1024) envelope.details = JSON.parse(encoded);
    } catch {}
  }
  return envelope;
}

function unsentError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, effect: "not_started", retryHint: "retry_later", details: { dispatch_state: "not_sent" } });
}

function interruptedStream(message: string, cause?: Error): Error {
  return Object.assign(new Error(message, cause ? { cause } : undefined), {
    code: "RPC_INTERRUPTED", effect: "unknown", retryHint: "query_original",
  });
}

/** One bidirectional control stream and independent flow-controlled data streams per peer.
 * A desktop behind NAT can receive calls AND byte streams on its outbound connection. */
export class PeerLink extends EventEmitter {
  readonly id = randomUUID();
  readonly connectedAt = Date.now();
  readonly pending = new Map<string, Pending>();
  latencyMs = 0;
  lastSeen = Date.now();
  closeReason?: string;
  private lastSeenAt = performance.now();
  private pingSentAt = 0;
  private text = "";
  private closed = false;
  private pingOutstanding = false;
  private consecutivePingErrors = 0;
  private queuedControlBytes = 0;
  private outgoingLargeFrames = 0;
  private readonly incoming = new Map<string, AbortController>();
  private readonly heartbeat: NodeJS.Timeout;
  constructor(
    readonly peerId: string,
    readonly session: Http2Session,
    readonly control: H2Stream,
    readonly client: ClientHttp2Session | undefined,
    private readonly owner: PeerTransport,
    readonly frameStreams = false,
  ) {
    super();
    control.setEncoding("utf8");
    control.on("data", (part: string) => this.receive(part));
    control.on("error", (err) => this.close(`control_error: ${err?.message || "error"}`));
    control.on("close", () => this.close("control_close"));
    session.on("error", (err) => this.close(`session_error: ${err?.message || "error"}`));
    session.on("goaway", (errorCode, lastStreamID) => this.close(`session_goaway (code=${errorCode}, lastStreamID=${lastStreamID})`));
    this.heartbeat = setInterval(() => {
      const now = performance.now();
      const heartbeatMs = owner.config.heartbeatMs;
      // 一次迟到的心跳不得中断当前连接上的全部 RPC。
      // 允许短暂的调度停顿、网络拥塞和网关瞬时波动。
      const hardTimeout = Math.max(heartbeatMs * 6, 45_000);
      if (this.pingOutstanding) {
        if (now - this.pingSentAt >= hardTimeout) {
          this.close(`heartbeat_timeout (${Math.round(now - this.pingSentAt)}ms)`);
        }
        return;
      }
      if (now - this.lastSeenAt >= hardTimeout) {
        this.close(`inactivity_timeout (${Math.round(now - this.lastSeenAt)}ms)`);
        return;
      }
      this.pingOutstanding = true;
      this.pingSentAt = now;
      try {
        session.ping((error, duration) => {
          this.pingOutstanding = false;
          if (this.closed) return;
          if (error) {
            this.consecutivePingErrors++;
            if (session.closed || session.destroyed || this.consecutivePingErrors >= 3) {
              this.close(`ping_error: ${error.message}`);
            }
          } else {
            this.consecutivePingErrors = 0;
            this.latencyMs = duration;
            this.lastSeen = Date.now();
            this.lastSeenAt = performance.now();
          }
        });
      } catch (err) {
        this.close(`ping_exception: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, owner.config.heartbeatMs);
    this.heartbeat.unref();
  }
  get connected(): boolean { return !this.closed; }
  diagnostics(): Record<string, unknown> {
    const now = performance.now();
    return { linkId: this.id, connectedAt: this.connectedAt, lastSeen: this.lastSeen,
      direction: this.client ? "outgoing" : "incoming", pendingRpc: this.pending.size,
      incomingRpc: this.incoming.size, queuedControlBytes: this.queuedControlBytes,
      outgoingLargeFrames: this.outgoingLargeFrames, frameStreams: this.frameStreams,
      oldestRpcMs: this.pending.size ? Math.round(Math.max(...[...this.pending.values()].map(value => now - value.startedAt))) : 0,
      pingOutstandingMs: this.pingOutstanding ? Math.round(now - this.pingSentAt) : 0 };
  }
  private receive(part: string): void {
    this.lastSeen = Date.now();
    this.lastSeenAt = performance.now();
    this.text += part;
    for (;;) {
      const end = this.text.indexOf("\n");
      if (end < 0) {
        if (Buffer.byteLength(this.text) > MAX_FRAME) {
          this.close("frame_too_large");
        }
        break;
      }
      const line = this.text.slice(0, end); this.text = this.text.slice(end + 1);
      if (Buffer.byteLength(line) > MAX_FRAME) {
        this.close("frame_too_large");
        return;
      }
      this.receiveFrame(line);
    }
  }
  receiveFrame(text: string): void {
    let frame: Frame;
    try { frame = JSON.parse(text); } catch { this.close("invalid_json_frame"); return; }
    if (!frame || typeof frame !== "object") { this.close("malformed_frame"); return; }
    if (frame.method === "$cancel") {
      const id = (frame.params as { id?: unknown } | undefined)?.id;
      if (typeof id === "string") this.incoming.get(id)?.abort(new RpcRequestTimeoutError(this.peerId, id, "调用方已结束等待"));
      return;
    }
    if (frame.method === "$progress") {
      const params = frame.params as { id?: unknown; notification?: unknown } | undefined;
      const progress = progressNotification(params?.notification);
      const pending = typeof params?.id === "string" ? this.pending.get(params.id) : undefined;
      if (progress && pending?.onProgress) {
        try { void Promise.resolve(pending.onProgress(progress)).catch(() => {}); } catch {}
      }
      return;
    }
    if (typeof frame.method === "string") void this.dispatch(frame);
    else if (typeof frame.id === "string") {
      const pending = this.pending.get(frame.id);
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(frame.id);
      if (frame.error) {
        const error = peerError(frame.error);
        pending.reject(new PeerApplicationError(this.peerId,
          error.code === "EXECUTION_CONFLICT" ? error.message : frame.error.message, frame.error.code, error));
      }
      else pending.resolve(frame.result);
    }
  }
  private async dispatch(frame: Frame): Promise<void> {
    const controller = new AbortController();
    try {
      if (frame.id && frame.method !== "$openStream") {
        if (this.incoming.size >= MAX_PENDING_CALLS) throw unsentError("PEER_BUSY", "节点请求队列已满，请稍后重试。");
        this.incoming.set(frame.id, controller);
      }
      const result = frame.method === "$openStream"
        ? await this.owner.openReverse(this, frame.params as { id: string; service: string; metadata: unknown })
        : await this.owner.handler(frame.method!, frame.params, this.peerId, { signal: controller.signal, requestId: frame.id,
          notify: value => {
            const notification = progressNotification(value);
            if (frame.id && this.frameStreams && notification && !controller.signal.aborted)
              this.notify("$progress", { id: frame.id, notification });
          } });
      if (frame.id && this.connected && !controller.signal.aborted) {
        try { await this.send({ id: frame.id, result: result ?? null }); }
        catch (error) {
          // 工作已经返回，正文交付失败须保留效果待核对，不能回报“未执行”。
          throw Object.assign(error instanceof Error ? error : new Error(String(error)), { effect: "unknown", retryHint: "query_original" });
        }
      }
    } catch (error) {
      if (frame.id && this.connected && !controller.signal.aborted) await this.send({ id: frame.id, error: peerError(error) }).catch(() => {});
    } finally { if (frame.id) this.incoming.delete(frame.id); }
  }
  async send(frame: Frame): Promise<void> {
    if (this.closed) throw Object.assign(new NodeUnavailableError(this.peerId), { effect: "not_started", retryHint: "retry_later" });
    const text = JSON.stringify(frame) + "\n";
    const bytes = Buffer.byteLength(text);
    if (this.frameStreams && bytes > CONTROL_FRAME_BYTES) {
      if (bytes > MAX_STREAM_FRAME) throw unsentError("PEER_PAYLOAD_TOO_LARGE", "节点消息超过 16 MiB，请使用文件传输接口。");
      if (this.outgoingLargeFrames >= MAX_LARGE_FRAMES) throw unsentError("PEER_BUSY", "节点大正文传输已满，请稍后重试。");
      this.outgoingLargeFrames++;
      try { await this.owner.sendFrameStream(this, text); }
      finally { this.outgoingLargeFrames--; }
      return;
    }
    if (bytes > MAX_FRAME) throw unsentError("PEER_PAYLOAD_TOO_LARGE", "目标节点仍使用 8 MiB 消息协议，请更新节点或使用文件传输接口。");
    if (this.queuedControlBytes + bytes > Math.max(MAX_QUEUED_CONTROL_BYTES, bytes)) throw unsentError("PEER_BUSY", "节点控制消息队列已满，请稍后重试。");
    this.queuedControlBytes += bytes;
    try { await new Promise<void>((resolve, reject) => this.control.write(text, (error) => error ? reject(error) : resolve())); }
    finally { this.queuedControlBytes -= bytes; }
  }
  call<T = unknown>(method: string, params: unknown, timeoutMs = this.owner.config.rpcTimeoutMs,
    onProgress?: (notification: PeerProgressNotification) => void | Promise<void>, signal?: AbortSignal): Promise<T> {
    if (this.closed) return Promise.reject(Object.assign(new NodeUnavailableError(this.peerId), { effect: "not_started", retryHint: "retry_later" }));
    if (signal?.aborted) return Promise.reject(unsentError("REQUEST_CANCELLED", "调用在发送前已取消。"));
    if (this.pending.size >= MAX_PENDING_CALLS) return Promise.reject(unsentError("PEER_BUSY", "节点调用数量已达上限，请稍后重试。"));
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, value?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer); signal?.removeEventListener("abort", aborted); this.pending.delete(id);
        error ? reject(error) : resolve(value as T);
      };
      const aborted = () => {
        if (this.frameStreams) this.notify("$cancel", { id });
        finish(Object.assign(new Error("调用方已取消等待；已受理的修改继续保留原操作身份。"), {
          code: "REQUEST_CANCELLED", effect: "unknown", retryHint: "query_original",
        }));
      };
      const timer = setTimeout(() => {
        this.owner.emit("rpcTimeout", this.peerId, { method, requestId: id, timeoutMs, ...this.diagnostics() });
        if (this.frameStreams) this.notify("$cancel", { id });
        // 单个慢请求只结束自己的等待者；共享连接继续承载心跳和其他请求。
        finish(new RpcRequestTimeoutError(this.peerId, id));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve: value => finish(undefined, value), reject: error => finish(error),
        timer, startedAt: performance.now(), onProgress });
      signal?.addEventListener("abort", aborted, { once: true });
      void this.send({ id, method, params }).catch((error) => finish(error));
    });
  }
  notify(method: string, params: unknown): void { void this.send({ method, params }).catch(() => {}); }
  openStream(service: string, metadata: unknown = {}): Promise<Duplex> { return this.owner.openStream(this, service, metadata); }
  close(reason = "normal_close"): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    const diagnostics = this.diagnostics();
    clearInterval(this.heartbeat);
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer); p.reject(new RpcInterruptedError(this.peerId, id, `连接中断 (${reason})`));
    }
    this.pending.clear();
    for (const controller of this.incoming.values()) controller.abort(new Error(`连接中断 (${reason})`));
    this.incoming.clear();
    this.control.destroy(); this.session.destroy();
    this.emit("closed", { peerId: this.peerId, reason, ...diagnostics });
  }
}

export class PeerTransport extends EventEmitter {
  readonly links = new Map<string, PeerLink>();
  private readonly sessions = new Set<Http2Session>();
  private readonly reconnects = new Map<string, NodeJS.Timeout>();
  private readonly dialing = new Map<string, ClientHttp2Session>();
  private readonly opening = new Set<string>();
  private readonly streams = new Map<string, { link: PeerLink; resolve: (stream: Duplex) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private readonly incomingFrameCounts = new Map<string, number>();
  private server?: Http2Server | Http2SecureServer;
  private stopped = true;
  private peerUrls = new Map<string, string>();
  constructor(readonly config: FederationConfig, private readonly token: string,
    readonly handler: RpcHandler, private readonly onStream: StreamHandler) { super(); this.peerUrls = new Map(config.peers.map((peer) => [peer.id, peer.url])); }
  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    const tls = this.config.tls;
    this.server = tls ? createSecureServer({ cert: readFileSync(tls.cert), key: readFileSync(tls.key), allowHTTP1: false }) : createServer();
    this.server.on("session", (session) => {
      this.sessions.add(session);
      session.on("error", () => session.destroy());
      session.on("close", () => this.sessions.delete(session));
    });
    this.server.on("stream", (stream, headers) => {
      // A failed source admission must reset the stream, not look like a clean empty body.
      void this.accept(stream as ServerHttp2Stream, headers)
        .catch(error => stream.destroy(error instanceof Error ? error : new Error(String(error))));
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.config.port, this.config.host, () => { this.server!.off("error", reject); resolve(); });
    });
    this.server.on("error", (error) => this.emit("fault", error));
    for (const peer of this.config.peers) this.dial(peer);
  }
  get address(): number { return (this.server?.address() as { port?: number } | null)?.port ?? this.config.port; }
  private authorized(value: unknown): boolean {
    if (typeof value !== "string") return false;
    const a = Buffer.from(value); const b = Buffer.from(`Bearer ${this.token}`);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  private async accept(stream: ServerHttp2Stream, headers: Record<string, unknown>): Promise<void> {
    stream.on("error", () => {});
    const peerId = headers["x-quaymesh-node"];
    if (!this.authorized(headers.authorization) || typeof peerId !== "string" || peerId === this.config.nodeId
      || !this.config.peers.some((p) => p.id === peerId)) {
      stream.respond({ ":status": 401 }); stream.end(); return;
    }
    if (headers[":path"] === "/control") {
      const existing = this.links.get(peerId);
      const peerConfig = this.config.peers.find((p) => p.id === peerId);
      const isNatPeer = !peerConfig?.url;
      // Both sides may dial. Keep the connection initiated by the lexically smaller ID.
      if (!isNatPeer && existing?.connected && (peerId > this.config.nodeId || !existing.client)) {
        stream.respond({ ":status": 409 }); stream.end(); return;
      }
      existing?.close("replaced_by_incoming_control");
      stream.respond({ ":status": 200, "x-quaymesh-node": this.config.nodeId, "x-quaymesh-features": FEATURES });
      this.install(new PeerLink(peerId, stream.session!, stream, undefined, this, String(headers["x-quaymesh-features"] ?? "").split(",").includes(FEATURES)));
      return;
    }
    if (headers[":path"] !== "/stream") { stream.respond({ ":status": 404 }); stream.end(); return; }
    const link = this.links.get(peerId);
    if (!link || link.session !== stream.session) { stream.respond({ ":status": 409 }); stream.end(); return; }
    const reverseId = headers["x-quaymesh-reverse"];
    if (typeof reverseId === "string") {
      const pending = this.streams.get(reverseId);
      if (!pending || pending.link !== link) { stream.respond({ ":status": 404 }); stream.end(); return; }
      this.streams.delete(reverseId); clearTimeout(pending.timer);
      stream.respond({ ":status": 200 }); pending.resolve(stream); return;
    }
    const service = headers["x-quaymesh-service"];
    const metadata = this.decodeMetadata(headers["x-quaymesh-metadata"]);
    if (typeof service !== "string") { stream.respond({ ":status": 400 }); stream.end(); return; }
    stream.respond({ ":status": 200 });
    await this.receiveStream(link, service, metadata, stream);
  }
  private decodeMetadata(header: unknown): unknown {
    return typeof header === "string" ? JSON.parse(Buffer.from(header, "base64url").toString()) : {};
  }
  private install(link: PeerLink): void {
    this.links.set(link.peerId, link);
    const timer = this.reconnects.get(link.peerId); if (timer) clearTimeout(timer);
    this.reconnects.delete(link.peerId);
    link.once("closed", (info?: { peerId: string; linkId: string; reason?: string } | string) => {
      if (this.links.get(link.peerId) !== link) return;
      this.links.delete(link.peerId);
      for (const [id, pending] of this.streams) if (pending.link === link) {
        clearTimeout(pending.timer); pending.reject(new NodeUnavailableError(link.peerId)); this.streams.delete(id);
      }
      const reason = typeof info === "object" ? info?.reason : (typeof info === "string" ? info : link.closeReason);
      this.emit("offline", link.peerId, { ...link.diagnostics(), ...(typeof info === "object" ? info : {}), linkId: link.id, reason });
      const peer = this.config.peers.find((p) => p.id === link.peerId); if (peer) this.schedule(peer);
    });
    this.emit("online", link);
  }
  private schedule(peer: PeerConfig, attempt = 0): void {
    if (this.stopped || this.reconnects.has(peer.id)) return;
    const timer = setTimeout(() => {
      this.reconnects.delete(peer.id); const current = this.config.peers.find((entry) => entry.id === peer.id); if (current) this.dial(current, attempt + 1);
    }, Math.min(15_000, 500 * 2 ** Math.min(attempt, 5)) + Math.random() * 250);
    timer.unref(); this.reconnects.set(peer.id, timer);
  }
  private async dial(peer: PeerConfig, attempt = 0): Promise<void> {
    if (this.stopped || this.opening.has(peer.id) || this.dialing.has(peer.id) || this.links.get(peer.id)?.connected) return;
    if (!peer.url) return; // Addressless peers (desktop behind NAT) connect outwards.
    let installed = false;
    let session: ClientHttp2Session;
    let socket:Socket|undefined;
    this.opening.add(peer.id);
    try {
      const url = new URL(peer.url);
      const tls = this.config.tls?.ca ? {ca:readFileSync(this.config.tls.ca)} : {};
      if (this.config.socksProxy) {
        socket = await connectSocket(url.hostname.replace(/^\[|\]$/g,""), Number(url.port || (url.protocol === "https:" ? 443 : 80)),
          {socksUrl:this.config.socksProxy, timeoutMs:8000});
        if (this.stopped || !this.config.peers.some(item => item.id === peer.id && item.url === peer.url)) { socket.destroy(); return; }
        const connection = url.protocol === "https:"
          ? tlsConnect({socket, servername:isIP(url.hostname) ? undefined : url.hostname, ALPNProtocols:["h2"], ...tls})
          : socket;
        session = connect(peer.url, {...tls, createConnection:() => connection});
      } else session = connect(peer.url, tls);
    } catch (error) {
      socket?.destroy(); this.emit("peerError",peer.id,error); this.schedule(peer,attempt); return;
    } finally { this.opening.delete(peer.id); }
    this.dialing.set(peer.id, session);
    this.sessions.add(session);
    const timer = setTimeout(() => session.destroy(), 10_000); timer.unref();
    session.on("error", (error) => { this.emit("peerError", peer.id, error); session.destroy(); });
    session.on("close", () => {
      clearTimeout(timer); this.sessions.delete(session);
      if (this.dialing.get(peer.id) === session) this.dialing.delete(peer.id);
      if (!installed) this.schedule(peer, attempt);
    });
    session.once("connect", () => {
      const stream = session.request({ ":method": "POST", ":path": "/control", authorization: `Bearer ${this.token}`, "x-quaymesh-node": this.config.nodeId, "x-quaymesh-features": FEATURES }, { endStream: false });
      stream.on("error", () => session.destroy());
      stream.once("response", (headers) => {
        clearTimeout(timer);
        if (this.dialing.get(peer.id) === session) this.dialing.delete(peer.id);
        if (headers[":status"] !== 200 || headers["x-quaymesh-node"] !== peer.id) { session.destroy(); return; }
        const existing = this.links.get(peer.id);
        if (existing?.connected && this.config.nodeId > peer.id) { session.destroy(); return; }
        existing?.close("replaced_by_outgoing_control"); installed = true;
        this.install(new PeerLink(peer.id, session, stream, session, this, String(headers["x-quaymesh-features"] ?? "").split(",").includes(FEATURES)));
      });
    });
  }
  updatePeers(peers: PeerConfig[]): void {
    this.config.peers = peers;
    for (const [id, link] of this.links) { const peer = peers.find((p) => p.id === id); if (!peer || this.peerUrls.get(id) !== peer.url) link.close(); }
    this.peerUrls = new Map(peers.map((peer) => [peer.id, peer.url]));
    for (const [id, timer] of this.reconnects) if (!peers.some((p) => p.id === id)) { clearTimeout(timer); this.reconnects.delete(id); }
    for (const peer of peers) this.dial(peer);
  }
  async openStream(link: PeerLink, service: string, metadata: unknown): Promise<Duplex> {
    if (!link.connected) throw new NodeUnavailableError(link.peerId);
    if (link.client) return this.requestStream(link, service, metadata);
    const id = randomUUID();
    const stream = new Promise<Duplex>((resolve, reject) => {
      const timer = setTimeout(() => { this.streams.delete(id); reject(new NodeUnavailableError(link.peerId, "建立传输流超时")); }, 10_000);
      timer.unref(); this.streams.set(id, { link, resolve, reject, timer });
    });
    // Register the receiving slot BEFORE asking the remote client to open it.
    void link.call("$openStream", { id, service, metadata }, 10_000).catch((error) => {
      const pending = this.streams.get(id); if (pending) { clearTimeout(pending.timer); this.streams.delete(id); pending.reject(error); }
    });
    return stream;
  }
  private requestStream(link: PeerLink, service: string, metadata: unknown, reverse?: string): Promise<ClientHttp2Stream> {
    return new Promise((resolve, reject) => {
      const stream = link.client!.request({ ":method": "POST", ":path": "/stream", authorization: `Bearer ${this.token}`,
        "x-quaymesh-node": this.config.nodeId,
        ...(reverse ? { "x-quaymesh-reverse": reverse } : { "x-quaymesh-service": service, "x-quaymesh-metadata": Buffer.from(JSON.stringify(metadata)).toString("base64url") }),
      }, { endStream: false });
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (error) { reject(error); stream.close(constants.NGHTTP2_CANCEL); }
        else resolve(stream);
      };
      const timer = setTimeout(() => finish(interruptedStream("传输流握手超时")), 10_000); timer.unref();
      stream.on("error", error => finish(interruptedStream("传输流在响应头前出错", error)));
      stream.once("aborted", () => finish(interruptedStream("传输流在响应头前被取消")));
      stream.once("response", (headers) => {
        finish(headers[":status"] !== 200 ? new Error(`传输流被拒绝 (${headers[":status"]})`) : undefined);
      });
      stream.once("close", () => finish(interruptedStream(`传输流在响应头前关闭 (rstCode=${stream.rstCode})`)));
    });
  }
  async openReverse(link: PeerLink, params: { id: string; service: string; metadata: unknown }): Promise<void> {
    if (!link.client) throw new Error("反向传输需要主动连接");
    const stream = await this.requestStream(link, params.service, params.metadata, params.id);
    void this.receiveStream(link, params.service, params.metadata, stream).catch((error) => stream.destroy(error));
  }
  private async receiveStream(link: PeerLink, service: string, metadata: unknown, stream: Duplex): Promise<void> {
    if (service !== FRAME_SERVICE) { await this.onStream(service, metadata, stream, link.peerId); return; }
    if (!link.frameStreams) throw new Error("节点未协商正文流协议");
    const active = this.incomingFrameCounts.get(link.id) ?? 0;
    if (active >= MAX_LARGE_FRAMES) throw new Error("节点正文流接收数量已达上限");
    this.incomingFrameCounts.set(link.id, active + 1);
    const timer = setTimeout(() => stream.destroy(new Error("节点正文流接收超时")), Math.max(10_000, this.config.rpcTimeoutMs));
    timer.unref();
    try {
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > MAX_STREAM_FRAME) throw new Error("节点正文流超过 16 MiB");
        chunks.push(buffer);
      }
      link.receiveFrame(Buffer.concat(chunks, bytes).toString("utf8"));
      stream.end();
    } finally {
      clearTimeout(timer);
      const count = (this.incomingFrameCounts.get(link.id) ?? 1) - 1;
      if (count) this.incomingFrameCounts.set(link.id, count); else this.incomingFrameCounts.delete(link.id);
    }
  }
  async sendFrameStream(link: PeerLink, text: string): Promise<void> {
    const stream = await this.openStream(link, FRAME_SERVICE, {});
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        stream.off("error", failed); stream.off("close", closed);
        if (error) { stream.destroy(); reject(error); } else resolve();
      };
      const failed = (error: Error) => finish(interruptedStream("节点正文流传输中断", error));
      const closed = () => finish(interruptedStream("节点正文流在发送完成前关闭"));
      const timer = setTimeout(() => finish(interruptedStream("节点正文流发送超时")), Math.max(10_000, this.config.rpcTimeoutMs));
      timer.unref();
      stream.once("error", failed); stream.once("close", closed);
      // 数据流按 HTTP/2 帧调度，小控制消息无需排在整段 JSON 正文之后。
      stream.end(text, () => finish());
    });
  }
  waitForLink(peerId: string, timeoutMs: number): Promise<PeerLink | undefined> {
    const current = this.links.get(peerId);
    if (current?.connected) return Promise.resolve(current);
    if (timeoutMs <= 0) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const finish = (link?: PeerLink) => {
        clearTimeout(timer);
        this.off("online", onOnline);
        resolve(link?.connected ? link : undefined);
      };
      const onOnline = (link: PeerLink) => { if (link.peerId === peerId) finish(link); };
      const timer = setTimeout(() => finish(this.links.get(peerId)), timeoutMs);
      timer.unref?.();
      this.on("online", onOnline);
    });
  }
  async close(): Promise<void> {
    this.stopped = true;
    for (const timer of this.reconnects.values()) clearTimeout(timer);
    this.reconnects.clear();
    this.dialing.clear();
    for (const link of this.links.values()) link.close("transport_closed");
    for (const session of this.sessions) session.destroy();
    for (const pending of this.streams.values()) { clearTimeout(pending.timer); pending.reject(new Error("服务停止")); }
    this.streams.clear();
    if (this.server?.listening) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }
}

/** pipe() supplies backpressure and half-close; only orderly closes drain queued output. */
export function bridge(left: Duplex, right: Duplex): void {
  const closePeer = (source: Duplex, destination: Duplex): void => {
    // HTTP/2 CANCEL can mark both halves finished without emitting an error.
    const reset = "rstCode" in source && typeof source.rstCode === "number" && source.rstCode !== 0;
    if (source.readableEnded && source.writableFinished && !source.errored && !reset
      && !destination.writableFinished && !destination.destroyed) {
      // pipe() has already ended this writable. Its source may close before the
      // final bytes leave an HTTP/2 flow-control queue. Do not discard that tail.
      const cleanup = finished(destination, { readable: false }, () => {
        cleanup();
        destination.destroy();
      });
      return;
    }
    destination.destroy();
  };
  left.on("error", () => right.destroy()); right.on("error", () => left.destroy());
  left.on("close", () => closePeer(left, right)); right.on("close", () => closePeer(right, left));
  left.pipe(right); right.pipe(left);
}
