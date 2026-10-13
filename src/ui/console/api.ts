export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = "ApiError";
  }
}

let csrf: string | null = null;
let localNode: string | null = null;
let unauthorized: (() => void) | null = null;
let expired = false;
let generation = 0;
export const AUTHENTICATED = "quaymesh:authenticated";

export const session = {
  get csrf(): string | null { return csrf; },
  setCsrf(value: string | null): void {
    csrf = value;
    expired = false;
    generation += 1;
    if (!value) localNode = null;
    if (value && typeof window !== "undefined") window.dispatchEvent(new Event(AUTHENTICATED));
  },
  setLocalNode(value: string | null): void { localNode = value; },
  onUnauthorized(handler: (() => void) | null): void { unauthorized = handler; },
};

let installationRegistered = false;

export async function api<T = unknown>(path: string, body?: unknown, node?: string | null): Promise<T> {
  const authRequest = ["login", "logout", "session"].includes(path);
  if (expired && !authRequest) throw new ApiError("会话已过期，请重新登录。", 401);
  const requestGeneration = generation;
  const write = body !== undefined;
  const headers: Record<string, string> = {};
  if (node && node !== "local" && node !== localNode) headers["X-QuayMesh-Node"] = node;
  if (write) {
    headers["Content-Type"] = "application/json";
    if (csrf) headers["X-QuayMesh-CSRF"] = csrf;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), write ? 60_000 : 20_000);
  try {
    const response = await fetch(`/console/api/${path}`, {
      method: write ? "POST" : "GET", credentials: "same-origin", cache: "no-store",
      headers, signal: controller.signal,
      ...(write ? { body: JSON.stringify(body) } : {}),
    });
    if (!installationRegistered && response.headers.get("X-QuayMesh-Portal") === "1" && typeof navigator !== "undefined" && "serviceWorker" in navigator) {
      installationRegistered = true;
      void navigator.serviceWorker.register("/console/sw.js", { scope: "/console/" })
        .catch((error: unknown) => console.error("QuayMesh 应用安装组件加载失败：", error));
    }
    if (response.status === 401) {
      if (!authRequest && generation === requestGeneration && !expired) {
        expired = true;
        unauthorized?.();
      }
      throw new ApiError(path === "login" ? "授权口令不正确。" : "会话已过期，请重新登录。", 401);
    }
    const result: unknown = response.status === 204 ? {} : await response.json().catch(() => null);
    const record = result && typeof result === "object" ? result as Record<string, unknown> : null;
    if (!response.ok) {
      const code = typeof record?.code === "string" ? record.code : undefined;
      const message = typeof record?.message === "string" ? record.message
        : response.status === 429 ? "操作过于频繁，请稍后再试。"
        : `请求失败（HTTP ${response.status}${code ? ` · ${code}` : ""}）。`;
      throw new ApiError(message, response.status, code);
    }
    if (!record) throw new ApiError("接口没有返回有效的 JSON，请检查服务地址与反向代理配置。", response.status, "INVALID_RESPONSE");
    if (!authRequest && generation !== requestGeneration) throw new ApiError("登录状态已变化，请重新读取。", 401);
    return result as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const reason = controller.signal.aborted ? "请求超时" : "无法连接到 QuayMesh 服务";
    throw new ApiError(`${reason}。${write ? "请先核对操作结果，再决定是否重试。" : "请检查网络或服务是否在运行。"}`, 0);
  } finally {
    clearTimeout(timer);
  }
}

export function errorText(error: unknown, fallback = "操作失败"): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
export function isAuthError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}
