import { consoleError, type createApi } from "./client.js";
import type { CacheEntry, RunDetail, RunPage, FileDiff, SourceState } from "./contracts.js";
import {retainDetail,pendingDetailRead,type RetainedDetail} from './retained-detail.js';

export class Resources {
  readonly entries = new Map<string, CacheEntry>();
  constructor(private readonly api: ReturnType<typeof createApi>, private readonly options: {
    freshness(path: string): number;
    paint(): void;
    loaded(path: string): void;
  }) {}

  data<T>(path: string): T | undefined { return this.entries.get(path)?.data as T | undefined; }

  async load(path: string, force = false): Promise<unknown> {
    let entry = this.entries.get(path);
    if (entry?.promise && !force) return entry.promise;
    if (entry?.promise || force && entry?.loading) {
      entry.ctl?.abort();
      entry = { ...entry, promise: null, ctl: undefined, loading: false };
      this.entries.set(path, entry);
    }
    if (!force && entry?.error && Date.now() < (entry.retryAt ?? 0)) return entry.data;
    if (!force && entry?.data && !entry.error && Date.now() - entry.time < this.freshness(path, entry.data)) return entry.data;
    if (!entry) { entry = { data: null, time: 0, error: null, loading: false }; this.entries.set(path, entry); }
    const current = entry, controller = new AbortController();
    current.loading = true; current.ctl = controller; current.startedAt = Date.now();
    const requestPath = force && !['session','login','logout','sessions/revoke-all'].includes(path.split('?')[0])
      ? path + (path.includes('?') ? '&' : '?') + 'fresh=1' : path;
    current.promise = this.api.get<unknown>(requestPath, controller.signal).then((value) => {
      if (controller.signal.aborted || this.entries.get(path) !== current) return;
      this.validate(path, value);
      if (/^runs\/[^/?]+$/.test(path)) {
        const detail = value as RunDetail;
        const previous = current.data as RunDetail | null;
        current.retained=retainDetail(previous,detail,current.receivedAt??current.time,current.retained as RetainedDetail|undefined);
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
      current.data = value; current.time = Date.now(); current.error = null; current.retryAt = 0; current.failures = 0;
      current.receivedAt=current.time;
      current.duration = current.time - current.startedAt!;
      return value;
    }).catch((failure: unknown) => {
      if (controller.signal.aborted || this.entries.get(path) !== current) return null;
      const error = consoleError(failure);
      if (error.name !== "AbortError") {
        current.error = error; current.failures = (current.failures || 0) + 1;
        current.retryAt = Date.now() + Math.min(60_000, Math.max(8000, Math.min(30_000, this.options.freshness(path))) * 2 ** Math.min(current.failures - 1, 3));
      }
      return null;
    }).finally(() => {
      if (this.entries.get(path) !== current) return;
      current.loading = false; current.promise = null; this.options.paint();
      if (!controller.signal.aborted) this.options.loaded(path);
    });
    this.options.paint();
    return current.promise;
  }

  cancelAll(): void { for (const entry of this.entries.values()) entry.ctl?.abort(); }

  private freshness(path: string, value: unknown): number {
    const ttl = this.options.freshness(path);
    if(pendingDetailRead(value))return Math.min(ttl,1_000);
    const sources = (value as { sources?: SourceState[] })?.sources;
    if (!Array.isArray(sources)) return ttl;
    // 过渡快照须能在下一轮读取到后台结果；保留短缓存，避免 loaded 回调立即重复请求。
    if (sources.some(source => source.state === 'loading' || source.state === 'refreshing')) return Math.min(ttl, 1_000);
    if (sources.some(source => source.error || source.state === 'error' || source.state === 'offline')) return Math.min(ttl, 8_000);
    return ttl;
  }

  invalidate(): void {
    for (const [path, entry] of this.entries) {
      entry.ctl?.abort();
      this.entries.set(path, { ...entry, time: 0, promise: null, ctl: undefined, loading: false, retryAt: 0 });
    }
  }

  async moreFile(path: string): Promise<number | null> {
    const entry = this.entries.get(path) as CacheEntry<FileDiff> | undefined;
    if (!entry || !entry.data?.nextCursor || entry.loading) return null;
    const previous = entry.data;
    const controller = new AbortController(); entry.ctl = controller; entry.loading = true;
    try {
      const next = await this.api.get<FileDiff>(path + "?cursor=" + encodeURIComponent(previous.nextCursor!),controller.signal);
      if (controller.signal.aborted || this.entries.get(path) !== entry) return null;
      this.validate(path,next);
      if (next.file.revision !== previous.file.revision) throw new Error("文件已变化，请刷新后重新查看");
      if (next.nextCursor && next.nextCursor === previous.nextCursor) throw new Error("文件分页游标没有推进，请重新读取文件");
      const rows = [...previous.file.rows, ...next.file.rows];
      entry.data = { ...next, file: { ...next.file, rows } }; entry.error = null;
      return rows.length;
    } catch (failure) { if (!controller.signal.aborted && this.entries.get(path) === entry) entry.error = consoleError(failure); return null; }
    finally { if (this.entries.get(path) === entry) { entry.loading = false; this.options.paint(); } }
  }

  private validate(path: string, value: unknown): asserts value is Record<string, unknown> {
    if (!value || typeof value !== "object") throw new Error("接口响应结构无效");
    const data = value as Record<string, unknown>, base = path.split("?")[0];
    if (["runs", "projects", "roots", "activity", "conversations", "receipts"].includes(base) && !Array.isArray(data.items)) throw new Error("接口缺少记录列表");
    const arrays = (keys: string[]) => keys.every(key => Array.isArray(data[key]));
    if (base === "fleet/status" && (!Array.isArray(data.nodes) || data.nodes.some((node: unknown) => {
      if (!node || typeof node !== 'object') return true;
      const n = node as Record<string, unknown>;
      return !['disks', 'gpus', 'components'].every(key => Array.isArray(n[key])) || !n.egress || !n.capabilities;
    }))) throw new Error("节点详情结构不完整");
    if (base === "overview") {
      if (!arrays(['active', 'waiting', 'current', 'olderOpen', 'recent', 'attention', 'projects', 'sources', 'taskSources', 'usageSources']) || !data.todayUsage) throw new Error("总览响应结构不完整");
      const sources = ['sources', 'taskSources', 'usageSources'].flatMap(key => data[key] as unknown[]);
      if (sources.some(item => {
        if (!item || typeof item !== 'object') return true;
        const source = item as Record<string, unknown>;
        return typeof source.nodeId !== 'string' || !source.nodeId || typeof source.name !== 'string'
          || typeof source.online !== 'boolean' || typeof source.stale !== 'boolean'
          || typeof source.state !== 'string' || !['loading', 'ready', 'refreshing', 'error', 'offline'].includes(source.state)
          || !(source.observedAt === null || typeof source.observedAt === 'number' && Number.isFinite(source.observedAt))
          || !(source.error === null || typeof source.error === 'string');
      })) throw new Error("总览数据来源结构不完整");
      const progress = ['current', 'olderOpen', 'recent'].flatMap(key => data[key] as unknown[]);
      if (progress.some(item => {
        if (!item || typeof item !== 'object') return true;
        const row = item as Record<string, unknown>;
        return typeof row.progressLabel !== 'string' || !(row.progressSummary === null || typeof row.progressSummary === 'string');
      }) || (data.attention as unknown[]).some(item => !item || typeof item !== 'object'
        || typeof (item as Record<string, unknown>).actionLabel !== 'string')) throw new Error("总览任务进展结构不完整");
    }
    if (/^runs\/[^/]+$/.test(base) && (!data.run || !arrays(['files', 'commands', 'agents', 'evidence', 'timeline']))) throw new Error("执行详情结构不完整");
    if (/^runs\/[^/]+\/files\//.test(base) && (!data.file || !Array.isArray((data.file as FileDiff['file']).rows))) throw new Error("文件响应结构不完整");
    if (/^projects\/[^/]+\/sessions$/.test(base) && !arrays(['items', 'conversations', 'batches', 'executionClaims'])) throw new Error("会话响应结构不完整");
    if (base === "usage" && !arrays(['daily', 'projects', 'top'])) throw new Error("用量响应结构不完整");
    if (base === "activity" && !arrays(['items', 'bins'])) throw new Error("活动响应结构不完整");
  }
}
