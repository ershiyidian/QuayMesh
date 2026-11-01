import type {ServerConfig} from '../config.js';
import type {SessionRuntime} from '../session/runtime.js';
import type {CaptureReadFence} from '../session/capture-read-observation.js';
import type {DetailReadEvidence} from './detail-read-model.js';
import type {ConsoleArtifactRequest,ConsoleArtifactRead} from './detail-read-artifacts.js';
import {readLocalDetail,readLocalArtifact} from './isolated-queries.js';
import {applyDetailReadObservation,applyArtifactReadObservation} from './detail-read-observation.js';
import {WorkbenchError} from './types.js';

export interface DetailCaptureSource {
  changes:Pick<SessionRuntime['changes'],'captureReadFence'|'captureReadObservation'>;
}

function validateRead(read:DetailReadEvidence,config:ServerConfig,runId:string,before?:CaptureReadFence):void {
  const scope=read.scope,nodeId=config.federation?.nodeId??'local';
  const invalidScope=scope&&(scope.runId!==runId||scope.nodeId!==nodeId);
  const invalidFence=before? !read.fence||read.fence.generation!==before.generation||read.fence.sequence!==before.sequence
    :read.fence!==null;
  if(invalidScope||invalidFence)
    throw new WorkbenchError('详情读取结果与请求范围不一致',409,'snapshot_scope','none');
}

/** Parent half of the detail read. Only memory-owned capture evidence is read
 * here; all SQL, snapshots, artifacts and formatting execute in the child. */
export async function readIsolatedRunDetail(config:ServerConfig,runId:string,runtime?:DetailCaptureSource) {
  const before=runtime?.changes.captureReadFence();
  const result=await readLocalDetail(config,runId,before);
  validateRead(result.read,config,runId,before);
  if(result.value.run.localId!==runId||result.value.run.nodeId!==(config.federation?.nodeId??'local'))
    throw new WorkbenchError('详情读取结果与请求范围不一致',409,'snapshot_scope','none');
  const scope=result.read.scope;
  const observation=runtime&&scope&&before?runtime.changes.captureReadObservation(scope,before):undefined;
  return applyDetailReadObservation(result,observation);
}

type ArtifactRequestOf<K extends ConsoleArtifactRequest['kind']>=Extract<ConsoleArtifactRequest,{kind:K}>;
type ArtifactValueOf<K extends ConsoleArtifactRead['kind']>=Extract<ConsoleArtifactRead,{kind:K}>['value'];
export function readIsolatedArtifact(config:ServerConfig,request:ArtifactRequestOf<'file-diff'>,runtime?:DetailCaptureSource):Promise<ArtifactValueOf<'file-diff'>>;
export function readIsolatedArtifact(config:ServerConfig,request:ArtifactRequestOf<'patch'>,runtime?:DetailCaptureSource):Promise<ArtifactValueOf<'patch'>>;
export function readIsolatedArtifact(config:ServerConfig,request:ArtifactRequestOf<'command-output'>,runtime?:DetailCaptureSource):Promise<ArtifactValueOf<'command-output'>>;
export function readIsolatedArtifact(config:ServerConfig,request:ConsoleArtifactRequest,runtime?:DetailCaptureSource):Promise<ConsoleArtifactRead['value']>;
export async function readIsolatedArtifact(config:ServerConfig,request:ConsoleArtifactRequest,runtime?:DetailCaptureSource):Promise<ConsoleArtifactRead['value']> {
  const before=runtime?.changes.captureReadFence();
  const result=await readLocalArtifact(config,request,before);
  validateRead(result.read,config,request.runId,before);
  if(result.kind!==request.kind||!result.read.scope)
    throw new WorkbenchError('保存的内容与请求范围不一致',409,'snapshot_scope','none');
  const observation=runtime&&before?runtime.changes.captureReadObservation(result.read.scope,before):undefined;
  return applyArtifactReadObservation(result,observation);
}
