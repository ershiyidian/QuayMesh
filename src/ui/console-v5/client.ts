import { notifyDesktop } from './desktop.js';

export class ApiError extends Error {
  readonly name = "ApiError";
  constructor(message: string, readonly status = 0, readonly code = "network", extra: Record<string, unknown> = {}) {
    super(message);
    Object.assign(this, extra);
  }
}

export interface ConsoleSession {
  contract: string;
  user: { name: string; role: string };
  csrf: string;
  capabilities: Record<string, boolean>;
  expiresAt?: number;
}

export type ConsoleError = Error & { code?: string; status?: number };
export function consoleError(error: unknown): ConsoleError {
  return error instanceof Error ? error : new Error(String(error));
}

export function createApi(onUnauthorized: () => void) {
  const native = new Set(["session", "login", "logout", "sessions/revoke-all"]);
  const api = {
    csrf: null as string | null,
    session: null as ConsoleSession | null,
    pending: new Set<AbortController>(),
    requestCount: 0,
    base: () => new URL("./api/v4/", location.href.split("#")[0]).href,
    abortAll() { for (const controller of this.pending) controller.abort(); this.pending.clear(); },
    async request<T = unknown>(method: "GET" | "POST", path: string, body?: Record<string, unknown>, externalSignal?: AbortSignal): Promise<T> {
      const controller = new AbortController();
      api.pending.add(controller);
      api.requestCount++;
      let timedOut = false;
      const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, 15_000);
      const abort = () => controller.abort();
      externalSignal?.addEventListener("abort", abort, { once: true });
      if (externalSignal?.aborted) controller.abort();
      try {
        const base = native.has(path) ? new URL("./api/", location.href.split("#")[0]).href : api.base();
        const headers: Record<string, string> = { Accept: "application/json", "X-Request-ID": crypto.randomUUID() };
        if (method === "POST") {
          headers["Content-Type"] = "application/json";
          if (api.csrf) headers["X-QuayMesh-CSRF"] = api.csrf;
        }
        const response = await fetch(base + path, { method, credentials: "same-origin", cache: "no-store", headers,
          body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal });
        const text = await response.text();
        let value: unknown;
        try { value = text ? JSON.parse(text) : {}; }
        catch { throw new ApiError("接口没有返回 JSON，请检查运行版本与控制台入口", response.status, "invalid_response"); }
        if (!response.ok) {
          const failure = value as { message?: string; code?: string };
          throw new ApiError(failure.message || failure.code || `请求失败 HTTP ${response.status}`, response.status, failure.code || "http");
        }
        if (['session','login'].includes(path)) notifyDesktop('session',true);
        if (['logout','sessions/revoke-all'].includes(path)) notifyDesktop('session',false);
        return value as T;
      } catch (error) {
        if (timedOut) throw new ApiError("请求超过 15 秒，请查询当前状态后再继续", 0, "timeout");
        if (error instanceof ApiError && error.status === 401 && error.code === 'CONSOLE_LOGIN_REQUIRED') {
          api.csrf = null; api.session = null; notifyDesktop('session',false); onUnauthorized();
        }
        throw error;
      } finally {
        window.clearTimeout(timeout);
        externalSignal?.removeEventListener("abort", abort);
        api.pending.delete(controller);
      }
    },
    get<T = unknown>(path: string, signal?: AbortSignal): Promise<T> { return api.request<T>("GET", path, undefined, signal); },
    post<T = unknown>(path: string, body: Record<string, unknown> = {}, key: string = crypto.randomUUID()): Promise<T> { return api.request<T>("POST", path, { ...body, requestKey: key }); },
  };
  return api;
}
