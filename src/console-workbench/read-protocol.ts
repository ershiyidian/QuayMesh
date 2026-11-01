import {isAbsolute} from 'node:path';
import type {ServerConfig} from '../config.js';
import type {Query} from './query.js';

export const CONSOLE_READ_OPERATIONS = ['metadata','page','task-index','session-titles','run-summaries','usage','overview-usage','overview',
  'activity-calls','activity-events','task-message-state'] as const;
export type ConsoleReadOperation = typeof CONSOLE_READ_OPERATIONS[number];
export const CONSOLE_READ_BUSINESS_ERRORS = {
  invalid_cursor:{status:400,message:'任务分页游标无效，请从第一页重新读取'},
  project_scope:{status:403,message:'此项目不在当前允许访问的目录内'},
  invalid_reference:{status:400,message:'任务或项目引用无效'},
  revision_conflict:{status:409,message:'记录已更新，请刷新后重试'},
  task_scope:{status:403,message:'任务不在允许访问的项目内'},
  task_owner_mismatch:{status:409,message:'镜像记录不能作为任务权威'},
} as const;
export function consoleReadFailureCode(error:unknown):string {
  const value=error as {code?:unknown;status?:unknown}|null;
  if(typeof value?.code==='string'&&Object.hasOwn(CONSOLE_READ_BUSINESS_ERRORS,value.code)) {
    const entry=CONSOLE_READ_BUSINESS_ERRORS[value.code as keyof typeof CONSOLE_READ_BUSINESS_ERRORS];
    if(value.status===entry.status)return value.code;
  }
  return 'console_read_failed';
}
export interface ConsoleReadRequest {
  operation: ConsoleReadOperation;
  config: ServerConfig;
  query?: Query;
  ids?: string[];
  zone?: string;
  at?: number;
}
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const string = (value: unknown, max=4096): value is string => typeof value === 'string' && value.length <= max && !value.includes('\0');
const queryKeys = new Set(['fresh','node','project','q','session','root','requestState','overviewGroup','resultStatus','days','stage','status',
  'sort','cursor','limit','changed','execution','date','finishedDay','usageDate','usageDays','after','afterId','attention','tz','kind','level','hour']);

/** The caller has already authenticated the Owner/mesh route. Never serialize
 * OAuth, agent configuration, cluster tokens, provider secrets or process env. */
export function consoleReadConfig(config: ServerConfig): ServerConfig {
  const f = config.federation;
  const cleanUrl = (value: string): string => { const url = new URL(value); url.username=''; url.password=''; return url.href; };
  return {
    stateDir:config.stateDir, configDir:config.configDir, allowedRoots:[...config.allowedRoots],
    ...(f ? {federation:{nodeId:f.nodeId,nickname:f.nickname, priority:f.priority,
      roots:f.roots.map(root=>({id:root.id,nickname:root.nickname,path:root.path,description:root.description,tags:[...root.tags],enabled:root.enabled})),
      capabilities:{coordinator:f.capabilities.coordinator},
      egress:{enabled:f.egress.enabled,mihomoConfig:f.egress.mihomoConfig,proxyUrl:cleanUrl(f.egress.proxyUrl),
        probeUrl:cleanUrl(f.egress.probeUrl),recoveryDelayMs:f.egress.recoveryDelayMs,inheritProxy:f.egress.inheritProxy}}} : {}),
  } as ServerConfig;
}

/** Validate before opening SQLite. This is a fixed read API, never SQL or a
 * general-purpose command/module/file-read protocol. */
export function parseConsoleReadRequest(value: unknown): ConsoleReadRequest {
  if (!object(value) || Object.keys(value).some(key=>!['operation','config','query','ids','zone','at'].includes(key))
    || !CONSOLE_READ_OPERATIONS.includes(value.operation as ConsoleReadOperation) || !object(value.config)) throw new Error('invalid_read');
  const config=value.config;
  if (Object.keys(config).some(key=>!['stateDir','configDir','allowedRoots','federation'].includes(key))
    || !string(config.stateDir) || !isAbsolute(config.stateDir) || !string(config.configDir) || !isAbsolute(config.configDir)
    || !Array.isArray(config.allowedRoots) || config.allowedRoots.length>256
    || !config.allowedRoots.every(root=>string(root)&&isAbsolute(root))) throw new Error('invalid_scope');
  if (config.federation!==undefined) {
    const f=config.federation;
    if (!object(f) || Object.keys(f).some(key=>!['nodeId','nickname','priority','roots','capabilities','egress'].includes(key))
      || !string(f.nodeId,256) || !Array.isArray(f.roots) || !object(f.egress) || !object(f.capabilities)) throw new Error('invalid_scope');
  }
  if (value.query!==undefined && (!object(value.query) || Object.entries(value.query).some(([key,item])=>!queryKeys.has(key)||item!==undefined&&!string(item,8192))))
    throw new Error('invalid_query');
  if (value.ids!==undefined && (!Array.isArray(value.ids) || value.ids.length>100
    || !value.ids.every(id=>typeof id==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(id)))) throw new Error('invalid_ids');
  if (value.zone!==undefined && !string(value.zone,100) || value.at!==undefined && (!Number.isSafeInteger(value.at)||(value.at as number)<0)) throw new Error('invalid_query');
  return value as unknown as ConsoleReadRequest;
}
