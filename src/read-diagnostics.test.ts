import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase} from './db/client.js';
import {SessionStore} from './session/store.js';
import {diagnosticOwnerHash} from './mcp-request-diagnostics.js';
import {readDiagnostics} from './read-diagnostics.js';
import {replyBytes,REPLY_BYTES} from './bounded-reply.js';

async function fixture() {
  const root=await mkdtemp(join(tmpdir(),'qm-diagnostic-coverage-'));
  const config={stateDir:join(root,'state')};
  const database=openDatabase(config.stateDir), store=new SessionStore(database.sqlite);
  const owner='diagnostic-owner', operationId='op_abcdef';
  const session=store.createSession(owner,'diagnostic-conversation','Diagnostic fixture');
  const member=store.addMember(session.id,'local','ws_abcdef',root,'checkout',null);
  const task=store.createTask(session.id,'Recorded diagnostic task');
  const now=Date.now(), since=new Date(now-30_000).toISOString(), until=new Date(now+30_000).toISOString();
  // 真实数据库提供操作归属；记录在查询窗口之前，避免把业务事件当成传输证据。
  store.appendEvent({session_id:session.id,task_id:task.id,member_id:member.id,type:'operation_started',
    source_id:operationId,timestamp:new Date(now-60_000).toISOString(),
    payload:{operation_id:operationId,kind:'read',status:'running',effect:'not_started'}});
  const input={task_id:task.id,since,until,limit:100};
  const directory=join(config.stateDir,'logs'), path=join(directory,'server-diagnostics.jsonl');
  const entry=(fields:Record<string,unknown>)=>({ts:new Date(now).toISOString(),method:'tools/call',tool:'workspace_context',
    ownerHash:diagnosticOwnerHash(owner),...fields});
  return {root,config,database,store,owner,operationId,task,input,directory,path,entry,
    async close(){database.close();await rm(root,{recursive:true,force:true});}};
}

test('已认证入口只按 owner 与数据库归属公开，缺少完成记录不推断运行状态', async t=>{
  const f=await fixture();t.after(()=>f.close());
  const before=f.database.sqlite.prepare('SELECT revision,state,last_activity_at FROM qm_tasks WHERE id=?').get(f.task.id);
  const missing=await readDiagnostics(f.config,f.owner,f.input);
  assert.equal((missing.coverage as any).transport_log,'not_found');
  assert.equal((missing.coverage as any).task_transport.evidence,'not_observed_in_scan');
  assert.equal((missing.coverage as any).history_completeness,'unknown');
  assert.equal((missing.coverage as any).host_acknowledgment,'unknown');
  const rows=[
    f.entry({event:'mcp_exchange_started',taskId:f.task.id,ownerHash:undefined,requestId:'pre-auth-not-public'}),
    f.entry({event:'mcp_exchange_authenticated',taskId:f.task.id,requestId:'task-ingress',authenticationMs:2,arguments:'secret-args'}),
    f.entry({event:'mcp_exchange_authenticated',operationId:f.operationId,requestId:'operation-ingress'}),
    f.entry({event:'mcp_exchange_authenticated',taskId:f.task.id,ownerHash:diagnosticOwnerHash('other-owner'),requestId:'other-owner-not-public'}),
    f.entry({event:'mcp_exchange_authenticated',taskId:f.task.id,ownerHash:undefined,requestId:'unverified-not-public'}),
    f.entry({event:'mcp_exchange_authenticated',taskId:'task_123abc',requestId:'other-task-not-public'}),
    f.entry({event:'mcp_exchange_authenticated',operationId:'op_123abc',requestId:'other-operation-not-public'}),
    f.entry({event:'mcp_exchange_authenticated',requestId:'unattributed-not-public'}),
  ];
  await mkdir(f.directory,{recursive:true});
  await writeFile(f.path,rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
  const incomplete=await readDiagnostics(f.config,f.owner,f.input);
  assert.deepEqual((incomplete.coverage as any).task_transport,{authenticated_ingress_records:2,finished_exchange_records:0,
    evidence:'observed',completion:'not_inferred'});
  assert.equal((incomplete.events as any[]).length,2);
  assert.ok((incomplete.events as any[]).every(entry=>entry.data.outcome===undefined && entry.data.state===undefined));
  assert.ok(!JSON.stringify(incomplete).includes('not-public'));
  assert.ok(!JSON.stringify(incomplete).includes('secret-'));

  rows.push(f.entry({event:'mcp_exchange_finished',operationId:f.operationId,requestId:'operation-ingress',httpStatus:200,
    resultInspection:'inspected',toolError:true,toolErrorCode:'REQUEST_TIMEOUT',effect:'unknown',retryHint:'query_original'}));
  await writeFile(f.path,rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
  const all:any[]=[];
  let cursor:string|undefined;
  do {
    const result=await readDiagnostics(f.config,f.owner,{...f.input,limit:1,cursor});
    assert.deepEqual((result.coverage as any).task_transport,{authenticated_ingress_records:2,finished_exchange_records:1,
      evidence:'observed',completion:'not_inferred'});
    all.push(...result.events as any[]);cursor=result.next_cursor as string|undefined;
  } while(cursor);
  assert.equal(all.length,3);
  assert.deepEqual(all.find(entry=>entry.data.event==='mcp_exchange_finished').data.effect,'unknown');
  assert.equal(all.find(entry=>entry.data.event==='mcp_exchange_finished').data.retryHint,'query_original');
  const byOperation=await readDiagnostics(f.config,f.owner,{...f.input,operation_id:f.operationId});
  assert.equal((byOperation.events as any[]).length,2);
  await assert.rejects(readDiagnostics(f.config,'other-owner',f.input),/TASK_NOT_FOUND_OR_FORBIDDEN/);
  await assert.rejects(readDiagnostics(f.config,f.owner,{...f.input,operation_id:'op_123abc'}),/OPERATION_NOT_IN_TASK/);
  assert.deepEqual(f.database.sqlite.prepare('SELECT revision,state,last_activity_at FROM qm_tasks WHERE id=?').get(f.task.id),before);
});

test('入口诊断保留真实 32 MiB 扫描预算、回复上限与不完整覆盖说明', async t=>{
  const f=await fixture();t.after(()=>f.close());
  const first=f.entry({event:'mcp_exchange_authenticated',taskId:f.task.id,requestId:'within-budget'});
  const later=f.entry({event:'mcp_exchange_finished',taskId:f.task.id,requestId:'outside-budget',httpStatus:200,resultInspection:'inspected'});
  await mkdir(f.directory,{recursive:true});
  const scanLimit=32*1024*1024;
  await writeFile(f.path,JSON.stringify(first)+'\n'+JSON.stringify({padding:'x'.repeat(scanLimit)})+'\n'+JSON.stringify(later)+'\n');
  const boundedScan=await readDiagnostics(f.config,f.owner,f.input);
  assert.equal((boundedScan.coverage as any).scanned_bytes,scanLimit);
  assert.equal((boundedScan.coverage as any).logs_truncated,true);
  assert.equal((boundedScan.coverage as any).task_transport.authenticated_ingress_records,1);
  assert.equal((boundedScan.coverage as any).task_transport.finished_exchange_records,0);
  assert.equal((boundedScan.coverage as any).task_transport.completion,'not_inferred');
  assert.equal((boundedScan.coverage as any).history_completeness,'unknown');
  assert.ok(!JSON.stringify(boundedScan).includes('outside-budget'));
  const many=Array.from({length:100},(_,index)=>({...first,requestId:String(index).padStart(3,'0')+'x'.repeat(500)}));
  await writeFile(f.path,many.map(row=>JSON.stringify(row)).join('\n')+'\n');
  const boundedReply=await readDiagnostics(f.config,f.owner,f.input);
  assert.ok(replyBytes(boundedReply)<=REPLY_BYTES);
  assert.ok(boundedReply.next_cursor);
  assert.ok((boundedReply.events as unknown[]).length>0);
  assert.equal((boundedReply.coverage as any).task_transport.authenticated_ingress_records,100);
});
