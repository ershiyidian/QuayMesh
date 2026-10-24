import { taskView } from './task-view.js';

export const taskStages: ReadonlyArray<readonly [string, string]> = [
  ['running', '执行中'], ['stopping', '正在停止'], ['queued', '排队'], ['waiting', '当前无后台执行'],
  ['stalled', '长时间无新执行记录'], ['finalizing', '交付确认中'],
  ['unknown', '待核对'], ['review', '待验收'], ['failed', '失败'],
  ['interrupted', '中断'], ['accepted', '已验收'], ['done', '已完成'],
  ['ended', '已结束'], ['handed_off', '已交接'], ['cancelled', '已取消'], ['rejected', '已驳回'],
];

export function taskStage(execution: string, acceptance: string, phaseExecution?: string): string {
  if (execution === 'idle') return 'waiting';
  if (execution === 'interrupted_recoverable') return 'interrupted';
  if (execution === 'waiting' && phaseExecution === 'completed' && acceptance === 'pending') return 'review';
  if (execution !== 'completed') return execution;
  return acceptance === 'pending' ? 'review' : acceptance === 'accepted' || acceptance === 'passed' ? 'accepted'
    : acceptance === 'rejected' || acceptance === 'failed' ? 'rejected' : 'done';
}

export function activeExecution(execution: string): boolean {
  return ['running', 'queued', 'stopping'].includes(execution);
}

export interface TaskFinalizationView {
  status: 'pending' | 'failed';
  requestedAt: number;
  error: string | null;
}

export function needsAttention(value: {
  executionStatus: string; actionableInterruption?: boolean; acceptanceStatus?: string;
  finalization?: TaskFinalizationView | null;
}): boolean {
  return Boolean(value.finalization) || ['failed', 'unknown', 'stalled', 'finalizing'].includes(value.executionStatus)
    || value.executionStatus === 'interrupted_recoverable' && value.actionableInterruption === true
    || value.acceptanceStatus === 'rejected';
}

export function relevantExecution(value: {currentPhase?: boolean; executionStatus: string; actionableInterruption?: boolean}): boolean {
  return value.currentPhase !== false || activeExecution(value.executionStatus) || value.executionStatus === 'unknown'
    || value.executionStatus === 'interrupted_recoverable' && value.actionableInterruption === true;
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
  sourceTaskId?: string|null;
  createdAt?: number;
  nodeId?: string;
  memberNodeIds?: string[];
  workspaces?: Array<{nodeId: string; projectId: string; memberId: string; name: string; root: string}>;
  finalization?: TaskFinalizationView | null;
}

export function withTaskLifecycle<T extends {
  taskId: string | null; executionStatus: string; acceptanceStatus: string;
  finishedAt: number | null; lastActivityAt: number;
  startedAt?: number;
  reason?: string | null;
  phaseExecutionStatus?: string;
}>(value: T, task?: TaskLifecycle): T {
  if (!task || task.id !== value.taskId) return value;
  const awaitingDelivery=task.state==='active' && !task.finalization && value.executionStatus==='completed';
  const newerActivity = value.executionStatus === 'stalled' && task.lastActivityAt > value.lastActivityAt;
  const lastActivityAt = Math.max(value.lastActivityAt, task.lastActivityAt);
  const status = taskView({requestState:task.state, result:task.resultStatus, execution:awaitingDelivery||newerActivity?'waiting':value.executionStatus,
    finalizing:Boolean(task.finalization),finalizationFailed:Boolean(task.finalization?.error),
    ...(newerActivity ? {lastProgressAt: lastActivityAt, now: Date.now()} : {})}).status;
  return {...value, executionStatus:status, sourceTaskId:task.sourceTaskId??null,
    ...(task.createdAt !== undefined ? {startedAt: task.createdAt} : {}),
    phaseExecutionStatus:value.phaseExecutionStatus ?? value.executionStatus,
    requestState:task.state, resultStatus:task.resultStatus, taskRevision:task.revision, finalization:task.finalization??null,
    reason:task.finalization ? task.finalization.error ? `交付确认失败：${task.finalization.error}` : '执行结果正在进行最终确认'
      : task.state==='closed'&&activeExecution(status) ? '请求已结束，后台仍有执行活动'
      : task.state==='closed'&&status==='unknown' ? '请求已结束，后台执行结果仍待核对'
      : awaitingDelivery ? '本阶段执行已结束，请求仍然开放'
      : newerActivity && status !== 'stalled' ? null : value.reason,
    acceptanceStatus:status === 'completed' && value.executionStatus !== 'completed'
      ? 'not_required' : value.acceptanceStatus,
    finishedAt:task.finalization && task.state!=='closed' ? null : task.state === 'closed' ? task.finishedAt ?? value.finishedAt : value.finishedAt,
    lastActivityAt};
}

export function observeSourceStates<T extends {nodeId:string;executionStatus:string}>(
  values:readonly T[],sources:readonly {nodeId:string;online:boolean;observedAt:number|null;error?:string|null}[],now=Date.now(),
):Array<T & {observedAt:number|null;stale:boolean}>{
  const byNode=new Map(sources.map(source=>[source.nodeId,source]));
  return values.map(value=>{
    const source=byNode.get(value.nodeId);
    const stale=!source||!source.online||Boolean(source.error)||source.observedAt===null||now-source.observedAt>30_000;
    return {...value, observedAt:source?.observedAt ?? null, stale,
      ...(stale&&activeExecution(value.executionStatus)?{executionStatus:'unknown'}:{})};
  });
}

export interface ExecutionTimeValue {
  executionStatus: string; finishedAt: number | null; lastActivityAt: number;
  observedAt?: number | null; stale?: boolean;
}

export function taskTimeEnd(value: ExecutionTimeValue & {requestState?: string}, now = Date.now()): number | null {
  if (value.requestState === 'active') return now;
  if (value.requestState === 'closed') return typeof value.finishedAt === 'number' && Number.isFinite(value.finishedAt) ? value.finishedAt : null;
  return executionTimeEnd(value, now);
}

/** 运行中才推进时间；来源失联或执行未知时固定到最后可证明的时点。 */
export function executionTimeEnd(value: ExecutionTimeValue, now = Date.now()): number | null {
  const valid = (time: number | null | undefined): time is number => typeof time === 'number' && Number.isFinite(time);
  if (valid(value.finishedAt)) return value.finishedAt;
  if (value.executionStatus === 'queued') return null;
  const stale = value.stale || valid(value.observedAt) && now - value.observedAt > 30_000;
  if (stale) return valid(value.observedAt) ? value.observedAt : valid(value.lastActivityAt) ? value.lastActivityAt : null;
  if (['running', 'stopping'].includes(value.executionStatus)) return now;
  if (['waiting', 'idle', 'unknown', 'stalled', 'interrupted', 'interrupted_recoverable', 'failed', 'cancelled', 'ended', 'handed_off', 'finalizing'].includes(value.executionStatus))
    return valid(value.lastActivityAt) ? value.lastActivityAt : null;
  return null;
}
