import type { CacheEntry, SourceState } from './contracts.js';

export function sourceWarning(source: SourceState, now = Date.now()): string | null {
  if (source.state === 'error' || source.state === 'offline') return source.error || '当前无法读取，保留最近确认的数据';
  if (source.state === 'loading' && !source.observedAt) return '尚未取得数据';
  if (source.state === 'refreshing' && !source.stale && source.observedAt !== null && !source.error && now-source.observedAt <= 30_000) return null;
  if (source.stale || source.state === 'refreshing') return source.observedAt ? '正在刷新，当前显示上次确认的数据' : '正在读取数据';
  return null;
}

export function resourceHealth(entries: Array<CacheEntry | undefined>) {
  const errors = entries.filter(entry => entry?.error).length;
  const missing = entries.filter(entry => !entry?.data).length;
  const loading = entries.filter(entry => entry?.loading).length;
  const stale = entries.some(entry => (entry?.data as { sources?: SourceState[] } | undefined)?.sources?.some(source => sourceWarning(source)));
  const times = entries.filter((entry): entry is CacheEntry => Boolean(entry?.data && entry.time)).map(entry => entry.time);
  return { errors, missing, loading, stale, confirmedAt: times.length ? Math.min(...times) : null,
    tone: errors || stale ? 'amber' : missing || loading ? 'muted' : 'green',
    label: errors ? '读取失败 · 保留上次数据' : stale ? '部分数据待更新' : missing ? '正在读取当前页面' : loading ? '正在刷新' : '当前数据已读取' };
}
