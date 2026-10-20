import { NodeUnavailableError, PeerApplicationError, RpcRequestTimeoutError } from "./transport.js";

export const READ_TOTAL_BUDGET_MS = 30_000;
export const READ_ATTEMPT_TIMEOUT_MS = 10_000;
/** Extra attempts after the first call. Wall time is still capped by READ_TOTAL_BUDGET_MS. */
export const MAX_READ_RETRIES = 3;

export function isTransientPeerFailure(error: unknown): boolean {
  if (error instanceof PeerApplicationError) return false;
  if (!error) return false;
  if (typeof error === "object") {
    const err = error as Record<string, unknown>;
    const code = String(err.code ?? err.name ?? "");
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
  if (method === "console") {
    const p = params as { method?: string } | undefined;
    const httpMethod = p?.method?.toUpperCase() ?? "GET";
    return httpMethod === "GET" || httpMethod === "HEAD";
  }
  if (method === "session.feed") return true;
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
    // Read-only surface. Snapshot, detail, list and status queries may be retried inside the read budget.
    if (toolName === "read" || toolName === "read_output" || toolName === "list_directory" || toolName === "search_files" ||
        toolName === "workspace_context" || toolName === "wait_agent" || toolName === "list_agents" ||
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
    if (deadline - now() <= 0) throw new RpcRequestTimeoutError(options.node, "read-budget", "读取预算已耗尽");
    let link = options.getLink();
    if (!link?.connected && options.waitForLink) {
      const waitMs = Math.min(deadline - now(), Math.max(1, backoffMs(attempt, () => 0)));
      if (waitMs > 0) link = await options.waitForLink(waitMs);
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
  if (method !== "tool" || !params || typeof params !== "object") return READ_ATTEMPT_TIMEOUT_MS;
  const request = params as { name?: unknown; input?: Record<string, unknown> };
  if (request.name === "open_workspace" || request.name === "attach_workspace") {
    // Windows Desktop project registration can legitimately wait up to 15 seconds
    // for the client-owned project mapping before returning a verified/partial receipt.
    return 20_000;
  }
  if (request.name !== "write_stdin") return READ_ATTEMPT_TIMEOUT_MS;
  const yieldMs = Number(request.input?.yield_time_ms ?? 5_000);
  if (!Number.isFinite(yieldMs) || yieldMs < 0) return READ_ATTEMPT_TIMEOUT_MS;
  // A write_stdin poll can intentionally wait for up to 12 seconds. The
  // transport attempt has to outlive that wait or a healthy request is retried
  // while the first invocation is still executing on the remote node.
  return Math.max(READ_ATTEMPT_TIMEOUT_MS, Math.min(12_000, yieldMs) + 3_000);
}

/** Idempotent reads retry inside a 30s budget. Mutations are attempted exactly once. */
export function dispatchPeerRequest<T>(options: PeerDispatchOptions<T>): Promise<T> {
  if (!isIdempotentPeerRequest(options.method, options.params)) {
    const link = options.getLink();
    if (!link?.connected) return Promise.reject(new NodeUnavailableError(options.node));
    return link.call(options.timeoutMs ?? options.rpcTimeoutMs);
  }
  return executeBoundedRead(options);
}
