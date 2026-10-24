import http from "node:http";
import https from "node:https";
import { createHash } from "node:crypto";
import { createAgent } from "./network.mjs";

const HOP_HEADERS = new Set(["connection","keep-alive","proxy-authenticate","proxy-authorization","te","trailer","transfer-encoding","upgrade"]);
const DISCOVERY_METADATA_PATHS = new Set([
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-authorization-server",
]);
const PATHS = ["/mcp","/authorize","/token","/register","/revoke","/introspect","/.well-known/","/console","/healthz","/readyz","/oauth"];
const CONSOLE_REQUEST_HEADERS = ["accept","content-type","cookie","origin","referer","if-none-match","if-modified-since","x-quaymesh-csrf"];
const CONSOLE_RESPONSE_HEADERS = ["content-type","content-length","cache-control","etag","last-modified","set-cookie","location","content-disposition","content-security-policy","x-content-type-options","referrer-policy"];
const CONSOLE_RECOVERY_SCRIPT = 'const reconnect=()=>location.reload();document.getElementById("reconnect").addEventListener("click",reconnect);setTimeout(reconnect,5000);';
const CONSOLE_RECOVERY_SCRIPT_HASH = createHash("sha256").update(CONSOLE_RECOVERY_SCRIPT).digest("base64");

function forwardedHeaders(headers) {
  const excluded = new Set(HOP_HEADERS);
  for (const name of String(headers.connection || "").split(",")) excluded.add(name.trim().toLowerCase());
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !excluded.has(name.toLowerCase())));
}

function pickHeaders(source, allowed) {
  const result = {};
  for (const name of allowed) {
    const value = source[name];
    if (typeof value === "string") result[name] = value;
    else if (Array.isArray(value) && value.length) result[name] = name === "set-cookie" ? value : value.join(", ");
  }
  return result;
}

// 把浏览器请求体收集为字符串/二进制，供 RPC 携带。
function readBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = []; let size = 0;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) { rejectBody(Object.assign(new Error("Console 请求体超过 2 MiB"),{status:413})); req.resume(); }
      else chunks.push(chunk);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks)));
    req.on("error", rejectBody);
    req.once("aborted", () => rejectBody(new Error("浏览器已断开")));
  });
}

export class McpRelay {
  constructor({ origin, host = "127.0.0.1", port = 17676, socksUrl, onError = () => {}, onSuccess = () => {}, consoleRpc, mcpResponseTimeoutMs = 125000 }) {
    this.origin = new URL(origin);
    this.host = host; this.port = port; this.onError = onError;
    this.onSuccess = onSuccess; this.accepting = true; this.activeRequests = 0;
    this.mcpResponseTimeoutMs = mcpResponseTimeoutMs;
    this.agent = createAgent(this.origin, { socksUrl });
    this.requests = new Set();
    this.consoleRpc = consoleRpc || null;
    this.server = http.createServer((req, res) => { void this.route(req, res).catch(error => this.fail(req, res, error)); });
    this.server.requestTimeout = 0;
    this.server.headersTimeout = 20000;
    this.server.keepAliveTimeout = 5000;
  }

  async route(req, res) {
    const pathname = new URL(req.url,"http://relay.local").pathname;
    const health = req.method === "GET" && ["/readyz","/healthz"].includes(pathname);
    const discoveryMetadata = req.method === "GET" && DISCOVERY_METADATA_PATHS.has(pathname);
    if (!this.accepting && !health && !discoveryMetadata) {
      // Discovery performs unauthenticated startup probes while admission is
      // paused. Answer locally: no JSON-RPC body or upstream work is accepted.
      if (["GET","POST"].includes(req.method) && ["/mcp","/mcp/"].includes(pathname) &&
          req.headers.authorization === undefined) {
        res.writeHead(401, {"www-authenticate":"Bearer", "cache-control":"no-store",
          "content-type":"application/json; charset=utf-8", "connection":"close"})
          .end('{"error":"authentication_required"}');
        req.resume();
      } else res.writeHead(503,{"retry-after":"2"}).end('{"error":"node_maintenance"}');
      return;
    }
    const blocking = !health && !discoveryMetadata && !(req.method === "GET" && pathname === "/mcp");
    if (blocking) this.activeRequests++;
    let released = false;
    const release = () => { if (!released) { released = true; if (blocking) this.activeRequests--; } };
    res.once("finish", release); res.once("close", release);
    let parsed;
    try { parsed = new URL(req.url, "http://relay.local"); }
    catch { res.writeHead(400).end(); return; }
    if (!PATHS.some(path => parsed.pathname === path || parsed.pathname.startsWith(path.endsWith("/") ? path : `${path}/`))) {
      res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not_found"}'); return;
    }
    if (req.url.startsWith("http://") || req.url.startsWith("https://")) {
      res.writeHead(400).end(); return;
    }
    const isConsole = parsed.pathname === "/console" || parsed.pathname.startsWith("/console/");
    if (isConsole && this.consoleRpc) {
      await this.serveConsole(req, res, parsed);
      return;
    }
    this.forward(req, res, parsed);
  }

  // 页面、资源和 API 统一由 Coordinator 提供，避免本机旧页面配上新版接口。
  async serveConsole(req, res, parsed) {
    const path = parsed.pathname;
    if (path === "/console") { res.writeHead(303,{location:`/console/${parsed.search}`}).end(); return; }
    const method = String(req.method || "GET").toUpperCase();
    if (!["GET", "HEAD", "POST"].includes(method)) { res.writeHead(405, { "content-type": "application/json" }).end('{"code":"CONSOLE_METHOD_REJECTED"}'); return; }
    const raw = method === "POST" ? await readBody(req) : Buffer.alloc(0);
    const headers = pickHeaders(req.headers, CONSOLE_REQUEST_HEADERS);
    headers["x-quaymesh-relay"] = "browser";
    const controller = new AbortController();
    const cancel = () => { if (!res.writableFinished) controller.abort(); };
    res.once("close", cancel);
    const reply = await this.consoleRpc({
      method,
      path: path + (parsed.search || ""),
      headers,
      body: raw.length ? raw.toString("utf8") : undefined,
      browserPeer: req.socket.remoteAddress || "127.0.0.1",
      deadlineAt:Date.now() + 30000,
      signal:controller.signal,
    }).finally(() => res.off("close",cancel));
    if (res.destroyed) return;
    const status = reply.status || 200;
    if (status >= 500 && this.consoleEntry(req, parsed)) {
      this.consoleUnavailable(res);
      return;
    }
    const outHeaders = pickHeaders(reply.headers || {}, CONSOLE_RESPONSE_HEADERS);
    if (!outHeaders["content-type"]) outHeaders["content-type"] = "application/json; charset=utf-8";
    const bodyText = typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body ?? null);
    const buffer = reply.bodyBase64 ? Buffer.from(String(reply.body), "base64") : Buffer.from(bodyText, "utf8");
    const noBody = method === "HEAD" || status === 204 || status === 304;
    if (!noBody) outHeaders["content-length"] = String(buffer.length);
    res.writeHead(status, outHeaders);
    res.end(noBody ? undefined : buffer);
    if (status < 500) this.onSuccess(`relay:${path}`);
  }

  consoleEntry(req, parsed) {
    return req.method === "GET" && ["/console/", "/console/console.html"].includes(parsed.pathname);
  }

  consoleUnavailable(res) {
    res.writeHead(503, { "content-type":"text/html; charset=utf-8", "cache-control":"no-store", "retry-after":"5",
      "content-security-policy":`default-src 'none'; script-src 'sha256-${CONSOLE_RECOVERY_SCRIPT_HASH}'; style-src 'unsafe-inline'; frame-ancestors 'none'`, "x-content-type-options":"nosniff" })
      .end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>QuayMesh · 连接恢复中</title><style>body{margin:0;padding:12vh 24px;background:#111214;color:#e9eaed;font:16px/1.6 system-ui,sans-serif}main{max-width:480px;margin:auto}h1{font-size:24px;font-weight:500}p{color:#aaaeb6}button{margin-top:12px;padding:10px 20px;border:1px solid #626771;border-radius:8px;background:#272b32;color:inherit;font:inherit;cursor:pointer}</style><main><h1>控制台暂未连接</h1><p>正在恢复连接，已有登录会话会保留。</p><button type="button" id="reconnect">重新连接</button></main><script>${CONSOLE_RECOVERY_SCRIPT}</script></html>`);
  }

  fail(req, res, error) {
    if (res.destroyed || req.aborted) return;
    error.source = `relay:${new URL(req.url,"http://relay.local").pathname}`;
    this.onError(error);
    if (res.headersSent) { res.destroy(error); return; }
    const parsed = new URL(req.url,"http://relay.local");
    if (this.consoleRpc && this.consoleEntry(req, parsed)) { this.consoleUnavailable(res); return; }
    res.writeHead(error.status || 503, { "content-type": "application/json", "retry-after": "2" }).end(JSON.stringify({ error: "coordinator_unavailable",message:error.message }));
  }

  forward(req, res, parsed) {
    const startedAt=Date.now();
    const boundedMcp=req.method==="POST"&&["/mcp","/mcp/"].includes(parsed.pathname);
    const target = new URL(`${parsed.pathname}${parsed.search}`, this.origin);
    const headers = forwardedHeaders(req.headers);
    headers.host = this.origin.host;
    const client = target.protocol === "https:" ? https : http;
    const upstream = client.request(target, { method: req.method, headers, agent: this.agent }, (reply) => {
      clearTimeout(headerTimer);
      if (res.destroyed) { reply.destroy(); return; }
      res.writeHead(reply.statusCode || 502, forwardedHeaders(reply.headers));
      res.flushHeaders();
      // 已有响应头不代表最终结果已送达；上游半途断开要同步终止下游，
      // 不能留下一个永远等待 SSE 终止消息的 ChatGPT 请求。
      const interrupted = () => {
        if (!res.writableFinished && !res.destroyed) res.destroy(new Error("Coordinator 响应流提前结束"));
      };
      reply.once("aborted", interrupted);
      reply.once("close", () => { if (!reply.complete) interrupted(); });
      reply.once("error", error => { if (!res.destroyed) res.destroy(error); });
      reply.pipe(res);
      if ((reply.statusCode || 502) < 500) res.once("finish", () => {
        if (reply.complete && !reply.aborted) this.onSuccess(`relay:${parsed.pathname}`);
      });
    });
    this.requests.add(upstream);
    // 最终结果期限不随 SSE 心跳延长，GET 订阅流仍按连接生命周期管理。
    let responseTimer;
    const deadline=(budget)=>{
      clearTimeout(responseTimer);
      responseTimer=setTimeout(()=>upstream.destroy(Object.assign(new Error("Coordinator 最终结果超时；请按原 operation 查询执行结果"),
        {code:"MCP_RESPONSE_TIMEOUT",phase:"final_result"})),Math.max(1,budget-(Date.now()-startedAt)));
      responseTimer.unref();
    };
    if(boundedMcp){
      deadline(this.mcpResponseTimeoutMs);
      // 附件导入已有独立的 15 分钟预算；只观察有限请求头段，不缓存大正文。
      const chunks=[];let bytes=0;
      req.on("data",chunk=>{bytes+=chunk.length;if(bytes<=65536)chunks.push(chunk);else chunks.length=0;});
      req.once("end",()=>{
        if(bytes>65536)return;
        try{const body=JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if(body.method==="tools/call"&&body.params?.name==="download_artifact")deadline(15*60*1000+5000);
        }catch{}
      });
    }
    res.once("finish",()=>clearTimeout(responseTimer));
    res.once("close",()=>clearTimeout(responseTimer));
    const headerTimer = setTimeout(() => upstream.destroy(new Error("Coordinator 响应头超时")), ["/mcp", "/mcp/"].includes(parsed.pathname) ? 125000 : 30000);
    headerTimer.unref();
    upstream.once("close", () => { clearTimeout(headerTimer); clearTimeout(responseTimer); this.requests.delete(upstream); });
    upstream.once("error", (error) => {
      clearTimeout(headerTimer);
      if (res.destroyed || req.aborted) return;
      this.fail(req,res,error);
    });
    req.once("aborted", () => upstream.destroy());
    res.once("close", () => { if (!res.writableFinished) upstream.destroy(); });
    req.pipe(upstream);
  }
  async start() {
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, this.host, () => { this.server.off("error", reject); resolve(); });
    });
    this.port = this.server.address().port;
    return this;
  }
  setAccepting(value) { this.accepting = value; }
  async close() {
    for (const req of this.requests) req.destroy();
    this.agent.destroy();
    this.server.closeAllConnections();
    await new Promise(resolve => this.server.close(() => resolve()));
  }
}
