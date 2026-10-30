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
  return {root,config,database,store,owner,operationId,session,member,task,input,directory,path,entry,
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

test('仅入口回执存在时诊断仍可按原任务查询，并严格校验会话与成员归属',async t=>{
  const f=await fixture();t.after(()=>f.close());
  const operationId='op_aa1122';
  f.store.reserveInvocation({id:'receipt-only',ownerId:f.owner,transportInstanceId:'entry',requestId:'1',
    sessionId:f.session.id,memberId:f.member.id,taskId:f.task.id,toolName:'apply_patch',operationId,
    argumentsJson:JSON.stringify({patch:'secret-patch-body'})});
  f.store.updateInvocation({ownerId:f.owner,transportInstanceId:'entry',requestId:'1',state:'unknown' as any,effect:'unknown',
    result:{kind:'error',errorCode:'RPC_INTERRUPTED',message:'secret-response-body'},finished:true});
  assert.equal(f.store.findOperationEvent(operationId),null);
  await mkdir(f.directory,{recursive:true});
  await writeFile(f.path,JSON.stringify(f.entry({event:'mcp_exchange_finished',operationId,requestId:'receipt-trace',
    httpStatus:200,resultInspection:'inspected',toolError:true,toolErrorCode:'INVALID_ARGUMENT',
    recoveryTextErrorCode:'RPC_INTERRUPTED',errorCodeConsistent:false}))+'\n');
  const result=await readDiagnostics(f.config,f.owner,{...f.input,operation_id:operationId});
  const events=result.events as any[];
  assert.equal(events.find(row=>row.data.event==='invocation_receipt')?.data.effect,'unknown');
  const exchange=events.find(row=>row.data.event==='mcp_exchange_finished').data;
  assert.equal(exchange.requestId,'receipt-trace');assert.equal(exchange.errorCodeConsistent,false);
  assert.equal(exchange.recoveryTextErrorCode,'RPC_INTERRUPTED');
  assert.ok(!JSON.stringify(result).includes('secret-'));
  const otherSession=f.store.createSession(f.owner,'other-conversation','Other scope');
  const otherMember=f.store.addMember(otherSession.id,'remote','ws_other',f.root,'checkout',null);
  const otherTask=f.store.createTask(otherSession.id,'Other task');
  await assert.rejects(readDiagnostics(f.config,f.owner,{...f.input,task_id:otherTask.id,operation_id:operationId}),/OPERATION_NOT_IN_TASK/);
  f.database.sqlite.prepare('UPDATE qm_invocations SET member_id=? WHERE id=?').run(otherMember.id,'receipt-only');
  await assert.rejects(readDiagnostics(f.config,f.owner,{...f.input,operation_id:operationId}),/OPERATION_NOT_IN_TASK/);
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

test('诊断按时间索引读取一页，跨来源同时间分页不漏项并保留旧操作日志归属',async t=>{
  const f=await fixture();t.after(()=>f.close());
  const at=f.entry({}).ts;
  const insert=f.database.sqlite.prepare(`INSERT INTO qm_events
    (session_id,task_id,member_id,source_id,event_type,data_json,created_at) VALUES (?,?,?,?,?,?,?)`);
  f.database.sqlite.transaction(()=>{
    for(let i=0;i<100;i++)insert.run(f.session.id,f.task.id,f.member.id,`op_old_${i}`,'operation_finished',
      JSON.stringify({operation_id:`op_old_${i}`,diagnostic_history_fixture:'old',padding:'x'.repeat(4096)}),
      new Date(Date.parse(f.input.since)-60_000).toISOString());
    for(let i=0;i<5;i++)insert.run(f.session.id,f.task.id,f.member.id,`op_page_${i}`,'operation_finished',
      JSON.stringify({operation_id:`op_page_${i}`,diagnostic_history_fixture:'current'}),at);
  })();
  f.store.reserveInvocation({id:'page-receipt',ownerId:f.owner,transportInstanceId:'page-entry',requestId:'1',
    sessionId:f.session.id,memberId:f.member.id,taskId:f.task.id,toolName:'read',operationId:'op_page_receipt',argumentsJson:'{}'});
  f.database.sqlite.prepare('UPDATE qm_invocations SET created_at=? WHERE id=?').run(at,'page-receipt');
  f.database.sqlite.prepare(`INSERT INTO qm_widget_stages(task_id,session_id,stage,resource_version,mount_id,observed_at)
    VALUES (?,?,'visible','test-resource','page-mount',?)`).run(f.task.id,f.session.id,at);
  await mkdir(f.directory,{recursive:true});
  await writeFile(f.path,JSON.stringify(f.entry({event:'mcp_exchange_authenticated',operationId:f.operationId,requestId:'old-operation-log'}))+'\n');
  const expected=await readDiagnostics(f.config,f.owner,f.input);
  assert.equal((expected.events as any[]).length,8);
  const originalParse=JSON.parse;
  let historicalPayloads=0,pagePayloads=0;
  t.mock.method(JSON,'parse',(text:string,reviver?:Parameters<typeof JSON.parse>[1])=>{
    if(text.includes('"diagnostic_history_fixture":"old"'))historicalPayloads++;
    if(text.includes('"diagnostic_history_fixture":"current"'))pagePayloads++;
    return originalParse(text,reviver);
  });
  const actual:any[]=[];
  let cursor:string|undefined;
  do {
    pagePayloads=0;
    const page=await readDiagnostics(f.config,f.owner,{...f.input,limit:2,cursor});
    assert.equal(historicalPayloads,0,'窗口外历史正文不应载入并解析');
    assert.ok(pagePayloads<=3,'每次最多解析当前页及一个后续事件');
    actual.push(...page.events as any[]);
    cursor=page.next_cursor as string|undefined;
  } while(cursor);
  assert.deepEqual(actual,expected.events);
  const plans=[
    f.database.sqlite.prepare(`EXPLAIN QUERY PLAN SELECT sequence FROM qm_events
      WHERE task_id=? AND created_at>=? AND created_at<=? ORDER BY created_at,sequence LIMIT 3`).all(f.task.id,f.input.since,f.input.until),
    f.database.sqlite.prepare(`EXPLAIN QUERY PLAN SELECT id FROM qm_invocations
      WHERE task_id=? AND coalesce(finished_at,created_at)>=? AND coalesce(finished_at,created_at)<=?
      ORDER BY coalesce(finished_at,created_at),id LIMIT 3`).all(f.task.id,f.input.since,f.input.until),
    f.database.sqlite.prepare(`EXPLAIN QUERY PLAN SELECT id FROM qm_invocations
      WHERE state IN ('accepted','queued','running')`).all(),
  ];
  assert.match(JSON.stringify(plans[0]),/qm_events_task_diagnostic_time/);
  assert.match(JSON.stringify(plans[1]),/qm_invocations_task_diagnostic_time/);
  assert.match(JSON.stringify(plans[2]),/qm_invocations_pending_state/);
});

test('按操作查询使用正文操作ID，并保留缺失或非文本操作ID的source归属',async t=>{
  const f=await fixture();t.after(()=>f.close());
  const at=f.entry({}).ts, operationId='op_union_page';
  const rows=[
    {source_id:'other-source',payload:{operation_id:operationId}},
    {source_id:operationId,payload:{operation_id:123}},
    {source_id:operationId,payload:{operation_id:'op_different'}},
  ];
  rows.forEach((row,index)=>f.store.appendEvent({session_id:f.session.id,task_id:f.task.id,member_id:f.member.id,
    source_id:row.source_id,type:`diagnostic_fixture_${index}` as any,timestamp:at,payload:row.payload}));
  const result=await readDiagnostics(f.config,f.owner,{...f.input,operation_id:operationId});
  assert.deepEqual((result.events as any[]).map(row=>row.data.event),['diagnostic_fixture_0','diagnostic_fixture_1']);
});

test('诊断数据库被独占时立即返回忙错误，不占住Core等待五秒',async t=>{
  const f=await fixture();t.after(()=>f.close());
  f.database.sqlite.pragma('journal_mode = DELETE');
  f.database.sqlite.exec('BEGIN EXCLUSIVE');
  const started=performance.now();
  try {
    await assert.rejects(readDiagnostics(f.config,f.owner,f.input),{code:'SQLITE_BUSY'});
    assert.ok(performance.now()-started<500);
  } finally {f.database.sqlite.exec('ROLLBACK');}
});

test('日志扫描中取消请求会结束读取并释放诊断连接',async t=>{
  const f=await fixture();t.after(()=>f.close());
  await mkdir(f.directory,{recursive:true});
  const rows=Array.from({length:1000},(_,index)=>f.entry({event:'mcp_exchange_authenticated',taskId:f.task.id,
    requestId:`cancel-scan-${index}`}));
  await writeFile(f.path,rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
  const controller=new AbortController(), originalParse=JSON.parse;
  t.mock.method(JSON,'parse',(text:string,reviver?:Parameters<typeof JSON.parse>[1])=>{
    if(text.includes('"requestId":"cancel-scan-200"'))controller.abort();
    return originalParse(text,reviver);
  });
  await assert.rejects(readDiagnostics(f.config,f.owner,f.input,controller.signal),{name:'AbortError'});
  // 取消完成后数据库连接已关闭，可以正常切换日志模式。
  assert.equal(f.database.sqlite.pragma('journal_mode = DELETE',{simple:true}),'delete');
});
