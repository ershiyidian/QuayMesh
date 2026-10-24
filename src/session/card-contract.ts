import type { Snapshot } from './types.js';
import type { ExecutionObservation } from '../execution-observation.js';

export const WORKSPACE_APP_VERSION = 'task-card-v8';
export const WORKSPACE_APP_URI = 'ui://quaymesh/task-card/v8.html';
export const PREVIOUS_WORKSPACE_APP_URI = 'ui://quaymesh/task-card/v7.html';

// 历史聊天永久保存资源地址；这份表记录实际发布过的入口，不按版本号倒推。
export const CARD_RESOURCES = [
  {version:'task-card-v1', uri:'ui://quaymesh/task-card/v1.html'},
  {version:'task-card-v3', uri:'ui://quaymesh/task-card/v3.html'},
  {version:'task-card-v4', uri:'ui://quaymesh/task-card/v4.html'},
  {version:'task-card-v5', uri:'ui://quaymesh/task-card/v5.html'},
  {version:'task-card-v6', uri:'ui://quaymesh/task-card/v6.html'},
  {version:'task-card-v7', uri:PREVIOUS_WORKSPACE_APP_URI},
  {version:WORKSPACE_APP_VERSION, uri:WORKSPACE_APP_URI},
] as const;
export type CardVersion = typeof CARD_RESOURCES[number]['version'];

// 首次工具回执早于界面握手，也可能交给仍缓存旧代码的宿主。
// 历史 v4 曾把请求标成 v5；v6 支持执行观测，v7 支持实时状态，v8 支持观测过期。
// 持久化快照保持完整，旧客户端得到其已知的展示协议。
export function snapshotForCard(snapshot: Snapshot, version?: string): Snapshot {
  if (version === WORKSPACE_APP_VERSION) return snapshot;
  const compatible = {...snapshot, ...(snapshot.executionObservation ? {executionObservation: legacyObservation(snapshot.executionObservation)} : {})};
  if (version === 'task-card-v7') return compatible;
  const {live: _live, finalization: _finalization, ...v6} = compatible;
  if (version === 'task-card-v6') return v6;
  const {sourceTaskId: _sourceTaskId, executionObservation: _observation, ...legacy} = v6;
  return legacy;
}

export function projectionForCard<T extends {snapshot?: Snapshot; observation?: ExecutionObservation; live?: unknown}>(result: T, version?: string): T {
  if (version === WORKSPACE_APP_VERSION) return result;
  const compatible = {...result};
  if (version !== 'task-card-v7') delete compatible.live;
  if (version === 'task-card-v7' || version === 'task-card-v6') {
    if (compatible.observation) compatible.observation = legacyObservation(compatible.observation);
  } else delete compatible.observation;
  if (compatible.snapshot) compatible.snapshot = snapshotForCard(compatible.snapshot, version);
  return compatible;
}

function legacyObservation(observation: ExecutionObservation): ExecutionObservation {
  const {stale: _stale, operationObservedAt: _operationObservedAt, ...compatible} = observation;
  return compatible;
}
