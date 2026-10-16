import { EventEmitter } from "node:events";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { connect, createServer, createSecureServer, constants,
  type ClientHttp2Session, type Http2Server, type Http2SecureServer,
  type ServerHttp2Stream, type ClientHttp2Stream, type Http2Session } from "node:http2";
import { Duplex } from "node:stream";
import { connect as tlsConnect } from "node:tls";
import { isIP, type Socket } from "node:net";
import { connectSocket } from "../../node/network.mjs";
import type { FederationConfig, PeerConfig } from "./types.js";

export class NodeUnavailableError extends Error {
  readonly code = "NODE_UNAVAILABLE";
  constructor(readonly nodeId: string, message = `节点 ${nodeId} 当前离线。该节点的工作区和运行仍归原节点所有。`) { super(message); }
}
export class PeerApplicationError extends Error {
  constructor(readonly nodeId: string, message: string, readonly code?: string) {
    super(message);
    this.name = "PeerApplicationError";
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
interface Frame { id?: string; method?: string; params?: unknown; result?: unknown; error?: { message: string; code?: string }; }
interface Pending { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
type H2Stream = ServerHttp2Stream | ClientHttp2Stream;
export type RpcHandler = (method: string, params: any, peerId: string) => unknown | Promise<unknown>;
export type StreamHandler = (service: string, metadata: any, stream: Duplex, peerId: string) => void | Promise<void>;
const MAX_FRAME = 8 * 1024 * 1024;

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
  private readonly heartbeat: NodeJS.Timeout;
  constructor(
    readonly peerId: string,
    readonly session: Http2Session,
    readonly control: H2Stream,
    readonly client: ClientHttp2Session | undefined,
    private readonly owner: PeerTransport,
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
      let frame: Frame;
      try { frame = JSON.parse(line); } catch { this.close("invalid_json_frame"); return; }
      if (!frame || typeof frame !== "object") { this.close("malformed_frame"); return; }
      if (typeof frame.method === "string") {
        void this.dispatch(frame);
      } else if (typeof frame.id === "string") {
        const pending = this.pending.get(frame.id);
        if (!pending) continue;
        clearTimeout(pending.timer); this.pending.delete(frame.id);
        if (frame.error) pending.reject(new PeerApplicationError(this.peerId, frame.error.message, frame.error.code));
        else pending.resolve(frame.result);
      }
    }
  }
  private async dispatch(frame: Frame): Promise<void> {
    try {
      const result = frame.method === "$openStream"
        ? await this.owner.openReverse(this, frame.params as { id: string; service: string; metadata: unknown })
        : await this.owner.handler(frame.method!, frame.params, this.peerId);
      if (frame.id && this.connected) await this.send({ id: frame.id, result: result ?? null });
    } catch (error) {
      if (frame.id && this.connected) await this.send({ id: frame.id, error: {
        message: error instanceof Error ? error.message : String(error),
        code: error && typeof error === "object" && "code" in error ? String(error.code) : "NODE_OPERATION_FAILED",
      } }).catch(() => {});
    }
  }
  async send(frame: Frame): Promise<void> {
    if (this.closed) throw new NodeUnavailableError(this.peerId);
    const text = JSON.stringify(frame) + "\n";
    if (Buffer.byteLength(text) > MAX_FRAME) throw new Error("节点消息超过 8 MiB，请使用文件传输接口。");
    await new Promise<void>((resolve, reject) => this.control.write(text, (error) => error ? reject(error) : resolve()));
  }
  call<T = unknown>(method: string, params: unknown, timeoutMs = this.owner.config.rpcTimeoutMs): Promise<T> {
    if (this.closed) return Promise.reject(new NodeUnavailableError(this.peerId));
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // 单个慢请求只结束自己的等待者；共享连接继续承载心跳和其他请求。
        reject(new RpcRequestTimeoutError(this.peerId, id));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      void this.send({ id, method, params }).catch((error) => {
        clearTimeout(timer); this.pending.delete(id); reject(error);
      });
    });
  }
  notify(method: string, params: unknown): void { void this.send({ method, params }).catch(() => {}); }
  openStream(service: string, metadata: unknown = {}): Promise<Duplex> { return this.owner.openStream(this, service, metadata); }
  close(reason = "normal_close"): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    clearInterval(this.heartbeat);
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer); p.reject(new RpcInterruptedError(this.peerId, id, `连接中断 (${reason})`));
    }
    this.pending.clear();
    this.control.destroy(); this.session.destroy();
    this.emit("closed", { peerId: this.peerId, linkId: this.id, reason });
  }
}

export class PeerTransport extends EventEmitter {
  readonly links = new Map<string, PeerLink>();
  private readonly sessions = new Set<Http2Session>();
  private readonly reconnects = new Map<string, NodeJS.Timeout>();
  private readonly dialing = new Map<string, ClientHttp2Session>();
  private readonly opening = new Set<string>();
  private readonly streams = new Map<string, { link: PeerLink; resolve: (stream: Duplex) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
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
    this.server.on("stream", (stream, headers) => { void this.accept(stream as ServerHttp2Stream, headers).catch(() => stream.destroy()); });
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
      stream.respond({ ":status": 200, "x-quaymesh-node": this.config.nodeId });
      this.install(new PeerLink(peerId, stream.session!, stream, undefined, this));
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
    await this.onStream(service, metadata, stream, peerId);
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
      this.emit("offline", link.peerId, { linkId: link.id, reason });
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
      const stream = session.request({ ":method": "POST", ":path": "/control", authorization: `Bearer ${this.token}`, "x-quaymesh-node": this.config.nodeId }, { endStream: false });
      stream.on("error", () => session.destroy());
      stream.once("response", (headers) => {
        clearTimeout(timer);
        if (this.dialing.get(peer.id) === session) this.dialing.delete(peer.id);
        if (headers[":status"] !== 200 || headers["x-quaymesh-node"] !== peer.id) { session.destroy(); return; }
        const existing = this.links.get(peer.id);
        if (existing?.connected && this.config.nodeId > peer.id) { session.destroy(); return; }
        existing?.close("replaced_by_outgoing_control"); installed = true;
        this.install(new PeerLink(peer.id, session, stream, session, this));
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
      const timer = setTimeout(() => { stream.close(constants.NGHTTP2_CANCEL); reject(new Error("传输流握手超时")); }, 10_000); timer.unref();
      stream.on("error", reject);
      stream.once("response", (headers) => {
        clearTimeout(timer);
        if (headers[":status"] !== 200) { stream.close(); reject(new Error(`传输流被拒绝 (${headers[":status"]})`)); return; }
        resolve(stream);
      });
      stream.once("close", () => clearTimeout(timer));
    });
  }
  async openReverse(link: PeerLink, params: { id: string; service: string; metadata: unknown }): Promise<void> {
    if (!link.client) throw new Error("反向传输需要主动连接");
    const stream = await this.requestStream(link, params.service, params.metadata, params.id);
    void Promise.resolve(this.onStream(params.service, params.metadata, stream, link.peerId)).catch((error) => stream.destroy(error));
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

/** pipe() supplies byte-level backpressure; errors close both ends, without replay. */
export function bridge(left: Duplex, right: Duplex): void {
  left.on("error", () => right.destroy()); right.on("error", () => left.destroy());
  left.on("close", () => right.destroy()); right.on("close", () => left.destroy());
  left.pipe(right); right.pipe(left);
}
