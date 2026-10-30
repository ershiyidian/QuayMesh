import type { TaskIndex } from './task-aggregation.js';

// A display grouping, never a Task timeout or a lifecycle transition.
export const OVERVIEW_MIDNIGHT_CARRYOVER_MS = 2 * 60 * 60_000;

export function lastObservedExecutingTasks(phases: readonly {taskId: string | null; executionStatus: string}[]): Set<string> {
  return new Set(phases.filter(phase=>phase.taskId && ['running','starting','queued','stopping'].includes(phase.executionStatus))
    .map(phase=>`task:${phase.taskId}`));
}

export interface TaskAttention {
  kind: 'review' | 'resume' | 'finalization_failed';
  detail: string;
  actionLabel: string;
}

/** A saved execution anomaly is not, by itself, an action for the user. */
export function taskAttention(task: Pick<TaskIndex, 'taskId' | 'requestState' | 'executionStatus'
  | 'phaseExecutionStatus' | 'acceptanceStatus' | 'actionableInterruption' | 'finalization'>): TaskAttention | null {
  if (!task.taskId || !['active', 'closed'].includes(task.requestState ?? '')) return null;
  const settled = ['completed', 'waiting'].includes(task.executionStatus);
  if (task.acceptanceStatus === 'pending' && settled
    && (task.executionStatus === 'completed' || task.phaseExecutionStatus === 'completed')) {
    return { kind: 'review', detail: '任务结果等待验收', actionLabel: '验收结果' };
  }
  if (task.requestState !== 'active') return null;
  if (task.finalization?.status === 'failed' || task.finalization?.error) {
    return { kind: 'finalization_failed', detail: '交付确认未完成，需要查看失败原因', actionLabel: '查看确认失败' };
  }
  if (task.actionableInterruption && ['interrupted_recoverable', 'failed'].includes(task.executionStatus)) {
    return { kind: 'resume', detail: '任务执行中断，需要核对后继续', actionLabel: '处理执行中断' };
  }
  return null;
}

export function selectOverviewTasks(
  tasks: readonly TaskIndex[],
  at: number,
  isToday: (time: number) => boolean,
  lastObservedExecuting: ReadonlySet<string> = new Set(),
) {
  const realTasks = tasks.filter(task => Boolean(task.taskId));
  const open = realTasks.filter(task => task.requestState === 'active');
  const isCurrent = (task: TaskIndex) => {
    const recentlyActive = Number.isFinite(task.lastActivityAt) && (isToday(task.lastActivityAt)
      || task.lastActivityAt <= at && at - task.lastActivityAt < OVERVIEW_MIDNIGHT_CARRYOVER_MS);
    return recentlyActive || ['running', 'starting', 'queued', 'stopping'].includes(task.executionStatus)
      || Boolean(task.finalization) || lastObservedExecuting.has(task.key);
  };
  const byActivity = (left: TaskIndex, right: TaskIndex) => right.lastActivityAt - left.lastActivityAt
    || left.key.localeCompare(right.key);
  const current = open.filter(isCurrent).sort((left, right) => {
    const rank = (task: TaskIndex) => !task.stale && ['running', 'starting', 'stopping'].includes(task.executionStatus) ? 0
      : !task.stale && task.executionStatus === 'queued' ? 1 : task.finalization ? 2 : 3;
    return rank(left) - rank(right) || byActivity(left, right);
  });
  const currentKeys = new Set(current.map(task => task.key));
  const olderOpen = open.filter(task => !currentKeys.has(task.key)).sort(byActivity);
  const ended = realTasks.filter(task => task.requestState === 'closed');
  const recent = [...ended].sort((left, right) => (right.finishedAt ?? right.lastActivityAt)
    - (left.finishedAt ?? left.lastActivityAt) || left.key.localeCompare(right.key));
  const attention = realTasks.filter(task => taskAttention(task) !== null).sort(byActivity);
  return {
    current, olderOpen, recent, attention,
    reviewCount: attention.filter(task => taskAttention(task)?.kind === 'review').length,
    completedToday: ended.filter(task => task.resultStatus === 'completed' && task.finishedAt !== null
      && Number.isFinite(task.finishedAt) && isToday(task.finishedAt)).length,
    failedToday: ended.filter(task => task.resultStatus === 'failed' && task.finishedAt !== null
      && Number.isFinite(task.finishedAt) && isToday(task.finishedAt)).length,
  };
}

export interface OverviewTaskProgress {
  progressLabel: string;
  progressSummary: string | null;
}

export function overviewTaskProgress(task: TaskIndex, group: 'current' | 'older' | 'recent'): OverviewTaskProgress {
  if (task.requestState === 'closed') {
    const labels: Record<string, string> = { completed: '已完成', failed: '未完成', cancelled: '已停止', handed_off: '已交接' };
    return { progressLabel: labels[task.resultStatus ?? ''] ?? '已结束',
      progressSummary: labels[task.resultStatus ?? ''] ? null : '交付结果尚未确认' };
  }
  // A confirmed member may still be executing while another member is stale.
  if (['running', 'starting', 'stopping'].includes(task.executionStatus)) {
    const summary=[task.executionStatus === 'stopping' ? '正在停止当前执行' : null,
      task.stale ? '部分任务信息待更新' : null].filter(Boolean).join('；');
    return { progressLabel: '进行中', progressSummary: summary || null };
  }
  if (task.executionStatus === 'queued') return { progressLabel: '等待执行', progressSummary: task.stale ? '部分任务信息待更新' : null };
  if (task.stale) return { progressLabel: '待更新', progressSummary: '显示上次取得的任务状态' };
  const attention = taskAttention(task);
  if (attention) return { progressLabel: attention.kind === 'review' ? '待验收'
    : attention.kind === 'resume' ? '执行中断' : '确认失败', progressSummary: attention.detail };
  if (task.finalization) return { progressLabel: '交付确认中', progressSummary: null };
  if (task.executionStatus === 'unknown') return { progressLabel: '状态待确认', progressSummary: '任务尚未结束' };
  return { progressLabel: group === 'older' ? '未结束' : '进行中',
    progressSummary: task.executionStatus === 'failed' ? '最近执行未成功，任务尚未结束'
      : task.phaseExecutionStatus === 'completed' ? '已记录阶段结果，任务尚未结束' : null };
}
