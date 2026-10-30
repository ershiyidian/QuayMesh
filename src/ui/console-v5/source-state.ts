import type { CacheEntry, SourceState } from './contracts.js';

export function sourceWarning(source: SourceState, now = Date.now()): string | null {
  if (source.error) return source.state === 'refreshing' ? `正在重试，上次读取失败：${source.error}` : source.error;
  if (source.state === 'error' || source.state === 'offline') return '当前无法读取，保留最近确认的数据';
  if ((source.state === 'loading' || source.state === 'refreshing') && source.observedAt === null && !source.error) return null;
  if (source.state === 'refreshing' && !source.stale && source.observedAt !== null && !source.error && now-source.observedAt <= 30_000) return null;
  if (source.stale || source.state === 'refreshing') return source.observedAt ? '正在刷新，当前显示上次确认的数据' : '正在读取数据';
  return null;
}

export function sourceWarnings(entries: Array<CacheEntry | undefined>, now = Date.now()): SourceState[] {
  const warnings = new Map<string, SourceState>();
  for (const entry of entries) for (const source of (entry?.data as { sources?: SourceState[] } | undefined)?.sources || []) {
    if (!sourceWarning(source, now)) continue;
    const previous = warnings.get(source.nodeId);
    if (!previous || (source.error && !previous.error) || Boolean(source.error) === Boolean(previous.error)
      && (source.observedAt ?? 0) > (previous.observedAt ?? 0)) warnings.set(source.nodeId, source);
  }
  return [...warnings.values()];
}

export function resourceHealth(entries: Array<CacheEntry | undefined>) {
  const errors = entries.filter(entry => entry?.error).length;
  const missing = entries.filter(entry => !entry?.data).length;
  const loading = entries.filter(entry => entry?.loading).length;
  const stale = sourceWarnings(entries).length > 0;
  const pending = entries.some(entry => (entry?.data as { sources?: SourceState[] } | undefined)?.sources?.some(source => source.observedAt === null && ['loading', 'refreshing'].includes(source.state)));
  const times = entries.filter((entry): entry is CacheEntry => Boolean(entry?.data && entry.time)).map(entry => entry.time);
  return { errors, missing, loading, stale, confirmedAt: times.length ? Math.min(...times) : null,
    tone: errors || stale ? 'amber' : missing || loading || pending ? 'muted' : 'green',
    label: errors ? '读取失败 · 保留上次数据' : stale ? '部分数据待更新' : missing || pending ? '正在读取当前页面' : loading ? '正在刷新' : '当前数据已读取' };
}

/** A refresh in progress does not invalidate a successful, recent observation. */
export function resourceObservation(entry: CacheEntry | undefined, now = Date.now()) {
  const receivedAt = entry?.time && Number.isFinite(entry.time) ? entry.time : null;
  const snapshot = entry?.data as { observedAt?: number | null } | undefined;
  const observedAt = snapshot?.observedAt;
  const confirmedAt = receivedAt ?? (typeof observedAt === 'number' && Number.isFinite(observedAt) ? observedAt : null);
  const expiresAt = receivedAt === null ? null : receivedAt + 30_000;
  // A retry keeps the previous failure until a successful response confirms recovery.
  const current = Boolean(entry?.data && receivedAt && !entry.error && !entry.failures
    && now >= receivedAt && expiresAt !== null && now < expiresAt);
  return { current, confirmedAt, expiresAt };
}
