import { taskView } from './task-view.js';

export const taskStages: ReadonlyArray<readonly [string, string]> = [
  ['running', '执行中'], ['queued', '排队'], ['waiting', '等待下一步'],
  ['stalled', '等待接续'], ['finalizing', '结束待确认'],
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
  sourceTaskId?: string|null;
}

export function withTaskLifecycle<T extends {
  taskId: string | null; executionStatus: string; acceptanceStatus: string;
  finishedAt: number | null; lastActivityAt: number;
}>(value: T, task?: TaskLifecycle): T {
  if (!task || task.id !== value.taskId) return value;
  const status = taskView({requestState:task.state, result:task.resultStatus, execution:value.executionStatus}).status;
  return {...value, executionStatus:status, sourceTaskId:task.sourceTaskId??null,
    acceptanceStatus:status === 'completed' && value.executionStatus !== 'completed'
      ? 'not_required' : value.acceptanceStatus,
    finishedAt:task.state === 'closed' ? task.finishedAt ?? value.finishedAt : value.finishedAt,
    lastActivityAt:Math.max(value.lastActivityAt,task.lastActivityAt)};
}

export function observeSourceStates<T extends {nodeId:string;executionStatus:string}>(
  values:readonly T[],sources:readonly {nodeId:string;online:boolean;observedAt:number|null}[],now=Date.now(),
):T[]{
  const byNode=new Map(sources.map(source=>[source.nodeId,source]));
  return values.map(value=>{
    const source=byNode.get(value.nodeId);
    const stale=Boolean(source&&(!source.online||source.observedAt===null||now-source.observedAt>30_000));
    return stale&&activeExecution(value.executionStatus)?{...value,executionStatus:'unknown'}:value;
  });
}
