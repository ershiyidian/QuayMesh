import { createServer, connect, type Server, type Socket } from "node:net";
import { request as httpRequest } from "node:http";
import { connect as tlsConnect } from "node:tls";
import { Duplex } from "node:stream";
import { bridge } from "./transport.js";

export function dialTcp(host: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port, allowHalfOpen: true });
    socket.setNoDelay(true);
    const timer = setTimeout(() => socket.destroy(new Error(`连接 ${host}:${port} 超时`)), 8_000); timer.unref();
    socket.once("connect", () => { clearTimeout(timer); resolve(socket); });
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
}
/** The local listener carries raw HTTP proxy bytes to one selected mihomo process.
 * Backpressure is native TCP + HTTP/2; request bodies are never accumulated in JSON. */
export class EgressListener {
  private server?: Server;
  private readonly sockets = new Set<Socket>();
  constructor(private readonly port: number, private readonly target: () => Promise<Duplex>) {}
  async start(): Promise<void> {
    this.server = createServer({ pauseOnConnect: true, allowHalfOpen: true }, (socket) => {
      this.sockets.add(socket); socket.setNoDelay(true);
      socket.on("error", () => {});
      socket.once("close", () => this.sockets.delete(socket));
      void this.target().then((target) => {
        if (socket.destroyed) { target.destroy(); return; }
        bridge(socket, target); socket.resume();
      }).catch(() => socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"));
    });
    await new Promise<void>((resolve, reject) => { this.server!.once("error", reject); this.server!.listen(this.port, "127.0.0.1", resolve); });
    this.server.on("error", () => {});
  }
  get address(): number { return (this.server?.address() as { port: number } | null)?.port ?? this.port; }
  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    if (this.server?.listening) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }
}
function proxyAddress(proxyUrl: string): URL {
  const url = new URL(proxyUrl);
  if (url.protocol !== "http:") throw new Error("mihomo 入口请使用本地 HTTP/mixed 代理地址");
  if (url.username || url.password) throw new Error("本地 mihomo 入口请为回环地址配置 skip-auth-prefixes，代理地址使用 http://127.0.0.1:端口");
  return url;
}
export async function connectProxy(proxyUrl: string): Promise<Socket> {
  const url = proxyAddress(proxyUrl);
  return dialTcp(url.hostname.replace(/^\[|\]$/g, ""), Number(url.port || 80));
}
/** A healthy listening port alone does not mean the provider's network is reachable. */
export function probeProxy(proxyUrl: string, targetUrl: string, timeoutMs = 8_000): Promise<void> {
  const proxy = proxyAddress(proxyUrl); const target = new URL(targetUrl);
  if (!["http:", "https:"].includes(target.protocol)) return Promise.reject(new Error("出网探测地址使用 HTTP/HTTPS"));
  return new Promise((resolve, reject) => {
    let finished = false; let tunnel: Duplex | undefined;
    const finish = (error?: Error) => {
      if (finished) return; finished = true; clearTimeout(timer); request.destroy(); tunnel?.destroy();
      error ? reject(error) : resolve();
    };
    const timer = setTimeout(() => finish(new Error("mihomo 出网探测超时")), timeoutMs); timer.unref();
    const authority = `${target.hostname}:${target.port || (target.protocol === "https:" ? 443 : 80)}`;
    const request = httpRequest({ hostname: proxy.hostname, port: proxy.port || 80, method: "CONNECT", path: authority,
      headers: { Host: authority }, agent: false });
    request.on("error", finish);
    request.on("connect", (response, socket, head) => {
      tunnel = socket;
      if (response.statusCode !== 200) { finish(new Error(`mihomo CONNECT ${response.statusCode}`)); return; }
      if (head.length) socket.unshift(head);
      const check = (stream: Duplex) => {
        tunnel = stream;
        stream.once("error", finish);
        let header = "";
        stream.on("data", (chunk: Buffer) => {
          header += chunk.toString("latin1");
          const end = header.indexOf("\r\n");
          if (end < 0 && header.length < 8192) return;
          const status = Number(/^HTTP\/\d\.\d (\d{3})/.exec(header)?.[1]);
          finish(status >= 200 && status < 400 ? undefined : new Error(`出网探测返回 HTTP ${status || "未知"}`));
        });
        stream.write(`GET ${target.pathname}${target.search} HTTP/1.1\r\nHost: ${target.host}\r\nConnection: close\r\n\r\n`);
      };
      if (target.protocol === "https:") {
        const secure = tlsConnect({ socket, servername: target.hostname, ALPNProtocols: ["http/1.1"] });
        secure.once("error", finish); secure.once("secureConnect", () => check(secure)); tunnel = secure;
      } else check(socket);
    });
    request.end();
  });
}

/** Keep localhost/CC Switch and federation traffic outside this proxy. */
export function proxyEnvironment(port: number, inherited: NodeJS.ProcessEnv, peerHosts: string[] = []): NodeJS.ProcessEnv {
  const url = `http://127.0.0.1:${port}`;
  const noProxy = [...new Set(["localhost", "127.0.0.1", "::1", ...peerHosts, ...(inherited.NO_PROXY ?? inherited.no_proxy ?? "").split(",")].filter(Boolean))].join(",");
  return { ...inherited, HTTP_PROXY: url, HTTPS_PROXY: url, ALL_PROXY: url,
    http_proxy: url, https_proxy: url, all_proxy: url, NO_PROXY: noProxy, no_proxy: noProxy };
}
