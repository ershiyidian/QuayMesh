export const TASK_SILENCE_MS = 10 * 60_000;

export interface TaskViewInput {
  requestState?: string | null;
  result?: string | null;
  execution: string;
  active?: boolean;
  queued?: boolean;
  unresolved?: boolean;
  stale?: boolean;
  finalizing?: boolean;
  finalizationFailed?: boolean;
  lastOutcome?: string | null;
  lastProgressAt?: number | null;
  now?: number;
}

export interface TaskView {
  status: string;
  requestEnded: boolean;
  backgroundActive: boolean;
  stale: boolean;
  clockRunning: boolean;
  resultStatus: string | null;
}

export function taskDelivery(requestState?: string | null, result?: string | null): {status: string; label: string} | null {
  if (requestState !== 'closed') return null;
  const labels: Record<string, string> = {completed:'已完成',failed:'未完成',cancelled:'已停止',handed_off:'已交接'};
  return result && labels[result] ? {status:result,label:labels[result]} : {status:'ended',label:'已结束 · 交付未确认'};
}

/** The task's saved lifecycle is independent of its latest tool or process. */
export function taskLifecycleView(input: Pick<TaskViewInput, 'requestState' | 'result' | 'finalizing' | 'finalizationFailed'>): {status: string; label: string} | null {
  const delivery = taskDelivery(input.requestState, input.result);
  if (delivery) return delivery;
  if (input.requestState !== 'active') return null;
  if (input.finalizing) return {status: 'finalizing', label: input.finalizationFailed ? '交付确认失败' : '交付确认中'};
  return {status: 'active', label: '任务进行中'};
}

// 交付状态与后台执行分别保留；界面、API 和 SQL 分类共同使用此读取模型。
export function taskView(input: TaskViewInput): TaskView {
  const ended = input.requestState === 'closed';
  const active = input.active ?? ['running', 'starting', 'stopping'].includes(input.execution);
  const queued = input.queued ?? input.execution === 'queued';
  const stale = input.stale === true;
  // 显式活性来自已确认的操作；汇总中的其它过期成员不能掩盖这部分执行。
  const confirmedActive = active && (!stale || input.active === true);
  const confirmedQueued = queued && (!stale || input.queued === true);
  const terminalResult=['completed','failed','cancelled','handed_off'].includes(input.result??'');
  let status: string;
  if (confirmedActive) status = input.execution === 'stopping' ? 'stopping' : 'running';
  else if (confirmedQueued) status = 'queued';
  else if (input.unresolved || input.execution === 'unknown' || stale&&(active||queued||!terminalResult)) status = 'unknown';
  else if (input.finalizing || input.execution === 'finalizing') status = 'finalizing';
  else if (input.result === 'completed' || input.result === 'failed' || input.result === 'cancelled') status = input.result;
  else if (input.result === 'handed_off') status = 'handed_off';
  else if (ended) status = 'ended';
  else if (input.execution === 'stalled') status = 'stalled';
  else if (input.execution === 'interrupted' || input.execution === 'interrupted_recoverable' || input.execution === 'reconciliation_required') status = 'interrupted_recoverable';
  else if (input.execution === 'failed' || input.execution === 'cancelled' || input.execution === 'completed') status = input.execution;
  else if (input.lastOutcome === 'failed') status = 'failed';
  else if (input.lastOutcome === 'cancelled' || input.lastOutcome === 'stopped') status = 'interrupted_recoverable';
  else if (input.lastProgressAt != null && input.now != null && input.now - input.lastProgressAt >= TASK_SILENCE_MS) status = 'stalled';
  else status = 'waiting';
  return {status, requestEnded: ended, resultStatus: input.result ?? null, backgroundActive: confirmedActive || confirmedQueued, stale,
    clockRunning: !ended && !(status === 'finalizing' && input.finalizationFailed)
      && ['running', 'queued', 'stopping', 'finalizing'].includes(status)};
}

export function runExecutionStatus(
  requestState: string | null, result: string | null, runStatus: string,
  working: boolean, queued: boolean, unresolved: boolean, lastProgressAt?:number|null, now?:number,
  finalizing = false, lastOutcome?: string | null,
): string {
  return taskView({requestState, result, execution: runStatus === 'running' ? 'waiting' : runStatus,
    active: working, queued, unresolved, finalizing, lastOutcome, lastProgressAt,now}).status;
}
