import type { Snapshot } from './types.js';
import type { ExecutionObservation } from '../execution-observation.js';
import { filesForReader } from './file-contract.js';

export const WORKSPACE_APP_VERSION = 'task-card-v9';
export const WORKSPACE_APP_URI = 'ui://quaymesh/task-card/v9.html';
export const PREVIOUS_WORKSPACE_APP_URI = 'ui://quaymesh/task-card/v8.html';

// 历史聊天永久保存资源地址；这份表记录实际发布过的入口，不按版本号倒推。
export const CARD_RESOURCES = [
  {version:'task-card-v1', uri:'ui://quaymesh/task-card/v1.html'},
  {version:'task-card-v3', uri:'ui://quaymesh/task-card/v3.html'},
  {version:'task-card-v4', uri:'ui://quaymesh/task-card/v4.html'},
  {version:'task-card-v5', uri:'ui://quaymesh/task-card/v5.html'},
  {version:'task-card-v6', uri:'ui://quaymesh/task-card/v6.html'},
  {version:'task-card-v7', uri:'ui://quaymesh/task-card/v7.html'},
  {version:'task-card-v8', uri:PREVIOUS_WORKSPACE_APP_URI},
  {version:WORKSPACE_APP_VERSION, uri:WORKSPACE_APP_URI},
] as const;
export type CardVersion = typeof CARD_RESOURCES[number]['version'];

// 首次工具回执早于界面握手，也可能交给仍缓存旧代码的宿主。
// 历史 v4 曾把请求标成 v5；v6 支持执行观测，v7 支持实时状态，v8 支持观测过期。
// 持久化快照保持完整，旧客户端得到其已知的展示协议。
export function snapshotForCard(snapshot: Snapshot, version?: string, fileRecordedAt = false): Snapshot {
  // Execution-attempt identity is private federation evidence. Even a current
  // card can be cached with a strict command reader that predates these fields.
  const publicSnapshot = { ...withoutCommandIdentity(snapshot),
    // A host may retain older HTML at the same resource URI and version.
    files: filesForReader(snapshot.files, fileRecordedAt) };
  if (supportsStaleObservation(version)) return publicSnapshot;
  const compatible = {...publicSnapshot, ...(snapshot.executionObservation ? {executionObservation: legacyObservation(snapshot.executionObservation)} : {})};
  if (version === 'task-card-v7') return compatible;
  const {live: _live, finalization: _finalization, ...v6} = compatible;
  if (version === 'task-card-v6') return v6;
  const {sourceTaskId: _sourceTaskId, executionObservation: _observation, ...legacy} = v6;
  return legacy;
}

export function projectionForCard<T extends {snapshot?: Snapshot; observation?: ExecutionObservation; live?: unknown}>(result: T, version?: string, fileRecordedAt = false): T {
  const compatible = {...result};
  if (compatible.snapshot) compatible.snapshot = snapshotForCard(compatible.snapshot, version, fileRecordedAt);
  if (supportsStaleObservation(version)) return compatible;
  if (version !== 'task-card-v7') delete compatible.live;
  if (version === 'task-card-v7' || version === 'task-card-v6') {
    if (compatible.observation) compatible.observation = legacyObservation(compatible.observation);
  } else delete compatible.observation;
  return compatible;
}

function supportsStaleObservation(version?: string): boolean {
  return version === 'task-card-v8' || version === WORKSPACE_APP_VERSION;
}

function withoutCommandIdentity(snapshot: Snapshot): Snapshot {
  const publicCommand = ({invocation_id: _invocation, effect: _effect, ...command}: Snapshot['commands'][number]) => command;
  return {
    ...snapshot,
    commands: snapshot.commands.map(publicCommand),
    ...(snapshot.currentCommand ? {currentCommand: publicCommand(snapshot.currentCommand)} : {}),
    ...(snapshot.runningCommand ? {runningCommand: publicCommand(snapshot.runningCommand)} : {}),
    ...(snapshot.lastCommand ? {lastCommand: publicCommand(snapshot.lastCommand)} : {}),
  };
}

function legacyObservation(observation: ExecutionObservation): ExecutionObservation {
  const {stale: _stale, operationObservedAt: _operationObservedAt, ...compatible} = observation;
  return compatible;
}
