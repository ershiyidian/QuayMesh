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
  lastProgressAt?: number | null;
  now?: number;
}

export interface TaskView {
  status: string;
  requestEnded: boolean;
  backgroundActive: boolean;
  stale: boolean;
  clockRunning: boolean;
}

// 交付状态与后台执行分别保留；界面、API 和 SQL 分类共同使用此读取模型。
export function taskView(input: TaskViewInput): TaskView {
  const ended = input.requestState === 'closed';
  const active = input.active ?? ['running', 'starting', 'stopping'].includes(input.execution);
  const queued = input.queued ?? input.execution === 'queued';
  const stale = input.stale === true;
  let status: string;
  if (input.result === 'completed' || input.result === 'failed' || input.result === 'cancelled') status = input.result;
  else if (active && !stale) status = 'running';
  else if (queued && !stale) status = 'queued';
  else if (ended) status = 'ended';
  else if (stale || input.unresolved || input.execution === 'unknown') status = 'unknown';
  else if (input.finalizing || input.execution === 'finalizing') status = 'finalizing';
  else if (input.execution === 'stalled') status = 'stalled';
  else if (input.execution === 'interrupted' || input.execution === 'interrupted_recoverable' || input.execution === 'reconciliation_required') status = 'interrupted_recoverable';
  else if (input.execution === 'failed' || input.execution === 'cancelled' || input.execution === 'completed') status = input.execution;
  else if (input.lastProgressAt != null && input.now != null && input.now - input.lastProgressAt >= TASK_SILENCE_MS) status = 'stalled';
  else status = 'waiting';
  return {status, requestEnded: ended, backgroundActive: (active || queued) && !stale, stale,
    clockRunning: !ended && !['stalled', 'unknown', 'interrupted_recoverable', 'completed', 'failed', 'cancelled'].includes(status)};
}

export function runExecutionStatus(
  requestState: string | null, result: string | null, runStatus: string,
  working: boolean, queued: boolean, unresolved: boolean, lastProgressAt?:number|null, now?:number,
): string {
  return taskView({requestState, result, execution: runStatus === 'running' ? 'waiting' : runStatus,
    active: working, queued: runStatus === 'running' && queued, unresolved: runStatus === 'running' && unresolved,
    lastProgressAt,now}).status;
}
