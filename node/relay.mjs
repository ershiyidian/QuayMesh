import http from "node:http";
import https from "node:https";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, extname, join, normalize, resolve, sep } from "node:path";
import { createAgent } from "./network.mjs";

const HOP_HEADERS = new Set(["connection","keep-alive","proxy-authenticate","proxy-authorization","te","trailer","transfer-encoding","upgrade"]);
const PATHS = ["/mcp","/authorize","/token","/register","/revoke","/introspect","/.well-known/","/console","/healthz","/readyz","/oauth"];
const CONSOLE_REQUEST_HEADERS = ["accept","content-type","cookie","origin","referer","if-none-match","if-modified-since","x-quaymesh-csrf"];
const CONSOLE_RESPONSE_HEADERS = ["content-type","cache-control","etag","last-modified","set-cookie","location","content-disposition"];
const STATIC_TYPES = { ".html":"text/html; charset=utf-8", ".js":"text/javascript; charset=utf-8", ".mjs":"text/javascript; charset=utf-8", ".css":"text/css; charset=utf-8", ".json":"application/json; charset=utf-8", ".svg":"image/svg+xml", ".png":"image/png", ".ico":"image/x-icon", ".map":"application/json", ".woff2":"font/woff2", ".woff":"font/woff", ".txt":"text/plain; charset=utf-8" };

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
  constructor({ origin, host = "127.0.0.1", port = 17676, socksUrl, onError = () => {}, onSuccess = () => {}, consoleRpc, consoleAssetDir, mcpResponseTimeoutMs = 125000 }) {
    this.origin = new URL(origin);
    this.host = host; this.port = port; this.onError = onError;
    this.onSuccess = onSuccess; this.accepting = true; this.activeRequests = 0;
    this.mcpResponseTimeoutMs = mcpResponseTimeoutMs;
    this.agent = createAgent(this.origin, { socksUrl });
    this.requests = new Set();
    this.consoleRpc = consoleRpc || null;
    this.consoleAssetDir = consoleAssetDir ? resolve(consoleAssetDir) : null;
    this.server = http.createServer((req, res) => { void this.route(req, res).catch(error => this.fail(req, res, error)); });
    this.server.requestTimeout = 0;
    this.server.headersTimeout = 20000;
    this.server.keepAliveTimeout = 5000;
  }

  async route(req, res) {
    const pathname = new URL(req.url,"http://relay.local").pathname;
    const health = req.method === "GET" && ["/readyz","/healthz"].includes(pathname);
    if (!this.accepting && !health) { res.writeHead(503,{"retry-after":"2"}).end('{"error":"node_maintenance"}'); return; }
    const blocking = !health && !(req.method === "GET" && pathname === "/mcp");
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

  // Console 页面：静态文件从本机 release 提供，API 经已认证的 federation RPC 送到 Coordinator。
  async serveConsole(req, res, parsed) {
    const path = parsed.pathname;
    if (path === "/console") { res.writeHead(303,{location:`/console/${parsed.search}`}).end(); return; }
    const isApi = path.startsWith("/console/api/");
    if (!isApi) {
      await this.serveStatic(req, res, path);
      return;
    }
    const method = String(req.method || "GET").toUpperCase();
    if (!["GET", "POST"].includes(method)) { res.writeHead(405, { "content-type": "application/json" }).end('{"code":"CONSOLE_METHOD_REJECTED"}'); return; }
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
    const outHeaders = pickHeaders(reply.headers || {}, CONSOLE_RESPONSE_HEADERS);
    if (!outHeaders["content-type"]) outHeaders["content-type"] = "application/json; charset=utf-8";
    const bodyText = typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body ?? null);
    const buffer = reply.bodyBase64 ? Buffer.from(String(reply.body), "base64") : Buffer.from(bodyText, "utf8");
    outHeaders["content-length"] = String(buffer.length);
    res.writeHead(reply.status || 200, outHeaders);
    res.end(buffer);
    if (reply.status < 500) this.onSuccess(`relay:${path}`);
  }

  async serveStatic(req, res, path) {
    if (!this.consoleAssetDir) { res.writeHead(404, { "content-type": "application/json" }).end('{"error":"console_assets_unavailable"}'); return; }
    const relative = path.replace(/^\/console\/?/, "") || "console.html";
    const safe = normalize(relative).replace(/^(\.\.(\/|\\|$))+/, "");
    const file = resolve(join(this.consoleAssetDir, safe));
    if (file !== this.consoleAssetDir && !file.startsWith(this.consoleAssetDir + sep)) {
      res.writeHead(403).end(); return;
    }
    let info;
    try { info = await stat(file); if (!info.isFile()) throw new Error("not_file"); }
    catch { res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not_found"}'); return; }
    const type = STATIC_TYPES[extname(file).toLowerCase()] || "application/octet-stream";
    const immutable = /-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/.test(basename(file));
    const cache = immutable ? "public, max-age=31536000, immutable" : "no-cache";
    const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
    if (req.headers["if-none-match"] === etag) { res.writeHead(304,{etag,"cache-control":cache}).end(); return; }
    res.writeHead(200, { "content-type": type, "content-length": info.size, "cache-control":cache, etag });
    if (req.method === "HEAD") { res.end(); return; }
    const stream = createReadStream(file);
    stream.once("error", error => res.destroy(error));
    res.once("close", () => stream.destroy());
    stream.pipe(res);
  }

  fail(req, res, error) {
    error.source = `relay:${new URL(req.url,"http://relay.local").pathname}`;
    this.onError(error);
    if (res.headersSent) { res.destroy(error); return; }
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
