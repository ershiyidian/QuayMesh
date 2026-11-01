import type {ServerConfig} from '../config.js';
import type {Query} from './query.js';
import type * as Local from './local-queries.js';
import type {ActivityQuery,readLocalActivity as localActivity} from './activity.js';
import type {readTaskMessageState as localTaskMessageState} from './read-task-state.js';
import type {CaptureReadFence} from '../session/capture-read-observation.js';
import type {ConsoleDetailRead} from './detail-read-model.js';
import type {ConsoleArtifactRequest,ConsoleArtifactRead} from './detail-read-artifacts.js';
import type {readConsoleAudit} from './audit-read.js';
import type {readProjectSessions} from './project-sessions-read.js';
import {AsyncLocalStorage} from 'node:async_hooks';
import {ConsoleReadProcessPool} from './read-process.js';
import {consoleReadConfig,parseConsoleReadRequest,type ConsoleReadRequest} from './read-protocol.js';

const readers=new ConsoleReadProcessPool();
const requestSignal=new AsyncLocalStorage<AbortSignal>();
export function withConsoleReadSignal<T>(signal:AbortSignal,fn:()=>T):T{return requestSignal.run(signal,fn);}
process.once('exit',()=>readers.close());
export const closeConsoleReaders=()=>readers.close();
function read<T>(config:ServerConfig,request:Omit<ConsoleReadRequest,'config'>,signal?:AbortSignal):Promise<T> {
  return readers.read<T>(parseConsoleReadRequest({...request,config:consoleReadConfig(config)}),signal??requestSignal.getStore());
}
export const readLocalMetadata=(config:ServerConfig,signal?:AbortSignal)=>
  read<ReturnType<typeof Local.readLocalMetadata>>(config,{operation:'metadata'},signal);
export const readLocalPage=(config:ServerConfig,query:Query,signal?:AbortSignal)=>
  read<ReturnType<typeof Local.readLocalPage>>(config,{operation:'page',query},signal);
export const readLocalTaskIndex=(config:ServerConfig,at?:number,signal?:AbortSignal)=>
  read<ReturnType<typeof Local.readLocalTaskIndex>>(config,{operation:'task-index',at},signal);
export const readLocalSessionTitles=(config:ServerConfig,signal?:AbortSignal)=>
  read<ReturnType<typeof Local.readLocalSessionTitles>>(config,{operation:'session-titles'},signal);
export const readLocalRunSummaries=(config:ServerConfig,ids:readonly string[],signal?:AbortSignal)=>
  read<ReturnType<typeof Local.readLocalRunSummaries>>(config,{operation:'run-summaries',ids:[...ids]},signal);
export const readLocalUsage=(config:ServerConfig,query:Query,signal?:AbortSignal)=>
  read<ReturnType<typeof Local.readLocalUsage>>(config,{operation:'usage',query},signal);
export const readLocalOverviewUsage=(config:ServerConfig,zone='UTC',at?:number,signal?:AbortSignal)=>
  read<ReturnType<typeof Local.readLocalOverviewUsage>>(config,{operation:'overview-usage',zone,at},signal);
export const readLocalOverview=(config:ServerConfig,zone='UTC',at?:number,signal?:AbortSignal)=>
  read<ReturnType<typeof Local.readLocalOverview>>(config,{operation:'overview',zone,at},signal);
export const readLocalActivity=(config:ServerConfig,kind:string,query:ActivityQuery,signal?:AbortSignal)=>
  read<ReturnType<typeof localActivity>>(config,{operation:kind==='calls'?'activity-calls':'activity-events',
    query:{...query,limit:String(query.limit)}},signal);
export const readLocalTaskMessageState=(config:ServerConfig,taskId:string,signal?:AbortSignal)=>
  read<ReturnType<typeof localTaskMessageState>>(config,{operation:'task-message-state',ids:[taskId]},signal);
export const readLocalAudit=(config:ServerConfig,query:Pick<ActivityQuery,'q'|'limit'>,signal?:AbortSignal)=>
  read<Awaited<ReturnType<typeof readConsoleAudit>>>(config,{operation:'audit',query:{q:query.q,limit:String(query.limit)}},signal);
export const readLocalProjectSessions=(config:ServerConfig,projectId:string,signal?:AbortSignal)=>
  read<ReturnType<typeof readProjectSessions>>(config,{operation:'project-sessions',ids:[projectId]},signal);
export const readLocalDetail=(config:ServerConfig,runId:string,fence?:CaptureReadFence,signal?:AbortSignal)=>
  read<ConsoleDetailRead>(config,{operation:'detail',ids:[runId],fence},signal);
export const readLocalArtifact=<T extends ConsoleArtifactRequest>(config:ServerConfig,request:T,fence?:CaptureReadFence,signal?:AbortSignal)=>
  read<Extract<ConsoleArtifactRead,{kind:T['kind']}>>(config,{operation:request.kind,ids:[request.runId],cursor:request.cursor,fence,
    expectedTaskId:request.expectedTaskId,expectedSessionId:request.expectedSessionId,
    ...(request.kind==='file-diff'?{fileId:request.fileId}:request.kind==='command-output'?{commandId:request.commandId}:{})},signal);
