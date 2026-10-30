import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {readdir, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
import {setImmediate as yieldToLoop} from 'node:timers/promises';
import Database from 'better-sqlite3';
import * as z from 'zod/v4';
import {jsonReply,replyBytes,REPLY_BYTES} from './bounded-reply.js';
import {diagnosticOwnerHash, mcpExchangeOutcome} from './mcp-request-diagnostics.js';
import type {McpRegistrationTarget} from './mcp-modern-server.js';
import type {ServerConfig} from './config.js';
import {CARD_RESOURCES} from './session/card-contract.js';

const id = z.string().min(1).max(256);
const timestamp = z.string().datetime({offset:true});
export const diagnosticsInputSchema = z.object({
  task_id:id,
  node_id:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
  operation_id:id.optional(),
  resource_uri:z.string().refine(uri => CARD_RESOURCES.some(item => item.uri === uri), 'Unknown card resource').optional(),
  since:timestamp,
  until:timestamp.optional(),
  cursor:z.string().max(2048).optional(),
  limit:z.number().int().min(1).max(100).default(30),
}).strict();
type Input = z.infer<typeof diagnosticsInputSchema>;
type Row = Record<string, unknown>;
type Entry = {key:string; time:string; source:'operation'|'card'|'transport'|'node'; data:Row};
const cursorSchema = z.object({scope:z.string(),until:timestamp,after:z.string().max(512)}).strict();
const lifecycle = new Set(['server_starting','server_exit','server_shutdown_started','server_shutdown_completed','server_shutdown_failed','server_uncaught_exception']);
const logFields = ['requestId','method','tool','resourceUri','taskId','operationId','sessionId','httpStatus','rpcErrorCode',
  'toolError','toolErrorCode','recoveryTextErrorCode','errorCodeConsistent','effect','retryHint','resultInspection','transportStatus','aborted','durationMs','authenticationMs','responseHeadersMs','firstResponseByteMs',
  'responseBytes','pid','ppid','childPid','exitCode','signal','elapsedMs','errorCode','outcome'];
const MAX_LOG_SCAN_BYTES = 32*1024*1024;
const operationFields = ['operation_id','kind','status','state','effect','exit_code','signal','error_code','result_ref'];
function select(row:Row, fields:string[]):Row {
  const result:Row = {};
  for (const key of fields) {
    const value = row[key];
    if (typeof value === 'boolean' || typeof value === 'number' || value === null) result[key]=value;
    else if (typeof value === 'string') result[key]=value.slice(0,512);
  }
  return result;
}

export async function readDiagnostics(config:Pick<ServerConfig,'stateDir'|'federation'>, ownerId:string, rawInput:Input, signal?:AbortSignal):Promise<Row> {
  signal?.throwIfAborted();
  if (!ownerId) throw new Error('MISSING_AUTHENTICATED_OWNER');
  const input = diagnosticsInputSchema.parse(rawInput);
  const cursor = input.cursor ? cursorSchema.parse(JSON.parse(input.cursor)) : undefined;
  const until = new Date(input.until ?? cursor?.until ?? Date.now()).toISOString();
  const since = new Date(input.since).toISOString();
  if (Date.parse(until) < Date.parse(since) || Date.parse(until)-Date.parse(since) > 86400_000) throw new Error('DIAGNOSTIC_WINDOW_REQUIRES_AT_MOST_24_HOURS');
  const nodeId = config.federation?.nodeId ?? 'local';
  if (input.node_id && input.node_id !== nodeId) throw new Error('DIAGNOSTIC_NODE_MISMATCH');
  const scope = JSON.stringify([nodeId,input.task_id,input.operation_id ?? null,input.resource_uri ?? null,since,until]);
  if (cursor && cursor.scope !== scope) throw new Error('DIAGNOSTIC_CURSOR_SCOPE_MISMATCH');
  const db = new Database(join(config.stateDir,'quaymesh.sqlite'),{readonly:true,fileMustExist:true,timeout:0});
  const entries:Entry[] = [];
  const keys = new Set<string>();
  const offer = (source:Entry['source'], time:string, identity:string, data:Row) => {
    const key = `${time}|${source}|${identity}`;
    if (time < since || time > until || cursor && key <= cursor.after || keys.has(key)) return;
    keys.add(key); entries.push({key,time,source,data});
    entries.sort((a,b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    if (entries.length > input.limit+1) keys.delete(entries.pop()!.key);
  };
  try {
    const task = db.prepare(`SELECT t.id,t.session_id,t.title,t.state,t.result_status,t.closure_reason,t.created_at,t.finished_at,
      s.conversation_id FROM qm_tasks t JOIN qm_sessions s ON s.id=t.session_id WHERE t.id=? AND s.owner_id=?`).get(input.task_id,ownerId) as Row | undefined;
    if (!task) throw new Error('TASK_NOT_FOUND_OR_FORBIDDEN');
    const operationOwnership = new Map<string,boolean>();
    const receiptOwner = db.prepare(`SELECT 1 FROM qm_invocations i INDEXED BY qm_invocations_operation
      JOIN qm_session_members m ON m.id=i.member_id AND m.session_id=i.session_id
      WHERE i.operation_id=? AND i.task_id=? AND i.session_id=? AND i.owner_id=? LIMIT 1`);
    const eventOwner = db.prepare(`SELECT 1 FROM qm_events WHERE session_id=? AND source_id=? AND task_id=?
      ${input.operation_id ? '' : "AND json_type(data_json,'$.operation_id') IS NOT 'text'"} LIMIT 1`);
    const payloadOwner = db.prepare(`SELECT 1 FROM qm_events INDEXED BY qm_events_operation_type
      WHERE json_extract(data_json,'$.operation_id')=? AND task_id=? AND session_id=? LIMIT 1`);
    const ownsOperation = (operationId:string):boolean => {
      const saved = operationOwnership.get(operationId);
      if (saved !== undefined) return saved;
      const owned = Boolean(receiptOwner.get(operationId,input.task_id,task.session_id,ownerId) ||
        (input.operation_id || operationId.startsWith('op_')) &&
        (eventOwner.get(task.session_id,operationId,input.task_id) || payloadOwner.get(operationId,input.task_id,task.session_id)));
      operationOwnership.set(operationId,owned);
      return owned;
    };
    if (input.operation_id) {
      if (!ownsOperation(input.operation_id)) throw new Error('OPERATION_NOT_IN_TASK');
    }
    const after = cursor?.after ?? '';
    const cursorTime = after.split('|',1)[0];
    const from = cursorTime > since ? cursorTime : since;
    const pageSize = input.limit+1;
    // 各来源先按索引取一页，再合并；旧操作的日志归属按需查询，避免预读整份任务历史。
    if (!input.resource_uri) {
      const receipts = db.prepare(`SELECT i.id,i.operation_id,i.tool_name,i.state,i.effect,i.created_at,i.finished_at,i.result_ref
        FROM qm_invocations i ${input.operation_id ? 'INDEXED BY qm_invocations_operation' : ''}
        JOIN qm_session_members m ON m.id=i.member_id AND m.session_id=i.session_id
        WHERE i.task_id=? AND i.session_id=? AND i.owner_id=?
          ${input.operation_id ? 'AND i.operation_id=?' : ''}
          AND coalesce(i.finished_at,i.created_at)>=? AND coalesce(i.finished_at,i.created_at)<=?
          AND coalesce(i.finished_at,i.created_at)||'|operation|receipt:'||i.id>?
        ORDER BY coalesce(i.finished_at,i.created_at),i.id LIMIT ?`).all(
          input.task_id,task.session_id,ownerId,...(input.operation_id ? [input.operation_id] : []),from,until,after,pageSize);
      for (const raw of receipts) {
        const receipt=raw as Row;
        offer('operation',String(receipt.finished_at??receipt.created_at),`receipt:${receipt.id}`,{
          event:'invocation_receipt',...select(receipt,['operation_id','tool_name','state','effect','created_at','finished_at','result_ref'])});
      }
      const eventColumns = 'sequence,event_type,data_json,created_at';
      const eventWindow = "created_at>=? AND created_at<=? AND created_at||'|operation|'||printf('%016d',sequence)>?";
      // 精确操作查询使用操作索引，避免查询优化器为省去排序而读取整个时间窗口。
      const events = input.operation_id
        ? db.prepare(`SELECT ${eventColumns} FROM qm_events INDEXED BY qm_events_operation_type
            WHERE task_id=? AND json_extract(data_json,'$.operation_id')=? AND ${eventWindow}
            UNION ALL SELECT ${eventColumns} FROM qm_events INDEXED BY qm_events_source_type WHERE task_id=? AND source_id=?
              AND json_type(data_json,'$.operation_id') IS NOT 'text' AND ${eventWindow}
            ORDER BY created_at,sequence LIMIT ?`).all(
              input.task_id,input.operation_id,from,until,after,input.task_id,input.operation_id,from,until,after,pageSize)
        : db.prepare(`SELECT ${eventColumns} FROM qm_events WHERE task_id=? AND ${eventWindow}
            ORDER BY created_at,sequence LIMIT ?`).all(input.task_id,from,until,after,pageSize);
      for (const raw of events) {
        const event = raw as {sequence:number;event_type:string;data_json:string;created_at:string};
        const payload = JSON.parse(event.data_json) as Row;
        offer('operation',event.created_at,String(event.sequence).padStart(16,'0'),{event:event.event_type,...select(payload,operationFields)});
      }
    }
    if (!input.operation_id) {
      const stages = db.prepare(`SELECT id,stage,resource_version,mount_id,observed_at FROM qm_widget_stages
        WHERE task_id=? AND observed_at>=? AND observed_at<=? AND observed_at||'|card|'||printf('%016d',id)>?
        ORDER BY observed_at,id LIMIT ?`).all(input.task_id,from,until,after,pageSize);
      for (const raw of stages) {
        const stage = raw as Row;
        offer('card',String(stage.observed_at),String(stage.id).padStart(16,'0'),select(stage,['stage','resource_version','mount_id']));
      }
    }
    await yieldToLoop(undefined,{signal});
    const ownerHash = diagnosticOwnerHash(ownerId);
    const conversationHash = typeof task.conversation_id === 'string'
      ? createHash('sha256').update(JSON.stringify(task.conversation_id)).digest('hex').slice(0,24) : null;
    const directory = join(config.stateDir,'logs');
    let files:string[];
    try { files = (await readdir(directory)).filter(name => /^server-diagnostics\.jsonl(?:\.\d{4}-\d{2}-\d{2}\.\d+)?$/.test(name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; files = []; }
    let rotatedFiles=0;
    const candidates:Array<{name:string;mtimeMs:number}>=[];
    for (const name of files) {
      try { candidates.push({name,mtimeMs:(await stat(join(directory,name))).mtimeMs}); }
      catch(error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; rotatedFiles++;}
    }
    candidates.sort((a,b) => b.mtimeMs-a.mtimeMs);
    let scannedBytes=0, malformedLines=0, filesRead=0, logsTruncated=false;
    let authenticatedIngressRecords=0, finishedExchangeRecords=0, scannedLines=0;
    for (const file of candidates) {
      if (file.mtimeMs < Date.parse(since)) continue;
      const remainingBytes = MAX_LOG_SCAN_BYTES-scannedBytes;
      if (remainingBytes <= 0) { logsTruncated=true; break; }
      // 在流上限制实际读取字节，超长单行和文件轮转都不能突破扫描预算。
      const stream = createReadStream(join(directory,file.name),{end:remainingBytes-1,signal});
      const lines = createInterface({input:stream,crlfDelay:Infinity});
      filesRead++;
      try {
        for await (const line of lines) {
          if (++scannedLines%128===0) await yieldToLoop(undefined,{signal});
          let row:Row;
          try { row = JSON.parse(line) as Row; } catch { malformedLines++; continue; }
          if (!row || typeof row !== 'object' || typeof row.ts !== 'string' || row.ts < since || row.ts > until) continue;
          if (row.tool === 'read_diagnostics') continue;
          const op = typeof row.operationId === 'string' ? row.operationId : row.sessionId;
          const authenticatedIngress = row.event === 'mcp_exchange_authenticated';
          const finishedExchange = row.event === 'mcp_exchange_finished';
          const exchange = authenticatedIngress || finishedExchange;
          const exact = (exchange ? row.ownerHash === ownerHash : typeof row.ownerHash !== 'string' || row.ownerHash === ownerHash) &&
            (input.operation_id ? op === input.operation_id : row.taskId === input.task_id || typeof op === 'string' && ownsOperation(op));
          const accountResource = !authenticatedIngress && row.method === 'resources/read' &&
            (row.ownerHash === ownerHash || row.ownerHash === undefined && conversationHash && row.conversationHash === conversationHash);
          const nodeEvent = lifecycle.has(String(row.event));
          if (input.resource_uri && row.resourceUri !== input.resource_uri || !exact && !accountResource && !nodeEvent) continue;
          if (!exchange && !String(row.event).startsWith('process_') && !nodeEvent) continue;
          if (exact && authenticatedIngress) authenticatedIngressRecords++;
          if (exact && finishedExchange) finishedExchangeRecords++;
          const data = {event:row.event,...select(row,logFields),correlation:exact ? 'task' : accountResource ? 'account_resource' : 'node',
            ...(finishedExchange ? {outcome:mcpExchangeOutcome(row)} : {})};
          offer(nodeEvent ? 'node' : 'transport',row.ts,`${row.event}|${row.requestId ?? op ?? row.pid ?? ''}`,data);
        }
      } catch(error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        rotatedFiles++;
      } finally { scannedBytes += stream.bytesRead; lines.close(); stream.destroy(); }
      if (scannedBytes >= MAX_LOG_SCAN_BYTES) { logsTruncated=true; break; }
    }
    let hasMore = entries.length > input.limit;
    if (hasMore) entries.pop();
    const result=():Row=>({node_id:nodeId,task:select(task,['id','session_id','title','state','result_status','closure_reason','created_at','finished_at']),
      since,until,events:entries.map(({key,...entry}) => entry),
      next_cursor:hasMore ? JSON.stringify({scope,until,after:entries.at(-1)!.key}) : null,
      coverage:{files_read:filesRead,scanned_bytes:scannedBytes,malformed_lines:malformedLines,logs_truncated:logsTruncated,rotated_files:rotatedFiles,
        transport_log:files.length ? 'available' : 'not_found',
        task_transport:{authenticated_ingress_records:authenticatedIngressRecords,finished_exchange_records:finishedExchangeRecords,
          evidence:authenticatedIngressRecords || finishedExchangeRecords ? 'observed' : 'not_observed_in_scan',
          completion:'not_inferred'},history_completeness:'unknown',host_acknowledgment:'unknown'}});
    let reply=result();
    while (entries.length>1 && replyBytes(reply)>REPLY_BYTES) {
      entries.pop();hasMore=true;reply=result();
    }
    return reply;
  } finally { db.close(); }
}

export function registerReadDiagnostics(server:McpRegistrationTarget, config:ServerConfig):void {
  server.registerTool('read_diagnostics',{
    title:'Read task diagnostics',
    description:'Read an authorized task’s saved events and transport/card diagnostics within at most 24 hours. node_id selects a cluster node. Authenticated ingress only proves HTTP identity/resource validation. Missing finish records do not establish execution state or non-arrival; older pre-auth starts cannot be attributed. Fixed read-only queries, no shell, SQL input, workspace locks or task progress updates. Host safety decisions and browser acknowledgments may be unavailable.',
    inputSchema:diagnosticsInputSchema,
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
  }, async (input,extra) => {
    const owner = extra.authInfo?.extra?.owner_id;
    if (typeof owner !== 'string') throw new Error('MISSING_AUTHENTICATED_OWNER');
    return jsonReply(await readDiagnostics(config,owner,input,extra.signal));
  });
}
