import type { TaskStateIndex } from './task-aggregation.js';
import { taskActivityView, TASK_EXECUTION_FRESHNESS_MS, TASK_SILENCE_MS } from '../task-view.js';

// A display grouping, never a Task timeout or a lifecycle transition.
export const OVERVIEW_ACTIVITY_WINDOW_MS = TASK_SILENCE_MS;

export function lastObservedExecutingTasks(phases: readonly {taskId: string | null; executionStatus: string; executionObservedAt?: number | null}[], at=Date.now()): Set<string> {
  return new Set(phases.filter(phase=>phase.taskId && ['running','starting','queued','stopping'].includes(phase.executionStatus)
    && typeof phase.executionObservedAt==='number' && Number.isFinite(phase.executionObservedAt)
    && phase.executionObservedAt<=at && at-phase.executionObservedAt<TASK_EXECUTION_FRESHNESS_MS)
    .map(phase=>`task:${phase.taskId}`));
}

export interface TaskAttention {
  kind: 'review' | 'resume' | 'finalization_failed';
  detail: string;
  actionLabel: string;
}

/** A saved execution anomaly is not, by itself, an action for the user. */
export function taskAttention(task: Pick<TaskStateIndex, 'taskId' | 'requestState' | 'executionStatus'
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

export function selectOverviewTasks<T extends TaskStateIndex>(
  tasks: readonly T[],
  at: number,
  isToday: (time: number) => boolean,
  _lastObservedExecuting: ReadonlySet<string> = new Set(),
) {
  const realTasks = tasks.filter(task => Boolean(task.taskId));
  const open = realTasks.filter(task => task.requestState === 'active');
  const activity = (task: TaskStateIndex) => taskActivityView({requestState:task.requestState,result:task.resultStatus,
    execution:task.executionStatus,lastProgressAt:task.lastProgressAt ?? task.lastActivityAt,
    executionObservedAt:task.executionObservedAt,stale:task.stale,now:at});
  const byActivity = (left: TaskStateIndex, right: TaskStateIndex) => (right.lastProgressAt ?? right.lastActivityAt) - (left.lastProgressAt ?? left.lastActivityAt)
    || left.key.localeCompare(right.key);
  const current = open.filter(task=>activity(task).current).sort((left, right) => {
    const rank = (task: TaskStateIndex) => activity(task).state==='executing' ? 0 : 1;
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

export function overviewTaskProgress(task: TaskStateIndex, _group: 'current' | 'older' | 'recent', at=Date.now()): OverviewTaskProgress {
  const activity=taskActivityView({requestState:task.requestState,result:task.resultStatus,execution:task.executionStatus,
    lastProgressAt:task.lastProgressAt ?? task.lastActivityAt,executionObservedAt:task.executionObservedAt,stale:task.stale,now:at});
  if(activity.state==='ended')return {progressLabel:activity.label,progressSummary:activity.detail};
  if(activity.state==='executing')return {progressLabel:activity.label,
    progressSummary:[activity.detail,task.stale?'部分任务信息待更新':null].filter(Boolean).join('；') || null};
  const attention = taskAttention(task);
  if (attention) return { progressLabel: attention.kind === 'review' ? '待验收'
    : attention.kind === 'resume' ? '执行中断' : '确认失败', progressSummary: attention.detail };
  return {progressLabel:activity.label,progressSummary:activity.detail};
}
