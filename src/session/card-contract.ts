import type { Snapshot } from './types.js';

export const WORKSPACE_APP_VERSION = 'task-card-v6';
export const WORKSPACE_APP_URI = 'ui://quaymesh/task-card/v6.html';
export const PREVIOUS_WORKSPACE_APP_URI = 'ui://quaymesh/task-card/v5.html';

// 历史聊天永久保存资源地址；这份表记录实际发布过的入口，不按版本号倒推。
export const CARD_RESOURCES = [
  {version:'task-card-v1', uri:'ui://quaymesh/task-card/v1.html'},
  {version:'task-card-v3', uri:'ui://quaymesh/task-card/v3.html'},
  {version:'task-card-v4', uri:'ui://quaymesh/task-card/v4.html'},
  {version:'task-card-v5', uri:PREVIOUS_WORKSPACE_APP_URI},
  {version:WORKSPACE_APP_VERSION, uri:WORKSPACE_APP_URI},
] as const;
export type CardVersion = typeof CARD_RESOURCES[number]['version'];

// 首次工具回执早于界面握手，也可能交给仍缓存旧代码的宿主。
// 历史 v4 代码曾把首轮请求标成 v5，只有 v6 可以明确确认新字段支持。
// 持久化快照保持完整，旧客户端得到其已知的展示协议。
export function snapshotForCard(snapshot: Snapshot, version?: string): Snapshot {
  if (version === WORKSPACE_APP_VERSION) return snapshot;
  const {sourceTaskId: _sourceTaskId, executionObservation: _observation, ...legacy} = snapshot;
  return legacy;
}

export function projectionForCard<T extends {snapshot?: Snapshot; observation?: unknown}>(result: T, version?: string): T {
  if (version === WORKSPACE_APP_VERSION) return result;
  const compatible = {...result};
  delete compatible.observation;
  if (compatible.snapshot) compatible.snapshot = snapshotForCard(compatible.snapshot, version);
  return compatible;
}
