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

export type ConsoleError = Error & { code?: string; status?: number; outcome?: string; effect?: string; requestKey?: string };
export function consoleError(error: unknown): ConsoleError {
  return error instanceof Error ? error : new Error(String(error));
}

export function validateSession(session: ConsoleSession): void {
  if (session?.contract !== "quaymesh.console.v4" || !session.capabilities?.conversations
      || !session.capabilities.taskLifecycle || !session.capabilities.workspaceLocations
      || typeof session.csrf !== "string" || !session.user?.name)
    throw new ApiError("控制台与协调端版本不一致，请更新协调端服务。", 409, "contract_mismatch");
}

export function uncertainWrite(error: unknown): boolean {
  const value = consoleError(error);
  if (value.outcome === "none" || value.effect === "none") return false;
  if ([value.outcome, value.effect].some(effect => effect === "unknown" || effect === "partial" || effect === "applied")) return true;
  return !value.status || value.status >= 500 || value.code === "request_in_progress";
}

// 未知结果复用原请求；明确拒绝后的修正采用新身份。
export class WriteIntent {
  private key = crypto.randomUUID();
  private uncertainBody: string | null = null;
  constructor(private readonly api: Pick<ReturnType<typeof createApi>, "post" | "get">, private readonly path: string) {}
  async submit<T>(body: Record<string, unknown>): Promise<T> {
    const serialized = JSON.stringify(body);
    if (this.uncertainBody !== null && this.uncertainBody !== serialized)
      throw new ApiError("原提交的结果尚待核对，请先查询原结果后再修改内容。", 409, "write_result_unknown", { effect: "unknown", requestKey: this.key });
    try {
      if (this.uncertainBody !== null) {
        const receipt = await this.api.get<{ state: string; response?: T; error?: { message?: string; code?: string; status?: number } } | null>(
          'receipts/' + encodeURIComponent(this.key) + '?path=' + encodeURIComponent('/api/v4/' + this.path)
          + '&target=' + encodeURIComponent(String(body.id ?? body.projectId ?? body.previewId ?? '')));
        if (receipt?.state === 'completed' || receipt?.state === 'partial') {
          if (receipt.response === undefined) throw new ApiError('回执尚未保存完整结果，请稍后查询。', 202, 'request_in_progress', { effect: 'unknown' });
          this.uncertainBody = null; return receipt.response;
        }
        if (receipt?.state === 'rejected') throw new ApiError(receipt.error?.message || '原请求已拒绝，可以修改后重新提交。', receipt.error?.status || 409, receipt.error?.code || 'operation_rejected', { effect: 'none' });
        throw new ApiError('原请求结果仍待核对，可在活动的“操作回执”中继续查看。', 202, 'request_in_progress', { effect: 'unknown', requestKey: this.key });
      }
      const value = await this.api.post<T>(this.path, body, this.key);
      this.uncertainBody = null;
      return value;
    } catch (error) {
      if (uncertainWrite(error)) this.uncertainBody = serialized;
      else { this.key = crypto.randomUUID(); this.uncertainBody = null; }
      throw error;
    }
  }
}

export function createApi(onUnauthorized: () => void, onWrite?: () => void) {
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
      const budget = native.has(path) ? 15_000 : method === "GET" ? 45_000 : 60_000;
      const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, budget);
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
        catch { throw new ApiError("接口没有返回 JSON，请检查运行版本与控制台入口", response.status, "invalid_response", method === 'POST' ? {effect:'unknown',requestKey:body?.requestKey} : {}); }
        if (!response.ok) {
          const failure = value as { message?: string; code?: string } & Record<string, unknown>;
          throw new ApiError(failure.message || failure.code || `请求失败 HTTP ${response.status}`, response.status, failure.code || "http", failure);
        }
        if (method === 'POST' && (!value || typeof value !== 'object' || Array.isArray(value)))
          throw new ApiError('提交返回了无效回执，请查询原请求结果。',response.status,'invalid_response',{effect:'unknown',requestKey:body?.requestKey});
        if (['session','login'].includes(path)) notifyDesktop('session',true);
        if (['logout','sessions/revoke-all'].includes(path)) notifyDesktop('session',false);
        return value as T;
      } catch (error) {
        if (timedOut) throw new ApiError(method === "POST" ? "提交结果尚未返回，请查询原请求结果。" : `读取超过 ${budget / 1000} 秒，已保留最近确认的数据。`, 0, "timeout", method === "POST" ? { effect: "unknown", requestKey: body?.requestKey } : {});
        if (error instanceof ApiError && error.status === 401 && error.code === 'CONSOLE_LOGIN_REQUIRED') {
          api.csrf = null; api.session = null; notifyDesktop('session',false); onUnauthorized();
        }
        if (!(error instanceof ApiError) && !(error instanceof DOMException && error.name === 'AbortError'))
          throw new ApiError(error instanceof Error ? error.message : '网络请求失败', 0, 'network', method === 'POST' ? { effect: 'unknown', requestKey: body?.requestKey } : {});
        throw error;
      } finally {
        window.clearTimeout(timeout);
        externalSignal?.removeEventListener("abort", abort);
        api.pending.delete(controller);
      }
    },
    get<T = unknown>(path: string, signal?: AbortSignal): Promise<T> { return api.request<T>("GET", path, undefined, signal); },
    async post<T = unknown>(path: string, body: Record<string, unknown> = {}, key: string = crypto.randomUUID()): Promise<T> {
      try { return await api.request<T>("POST", path, { ...body, requestKey: key }); }
      finally { if (!native.has(path)) onWrite?.(); }
    },
  };
  return api;
}
