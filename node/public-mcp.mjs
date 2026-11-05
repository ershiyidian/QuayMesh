import { createServer, request as httpRequest } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const AUTH_PATHS = new Set(["/authorize", "/token", "/register", "/revoke", "/introspect"]);
const MCP_PATHS = new Set(["/mcp", "/mcp/"]);
const METADATA_PATHS = new Set([
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-authorization-server/mcp",
]);
const BROWSER_ORIGINS = new Set(["https://gemini.google.com", "https://www.google.com"]);
const HOP_HEADERS = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "proxy-connection"]);
const OAUTH_ERROR_CODES = new Set(["invalid_request", "invalid_client", "invalid_grant",
  "unauthorized_client", "unsupported_grant_type", "invalid_scope", "invalid_target",
  "server_error", "temporarily_unavailable"]);
export const PUBLIC_MCP_PROBE_USER_AGENT = "QuayMesh-Public-Mcp-Probe/1";

function htmlEscape(text) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function metadata(base, pathname) {
  if (pathname === "/.well-known/oauth-authorization-server"
      || pathname === "/.well-known/oauth-authorization-server/mcp") return {
    issuer: base,
    authorization_endpoint: base + "/authorize",
    token_endpoint: base + "/token",
    registration_endpoint: base + "/register",
    revocation_endpoint: base + "/revoke",
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
    scopes_supported: ["quaymesh"],
  };
  return {
    // Gemini Web 经实测读取本元数据后中止；兼容已成功连接的
    // Coding Tools MCP 所用的同源资源标识，内部仍提供 /mcp。
    resource: base,
    authorization_servers: [base],
    bearer_methods_supported: ["header"],
    scopes_supported: ["quaymesh"],
    resource_name: "QuayMesh",
  };
}

function acceptPath(pathname, method) {
  if (METADATA_PATHS.has(pathname)) return method === "GET" || method === "HEAD";
  if (MCP_PATHS.has(pathname)) return ["HEAD", "GET", "POST", "DELETE"].includes(method);
  if (AUTH_PATHS.has(pathname)) return pathname === "/authorize"
    ? ["GET", "POST"].includes(method)
    : method === "POST";
  return false;
}

function redirectToGeminiRelay(location) {
  try {
    const url = new URL(location);
    return url.protocol === "https:" && url.hostname === "oauth-redirect.googleusercontent.com"
      && url.pathname.startsWith("/r/") && url.searchParams.has("code") && url.searchParams.has("state");
  } catch { return false; }
}

export function createPublicMcpIngress({
  publicUrl, upstream = "http://127.0.0.1:27676", host = "127.0.0.1", port = 29176,
  onRequest = () => {},
} = {}) {
  const declared = new URL(publicUrl);
  if (declared.protocol !== "https:" || declared.pathname !== "/mcp" || declared.search || declared.hash
      || declared.username || declared.password)
    throw new Error("publicUrl must be a fixed HTTPS origin ending in /mcp");
  const base = declared.origin;
  const target = new URL(upstream);
  if (target.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)
      || target.pathname !== "/" || target.search || target.hash || target.username || target.password)
    throw new Error("Upstream must be an HTTP loopback origin");
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("Port must be an integer between 0 and 65535");
  const rate = new Map();
  let windowStart = Date.now();
  let registrations = 0;

  const server = createServer((req, res) => {
    const started = Date.now();
    const startedClock = performance.now();
    const method = req.method ?? "GET";
    const origin = typeof req.headers.origin === "string" && BROWSER_ORIGINS.has(req.headers.origin)
      ? req.headers.origin : null;
    if (origin) {
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("vary", "Origin");
      res.setHeader("access-control-expose-headers",
        "WWW-Authenticate, MCP-Session-Id, MCP-Protocol-Version");
    }
    const raw = req.url ?? "";
    if (!raw.startsWith("/") || raw.startsWith("//")) {
      res.writeHead(400).end(); req.resume(); return;
    }
    const url = new URL(raw, base);
    const pathname = url.pathname;
    const localProbe = method === "GET" && raw === "/.well-known/oauth-protected-resource"
      && req.headers["user-agent"] === PUBLIC_MCP_PROBE_USER_AGENT
      && req.headers["x-forwarded-for"] === undefined && req.headers.forwarded === undefined
      && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);
    let recorded = false;
    let failure;
    let oauthError = null;
    const record = outcome => {
      if (recorded) return;
      recorded = true;
      // 只省略本机探测的成功记录，真实请求与探测失败继续保留。
      if (localProbe && outcome === "completed" && res.statusCode === 200 && !failure) return;
      const finished = Date.now();
      onRequest({
        startedAt: new Date(started).toISOString(), finishedAt: new Date(finished).toISOString(),
        method, path: pathname, status: res.headersSent ? res.statusCode : null,
        ms: Math.round(performance.now()-startedClock), outcome: failure ?? outcome,
        ...(oauthError ? { oauthError } : {}),
        // 不记录查询参数、凭据或原始错误文本；中途断开也只写一条结果。
        origin: typeof req.headers.origin === "string" ? req.headers.origin.slice(0, 100) : null,
        agent: String(req.headers["user-agent"] ?? "").slice(0, 120),
        accept: String(req.headers.accept ?? "").slice(0, 100),
      });
    };
    res.once("finish", () => record("completed"));
    res.once("close", () => record("client_closed"));
    res.once("error", () => record("client_error"));
    req.once("aborted", () => record("client_aborted"));
    req.once("error", () => record("client_error"));
    if (method === "OPTIONS" && origin &&
        (METADATA_PATHS.has(pathname) || MCP_PATHS.has(pathname) || AUTH_PATHS.has(pathname))) {
      res.writeHead(204, {
        "access-control-allow-methods": "GET, HEAD, POST, DELETE, OPTIONS",
        "access-control-allow-headers": "Authorization, Content-Type, Accept, MCP-Protocol-Version, MCP-Session-Id",
        "access-control-max-age": "300",
        "cache-control": "no-store",
      }).end();
      return;
    }
    if (!acceptPath(pathname, method)) {
      res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not_found"}');
      req.resume(); return;
    }
    if (METADATA_PATHS.has(pathname)) {
      const body = JSON.stringify(metadata(base, pathname));
      res.writeHead(200, { "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(body), "cache-control": "no-store" });
      res.end(method === "HEAD" ? undefined : body);
      return;
    }
    if (pathname === "/register") {
      if (Date.now()-windowStart > 3_600_000) { windowStart = Date.now(); rate.clear(); registrations = 0; }
      // 连接身份经本机 HTTPS 代理转交；防止公开 DCR 写满数据库。
      const ip = String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "")
        .split(",")[0].trim().slice(0, 64);
      const count = rate.get(ip) ?? 0;
      if (count >= 12 || registrations >= 120) {
        res.writeHead(429, { "retry-after": "3600", "cache-control": "no-store" })
          .end('{"error":"rate_limited"}');
        req.resume(); return;
      }
      rate.set(ip, count+1); registrations++;
    }
    const headers = Object.fromEntries(Object.entries(req.headers)
      .filter(([name]) => !HOP_HEADERS.has(name.toLowerCase())
        && !name.toLowerCase().startsWith("x-forwarded-")
        && name.toLowerCase() !== "cookie"));
    headers.host = target.host;
    const outgoing = httpRequest(new URL(url.pathname + url.search, target), {
      method, headers, timeout: MCP_PATHS.has(pathname) ? 900_000 : 45_000,
    }, reply => {
      if (res.destroyed) { reply.destroy(); return; }
      const status = reply.statusCode ?? 502;
      const replyHeaders = Object.fromEntries(Object.entries(reply.headers)
        .filter(([name]) => !HOP_HEADERS.has(name.toLowerCase())));
      if (pathname === "/token" && method === "POST" && status >= 400
          && /^application\/json(?:;|$)/i.test(String(reply.headers["content-type"] ?? ""))
          && !reply.headers["content-encoding"]) {
        let errorChunks = [], errorBytes = 0;
        // 旁路读取有限的错误内容；原响应保持流式转发，凭据和错误说明不进入日志。
        reply.on("data", chunk => {
          if (errorChunks === null) return;
          errorBytes += chunk.length;
          if (errorBytes > 4096) { errorChunks = null; return; }
          errorChunks.push(chunk);
        });
        reply.once("end", () => {
          if (errorChunks === null) return;
          try {
            const body = JSON.parse(Buffer.concat(errorChunks, errorBytes).toString("utf8"));
            if (OAUTH_ERROR_CODES.has(body?.error)) oauthError = body.error;
          } catch { oauthError = null; }
        });
      }
      if (status === 401 && MCP_PATHS.has(pathname)) {
        const original = String(replyHeaders["www-authenticate"] ?? 'Bearer error="invalid_token"');
        const marker = 'resource_metadata="' + base + '/.well-known/oauth-protected-resource"';
        // RFC 6750 §3.1: unauthenticated discovery has no invalid_token error.
        // Invalid supplied bearer tokens retain the original authentication error.
        replyHeaders["www-authenticate"] = req.headers.authorization === undefined
          ? 'Bearer realm="QuayMesh", scope="quaymesh", ' + marker
          : original.includes("resource_metadata=")
            ? original.replace(/resource_metadata="[^"]*"/u, marker)
            : original + ", " + marker;
      }
      const location = String(replyHeaders.location ?? "");
      if (pathname === "/authorize" && method === "POST" && status === 302 && redirectToGeminiRelay(location)) {
        // Google 的回调中继还会跳转一次；POST 直接 302 会受到 form-action 多跳校验影响。
        const href = htmlEscape(location);
        const body = '<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer">'
          + '<meta http-equiv="refresh" content="0;url=' + href + '">'
          + '<a rel="noreferrer" href="' + href + '">Continue to Gemini</a>';
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
          "referrer-policy": "no-referrer", "content-length": Buffer.byteLength(body) });
        res.end(body); reply.resume(); return;
      }
      replyHeaders["cache-control"] ??= "no-store";
      res.writeHead(status, replyHeaders);
      reply.on("error", () => { failure ??= "upstream_error"; res.destroy(); });
      reply.once("aborted", () => { failure ??= "upstream_closed"; res.destroy(); });
      reply.pipe(res);
    });
    outgoing.once("timeout", () => { failure ??= "upstream_timeout"; outgoing.destroy(); });
    outgoing.once("error", () => {
      failure ??= "upstream_error";
      if (!res.headersSent && !res.destroyed) res.writeHead(502, {
        "content-type": "application/json", "cache-control": "no-store",
      }).end('{"error":"coordinator_unavailable"}');
      else if (!res.destroyed) res.destroy();
    });
    req.once("aborted", () => outgoing.destroy());
    req.once("error", () => outgoing.destroy());
    res.once("close", () => { if (!res.writableFinished) outgoing.destroy(); });
    req.pipe(outgoing);
  });
  server.headersTimeout = 20_000;
  server.requestTimeout = 0;
  return {
    publicUrl: declared.href,
    server,
    async start() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => { server.off("error", reject); resolve(); });
      });
      return this;
    },
    close() { return new Promise(resolve => server.close(resolve)); },
  };
}

async function commandOptions(args) {
  const { values } = parseArgs({ args, allowPositionals: false, options: {
    config: { type: "string" }, "public-url": { type: "string" },
    upstream: { type: "string" }, port: { type: "string" },
  } });
  let publicUrl = values["public-url"];
  let upstream = values.upstream;
  if (values.config !== undefined) {
    if (publicUrl !== undefined || upstream !== undefined)
      throw new Error("Use either --config or --public-url with --upstream");
    const node = JSON.parse(await readFile(values.config, "utf8"));
    if (!node.capabilities?.coordinator || !node.publicMcp?.url)
      throw new Error("Missing publicMcp Coordinator config");
    if (!Number.isInteger(node.corePort) || node.corePort < 1 || node.corePort > 65535)
      throw new Error("Coordinator corePort must be an integer between 1 and 65535");
    publicUrl = node.publicMcp.url;
    upstream = "http://127.0.0.1:" + node.corePort;
  } else if (!publicUrl || !upstream) {
    throw new Error("Provide --config or both --public-url and --upstream");
  }
  if (values.port !== undefined && !/^\d+$/.test(values.port))
    throw new Error("Port must be an integer between 0 and 65535");
  return { publicUrl, upstream, port: values.port === undefined ? 29176 : Number(values.port) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const ingress = await createPublicMcpIngress({
    ...await commandOptions(process.argv.slice(2)),
    onRequest: event => {
      console.info(JSON.stringify(event));
      if (process.connected) process.send({ type: "public-mcp-request", ...event }, () => {});
    },
  }).start();
  console.log("Public MCP ingress listening on 127.0.0.1:" + ingress.server.address().port
    + "; public URL " + ingress.publicUrl);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => { void ingress.close().then(() => process.exit(0)); });
  }
}
