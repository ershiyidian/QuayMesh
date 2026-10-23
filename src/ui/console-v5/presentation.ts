import { icon } from './icons.js';
import { fmt, compact, duration, fullTime, ago, smartTime, validTime } from './format.js';
import type { Run } from './contracts.js';
import { taskStage, taskStages, executionTimeEnd } from '../../console-task-state.js';

export const esc = (v: unknown): string => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export const clamp = (v: unknown, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number(v) || 0));

export const stages: Record<string, string> = { ...Object.fromEntries(taskStages), online: '在线', offline: '离线', responded: '已响应', pending: '等待响应' };

export function stage(r: Pick<Run, 'executionStatus' | 'acceptanceStatus'>) { return taskStage(r.executionStatus,r.acceptanceStatus); }

export const status = (s: string) => `<span class="state ${esc(s)}">${icon(s === 'online' ? 'accepted' : s === 'offline' ? 'cancelled' : s, 14)}${esc(stages[s] || '状态未知')}</span>`;

export const btn = (text: string, action: string, extras = '', klass = '') => `<button type="button" class="btn ${klass}" data-action="${action}" ${extras}>${text}</button>`;

export const ib = (name: string, action: string, label: string, extras = '', klass = '') => `<button type="button" class="icon-btn ${klass}" data-action="${action}" title="${esc(label)}" aria-label="${esc(label)}" ${extras}>${icon(name)}</button>`;

export const badge = (text: string | number, tone = '') => `<span class="badge ${tone}">${esc(text)}</span>`;

export const meter = (v: number | null | undefined, tone = '') => v == null || !Number.isFinite(v)
  ? '<span class="progress indeterminate" role="meter" aria-label="数据尚未取得" aria-valuetext="未知"><i></i></span>'
  : `<span class="progress ${tone}" role="meter" aria-label="使用率" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${clamp(v, 0, 100)}"><i style="width:${clamp(v, 0, 100)}%"></i></span>`;

export const smallTime = (t: number | null | undefined) => `<time class="num muted" datetime="${validTime(t) ? new Date(t).toISOString() : ''}" title="${esc(fullTime(t))} · ${ago(t)}">${esc(smartTime(t))}</time>`;

export function spark(values: number[], w = 88, h = 32) { if (!values?.length)
    return ''; const max = Math.max(...values, 1); const p = values.map((v, i) => `${i * w / Math.max(1, values.length - 1)},${h - 3 - v / max * (h - 6)}`).join(' '); return `<svg class="sparkline" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polyline points="${p}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>`; }

export function usageText(r: Run) { const u = r.usage; if (!u || u.quality === 'unavailable')
    return '<span class="muted" title="用量未上报">未知</span>'; if (u.quality === 'not_used')
    return '<span class="muted" title="已确认未调用模型">0</span>'; return `<span class="num" title="${fmt(u.total)} Token · ${u.quality === 'partial' ? '部分已记录' : '统计完整'}">${u.quality === 'partial' ? '<span class="amber">≥</span> ' : ''}${compact(u.total)}</span>`; }

export function diffStat(r: Run) { return r.diff ? `<span class="diff-summary"><span class="green">+${fmt(r.diff.add)}</span><span class="red">−${fmt(r.diff.del)}</span></span>` : '<span class="muted">—</span>'; }

export function resultExplanation(summary: string, reason: string | null, state: string) {
  // 没有交付总结时，接口会把状态说明作为概要回退；同一句话只显示一次。
  const distinctSummary = summary.trim() && summary.trim() !== reason?.trim();
  return (distinctSummary ? `<p class="execution-summary">${esc(summary)}</p>` : '')
    + (reason ? `<p class="notice ${['unknown','failed','interrupted','stalled','finalizing'].includes(state) ? 'warn' : ''}">${esc(reason)}</p>` : '');
}

export function elapsed(r: Run, observation?: { stale: boolean; observedAt: number | null }) {
  const active = ['running', 'stopping'].includes(r.executionStatus);
  const at = observation ? observation.observedAt : r.observedAt ?? null;
  const stale = observation?.stale || r.stale || at !== null && Date.now() - at > 30_000;
  const end = executionTimeEnd({...r,stale:Boolean(stale),observedAt:at});
  if (active && !stale && r.finishedAt === null) return `<span class="num elapsed" data-elapsed="${r.startedAt}" data-observed="${at ?? Date.now()}">${duration(end === null ? null : end-r.startedAt)}</span>`;
  if ((active || r.executionStatus === 'unknown') && stale)
    return `<span class="num muted" title="截至最后确认 ${esc(fullTime(end))}">${duration(end === null ? null : Math.max(0, end - r.startedAt))} · 待核对</span>`;
  return r.executionStatus === 'queued' ? '<span class="muted">尚未开始</span>' : `<span class="num"${r.finishedAt === null && end !== null ? ' title="记录截至最近活动 ' + esc(fullTime(end)) + '"' : ''}>${duration(end === null ? null : end - r.startedAt)}</span>`;
}

export function transferPercent(transfer: { bytes: number; total: number | null; status: string }): number | null {
  if (transfer.total === 0) return transfer.status === 'completed' ? 100 : null;
  return transfer.total != null && transfer.total > 0 && Number.isFinite(transfer.bytes) && Number.isFinite(transfer.total)
    ? clamp(transfer.bytes / transfer.total * 100, 0, 100) : null;
}

export const percent = (used: number | null | undefined, total: number | null | undefined) =>
  used != null && total != null && Number.isFinite(used) && Number.isFinite(total) && total > 0 ? clamp(used / total * 100, 0, 100) : null;

export const QUALITY: Record<string, string> = { complete: '完整', partial: '部分已记录', unavailable: '未知', not_used: '未调用模型' };
