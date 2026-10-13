import { consoleError, type createApi } from "./client.js";
import type { CacheEntry, RunDetail, RunPage, Overview, FileDiff } from "./contracts.js";

export class Resources {
  readonly entries = new Map<string, CacheEntry>();
  constructor(private readonly api: ReturnType<typeof createApi>, private readonly options: {
    freshness(path: string): number;
    paint(): void;
    loaded(path: string): void;
    observe(snapshot: Overview): void;
  }) {}

  data<T>(path: string): T | undefined { return this.entries.get(path)?.data as T | undefined; }

  async load(path: string, force = false): Promise<unknown> {
    let entry = this.entries.get(path);
    if (entry?.promise) return entry.promise;
    if (!force && entry?.error && Date.now() < (entry.retryAt ?? 0)) return entry.data;
    if (!force && entry?.data && Date.now() - entry.time < this.options.freshness(path)) return entry.data;
    if (!entry) { entry = { data: null, time: 0, error: null, loading: false }; this.entries.set(path, entry); }
    const current = entry, controller = new AbortController();
    current.loading = true; current.error = null; current.ctl = controller;
    current.promise = this.api.get<unknown>(path, controller.signal).then((value) => {
      if (controller.signal.aborted || this.entries.get(path) !== current) return;
      this.validate(path, value);
      if (/^runs\/[^/?]+$/.test(path)) {
        const detail = value as RunDetail;
        const previous = current.data as RunDetail | null;
        if (previous?.run.workspaceRevision !== detail.run.workspaceRevision) {
          for (const [key, file] of this.entries) if (key.startsWith(path + "/files/")) {
            file.ctl?.abort(); this.entries.delete(key);
          }
        }
      }
      if (path.startsWith("runs?")) for (const run of (value as RunPage).items) {
        const detail = this.entries.get("runs/" + encodeURIComponent(run.id)) as CacheEntry<RunDetail> | undefined;
        if (detail?.data && (detail.data.run.revision !== run.revision || detail.data.run.workspaceRevision !== run.workspaceRevision)) detail.time = 0;
      }
      current.data = value; current.time = Date.now(); current.error = null; current.retryAt = 0;
      if (path.startsWith("overview")) this.options.observe(value as Overview);
      return value;
    }).catch((failure: unknown) => {
      const error = consoleError(failure);
      if (error.name !== "AbortError") { current.error = error; current.retryAt = Date.now() + Math.max(8000, this.options.freshness(path)); }
      return null;
    }).finally(() => { current.loading = false; current.promise = null; this.options.paint(); this.options.loaded(path); });
    if (!current.data) this.options.paint();
    return current.promise;
  }

  async moreFile(path: string): Promise<number | null> {
    const entry = this.entries.get(path) as CacheEntry<FileDiff> | undefined;
    if (!entry || !entry.data?.nextCursor || entry.loading) return null;
    const previous = entry.data;
    entry.loading = true;
    try {
      const next = await this.api.get<FileDiff>(path + "?cursor=" + encodeURIComponent(previous.nextCursor!));
      if (this.entries.get(path) !== entry) return null;
      if (next.file.revision !== previous.file.revision) throw new Error("文件已变化，请刷新后重新查看");
      const rows = [...previous.file.rows, ...next.file.rows];
      entry.data = { ...next, file: { ...next.file, rows } }; entry.error = null;
      return rows.length;
    } catch (failure) { entry.error = consoleError(failure); return null; }
    finally { entry.loading = false; this.options.paint(); }
  }

  private validate(path: string, value: unknown): asserts value is Record<string, unknown> {
    if (!value || typeof value !== "object") throw new Error("接口响应结构无效");
    const data = value as Record<string, unknown>, base = path.split("?")[0];
    if (["runs", "projects", "roots", "activity"].includes(base) && !Array.isArray(data.items)) throw new Error("接口缺少记录列表");
    if (base === "fleet/status" && !Array.isArray(data.nodes)) throw new Error("接口缺少节点列表");
    if (base === "overview" && !Array.isArray(data.active)) throw new Error("接口缺少活动任务");
    if (/^runs\/[^/]+$/.test(base) && (!data.run || !Array.isArray(data.files) || !Array.isArray(data.commands))) throw new Error("执行详情结构不完整");
    if (base === "usage" && !Array.isArray(data.daily)) throw new Error("接口缺少每日用量");
  }
}
