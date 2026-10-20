import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash,randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Server} from 'node:http';
import Database from 'better-sqlite3';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createRealTestServer} from './session-card/server-fixture.js';
import {readDiagnostics} from '../src/read-diagnostics.js';
import {diagnosticOwnerHash} from '../src/mcp-request-diagnostics.js';
import {twoNodes,until} from './tool-contract/fixture.js';
import {replyBytes,REPLY_BYTES} from '../src/bounded-reply.js';
import {loadConfig} from '../src/config.js';
import {createServer} from '../src/server.js';
import {SqliteOAuthStore} from '../src/oauth-store.js';
import {ServerDiagnostics} from '../src/server-diagnostics.js';
import {writeTestQuayMeshConfig} from '../src/test-support/config.test.js';

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
  let row:{owner_id:string};
  try {row = db.prepare('SELECT s.owner_id FROM qm_tasks t JOIN qm_sessions s ON s.id=t.session_id WHERE t.id=?').get(taskId) as {owner_id:string};}
  finally {db.close();}
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

test('真实 OAuth、HTTP 和 SQLite 诊断显示已认证入口，等待输出期间不推断完成或执行状态', {timeout:45_000}, async t=>{
  const root=await mkdtemp(join(tmpdir(),'qm-diagnostic-ingress-')), project=join(root,'project');
  const release=join(project,'release.txt');
  const client=new Client({name:'diagnostic-ingress-test',version:'1'});
  let running:ReturnType<typeof createServer>|undefined, listener:Server|undefined, diagnostics:ServerDiagnostics|undefined;
  let observer:ReturnType<Client['callTool']>|undefined;
  t.after(async()=>{
    try {
      try {await writeFile(release,'release\n');}
      finally {
        try {await client.close();}
        finally {
          if(listener) {
            listener.closeAllConnections();
            if(listener.listening) await new Promise<void>((resolve,reject)=>listener!.close(error=>error?reject(error):resolve()));
          }
        }
      }
    } finally {
      await Promise.allSettled(observer?[observer]:[]);
      try {await running?.close();}
      finally {diagnostics?.dispose();await rm(root,{recursive:true,force:true});}
    }
  });
  await mkdir(project);
  const loaded=loadConfig(writeTestQuayMeshConfig(join(root,'config'),{
    server:{publicBaseUrl:'https://diagnostics.example.invalid'},
    storage:{stateDir:join(root,'state')},workspaces:{allowedRoots:[project]},
    logging:{level:'info',requests:true,assets:false,toolCalls:false},
  }));
  const config={...loaded,subagents:{...loaded.subagents,enabled:false,providers:[]}};
  const token='diagnostic-valid-token', wrongResourceToken='diagnostic-wrong-resource-token';
  const tokens=new SqliteOAuthStore(config.stateDir);
  try {
    const registered=tokens.registerClient({redirect_uris:['http://127.0.0.1/callback']},config.oauth.allowedRedirectHosts);
    for(const [value,resource] of [[token,'https://diagnostics.example.invalid/mcp'],[wrongResourceToken,'https://other.example.invalid/mcp']]) {
      tokens.saveAccessToken(createHash('sha256').update(value).digest('base64url'),{
        clientId:registered.client_id,scopes:['quaymesh'],expiresAt:Math.floor(Date.now()/1000)+3600,resource,
      });
    }
  } finally {tokens.close();}
  diagnostics=new ServerDiagnostics(config);
  running=createServer(config,{diagnostics,incomingArtifactAdapters:[]});
  await running.ready;
  listener=running.app.listen(0,'127.0.0.1');await once(listener,'listening');
  const address=listener.address();assert.ok(address && typeof address!=='string');
  const url=new URL(`http://127.0.0.1:${address.port}/mcp`);
  await client.connect(new StreamableHTTPClientTransport(url,{requestInit:{headers:{authorization:`Bearer ${token}`}}}));
  await client.listTools();
  const meta={'openai/session':randomUUID()};
  const raw=(name:string,args:Record<string,unknown>)=>client.callTool({name,arguments:args,_meta:meta});
  const call=async(name:string,args:Record<string,unknown>)=>{
    const response=await raw(name,args);assert.notEqual(response.isError,true,JSON.stringify(response));
    return response.structuredContent as Record<string,any>;
  };
  const task=await call('start_session',{title:'真实入口诊断',request_key:randomUUID()});
  const readLogs=async()=> (await readFile(join(config.stateDir,'logs','server-diagnostics.jsonl'),'utf8'))
    .split('\n').filter(Boolean).map(line=>JSON.parse(line) as Record<string,any>);
  // 两种真实鉴权拒绝仍有原始入口记录，但不能产生已认证入口事件。
  for(const rejectedToken of ['diagnostic-unknown-token',wrongResourceToken]) {
    const response=await fetch(url,{method:'POST',headers:{authorization:`Bearer ${rejectedToken}`,'content-type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'finish_task',
        arguments:{task_id:task.task_id,status:'completed',summary:'must-not-finish'},_meta:meta}}),signal:AbortSignal.timeout(5000)});
    assert.equal(response.status,401,await response.text());
  }
  const denied=await readLogs();
  const rejectedRequests=denied.filter(row=>row.event==='mcp_exchange_started' && row.tool==='finish_task');
  assert.equal(rejectedRequests.length,2);
  assert.ok(rejectedRequests.every(request=>!denied.some(row=>row.requestId===request.requestId && row.event==='mcp_exchange_authenticated')));

  const opened=await call('open_workspace',{path:project}), workspace_id=opened.workspace_id;
  const script=join(project,'wait-for-release.mjs');
  await writeFile(script,"import {existsSync} from 'node:fs';\nconst timer=setInterval(()=>{if(existsSync('release.txt')){clearInterval(timer);console.log('diagnostic output released');}},20);\nsetTimeout(()=>{clearInterval(timer);process.exitCode=1;},20000).unref();\n");
  const receipt=await call('exec_command',{workspace_id,cmd:`"${process.execPath}" "${script}"`,tty:false,yield_time_ms:100,operation_key:randomUUID()});
  const operation_id=receipt.operation_id;assert.equal(typeof operation_id,'string');
  await until(async()=>{
    const output=await call('read_output',{workspace_id,operation_id,cursor:0});
    return output.operation_state==='running' && !output.process_done;
  });
  const beforeObserver=(await readLogs()).length;
  observer=raw('read_output',{workspace_id,operation_id,cursor:0,wait_ms:10000});
  void observer.catch(()=>{});
  let ingress:Record<string,any>|undefined;
  await until(async()=>{
    ingress=(await readLogs()).slice(beforeObserver).find(row=>row.event==='mcp_exchange_authenticated' && row.tool==='read_output' && row.operationId===operation_id);
    return Boolean(ingress);
  });
  const input={task_id:task.task_id,operation_id,since:new Date(Date.now()-60_000).toISOString(),limit:100};
  const waiting=await call('read_diagnostics',input);
  const visible=waiting.events.find((entry:any)=>entry.data.requestId===ingress!.requestId);
  assert.equal(visible.data.event,'mcp_exchange_authenticated');
  assert.equal(visible.data.operationId,operation_id);
  assert.equal(visible.data.outcome,undefined);
  assert.ok(!waiting.events.some((entry:any)=>entry.data.requestId===ingress!.requestId && entry.data.event==='mcp_exchange_finished'));
  assert.equal(waiting.coverage.task_transport.completion,'not_inferred');
  assert.equal(waiting.coverage.history_completeness,'unknown');
  assert.equal(waiting.coverage.host_acknowledgment,'unknown');
  await writeFile(release,'release\n');
  const observed=await observer;assert.notEqual(observed.isError,true,JSON.stringify(observed));
  assert.match((observed.structuredContent as any).result,/diagnostic output released/);
  await until(async()=> (await readLogs()).some(row=>row.requestId===ingress!.requestId && row.event==='mcp_exchange_finished'));
  const finished=await call('read_diagnostics',input);
  assert.ok(finished.events.some((entry:any)=>entry.data.requestId===ingress!.requestId && entry.data.event==='mcp_exchange_finished' && entry.data.outcome==='success'));
  assert.ok(!JSON.stringify(await readLogs()).includes(token));
});
