import { isAbsolute } from 'node:path';
import type { CaptureReadFence, CaptureReadObservation, CaptureReadScope } from './capture-read-observation.js';
import type { Snapshot } from './types.js';

export interface ProjectionIdentity {
  ownerId:string; sessionId:string; memberId:string; taskId:string|null; nodeId:string;
  workspaceId:string; root:string; sourceRoot:string|null; recoveryRoot:string; mode:string;
  sessionRevision:number; memberRevision:number; taskRevision:number|null;
  currentTaskId:string|null; sessionState:string; sessionReview:string; sessionHost:string;
  sessionTitle:string; taskState:string|null; taskTitle:string|null;
}
export interface ProjectionCaptureSource {
  captureReadFence():CaptureReadFence;
  captureReadObservation(scope:CaptureReadScope,before:CaptureReadFence):CaptureReadObservation;
}
export interface ProjectionReadRequest {
  operation:'session-projection'; stateDir:string; consoleUrl:string|null; localNodeId:string;
  identity:ProjectionIdentity; capture:CaptureReadObservation|null;
}
export interface ProjectionReadResult {
  identity:ProjectionIdentity; capture:CaptureReadObservation|null; snapshot:Snapshot;
}
const record = (value:unknown):value is Record<string,unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value:unknown,max=4096):value is string => typeof value === 'string' && value.length <= max && !value.includes('\0');
const integer = (value:unknown):value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const nullableText = (value:unknown) => value === null || text(value);
const identityKeys = ['ownerId','sessionId','memberId','taskId','nodeId','workspaceId','root','sourceRoot','recoveryRoot','mode',
  'sessionRevision','memberRevision','taskRevision','currentTaskId','sessionState','sessionReview','sessionHost','sessionTitle','taskState','taskTitle'];

export function sameProjectionIdentity(a:ProjectionIdentity,b:ProjectionIdentity):boolean {
  return identityKeys.every(key => a[key as keyof ProjectionIdentity] === b[key as keyof ProjectionIdentity]);
}
export function projectionScope(identity:ProjectionIdentity):CaptureReadScope {
  return {sessionId:identity.sessionId,memberId:identity.memberId,taskId:identity.taskId};
}
export function sameProjectionCapture(a:CaptureReadObservation|null,b:CaptureReadObservation|null):boolean {
  return a === null ? b === null : b !== null && a.generation === b.generation && a.sequence === b.sequence
    && a.unchanged === b.unchanged && a.state === b.state && a.error === b.error
    && a.scope.sessionId === b.scope.sessionId && a.scope.memberId === b.scope.memberId && a.scope.taskId === b.scope.taskId;
}

/** Private fixed method. No SQL, arbitrary module path, process environment or credentials cross this boundary. */
export function parseProjectionReadRequest(value:unknown):ProjectionReadRequest {
  if (!record(value) || Object.keys(value).some(key => !['operation','stateDir','consoleUrl','localNodeId','identity','capture'].includes(key))
    || value.operation !== 'session-projection' || !text(value.stateDir) || !isAbsolute(value.stateDir)
    || !nullableText(value.consoleUrl) || !text(value.localNodeId,256) || !value.localNodeId || !record(value.identity)) throw new Error('invalid_projection_read');
  const id = value.identity;
  if (Object.keys(id).length !== identityKeys.length || identityKeys.some(key => !Object.hasOwn(id,key))
    || Object.keys(id).some(key => !identityKeys.includes(key))
    || !['ownerId','sessionId','memberId','nodeId','workspaceId'].every(key => text(id[key],256) && id[key] !== '')
    || !['root','recoveryRoot'].every(key => text(id[key]) && id[key] !== ''
      && (id.nodeId !== value.localNodeId || isAbsolute(id[key] as string)))
    || !['sourceRoot','taskId','currentTaskId','taskState','taskTitle'].every(key => nullableText(id[key]))
    || !['mode','sessionState','sessionReview','sessionHost','sessionTitle'].every(key => text(id[key]))
    || !integer(id.sessionRevision) || !integer(id.memberRevision)
    || !(id.taskRevision === null || integer(id.taskRevision))
    || (id.taskId === null) !== (id.taskRevision === null)) throw new Error('invalid_projection_scope');
  if (value.capture !== null) {
    const c = value.capture;
    if (!record(c) || Object.keys(c).some(key => !['scope','generation','sequence','unchanged','state','error'].includes(key))
      || !record(c.scope) || Object.keys(c.scope).length !== 3
      || c.scope.sessionId !== id.sessionId || c.scope.memberId !== id.memberId || c.scope.taskId !== id.taskId
      || !text(c.generation,256) || !integer(c.sequence) || typeof c.unchanged !== 'boolean'
      || !['idle','pending','failed'].includes(String(c.state)) || !nullableText(c.error)) throw new Error('invalid_projection_capture');
  }
  return value as unknown as ProjectionReadRequest;
}
