import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { once } from "node:events";

export async function connectSocket(host, port, { socksUrl, timeoutMs = 8000, signal } = {}) {
  signal?.throwIfAborted();
  let socket;
  if (socksUrl) {
    const { SocksClient } = await import("socks");
    const proxy = new URL(socksUrl);
    if (proxy.protocol !== "socks5:") throw new Error("虚拟网络代理必须使用 socks5");
    const connection = await SocksClient.createConnection({
      proxy: { host: proxy.hostname, port: Number(proxy.port), type: 5,
        ...(proxy.username ? { userId: decodeURIComponent(proxy.username), password: decodeURIComponent(proxy.password) } : {}) },
      command: "connect", destination: { host, port }, timeout: timeoutMs,
    });
    socket = connection.socket;
  } else {
    socket = net.connect({ host, port });
    const timer = setTimeout(() => socket.destroy(new Error(`连接 ${host}:${port} 超时`)), timeoutMs);
    timer.unref();
    try { await once(socket, "connect", { signal }); }
    catch (error) { socket.destroy(); throw error; }
    finally { clearTimeout(timer); }
  }
  if (signal?.aborted) { socket.destroy(); signal.throwIfAborted(); }
  socket.setNoDelay(true);
  return socket;
}

export function createAgent(url, { socksUrl, timeoutMs = 8000 } = {}) {
  const secure = url.protocol === "https:";
  const Agent = secure ? https.Agent : http.Agent;
  const agent = new Agent({ keepAlive: true, maxSockets: 24, maxFreeSockets: 4, timeout: 30000 });
  if (!socksUrl) return agent;
  agent.createConnection = (options, callback) => {
    const host = options.hostname || options.host;
    const port = Number(options.port || (secure ? 443 : 80));
    void connectSocket(host, port, { socksUrl, timeoutMs }).then((socket) => {
      if (!secure) { callback(null, socket); return; }
      const encrypted = tls.connect({ socket, servername: net.isIP(host) ? undefined : host,
        rejectUnauthorized: true, ALPNProtocols: ["http/1.1"] });
      encrypted.once("secureConnect", () => callback(null, encrypted));
      encrypted.once("error", error => callback(error));
    }, error => callback(error));
    return undefined;
  };
  return agent;
}

export async function requestJson(urlInput, { method = "GET", body, token, agent, timeoutMs = 8000, signal, headers = {} } = {}) {
  const url = new URL(urlInput);
  const client = url.protocol === "https:" ? https : http;
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = client.request(url, {
      method, agent, signal,
      headers: { accept: "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(payload ? { "content-type": "application/json", "content-length": String(payload.length) } : {}), ...headers },
    }, (res) => {
      const parts = []; let length = 0;
      res.on("data", chunk => {
        length += chunk.length;
        if (length > 4 * 1024 * 1024) { res.destroy(new Error("节点响应超过 4 MiB")); return; }
        parts.push(chunk);
      });
      res.once("error", reject);
      res.once("end", () => {
        clearTimeout(timer);
        const text = Buffer.concat(parts).toString("utf8");
        if ((res.statusCode || 500) < 200 || (res.statusCode || 500) >= 300) {
          const error = new Error(`HTTP ${res.statusCode}：${text.slice(0, 300)}`);
          error.status = res.statusCode; reject(error); return;
        }
        try { resolve(text ? JSON.parse(text) : null); }
        catch (error) { reject(error); }
      });
    });
    const timer = setTimeout(() => req.destroy(new Error(`请求 ${url.pathname} 超时`)), timeoutMs);
    timer.unref();
    req.once("error", error => { clearTimeout(timer); reject(error); });
    req.once("close", () => clearTimeout(timer));
    req.end(payload);
  });
}

export async function requestText(urlInput, { method = "GET", body, token, agent, timeoutMs = 8000, signal, headers = {}, maxBytes = 1024 * 1024 } = {}) {
  const url = new URL(urlInput);
  const client = url.protocol === "https:" ? https : http;
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = client.request(url, {
      method, agent, signal,
      headers: { accept: "text/plain, application/json", ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(payload ? { "content-type": "application/json", "content-length": String(payload.length) } : {}), ...headers },
    }, (res) => {
      const parts = []; let length = 0;
      res.on("data", chunk => {
        length += chunk.length;
        if (length > maxBytes) { res.destroy(new Error("节点响应超过允许大小")); return; }
        parts.push(chunk);
      });
      res.once("error", reject);
      res.once("end", () => {
        clearTimeout(timer);
        resolve({ status: res.statusCode || 0, text: Buffer.concat(parts).toString("utf8") });
      });
    });
    const timer = setTimeout(() => req.destroy(new Error(`请求 ${url.pathname} 超时`)), timeoutMs);
    timer.unref();
    req.once("error", error => { clearTimeout(timer); reject(error); });
    req.once("close", () => clearTimeout(timer));
    req.end(payload);
  });
}

// tunnel-client 的 /readyz 返回纯文本，其他 JSON 服务仍走 requestJson。
// 这里只接受 HTTP 200 且正文确实表示 ready 的响应，避免把任意正文当成成功。
export async function requestDiscoveryReady(urlInput, options = {}) {
  const reply = await requestText(urlInput, options);
  if (reply.status !== 200) throw new Error(`发现端返回 HTTP ${reply.status}：${reply.text.trim().slice(0, 200)}`);
  const body = reply.text.trim().toLowerCase();
  if (body !== "ready" && !body.startsWith("ready (") && !body.startsWith("ready(")) {
    throw new Error(`发现端就绪正文无法识别：${reply.text.trim().slice(0, 200)}`);
  }
  return { ready: true, body: reply.text.trim(), status: reply.status };
}

export async function probeHttp(url, options = {}) {
  const response = await requestJson(url, options);
  if (response?.ok === false) throw new Error(response.error || "服务尚未就绪");
  return response;
}
