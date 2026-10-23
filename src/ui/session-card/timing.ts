import { mergeExecutionObservations } from "../../execution-observation.js";
import type { CommandSummary, Snapshot } from "../../session/types.js";
import { taskDelivery, taskView, TASK_SILENCE_MS } from "../../task-view.js";

export const DEFAULT_SILENCE_WARNING_MS = TASK_SILENCE_MS;
export type CardStatus = "running" | "stalled" | "failed" | "success" | "cancelled" | "handed_off" | "finalizing" | "archived" | "idle" | "unavailable";
export type BackgroundStatus = "running" | "queued" | "unconfirmed" | "idle";

export interface CardPresentation {
  status: CardStatus;
  label: string;
  backgroundStatus: BackgroundStatus;
  backgroundLabel: string | null;
  taskElapsedMs: number | null;
  taskClockLabel: string;
  commandElapsedMs: number | null;
  modelActivityAgeMs: number | null;
  executionActivityAgeMs: number | null;
  activityAgeMs: number;
  outputAgeMs: number | null;
  taskClockDynamic: boolean;
  commandClockDynamic: boolean;
}

export function hasBackground(snapshot: Snapshot | null, now = Date.now()): boolean {
  if (!snapshot) return false;
  const value = backgroundObservation(snapshot, now);
  return value.activeOperationIds.length > 0 || value.preparingOperationIds.length > 0;
}

function backgroundObservation(snapshot: Snapshot, now: number) {
  if (snapshot.executionObservation) return mergeExecutionObservations([snapshot.executionObservation], now);
  const commands = [...snapshot.commands, ...(snapshot.runningCommand ? [snapshot.runningCommand] : [])];
  return mergeExecutionObservations([{observedAt: snapshot.observedAt,
    activeOperationIds: [...commands.filter(command => command.status === 'run').map(command => command.operation_id),
      ...snapshot.agents.filter(agent => agent.state === 'working').map(agent => `agent:${agent.id}`)],
    preparingOperationIds: [...commands.filter(command => command.status === 'queued').map(command => command.operation_id),
      ...snapshot.agents.filter(agent => agent.state === 'queued').map(agent => `agent:${agent.id}`)],
    staleOperationIds: [...commands.filter(command => command.status === 'unknown').map(command => command.operation_id),
      ...snapshot.agents.filter(agent => agent.state === 'unknown').map(agent => `agent:${agent.id}`)]}], now);
}

function finalizationPending(snapshot: Snapshot): boolean {
  if (snapshot.finalization !== undefined) return snapshot.finalization !== null;
  return snapshot.notices.some(value => value.includes("正在确认") || value.includes("结束尚未确认"));
}

export function deliveryEnd(snapshot: Snapshot): number | null {
  if (finiteTime(snapshot.deliveryEndedAt)) return snapshot.deliveryEndedAt;
  if (snapshot.taskResult && finiteTime(snapshot.endedAt)) return snapshot.endedAt;
  return null;
}

export function lastProgressAt(snapshot: Snapshot): number {
  return Math.max(snapshot.startedAt, ...[snapshot.lastModelToolAt, snapshot.lastActivityAt,
    snapshot.lastExecutionActivityAt, snapshot.lastOutputAt, snapshot.lastOperation?.endedAt,
    snapshot.lastOperation?.startedAt].filter(finiteTime));
}

function executionView(snapshot: Snapshot, now: number, silenceWarningMs = DEFAULT_SILENCE_WARNING_MS) {
  const observation = backgroundObservation(snapshot, now);
  return taskView({requestState: snapshot.taskState, result: snapshot.taskResult,
    execution: snapshot.execution_status, active: observation.activeOperationIds.length > 0,
    queued: observation.preparingOperationIds.length > 0, finalizing: finalizationPending(snapshot),
    finalizationFailed: snapshot.finalization?.state === 'failed',
    unresolved: observation.staleOperationIds.length > 0,
    stale: snapshot.host_status === "disconnected" && (!snapshot.executionObservation || !(observation.activeOperationIds.length || observation.preparingOperationIds.length)),
    lastProgressAt: lastProgressAt(snapshot),
    now: now + (TASK_SILENCE_MS - silenceWarningMs)});
}

export function taskElapsedMs(snapshot: Snapshot, now: number): number | null {
  const end = deliveryEnd(snapshot);
  if (end !== null) return nonNegative(end - snapshot.startedAt);
  if (snapshot.taskState === 'closed' || snapshot.closureReason === "superseded" || snapshot.closureReason === "legacy_archive") return null;
  if (executionView(snapshot, now).clockRunning) return nonNegative(now - snapshot.startedAt);
  const observed = snapshot.executionObservation;
  const previouslyActive = observed && (observed.activeOperationIds.length > 0 || observed.preparingOperationIds.length > 0);
  const recordedEnd = previouslyActive ? Math.max(lastProgressAt(snapshot), observed.observedAt) : lastProgressAt(snapshot);
  return nonNegative(Math.min(now, recordedEnd) - snapshot.startedAt);
}

export function commandElapsedMs(command: CommandSummary | null | undefined, now: number): number | null {
  if (!command || command.startedAt === null) return null;
  return nonNegative((command.endedAt ?? now) - command.startedAt);
}

export function commandTiming(snapshot: Snapshot, command: CommandSummary | null | undefined, now: number): {elapsedMs: number | null; dynamic: boolean; confirmed: boolean} {
  if (!command || command.startedAt === null) return {elapsedMs: null, dynamic: false, confirmed: false};
  if (['ok', 'fail', 'cancelled'].includes(command.status) && command.endedAt !== null)
    return {elapsedMs: commandElapsedMs(command, now), dynamic: false, confirmed: true};
  const observation = backgroundObservation(snapshot, now);
  const dynamic = (Boolean(snapshot.executionObservation) || snapshot.host_status !== 'disconnected') && observation.activeOperationIds.includes(command.operation_id);
  if (dynamic) return {elapsedMs: commandElapsedMs(command, now), dynamic: true, confirmed: true};
  const original = snapshot.executionObservation;
  const confirmedAt = original?.activeOperationIds.includes(command.operation_id) ? original.observedAt
    : !original && command.status === 'run' ? snapshot.observedAt : null;
  return {elapsedMs: confirmedAt === null ? null : nonNegative(Math.min(now, confirmedAt) - command.startedAt), dynamic: false, confirmed: false};
}

export function modelActivityAt(snapshot: Snapshot): number | null {
  return snapshot.lastModelToolAt ?? snapshot.lastActivityAt ?? null;
}

export function cardPresentation(snapshot: Snapshot, now: number, silenceWarningMs = DEFAULT_SILENCE_WARNING_MS): CardPresentation {
  const observation = backgroundObservation(snapshot, now);
  const shared = executionView(snapshot, now, silenceWarningMs);
  const modelAt = modelActivityAt(snapshot);
  const executionAt = snapshot.lastExecutionActivityAt ?? snapshot.lastOperation?.endedAt ?? snapshot.lastOperation?.startedAt ?? null;
  const backgroundStatus: BackgroundStatus = shared.backgroundActive
    ? observation.activeOperationIds.length ? 'running' : 'queued'
    : observation.staleOperationIds.length ? 'unconfirmed' : 'idle';
  const backgroundLabel = backgroundStatus === 'running' ? `后台仍在执行${observation.staleOperationIds.length?' · 另有命令结果待核对':''}`
    : backgroundStatus === 'queued' ? `后台正在准备${observation.staleOperationIds.length?' · 另有命令结果待核对':''}`
    : backgroundStatus === 'unconfirmed' ? '后台命令结果待核对' : null;
  let status: CardStatus, label: string;
  // 本轮交付和后台命令各有自己的状态，失联回执不改写已保存的交付结果。
  const delivery = taskDelivery(snapshot.taskState, snapshot.taskResult);
  if (delivery) {
    status = delivery.status === 'completed' ? 'success' : delivery.status === 'ended' ? 'archived' : delivery.status as CardStatus;
    label = delivery.status === 'ended' && (snapshot.closureReason === 'superseded' || snapshot.closureReason === 'legacy_archive')
      ? '已归档 · 交付未确认' : delivery.label;
  } else if (shared.status === 'running' || shared.status === 'queued' || shared.status === 'stopping') {
    status = 'running'; label = shared.status === 'queued' ? '准备执行' : shared.status === 'stopping' ? '正在停止' : '执行中';
  } else if (shared.status === 'unknown') {
    status = 'unavailable'; label = snapshot.host_status === 'disconnected' ? '暂时无法读取执行状态' : '执行结果待核对';
  } else if (shared.status === 'finalizing') {status = snapshot.finalization?.state === 'failed' ? 'failed' : 'finalizing'; label = snapshot.finalization?.state === 'failed' ? '交付确认失败' : '交付确认中';}
  else if (shared.status === 'failed') {status = 'failed'; label = '未完成';}
  else if (shared.status === 'cancelled') {status = 'cancelled'; label = '已停止';}
  else if (shared.status === 'handed_off') {status = 'handed_off'; label = '已交接';}
  else if (shared.status === 'completed') {status = 'success'; label = '已完成';}
  else if (snapshot.closureReason === 'superseded' || snapshot.closureReason === 'legacy_archive') {status = 'archived'; label = '已归档 · 交付未确认';}
  else if (shared.status === 'interrupted_recoverable') {status = 'stalled'; label = '执行已中断';}
  else if (shared.status === 'stalled') {status = 'stalled'; label = '长时间没有新的执行进展';}
  else {status = 'idle'; label = '当前无后台执行';}
  const command = snapshot.runningCommand ?? snapshot.lastCommand ?? snapshot.currentCommand ?? null;
  const timing = commandTiming(snapshot, command, now);
  const taskClockDynamic = shared.clockRunning && deliveryEnd(snapshot) === null && snapshot.taskState !== 'closed';
  return {status, label, backgroundStatus, backgroundLabel,
    taskElapsedMs: taskElapsedMs(snapshot, now), taskClockLabel: deliveryEnd(snapshot) !== null ? '本轮交付耗时' : taskClockDynamic ? '本轮耗时' : '耗时截至最近确认的活动',
    commandElapsedMs: timing.elapsedMs, taskClockDynamic, commandClockDynamic: timing.dynamic,
    modelActivityAgeMs: age(now, modelAt), executionActivityAgeMs: age(now, executionAt),
    activityAgeMs: nonNegative(now - lastProgressAt(snapshot)), outputAgeMs: age(now, snapshot.lastOutputAt ?? null)};
}

export function isFinal(snapshot: Snapshot | null, now = Date.now()): boolean {
  if (!snapshot) return false;
  const observation = backgroundObservation(snapshot, now);
  if (observation.activeOperationIds.length || observation.preparingOperationIds.length || observation.staleOperationIds.length) return false;
  if (finalizationPending(snapshot)) return false;
  return snapshot.taskState === 'closed' || snapshot.taskState === undefined && !snapshot.capabilities.refresh;
}

export function refreshDelay(snapshot: Snapshot | null, collapsed = false): number | null {
  if (isFinal(snapshot)) return null;
  if (snapshot?.taskState === 'closed') return hasBackground(snapshot) ? 5_000 : 30_000;
  if (!snapshot || hasBackground(snapshot) || snapshot.status === 'running' || Date.now()-lastProgressAt(snapshot)<60_000) return 5_000;
  return collapsed ? 15_000 : 10_000;
}

export function needsLocalTimer(snapshot: Snapshot | null): boolean {
  return Boolean(snapshot && !isFinal(snapshot));
}

export function elapsedText(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  return seconds < 3600 ? `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
    : `${Math.floor(seconds / 3600)}:${String(minutes % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

export function taskLabel(snapshot: Snapshot): string {return cardPresentation(snapshot, Date.now()).label;}
function age(now: number, value: number | null): number | null {return value === null ? null : nonNegative(now - value);}
function nonNegative(value: number): number {return Math.max(0, value);}
function finiteTime(value: number | null | undefined): value is number {return typeof value === 'number' && Number.isFinite(value);}
