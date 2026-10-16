import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {createRealTestServer} from './session-card/server-fixture.js';
import {readDiagnostics} from '../src/read-diagnostics.js';
import {diagnosticOwnerHash} from '../src/mcp-request-diagnostics.js';
import {twoNodes} from './tool-contract/fixture.js';
import {replyBytes,REPLY_BYTES} from '../src/bounded-reply.js';

test('诊断读取通过真实 MCP，不启动命令、不写运行记录、不改变任务进展', async t => {
  const f = await createRealTestServer({git:false});
  let db:Database.Database|undefined;
  t.after(async () => {db?.close();await f.dispose();});
  const meta = {'openai/session':randomUUID()};
  const started = await f.client.callTool({name:'start_session',arguments:{title:'只读诊断',request_key:randomUUID()},_meta:meta});
  const taskId = (started.structuredContent as {task_id:string}).task_id;
  db = new Database(join(f.config.stateDir,'quaymesh.sqlite'),{readonly:true});
  const before = () => ({task:db!.prepare('SELECT * FROM qm_tasks WHERE id=?').get(taskId),
    calls:db!.prepare('SELECT count(*) n FROM qm_invocations').get(),runs:db!.prepare('SELECT count(*) n FROM console_work_runs').get()});
  const saved = before();
  for (let index=0; index<3; index++) {
    const response = await f.client.callTool({name:'read_diagnostics',arguments:{task_id:taskId,since:new Date(Date.now()-60_000).toISOString()},_meta:meta});
    assert.notEqual(response.isError,true,JSON.stringify(response));
    assert.equal((response.structuredContent as any).task.id,taskId);
    assert.equal((response.structuredContent as any).coverage.host_acknowledgment,'unknown');
  }
  assert.deepEqual(before(),saved);
  const rejected = await f.client.callTool({name:'read_diagnostics',arguments:{task_id:taskId,since:new Date().toISOString(),sql:'DELETE FROM qm_tasks'},_meta:meta});
  assert.equal(rejected.isError,true);
  assert.deepEqual(before(),saved);
});

test('按任务授权、分层错误、分页及隐私字段白名单', async t => {
  const f = await createRealTestServer({git:false});
  t.after(() => f.dispose());
  const started = await f.client.callTool({name:'start_session',arguments:{title:'传输诊断分页',request_key:randomUUID()},_meta:{'openai/session':randomUUID()}});
  const taskId = (started.structuredContent as {task_id:string}).task_id;
  const db = new Database(join(f.config.stateDir,'quaymesh.sqlite'),{readonly:true});
  const row = db.prepare('SELECT s.owner_id FROM qm_tasks t JOIN qm_sessions s ON s.id=t.session_id WHERE t.id=?').get(taskId) as {owner_id:string};
  db.close();
  const since='2026-10-15T15:30:00.000Z', until='2026-10-15T16:30:00.000Z';
  const ownerHash=diagnosticOwnerHash(row.owner_id);
  const entries=[
    {ts:'2026-10-15T15:31:00.000Z',event:'mcp_exchange_finished',taskId,ownerHash,requestId:'one',httpStatus:200,rpcErrorCode:-32602,toolError:false,resultInspection:'inspected',arguments:'secret-args'},
    {ts:'2026-10-15T15:32:00.000Z',event:'mcp_exchange_finished',taskId,ownerHash,requestId:'two',httpStatus:200,toolError:true,resultInspection:'inspected',message:'secret-body'},
    {ts:'2026-10-15T15:33:00.000Z',event:'mcp_exchange_finished',taskId,ownerHash,requestId:'three',httpStatus:200,resultInspection:'over_limit',headers:'secret-cookie'},
    {ts:'2026-10-15T15:34:00.000Z',event:'mcp_exchange_finished',taskId,ownerHash,requestId:'four',httpStatus:200,resultInspection:'inspected',aborted:true},
    {ts:'2026-10-15T15:35:00.000Z',event:'mcp_exchange_finished',ownerHash,requestId:'five',method:'resources/read',resourceUri:'ui://quaymesh/task-card/v4.html',httpStatus:200,rpcErrorCode:-32602,resultInspection:'inspected'},
    {ts:'2026-10-15T15:36:00.000Z',event:'mcp_exchange_finished',taskId,ownerHash:diagnosticOwnerHash('another-owner'),requestId:'must-not-leak',httpStatus:200,resultInspection:'inspected'},
  ];
  await mkdir(join(f.config.stateDir,'logs'),{recursive:true});
  await writeFile(join(f.config.stateDir,'logs/server-diagnostics.jsonl'),'{truncated\n'+entries.map(entry=>JSON.stringify(entry)).join('\n')+'\n');
  const input={task_id:taskId,since,until,limit:2};
  await assert.rejects(readDiagnostics(f.config,'another-owner',input),/TASK_NOT_FOUND_OR_FORBIDDEN/);
  await assert.rejects(readDiagnostics(f.config,row.owner_id,{...input,operation_id:'op_not_in_task'}),/OPERATION_NOT_IN_TASK/);
  const all:any[]=[];
  let cursor:string|undefined;
  do {
    const result=await readDiagnostics(f.config,row.owner_id,{...input,cursor});
    assert.equal((result.coverage as any).malformed_lines,1);
    assert.ok(!JSON.stringify(result).includes('secret-'));
    all.push(...result.events as any[]);
    cursor=result.next_cursor as string|undefined;
    if(cursor) await assert.rejects(readDiagnostics(f.config,row.owner_id,{...input,cursor,since:'2026-10-15T15:00:00.000Z'}),/CURSOR_SCOPE_MISMATCH/);
  } while(cursor);
  assert.deepEqual(all.map(entry=>entry.data.outcome),['protocol_error','tool_error','uninspected','transport_error','protocol_error']);
  assert.equal(all.at(-1).data.correlation,'account_resource');
  assert.ok(!JSON.stringify(all).includes('must-not-leak'));
  const large=Array.from({length:100},(_,index)=>({...entries[0],requestId:String(index).padStart(3,'0')+'x'.repeat(500),
    resourceUri:'ui://quaymesh/'+'r'.repeat(500),toolErrorCode:'e'.repeat(500)}));
  await writeFile(join(f.config.stateDir,'logs/server-diagnostics.jsonl'),large.map(entry=>JSON.stringify(entry)).join('\n'));
  const bounded=await readDiagnostics(f.config,row.owner_id,{...input,limit:100});
  assert.ok(replyBytes(bounded)<=REPLY_BYTES);
  assert.ok(bounded.next_cursor);
  assert.ok((bounded.events as unknown[]).length>0);
});

test('长命令持有项目资源时，读取诊断仍可立即完成', async t => {
  const f=await createRealTestServer({git:false,configure:async config=>({...config,dangerouslySkipCommandReview:true})});
  const meta={'openai/session':randomUUID()};
  let workspaceId:string|undefined,operationId:string|undefined;
  t.after(async()=>{
    try {if(operationId) await f.client.callTool({name:'cancel_command',arguments:{workspace_id:workspaceId,operation_id:operationId},_meta:meta});}
    finally {await f.dispose();}
  });
  const started=await f.client.callTool({name:'start_session',arguments:{title:'并行只读',request_key:randomUUID()},_meta:meta});
  const opened=await f.client.callTool({name:'open_workspace',arguments:{path:f.project},_meta:meta});
  workspaceId=(opened.structuredContent as any).workspace_id;
  const command=await f.client.callTool({name:'exec_command',arguments:{workspace_id:workspaceId,cmd:'node -e "setTimeout(()=>{},60000)"',yield_time_ms:100},_meta:meta});
  assert.notEqual(command.isError,true,JSON.stringify(command));
  operationId=(command.structuredContent as any).operation_id;
  const response=await f.client.callTool({name:'read_diagnostics',arguments:{task_id:(started.structuredContent as any).task_id,operation_id:operationId,since:new Date(Date.now()-60_000).toISOString()},_meta:meta});
  assert.notEqual(response.isError,true,JSON.stringify(response));
  assert.ok((response.structuredContent as any).events.length>0);
});

test('禁执行的 Cloud 入口可读取本地和远端已授权诊断，不创建新运行', async t => {
  const {worker,cloud}=await twoNodes(t);
  assert.equal(cloud.config.federation?.capabilities.worker,false);
  const meta={'openai/session':randomUUID()};
  const call=(name:string,args:Record<string,unknown>)=>cloud.client.callTool({name,arguments:args,_meta:meta});
  const started=await call('start_session',{title:'远程诊断',request_key:randomUUID()});
  const taskId=(started.structuredContent as any).task_id;
  const opened=await call('open_workspace',{root_id:'worker/main'});
  assert.notEqual(opened.isError,true,JSON.stringify(opened));
  const input={task_id:taskId,since:new Date(Date.now()-60_000).toISOString()};
  const counts=()=>[worker,cloud].map(server=>{
    const db=new Database(join(server.config.stateDir,'quaymesh.sqlite'),{readonly:true});
    // 联邦成员同步会推进副本版本；观察操作不得制造执行活动或新运行。
    try {return {task:db.prepare('SELECT last_activity_at FROM qm_tasks WHERE id=?').get(taskId),
      invocations:db.prepare('SELECT count(*) n FROM qm_invocations').get(),runs:db.prepare('SELECT count(*) n FROM console_work_runs').get()};}
    finally {db.close();}
  });
  const before=counts();
  for(const node of ['cloud','worker']) {
    const result=await call('read_diagnostics',{...input,node_id:node});
    assert.notEqual(result.isError,true,JSON.stringify(result));
    assert.equal((result.structuredContent as any).node_id,node);
    assert.equal((result.structuredContent as any).task.id,taskId);
  }
  assert.deepEqual(counts(),before);
});
