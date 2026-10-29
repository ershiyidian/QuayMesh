import { icon } from './icons.js';
import { fmt, compact, duration, fullTime, ago, smartTime, validTime } from './format.js';
import type { Run, ChangeCapture, SourceState } from './contracts.js';
import { taskStage, taskStages, executionTimeEnd, taskTimeEnd } from '../../console-task-state.js';
import { taskLifecycleView } from '../../task-view.js';

export const esc = (v: unknown): string => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export const clamp = (v: unknown, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number(v) || 0));

export const stages: Record<string, string> = { ...Object.fromEntries(taskStages), online: '在线', offline: '离线', responded: '已响应', pending: '等待响应' };

export function stage(r: Pick<Run, 'executionStatus' | 'acceptanceStatus'>) { return taskStage(r.executionStatus,r.acceptanceStatus); }

export const status = (s: string) => `<span class="state ${esc(s)}">${icon(s === 'online' ? 'accepted' : s === 'offline' ? 'cancelled' : s, 14)}${esc(stages[s] || '状态未知')}</span>`;

export const btn = (text: string, action: string, extras = '', klass = '') => `<button type="button" class="btn ${klass}" data-action="${action}" ${extras}>${text}</button>`;

export const ib = (name: string, action: string, label: string, extras = '', klass = '') => `<button type="button" class="icon-btn ${klass}" data-action="${action}" title="${esc(label)}" aria-label="${esc(label)}" ${extras}>${icon(name)}</button>`;

export const badge = (text: string | number, tone = '') => `<span class="badge ${tone}">${esc(text)}</span>`;

export function acceptanceBadge(run: Pick<Run, 'executionStatus' | 'phaseExecutionStatus' | 'acceptanceStatus'>): string {
  if (['review','accepted','rejected'].includes(stage(run))) return '';
  if (run.acceptanceStatus === 'pending')
    return (run.phaseExecutionStatus ?? run.executionStatus) === 'completed' ? badge('结果待验收','warn') : '';
  if (['accepted','passed'].includes(run.acceptanceStatus)) return badge('结果已验收','good');
  if (['rejected','failed'].includes(run.acceptanceStatus)) return badge('结果已驳回','warn');
  return '';
}

export function lifecycleBadges(run: Pick<Run, 'requestState'|'resultStatus'|'executionStatus'|'phaseExecutionStatus'|'acceptanceStatus'|'finalization'>,
  observation?: {stale: boolean; observedAt: number | null}): string {
  const lifecycle=taskLifecycleView({requestState:run.requestState,result:run.resultStatus,
    finalizing:Boolean(run.finalization),finalizationFailed:run.finalization?.status==='failed'});
  const ended=run.requestState==='closed',state=stage(run);
  const tone=lifecycle?.status==='completed'?'done':lifecycle?.status==='finalizing'&&run.finalization?.status==='failed'?'failed':lifecycle?.status ?? state;
  const symbol=lifecycle?.status==='active'?'tasks':lifecycle?.status==='ended'?'archive':tone;
  const primary=lifecycle ? `<span class="state ${esc(tone)}">${icon(symbol,14)}${esc(lifecycle.label)}</span>`
    : run.finalization?.status==='failed'&&state==='finalizing' ? `<span class="state failed">${icon('failed',14)}交付确认失败</span>` : status(state);
  const result=[primary];
  if(!lifecycle&&run.finalization&&state!=='finalizing')result.push(badge(run.finalization.status==='failed'?'交付确认失败':'交付确认中','warn'));
  if(lifecycle){
    const background:Record<string,string>=ended
      ? {running:'后台仍在执行',stopping:'后台正在停止',queued:'后台正在准备',unknown:'后台执行结果待核对',interrupted_recoverable:'后台执行已中断'}
      : {running:'后台执行中',stopping:'后台正在停止',queued:'后台正在准备',waiting:'当前无后台执行',idle:'当前无后台执行',
        stalled:'长时间无新执行记录',unknown:'后台执行结果待核对',interrupted_recoverable:'后台执行已中断',
        failed:'最近执行失败',cancelled:'最近执行已停止',completed:'本阶段执行已结束',ended:'本阶段执行已结束',handed_off:'执行阶段已交接'};
    if(background[run.executionStatus])result.push(badge(background[run.executionStatus],['failed','unknown','stalled','interrupted_recoverable'].includes(run.executionStatus)?'warn':''));
  }
  if(observation?.stale)result.push(`<span class="badge warn" title="${esc('最后确认：'+fullTime(observation.observedAt))}">上次确认</span>`);
  if(!ended&&run.phaseExecutionStatus==='completed'&&run.executionStatus!=='completed')result.push(badge('执行阶段已结束'));
  const acceptance=acceptanceBadge(run);
  if(acceptance)result.push(acceptance);
  else if(lifecycle&&['review','accepted','rejected'].includes(state))result.push(badge(stages[state],state==='accepted'?'good':'warn'));
  return result.join(' ');
}

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

export function changeCaptureBlockReason(captures?: readonly ChangeCapture[]): string | null {
  const pending = captures?.some(capture => capture.state === 'pending');
  const failed = captures?.some(capture => capture.state === 'failed');
  if (pending && failed) return '部分文件改动仍在采集，部分采集失败，证据尚不完整。请核对错误，等待重新采集后刷新。';
  if (failed) return '文件改动采集失败，证据尚不完整。请核对错误并重新采集后刷新。';
  return pending ? '文件改动仍在采集，证据尚不完整。请等待采集结束后刷新。' : null;
}

export function changeCaptureNotice(captures?: readonly ChangeCapture[]): string {
  const affected = captures?.filter(capture => capture.state === 'pending' || capture.state === 'failed') || [];
  if (!affected.length) return '';
  const blocked = changeCaptureBlockReason(affected);
  const title = affected.some(capture => capture.state === 'failed') ? '文件改动采集失败' : '文件改动采集进行中';
  return `<section class="notice warn change-capture-notice" role="status"><div><strong>${title}</strong><p>${blocked}</p>${affected.map(capture => `<div class="capture-scope" data-capture-state="${esc(capture.state)}"><b>${esc(capture.projectName)} · ${esc(capture.nodeId)} · ${capture.state === 'failed' ? '采集失败' : '采集中'}</b><div><code class="break">${esc(capture.root)}</code></div>${capture.error ? `<p class="small break">${esc(capture.error)}</p>` : ''}</div>`).join('')}<p>已取得的文件仍可查看。证据完整前，暂不能验收结果、导出补丁或还原文件。</p>${btn('刷新文件证据','refresh','','small')}</div></section>`;
}

export function dedupeCaptureWarnings(warnings: readonly string[], captures?: readonly ChangeCapture[]): string[] {
  const repeated = new Set<string>();
  for (const capture of captures || []) {
    if (capture.state === 'pending') repeated.add('文件改动正在整理，当前列表尚未确认完整。');
    if (capture.state === 'failed') repeated.add(`文件改动整理失败，当前列表可能不完整：${capture.error ?? '原因未知'}`);
  }
  return warnings.filter(warning => !repeated.has(warning));
}

export function executionObservationForRun(run:Run,sources:readonly Pick<SourceState,'nodeId'|'online'|'observedAt'|'error'>[],
  fallback:{stale:boolean;observedAt:number|null},now=Date.now()):{stale:boolean;observedAt:number|null}{
  if(!['running','stopping','queued'].includes(run.executionStatus))return fallback;
  const active=sources.filter(source=>{
    const execution=run.nodeStates?.[source.nodeId]??((run.nodeIds?.length??1)===1&&source.nodeId===run.nodeId?run.executionStatus:null);
    return execution&&['running','stopping','queued'].includes(execution)&&source.online&&!source.error
      &&source.observedAt!==null&&now-source.observedAt<=30_000;
  });
  return active.length?{stale:false,observedAt:Math.min(...active.map(source=>source.observedAt!))}:fallback;
}

export function elapsed(r: Run, observation?: { stale: boolean; observedAt: number | null }) {
  if (r.requestState === 'active') return `<span class="num elapsed" title="任务历时：从创建起计算，包含等待和节点离线时间" data-elapsed="${r.startedAt}" data-observed="0">${duration(Date.now() - r.startedAt)}</span>`;
  if (r.requestState === 'closed') {
    const end = taskTimeEnd(r);
    return `<span class="num" title="任务历时：从创建起计算，包含等待和节点离线时间">${duration(end === null ? null : end - r.startedAt)}</span>`;
  }
  const active = ['running', 'stopping'].includes(r.executionStatus);
  const at = observation ? observation.observedAt : r.observedAt ?? null;
  const stale = (observation ? observation.stale : r.stale) || at !== null && Date.now() - at > 30_000;
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
