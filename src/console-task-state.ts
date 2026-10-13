export const taskStages: ReadonlyArray<readonly [string, string]> = [
  ['running', '运行中'], ['queued', '排队'], ['waiting', '等待下一步'],
  ['unknown', '待核对'], ['review', '待验收'], ['failed', '失败'],
  ['interrupted', '中断'], ['accepted', '已验收'], ['done', '已完成'],
  ['ended', '已结束'], ['cancelled', '已取消'], ['rejected', '已驳回'],
];

export function taskStage(execution: string, acceptance: string): string {
  if (execution === 'idle') return 'waiting';
  if (execution === 'interrupted_recoverable') return 'interrupted';
  if (execution !== 'completed') return execution;
  return acceptance === 'pending' ? 'review' : acceptance === 'accepted' || acceptance === 'passed' ? 'accepted'
    : acceptance === 'rejected' || acceptance === 'failed' ? 'rejected' : 'done';
}

export function activeExecution(execution: string): boolean {
  return ['running', 'queued', 'stopping'].includes(execution);
}

export interface TaskLifecycle {
  id: string;
  sessionId: string;
  title: string;
  state: string;
  resultStatus: string | null;
  revision: number;
  finishedAt: number | null;
  lastActivityAt: number;
}

export function withTaskLifecycle<T extends {
  taskId: string | null; executionStatus: string; acceptanceStatus: string;
  finishedAt: number | null; lastActivityAt: number;
}>(value: T, task?: TaskLifecycle): T {
  if (!task || task.id !== value.taskId || activeExecution(value.executionStatus)) return value;
  let status = value.executionStatus;
  if (task.resultStatus === 'completed') status = 'completed';
  else if (task.resultStatus === 'failed') status = 'failed';
  else if (task.resultStatus === 'cancelled') status = 'cancelled';
  else if (task.state === 'closed' && !['completed','failed','cancelled'].includes(status)) status = 'ended';
  return {...value, executionStatus:status,
    acceptanceStatus:status === 'completed' && value.executionStatus !== 'completed'
      ? 'not_required' : value.acceptanceStatus,
    finishedAt:task.state === 'closed' ? task.finishedAt ?? value.finishedAt : value.finishedAt,
    lastActivityAt:Math.max(value.lastActivityAt,task.lastActivityAt)};
}
