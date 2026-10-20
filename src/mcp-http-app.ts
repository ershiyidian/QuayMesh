import express, { type Request } from "express";
import type { CreateMcpExpressAppOptions } from "@modelcontextprotocol/sdk/server/express.js";
import { hostHeaderValidation, localhostHostValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";

export const MCP_REQUEST_BODY_LIMIT_BYTES = 2 * 1024 * 1024;

interface RequestRejection {
  httpStatus: 400 | 413;
  errorCode: "INVALID_JSON" | "REQUEST_BODY_TOO_LARGE";
  effect: "not_started";
  stage: "request_body";
  requestBytes: number | null;
  receivedBytes: number | null;
  limitBytes: number;
}

export function createMcpHttpApp(options: CreateMcpExpressAppOptions & {
  onRejected?(request: Request, fields: RequestRejection): string | undefined;
} = {}) {
  const { host = "127.0.0.1", allowedHosts } = options;
  const app = express();
  // 沿用 SDK 的公开 Host 校验；不依赖 Express 的私有中间件栈。
  if (allowedHosts) app.use(hostHeaderValidation(allowedHosts));
  else if (["127.0.0.1", "localhost", "::1"].includes(host)) app.use(localhostHostValidation());
  else if (host === "0.0.0.0" || host === "::") {
    console.warn(`Server is binding to ${host} without DNS rebinding protection. Consider using allowedHosts or authentication.`);
  }

  const ordinaryJson = express.json();
  // 任何带正文的 MCP 请求都受预算约束，内容类型仍由 SDK 协议校验。
  const mcpJson = express.json({ limit: MCP_REQUEST_BODY_LIMIT_BYTES, type: () => true });
  app.use((req, res, next) => {
    if (!/^\/mcp\/?$/iu.test(req.path)) { ordinaryJson(req, res, next); return; }
    mcpJson(req, res, error => {
      if (!error) { next(); return; }
      const type = (error as { type?: unknown }).type;
      if (type !== "entity.too.large" && type !== "entity.parse.failed") { next(error); return; }
      const oversized = type === "entity.too.large";
      const fields: RequestRejection = {
        httpStatus: oversized ? 413 : 400,
        errorCode: oversized ? "REQUEST_BODY_TOO_LARGE" : "INVALID_JSON",
        effect: "not_started", stage: "request_body",
        requestBytes: safeBytes(req.headers["content-length"]),
        receivedBytes: safeBytes((error as { received?: unknown }).received),
        limitBytes: MCP_REQUEST_BODY_LIMIT_BYTES,
      };
      let requestId: string | undefined;
      // 未解析正文，也未完成鉴权；只记录固定分类和数值，不记录错误原文或请求内容。
      try { requestId = options.onRejected?.(req, fields); } catch {}
      res.status(fields.httpStatus).json({
        jsonrpc: "2.0", id: null,
        error: {
          code: oversized ? -32600 : -32700,
          message: oversized ? "Request body exceeds 2 MiB; split the change into smaller requests." : "Request body is not valid JSON.",
          data: { error_code: fields.errorCode, effect: "not_started", retry_hint: "fix_input",
            ...(oversized ? { limit_bytes: MCP_REQUEST_BODY_LIMIT_BYTES } : {}),
            ...(requestId ? { request_id: requestId } : {}) },
        },
      });
    });
  });
  return app;
}

function safeBytes(value: unknown): number | null {
  const bytes = typeof value === "number" ? value
    : typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
}
