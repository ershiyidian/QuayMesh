import { icon } from './icons.js';
import { fmt, compact, duration, fullTime, ago, smartTime } from './format.js';
import type { Run } from './contracts.js';
import { taskStage } from '../../console-task-state.js';

export const esc = (v: unknown): string => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export const clamp = (v: unknown, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number(v) || 0));

export const stages: Record<string, string> = { waiting: '等待下一步', ended:'已结束', unknown: '状态待核对', running: '运行中', queued: '排队中', review: '待验收', accepted: '已验收', done: '已完成', failed: '失败', interrupted: '可恢复中断', cancelled: '已取消', rejected: '已驳回', stopping: '中断请求中', online: '在线', offline: '离线' };

export function stage(r: Pick<Run, 'executionStatus' | 'acceptanceStatus'>) { return taskStage(r.executionStatus,r.acceptanceStatus); }

export const status = (s: string) => `<span class="state ${esc(s)}">${icon(s === 'online' ? 'accepted' : s === 'offline' ? 'cancelled' : s, 14)}${esc(stages[s] || '状态未知')}</span>`;

export const btn = (text: string, action: string, extras = '', klass = '') => `<button type="button" class="btn ${klass}" data-action="${action}" ${extras}>${text}</button>`;

export const ib = (name: string, action: string, label: string, extras = '', klass = '') => `<button type="button" class="icon-btn ${klass}" data-action="${action}" title="${esc(label)}" aria-label="${esc(label)}" ${extras}>${icon(name)}</button>`;

export const badge = (text: string | number, tone = '') => `<span class="badge ${tone}">${esc(text)}</span>`;

export const meter = (v: number | null | undefined, tone = '') => `<span class="progress ${tone}" role="meter" aria-label="使用率" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${clamp(v, 0, 100)}"><i style="width:${clamp(v, 0, 100)}%"></i></span>`;

export const smallTime = (t: number | null | undefined) => `<time class="num muted" datetime="${t ? new Date(t).toISOString() : ''}" title="${esc(fullTime(t))} · ${ago(t)}">${esc(smartTime(t))}</time>`;

export function spark(values: number[], w = 88, h = 32) { if (!values?.length)
    return ''; const max = Math.max(...values, 1); const p = values.map((v, i) => `${i * w / Math.max(1, values.length - 1)},${h - 3 - v / max * (h - 6)}`).join(' '); return `<svg class="sparkline" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polyline points="${p}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>`; }

export function usageText(r: Run) { const u = r.usage; if (!u || u.quality === 'unavailable')
    return '<span class="muted" title="用量未上报">未知</span>'; if (u.quality === 'not_used')
    return '<span class="muted" title="已确认未调用模型">0</span>'; return `<span class="num" title="${fmt(u.total)} Token · ${u.quality === 'partial' ? '部分已记录' : '统计完整'}">${u.quality === 'partial' ? '<span class="amber">≥</span> ' : ''}${compact(u.total)}</span>`; }

export function diffStat(r: Run) { return r.diff ? `<span class="diff-summary"><span class="green">+${fmt(r.diff.add)}</span><span class="red">−${fmt(r.diff.del)}</span></span>` : '<span class="muted">—</span>'; }

export function elapsed(r: Run) { return ['running', 'stopping'].includes(r.executionStatus) ? `<span class="num elapsed" data-elapsed="${r.startedAt}"></span>` : r.executionStatus === 'queued' ? '<span class="muted">尚未开始</span>' : `<span class="num">${duration(r.finishedAt == null ? null : r.finishedAt - r.startedAt)}</span>`; }

export const QUALITY: Record<string, string> = { complete: '完整', partial: '部分已记录', unavailable: '未知', not_used: '未调用模型' };
