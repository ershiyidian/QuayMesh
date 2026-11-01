import { NodeUnavailableError, PeerApplicationError, RpcRequestTimeoutError } from "./transport.js";

export const READ_TOTAL_BUDGET_MS = 30_000;
export const READ_ATTEMPT_TIMEOUT_MS = 10_000;
/** Extra attempts after the first call. Wall time is still capped by READ_TOTAL_BUDGET_MS. */
export const MAX_READ_RETRIES = 3;

export function isTransientPeerFailure(error: unknown): boolean {
  if (!error) return false;
  if (typeof error === "object") {
    const err = error as Record<string, unknown>;
    const code = String(err.code ?? err.name ?? "");
    // 远端已经执行的业务异常不能重试；只有明确定性的传输中断可重试只读请求。
    if (error instanceof PeerApplicationError) return ["RPC_INTERRUPTED", "REQUEST_TIMEOUT", "NODE_UNAVAILABLE", "PEER_BUSY"].includes(code);
    const status = Number(err.status ?? err.statusCode ?? 0);
    if (code === "NODE_UNAVAILABLE" || code === "RPC_INTERRUPTED" || code === "REQUEST_TIMEOUT") return true;
    if (status === 502 || status === 503 || status === 504) return true;
    if (["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ECONNABORTED", "EPIPE", "ENOTFOUND"].includes(code)) return true;
  }
  return false;
}

export function isIdempotentPeerRequest(method: string, params: unknown): boolean {
  if (method === "hello") return true;
  if (method === "settings.get" || method === "mihomo.read") return true;
  if (method === "transfers.list" || method === "artifact.stat" || method === "artifact.observe" || method === "artifact.lookup") return true;
  if (method === "console" || method === "console.request") {
    const p = params as { method?: string } | undefined;
    const httpMethod = p?.method?.toUpperCase() ?? "GET";
    return httpMethod === "GET" || httpMethod === "HEAD";
  }
  if (method === "session.feed") {
    const kind = (params as { kind?: unknown } | null)?.kind;
    // Finalize/archive mutate goal ownership and can outlive a lost response.
    // Their durable intent, not read retry, controls any subsequent attempt.
    return ["snapshot", "revision", "subscribe", "unsubscribe"].includes(String(kind));
  }
  if (method === "tool") {
    const p = params as { name?: string; input?: Record<string, unknown> } | undefined;
    const toolName = p?.name;
    const input = p?.input ?? {};
    if (toolName === "workspace_catalog") return true;
    if (toolName === "open_workspace") {
      return input.create_directory !== true && (input.mode === undefined || input.mode === "checkout");
    }
    if (toolName === "attach_workspace") {
      return input.create_directory !== true && (input.mode === undefined || input.mode === "checkout");
    }
    if (toolName === "workspace_context") {
      // Recovery release/stop change durable execution state. A lost reply
      // must retain that invocation, not replay it as a cancellable read.
      return ["list", "capture", "search", "status"].includes(String(input.action))
        || input.action === "recovery" && (input.recovery_action === undefined || input.recovery_action === "inspect");
    }
    // Read-only surface. Snapshot, detail, list and status queries may be retried inside the read budget.
    if (toolName === "read" || toolName === "read_output" || toolName === "list_directory" || toolName === "search_files" ||
        toolName === "wait_agent" || toolName === "list_agents" ||
        toolName === "qm_session" || toolName === "qm_file_diff" ||
        toolName === "qm_command_output" || toolName === "qm_command_outputs" || toolName === "qm_instruction" ||
        toolName === "qm_patch" || toolName === "qm_file_url" ||
        toolName === "qm_session_continue") {
      return true;
    }
    // Empty write_stdin is a read-cursor poll; a non-empty write is a mutation and never retried.
    if (toolName === "write_stdin") {
      return (input.chars === undefined || input.chars === null || input.chars === "") && input.columns===undefined && input.rows===undefined;
    }
    return false;
  }
  return false;
}


/** Workspace membership is durable even when opening it is replay-safe. */
export function isCancellableToolObservation(name: string, input: Record<string, unknown>): boolean {
  return name !== "open_workspace" && name !== "attach_workspace"
    && isIdempotentPeerRequest("tool", { name, input });
}

export interface ReadRetryLink<T> {
  connected: boolean;
  call(timeoutMs: number): Promise<T>;
  close(): void;
}

export interface PeerDispatchOptions<T> {
  node: string;
  method: string;
  params: unknown;
  timeoutMs?: number;
  rpcTimeoutMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  signal?: AbortSignal;
  getLink: () => ReadRetryLink<T> | undefined;
  waitForLink?: (waitMs: number) => Promise<ReadRetryLink<T> | undefined>;
}

function backoffMs(attempt: number, random: () => number): number {
  return Math.round(250 * 2 ** attempt + random() * 100);
}

function dropBrokenLink(error: unknown, link: ReadRetryLink<unknown>): void {
  if (!error || typeof error !== "object") return;
  const code = String((error as { code?: unknown }).code ?? "");
  if (code === "ECONNRESET" || code === "EPIPE" || code === "ECONNABORTED" || code === "ECONNREFUSED") {
    link.close();
  }
}

function retryableStatus<T>(result: T): boolean {
  if (!result || typeof result !== "object" || !("status" in result)) return false;
  const status = Number((result as { status?: unknown }).status);
  return status === 502 || status === 503 || status === 504;
}

export async function executeBoundedRead<T>(options: PeerDispatchOptions<T>): Promise<T> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const random = options.random ?? Math.random;
  const budget = Math.min(options.timeoutMs ?? options.rpcTimeoutMs, READ_TOTAL_BUDGET_MS);
  const deadline = now() + Math.max(0, budget);
  const maxAttempts = MAX_READ_RETRIES + 1;
  let lastError: unknown = new RpcRequestTimeoutError(options.node, "read-budget", "读取预算已耗尽");
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    options.signal?.throwIfAborted();
    if (deadline - now() <= 0) throw new RpcRequestTimeoutError(options.node, "read-budget", "读取预算已耗尽");
    let link = options.getLink();
    if (!link?.connected && options.waitForLink) {
      const waitMs = Math.min(deadline - now(), Math.max(1, backoffMs(attempt, () => 0)));
      if (waitMs > 0) link = await options.waitForLink(waitMs);
      options.signal?.throwIfAborted();
    }
    if (!link?.connected) {
      lastError = new NodeUnavailableError(options.node);
      if (attempt === maxAttempts - 1 || deadline - now() <= 0) throw lastError;
      const delay = Math.min(Math.max(0, deadline - now()), backoffMs(attempt, random));
      if (delay > 0) await sleep(delay);
      if (deadline - now() <= 0) throw new RpcRequestTimeoutError(options.node, "read-budget", "读取预算已耗尽");
      continue;
    }
    const timeout = Math.min(readAttemptTimeout(options.method, options.params), Math.max(1, deadline - now()));
    try {
      const result = await link.call(timeout);
      if (retryableStatus(result) && attempt < maxAttempts - 1 && deadline - now() > 0) {
        const delay = Math.min(deadline - now(), backoffMs(attempt, random));
        if (delay > 0) await sleep(delay);
        continue;
      }
      return result;
    } catch (error) {
      lastError = error;
      dropBrokenLink(error, link);
      if (!isTransientPeerFailure(error) || attempt === maxAttempts - 1) throw error;
      if (deadline - now() <= 0) throw new RpcRequestTimeoutError(options.node, "read-budget", "读取预算已耗尽");
      const delay = Math.min(deadline - now(), backoffMs(attempt, random));
      if (delay > 0) await sleep(delay);
    }
  }
  throw lastError instanceof Error ? lastError : new RpcRequestTimeoutError(options.node, "read-budget", "读取预算已耗尽");
}

function readAttemptTimeout(method: string, params: unknown): number {
  if ((method === "console" || method === "console.request")
    && ["GET", "HEAD"].includes(String((params as {method?:unknown}|null)?.method ?? "GET").toUpperCase())) return 18_000;
  if (method !== "tool" || !params || typeof params !== "object") return READ_ATTEMPT_TIMEOUT_MS;
  const request = params as { name?: unknown; input?: Record<string, unknown> };
  if (request.name === "open_workspace" || request.name === "attach_workspace") {
    // Windows Desktop project registration can legitimately wait up to 15 seconds
    // for the client-owned project mapping before returning a verified/partial receipt.
    return 20_000;
  }
  const waitMs = request.name === "read_output" ? Number(request.input?.wait_ms ?? 0)
    : request.name === "wait_agent" ? Number(request.input?.result_cursor ? 0 : request.input?.timeout_ms ?? 5_000)
      : request.name === "write_stdin" ? Number(request.input?.yield_time_ms ?? 5_000) : 0;
  if (!Number.isFinite(waitMs) || waitMs < 0) return READ_ATTEMPT_TIMEOUT_MS;
  const maxWaitMs = request.name === "write_stdin" ? 12_000 : 10_000;
  // 观察可以等满窗口；单次 RPC 还要留出传输和回传时间，总期限仍由调用方限制。
  return Math.max(READ_ATTEMPT_TIMEOUT_MS, Math.min(maxWaitMs, waitMs) + 3_000);
}

/** Idempotent reads retry inside a 30s budget. Mutations are attempted exactly once. */
export function dispatchPeerRequest<T>(options: PeerDispatchOptions<T>): Promise<T> {
  if (!isIdempotentPeerRequest(options.method, options.params)) {
    const link = options.getLink();
    if (!link?.connected) return Promise.reject(Object.assign(new NodeUnavailableError(options.node), {
      effect: "not_started", retryHint: "retry_later", details: { dispatch_state: "not_sent", owner_node_id: options.node },
    }));
    return link.call(options.timeoutMs ?? options.rpcTimeoutMs);
  }
  return executeBoundedRead(options);
}

/** Local single-dispatch proof only. A peer's error envelope is never proof that no owner received the request. */
export function locallyUnsentPeerRequest(error: unknown): boolean {
  if (!error || typeof error !== "object" || error instanceof PeerApplicationError) return false;
  const value=error as { effect?: unknown; details?: { dispatch_state?: unknown } };
  if (value.effect!=="not_started") return false;
  return error instanceof NodeUnavailableError || value.details?.dispatch_state==="not_sent";
}
