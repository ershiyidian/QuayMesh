import { createServer, request as httpRequest } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

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
  if (declared.protocol !== "https:" || declared.pathname !== "/mcp" || declared.search || declared.hash)
    throw new Error("publicUrl must be a fixed HTTPS origin ending in /mcp");
  const base = declared.origin;
  const target = new URL(upstream);
  if (target.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname))
    throw new Error("Upstream must be on loopback");
  const rate = new Map();
  let windowStart = Date.now();
  let registrations = 0;

  const server = createServer((req, res) => {
    const started = Date.now();
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
    res.once("finish", () => onRequest({
      method, path: pathname, status: res.statusCode, ms: Date.now()-started,
      // 只记录发现请求特征，不记录 OAuth code/state、Authorization 或 Cookie。
      origin: typeof req.headers.origin === "string" ? req.headers.origin.slice(0, 100) : null,
      agent: String(req.headers["user-agent"] ?? "").slice(0, 120),
      accept: String(req.headers.accept ?? "").slice(0, 100),
    }));
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
      reply.on("error", () => res.destroy());
      reply.once("aborted", () => res.destroy());
      reply.pipe(res);
    });
    outgoing.once("timeout", () => outgoing.destroy(new Error("upstream_timeout")));
    outgoing.once("error", () => {
      if (!res.headersSent && !res.destroyed) res.writeHead(502, {
        "content-type": "application/json", "cache-control": "no-store",
      }).end('{"error":"coordinator_unavailable"}');
      else if (!res.destroyed) res.destroy();
    });
    req.once("aborted", () => outgoing.destroy());
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

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const configIndex = process.argv.indexOf("--config");
  if (configIndex < 0 || !process.argv[configIndex + 1]) throw new Error("Expected --config path");
  const node = JSON.parse(await readFile(process.argv[configIndex + 1], "utf8"));
  if (!node.capabilities?.coordinator || !node.publicMcp?.url) throw new Error("Missing publicMcp Coordinator config");
  const portIndex = process.argv.indexOf("--port");
  const port = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 29176;
  const upstream = "http://127.0.0.1:" + node.corePort;
  const ingress = await createPublicMcpIngress({
    publicUrl: node.publicMcp.url, upstream, port,
    onRequest: event => console.info(JSON.stringify(event)),
  }).start();
  console.log("Public MCP ingress listening on loopback; public URL " + ingress.publicUrl);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => { void ingress.close().then(() => process.exit(0)); });
  }
}
