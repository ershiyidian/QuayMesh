import { toolDeadline } from "./tool-request-budget.js";

// 观察可以停止等待；执行的所有权仍由原操作持有。
export function observeWithSignal<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) { void work.catch(() => {}); return Promise.reject(signal.reason); }
  return new Promise<T>((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason); };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    work.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

export function observationBudget(name: string, input: unknown, extra: { signal?: AbortSignal; _meta?: unknown }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(Object.assign(new Error("TOOL_REQUEST_EXPIRED: observation deadline reached; query the saved operation again"), {
    code: "TOOL_REQUEST_EXPIRED", effect: "not_started", retryHint: "retry_later",
  })), Math.max(1, toolDeadline(name, input, extra._meta) - Date.now() - 100));
  timeout.unref();
  return { signal: extra.signal ? AbortSignal.any([extra.signal, controller.signal]) : controller.signal,
    dispose: () => clearTimeout(timeout) };
}

export class ObservationGate {
  private active = 0;
  private readonly waiting: Array<{ enter: () => void; abort: () => void; signal?: AbortSignal }> = [];
  constructor(private readonly concurrency: number, private readonly maximumWaiting: number) {}

  async run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const entry = { signal, enter: () => { signal?.removeEventListener("abort", entry.abort); this.active++; resolve(); },
        abort: () => { const index = this.waiting.indexOf(entry); if (index >= 0) this.waiting.splice(index, 1); reject(signal?.reason); } };
      if (this.active < this.concurrency) entry.enter();
      else if (this.waiting.length >= this.maximumWaiting) reject(Object.assign(new Error("OBSERVATION_BUSY: output readers are at capacity; retry later"), {
        code: "OBSERVATION_BUSY", effect: "not_started", retryHint: "retry_later",
      }));
      else { this.waiting.push(entry); signal?.addEventListener("abort", entry.abort, { once: true }); }
    });
    try { signal?.throwIfAborted(); return await operation(); }
    finally { this.active--; this.waiting.shift()?.enter(); }
  }
}
