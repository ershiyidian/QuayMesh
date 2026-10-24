import type { ConsoleReply, JsonRecord } from "./types.js";

export const CONSOLE_REQUEST_LIMIT_BYTES = 1024 * 1024;
const FORWARD_HEADERS = ["accept", "content-type", "cookie", "origin", "referer", "if-none-match", "if-modified-since", "x-quaymesh-csrf"] as const;
const RESPONSE_HEADERS = ["content-type", "content-length", "cache-control", "etag", "last-modified", "set-cookie", "location", "content-disposition", "content-security-policy", "x-content-type-options", "referrer-policy"] as const;
const TEXTUAL = /(^text\/|json|javascript|ecmascript|xml|html|css|svg|x-www-form-urlencoded|charset)/i;

export interface ConsoleHttpRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
  bodyBase64?: boolean;
  browserPeer?: string;
}

// 只透传 Console 识别所需的头，阻断逐跳头与伪造身份头。
export function pickRequestHeaders(headers: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of FORWARD_HEADERS) {
    const value = headers[name];
    if (typeof value === "string") result[name] = value.slice(0, 16384);
    else if (Array.isArray(value) && value.length > 0) result[name] = value.map(String).join(", ").slice(0, 16384);
  }
  return result;
}

// 回传方向同样只保留 Console 页面所需的头；set-cookie 可能有多条，已在响应侧合并。
export function pickResponseHeaders(headers: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of RESPONSE_HEADERS) {
    const value = headers[name];
    if (typeof value === "string") result[name] = value.slice(0, 16384);
    else if (Array.isArray(value)) result[name] = value.map(String).join(", ").slice(0, 16384);
  }
  return result;
}

// Coordinator 收到浏览器经 Relay 转发来的 Console 请求后，直接调用本地 HTTP 入口。
// 请求的真实身份来自已经通过集群密钥认证的 federation 连接，而不是转发头。
export async function dispatchConsoleRequest(httpPort: number, relayNodeId: string, params: JsonRecord): Promise<ConsoleReply> {
  const method = typeof params.method === "string" ? params.method.toUpperCase() : "";
  const path = typeof params.path === "string" ? params.path : "";
  if (!["GET", "HEAD", "POST"].includes(method)) return { status: 405, body: { code: "CONSOLE_METHOD_REJECTED" } };
  if (!path.startsWith("/console/") && path !== "/console") return { status: 400, body: { code: "CONSOLE_PATH_REJECTED" } };
  const headers = params.headers && typeof params.headers === "object" ? params.headers as Record<string, unknown> : {};
  const headerList: [string, string][] = [
    ["x-quaymesh-relay", relayNodeId],
    ["x-quaymesh-relay-peer", typeof params.browserPeer === "string" && params.browserPeer ? params.browserPeer : relayNodeId],
  ];
  const browserOrigin = typeof headers.origin === "string" ? headers.origin : "";
  if (browserOrigin) headerList.push(["x-quaymesh-relay-origin", browserOrigin.slice(0, 2048)]);
  for (const name of FORWARD_HEADERS) {
    const value = headers[name];
    if (typeof value === "string" && value) headerList.push([name, value.slice(0, 16384)]);
  }
  let body: Buffer | undefined;
  if (typeof params.body === "string" && params.body) {
    body = params.bodyBase64 === true ? Buffer.from(params.body, "base64") : Buffer.from(params.body, "utf8");
    if (body.length > CONSOLE_REQUEST_LIMIT_BYTES) return { status: 413, body: { code: "CONSOLE_BODY_TOO_LARGE" } };
  }
  let response: Response;
  try {
    // 显式重验证，避免 fetch 为条件请求补上 no-cache 并使服务端忽略 ETag。
    response = await fetch(`http://127.0.0.1:${httpPort}${path}`, { method, headers: headerList, body: body ? new Uint8Array(body) : undefined, redirect: "manual", cache: "no-cache" });
  } catch (error) {
    return { status: 503, body: { code: "CONSOLE_UPSTREAM_UNAVAILABLE", message: error instanceof Error ? error.message : String(error) } };
  }
  const responseHeaders = pickResponseHeaders(Object.fromEntries(response.headers.entries()));
  const buffer = Buffer.from(await response.arrayBuffer());
  const type = response.headers.get("content-type") ?? "";
  const textual = TEXTUAL.test(type) && !/image\/(png|jpeg|gif|webp|x-icon|vnd\.microsoft\.icon)/i.test(type);
  return {
    status: response.status,
    headers: responseHeaders,
    body: textual ? buffer.toString("utf8") : buffer.toString("base64"),
    ...(textual ? {} : { bodyBase64: true }),
  };
}
