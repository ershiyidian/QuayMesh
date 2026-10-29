import { createHash } from "node:crypto";
import type { Request, Response } from "express";

type RecordEvent = (event: string, fields: Record<string, unknown>, level?: "info" | "warn" | "error") => void;
const methods = new Set(["initialize", "server/discover", "tools/list", "tools/call", "resources/list", "resources/read", "resources/templates/list", "notifications/initialized", "ping"]);
const tools = new Set(["open_workspace", "attach_workspace", "read", "read_diagnostics", "workspace_context", "spawn_agent", "followup_agent", "send_message", "wait_agent", "interrupt_agent", "list_agents",  "exec_command", "write_stdin", "apply_patch", "write", "edit", "bash",
  "start_session","finish_task","workspace_catalog","read_output","cancel_command","checkpoint_task","download_artifact","copy_artifact","qm_widget_stage",
  "qm_session","qm_file_diff","qm_command_output","qm_command_outputs","qm_instruction","qm_patch","qm_revert","qm_file_url","qm_session_continue",
  "task_messages","task_resume","qm_task_message_enqueue","qm_task_messages"]);
const actions = new Set(["list","capture","search","status","recovery","start","observe","cancel",
  "history","receive","ack","reply","inspect","resume"]);
const errorCodes = new Set(["WORK_STATE", "INVALID_TASK", "AGENT_CONFLICT", "EXECUTION_CONFLICT", "STALE_CONTEXT", "ACCESS_DENIED", "WORKSPACE_NOT_FOUND", "WORKSPACE_RESTORE_REQUIRED", "WORKSPACE_MISMATCH", "WORKSPACE_SESSION_MISMATCH", "SESSION_SCOPE_MISMATCH", "TASK_NOT_ACTIVE", "AGENT_NOT_FOUND",
  "NODE_ADMISSION_PAUSED", "TASK_SESSION_MISMATCH", "TASK_NOT_FOUND", "INVALID_ARGUMENT", "OPERATION_KEY_INVALID", "REQUEST_ID_REUSED",
  "OPERATION_RETRY_SCOPE_MISMATCH", "OPERATION_RETRY_NOT_ALLOWED", "OPERATION_RETRY_SUPERSEDED", "OPERATION_ID_MISMATCH",
  "REQUEST_TIMEOUT", "RPC_INTERRUPTED", "NODE_UNAVAILABLE", "PEER_BUSY", "PROCESS_RECONCILIATION_REQUIRED", "TOOL_EXECUTION_ERROR", "ZOD_ERROR",
  // Explicit Task access, mailbox, binding and finalization contracts. Unknown strings still become "other".
  "MISSING_AUTHENTICATED_OWNER", "MISSING_AUTHENTICATED_CLIENT", "TASK_ACCESS_INVALID_ID", "TASK_ACCESS_DENIED",
  "TASK_ACCESS_METADATA_INVALID", "TASK_ACCESS_OWNER_SOURCE_INVALID", "TASK_ACCESS_TRANSACTION_REQUIRED",
  "TASK_MAILBOX_AUTHORITY_REQUIRED", "TASK_MAILBOX_ENTRY_REQUIRED", "TASK_MAILBOX_INVALID_ACTION", "TASK_MAILBOX_INVALID_ID",
  "TASK_MAILBOX_INVALID_BODY", "TASK_MAILBOX_INVALID_CLAIM", "TASK_MAILBOX_INVALID_ACK", "TASK_MAILBOX_INVALID_REPLY",
  "TASK_MAILBOX_INVALID_CURSOR", "TASK_MAILBOX_INVALID_FILTER", "TASK_MAILBOX_INVALID_SEQUENCE", "TASK_MAILBOX_IDEMPOTENCY_CONFLICT",
  "TASK_MAILBOX_TASK_CLOSED", "TASK_MAILBOX_TASK_FINISHING", "TASK_MAILBOX_BATCH_LIMIT", "TASK_MAILBOX_RECEIVER_MISMATCH",
  "TASK_MAILBOX_MESSAGE_NOT_OFFERED", "TASK_MAILBOX_DELIVERY_SUPERSEDED", "TASK_MAILBOX_LEASE_EXPIRED", "TASK_MAILBOX_ACK_OUT_OF_ORDER",
  "TASK_MAILBOX_REPLY_NOT_ACKNOWLEDGED", "TASK_MAILBOX_MESSAGE_NOT_FOUND", "TASK_MAILBOX_DELIVERY_NOT_FOUND",
  "TASK_MAILBOX_CORRUPT_DELIVERY", "TASK_MAILBOX_TRANSACTION_REQUIRED", "TASK_MAILBOX_CHANGED", "TASK_MAILBOX_INPUT_PENDING",
  "TASK_ENTRY_REQUIRED", "TASK_BINDING_AUTHORITY_REQUIRED", "TASK_BINDING_INVALID_INPUT", "TASK_BINDING_REPLY_TOO_LARGE",
  "TASK_START_SELECTION_REQUIRED", "TASK_BINDING_KEY_CONFLICT", "TASK_BINDING_REVISION_REQUIRED", "TASK_BINDING_REQUEST_KEY_REQUIRED", "TASK_BINDING_CHANGED",
  "TASK_BINDING_REPLAY_SUPERSEDED", "TASK_FINISHING", "TASK_HANDOFF_NOT_TERMINAL", "TASK_REVISION_REQUIRED", "TASK_REVISION_CONFLICT",
  "TASK_FINALIZATION_SUPERSEDED", "TASK_FINALIZATION_CONFLICT", "TASK_FINALIZATION_ALREADY_CONFIRMED",
  "TASK_FINALIZATION_WRITE_TRANSACTION_REQUIRED", "TASK_OWNER_FINALIZATION_UNCONFIRMED",
  // Fixed peer binding and copy contracts, including legacy receipt lookup failures.
  "TASK_BINDING_COORDINATOR_REQUIRED", "TASK_BINDING_CAPABILITY_INVALID", "TASK_BINDING_PEER_UPGRADE_REQUIRED",
  "TASK_BINDING_VERSION_UNSUPPORTED", "TASK_BINDING_SCOPE_REQUIRED", "TASK_SCOPE_MISMATCH", "TASK_MEMBER_REQUIRED",
  "TASK_REMOTE_HISTORY_UNAVAILABLE", "TASK_REMOTE_SCOPE_MISMATCH", "COPY_REQUEST_KEY_REQUIRED", "COPY_REQUEST_KEY_REUSED",
  "COPY_TASK_CONTEXT_REQUIRED", "COPY_RECEIPT_LOOKUP_FAILED", "COPY_ARGUMENT_REQUIRED",
  "ENOENT", "EACCES", "EPERM", "EINVAL", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ECONNABORTED", "EPIPE", "ENOTFOUND"]);
const effects = new Set(["not_started", "started", "partial", "completed", "unknown"]);
const retryHints = new Set(["fix_input", "retry_same_key", "query_original", "do_not_retry", "retry_later"]);
// 只检查服务自己定义的完整恢复尾注；错误正文、任意标记和私有 details 不进入日志。
const recoverySuffix = /\n\[QuayMesh recovery: error_code=([A-Z][A-Z0-9_]{0,63}); effect=(?:not_started|started|partial|completed|unknown); retry_hint=(?:fix_input|retry_same_key|query_original|do_not_retry|retry_later)(?:; operation_id=[A-Za-z0-9][A-Za-z0-9_.:%~-]{0,255})?\]$/u;
const object = (value: unknown): Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
const known = (value: unknown, allowed: Set<string>) => typeof value === "string" && allowed.has(value) ? value : "other";
const identity = (value: unknown, prefix: string) => typeof value === "string"
  && new RegExp(`^(?:qm:[A-Za-z0-9_-]+:)?${prefix}_[a-f0-9]{6,64}$`).test(value) ? value : undefined;

export function diagnosticOwnerHash(owner: string): string {
  return createHash('sha256').update(owner).digest('hex');
}

// HTTP、JSON-RPC 和工具结果分别判定；未检查的大响应保留未知状态。
export function mcpExchangeOutcome(row: Record<string, unknown>): 'transport_error' | 'protocol_error' | 'tool_error' | 'success' | 'uninspected' {
  if (row.aborted === true || typeof row.httpStatus === 'number' && row.httpStatus >= 400) return 'transport_error';
  if (typeof row.rpcErrorCode === 'number') return 'protocol_error';
  if (row.toolError === true) return 'tool_error';
  return row.resultInspection === 'inspected' ? 'success' : 'uninspected';
}

export function argumentFingerprint(args: Record<string, any>): string {
  const normalize = (value: any): any => Array.isArray(value) ? value.map(normalize)
    : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])])) : value;
  const selection = Array.isArray(args.files) ? args.files.map((file: any) => ({ path: String(file?.path ?? "").replaceAll("\\", "/"),
    startLine: file?.start_line ?? file?.startLine ?? 1, maxLines: file?.max_lines ?? file?.maxLines ?? 80 })) : undefined;
  return createHash("sha256").update(JSON.stringify(normalize({ ...args,
    ...(typeof args.path === "string" ? { path: args.path.replaceAll("\\", "/") } : {}),
    ...(typeof args.directory === "string" ? { directory: args.directory.replaceAll("\\", "/") } : {}),
    ...(selection ? { files: selection } : {}) }))).digest("hex");
}

/** Metadata only. Never log request arguments, result text, headers, or raw errors.
 * This boundary also sees schema/auth failures that never enter a tool handler. */
export function traceMcpRequest(req: Request, res: Response, requestId: string, record: RecordEvent): { authenticated(): void } {
  const body = object(req.body), params = object(body.params), args = object(params.arguments);
  const session = object(params._meta)["openai/session"];
  // Untrusted correlation only: never replaces requestId, authentication or operation identity.
  const relayTrace = req.headers["x-quaymesh-relay-trace"];
  const context = { requestId, method: known(body.method, methods),
    ...(typeof relayTrace === "string" && relayTrace.length === 36 && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(relayTrace)
      ? { relayTraceId: relayTrace.toLowerCase() } : {}),
    source:body.method!=="tools/call" ? "protocol" : String(params.name).startsWith("qm_") ? "card" : "model",
    sourceEvidence:"tool_surface",taskId:identity(args.task_id,"task"),
    operationId:identity(args.operation_id ?? args.operationId,"op"),
    requestBytes:Number(req.headers["content-length"] ?? 0),
    ...(body.method === "resources/read" && typeof params.uri === "string" ? { resourceUri: params.uri.slice(0, 512) } : {}),
    ...(body.method === "tools/call" ? { tool: known(params.name, tools), action: known(args.action, actions),
      workspaceId: identity(args.workspace_id ?? args.workspaceId, "ws"), workRunId: identity(args.work_run_id ?? args.workRunId, "run"), agentId: identity(args.agent_id ?? args.agentId, "agt") } : {}),
    argumentFingerprint: argumentFingerprint(args), selectionCount: Array.isArray(args.files) ? args.files.length : typeof args.path === "string" ? 1 : 0,
    conversationHash: typeof session === "string" && session.length <= 1024
      ? createHash("sha256").update(JSON.stringify(session)).digest("hex").slice(0, 24) : undefined };
  const started = performance.now(), limit = 64 * 1024;
  let bytes = 0, capturedBytes = 0, done = false, authenticated = false;
  let headersAt: number | undefined;
  let firstByteAt: number | undefined;
  const chunks: Buffer[] = [], hash = createHash("sha256");
  const capture = (chunk: unknown, encoding?: unknown) => {
    if (chunk === undefined || chunk === null) return;
    const value = typeof chunk === "string" ? Buffer.from(chunk, typeof encoding === "string" ? encoding as BufferEncoding : "utf8")
      : Buffer.isBuffer(chunk) ? chunk : chunk instanceof Uint8Array ? Buffer.from(chunk) : undefined;
    if (!value) return;
    if (value.length && firstByteAt === undefined) firstByteAt = performance.now();
    bytes += value.length; hash.update(value);
    if (bytes <= limit) { chunks.push(Buffer.from(value)); capturedBytes += value.length; }
    else { chunks.length = 0; capturedBytes = 0; }
  };
  const writeHead = res.writeHead, flushHeaders = res.flushHeaders;
  res.writeHead = function (this: Response, ...args: any[]) {
    if (headersAt === undefined) headersAt = performance.now();
    return (writeHead as (...values: any[]) => Response).apply(this, args);
  } as Response["writeHead"];
  res.flushHeaders = function (this: Response) {
    if (headersAt === undefined) headersAt = performance.now();
    return flushHeaders.call(this);
  };
  const write = res.write, end = res.end;
  res.write = function (this: Response, ...args: any[]) { capture(args[0], args[1]); return (write as any).apply(this, args); } as Response["write"];
  res.end = function (this: Response, ...args: any[]) { capture(args[0], args[1]); return (end as any).apply(this, args); } as Response["end"];
  // Logging failures must never alter transport/tool semantics.
  const emit: RecordEvent = (...args) => { try { record(...args); } catch {} };
  emit("mcp_exchange_started", context);
  const finish = () => {
    if (done) return; done = true;
    let result: Record<string, unknown> = { resultInspection: bytes > limit ? "over_limit" : "unrecognized" };
    if (capturedBytes) {
      const text = Buffer.concat(chunks).toString("utf8");
      const messages = String(res.getHeader("content-type") ?? "").includes("text/event-stream")
        ? text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()) : [text];
      for (const message of messages) {
        try {
          const envelope = object(JSON.parse(message));
          if (!("result" in envelope) && !("error" in envelope)) continue;
          const payload = object(envelope.result), error = object(envelope.error);
          const structured = object(payload.structuredContent);
          const content = Array.isArray(payload.content) ? payload.content : [];
          result = { resultInspection: "inspected", rpcErrorCode: Number.isInteger(error.code) ? error.code : undefined,
            taskId: identity(structured.task_id, "task") ?? context.taskId,
            operationId: identity(structured.operation_id ?? structured.operationId, "op") ?? context.operationId,
            toolError: payload.isError === true, contentBlocks: content.length,
            textBytes: content.reduce((n: number, block: any) => n + (typeof block?.text === "string" ? Buffer.byteLength(block.text) : 0), 0),
            structuredContentPresent: payload.structuredContent !== undefined,
            structuredTextBytes:typeof structured.result==="string"?Buffer.byteLength(structured.result):0,
            duplicateBodyBytes:typeof structured.result==="string" && content.some((block:any)=>block.type==="text"&&block.text===structured.result)
              ? Buffer.byteLength(structured.result):0 };
          // 结构化错误只提取允许的元数据，远端错误内容仍不进入日志。
          if (typeof structured.error_code === "string") result.toolErrorCode = known(structured.error_code, errorCodes);
          if (typeof structured.effect === "string") result.effect = known(structured.effect, effects);
          if (typeof structured.retry_hint === "string") result.retryHint = known(structured.retry_hint, retryHints);
          // Report only presence of receipt layers; values/errors may be private.
          for (const block of content) {
            if (block?.type !== "text" || typeof block.text !== "string") continue;
            const recoveryCode = recoverySuffix.exec(block.text)?.[1];
            if (recoveryCode) {
              result.recoveryTextErrorCode = known(recoveryCode, errorCodes);
              if (typeof structured.error_code === "string") result.errorCodeConsistent = result.errorCodeConsistent !== false
                && recoveryCode === structured.error_code;
            }
            try {
              const value = object(JSON.parse(block.text));
              result.operationId = identity(value.operation_id ?? value.operationId, "op") ?? result.operationId;
              result.receiptPresent = result.receiptPresent === true || "completionReceipt" in value || "completionSnapshot" in value || "receipt" in value || "workRunId" in value || "work_run_id" in value;
              if (result.toolErrorCode === undefined && typeof value.code === "string") result.toolErrorCode = known(value.code, errorCodes);
              if (typeof value.message === "string" && payload.isError === true) result.errorFingerprint = createHash("sha256").update(value.message).digest("hex").slice(0, 16);
            } catch { /* Non-JSON text is never returned to logs. */ }
          }
        } catch { /* No raw malformed response in diagnostics. */ }
      }
    }
    const outcome = mcpExchangeOutcome({...result,httpStatus:res.statusCode,aborted:!res.writableFinished});
    const owner = object(req.auth?.extra).owner_id;
    emit("mcp_exchange_finished", { ...context, httpStatus: res.statusCode, aborted: !res.writableFinished,
      transportStatus: res.writableFinished ? "finished" : "aborted", hostAcknowledgment: "unknown",
      outcome, ...(typeof owner === 'string' ? {ownerHash:diagnosticOwnerHash(owner)} : {}),
      durationMs: Math.round(performance.now() - started),
      responseHeadersMs: headersAt === undefined ? null : Math.round(headersAt - started),
      firstResponseByteMs: firstByteAt === undefined ? null : Math.round(firstByteAt - started),
      responseBytes: bytes, responseSha256: hash.digest("hex"),
      responseFormat: String(res.getHeader("content-type") ?? "").includes("text/event-stream") ? "sse"
        : String(res.getHeader("content-type") ?? "").includes("application/json") ? "json" : "other",
      ...result }, outcome.endsWith('_error') ? "warn" : "info");
    chunks.length = 0;
    res.off("finish", finish); res.off("close", finish);
  };
  res.once("finish", finish); res.once("close", finish);
  return { authenticated() {
    if (done || authenticated) return;
    const owner = object(req.auth?.extra).owner_id;
    if (typeof owner !== "string" || !owner) return;
    authenticated = true;
    // 仅由 HTTP 身份和目标资源校验成功处调用，不表示工具已经授权或执行。
    emit("mcp_exchange_authenticated", { ...context, ownerHash: diagnosticOwnerHash(owner),
      authenticationMs: Math.round(performance.now() - started) });
  } };
}
