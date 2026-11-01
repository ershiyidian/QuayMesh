import assert from 'node:assert/strict';
import test, {type TestContext} from 'node:test';
import {createServer as createHttpServer, type ServerResponse} from 'node:http';
import {once} from 'node:events';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import express from 'express';
import {createRealTestServer,structured,waitForRecordedTool} from '../session-card/server-fixture.js';
import {createProjectConsoleRouter} from '../../src/project-console-router.js';
import {readLocalRunSummaries,readLocalSessionTitles,readLocalTaskIndex,readLocalTaskStateIndex} from '../../src/console-workbench/local-queries.js';
import {parseTaskReadScopeQuery} from '../../src/console-workbench/task-read-scope.js';
import {WorkbenchFeed} from '../../src/console-workbench/feed.js';
import {openDatabase} from '../../src/db/client.js';
import {SessionStore} from '../../src/session/store.js';
import {parseWorkspaceHandle,workspaceHandle} from '../../src/federation/routing.js';
import {mapConcurrent} from '../../src/concurrency.js';
import type {FederationRuntime} from '../../src/federation/runtime.js';
import type {ServerConfig} from '../../src/config.js';

/** Real MCP writes and SQLite projections, read through a deliberately slow HTTP peer. */
async function fixture(t:TestContext) {
  const server=await createRealTestServer({git:false,uiEnabled:true});
  t.after(()=>server.dispose());
  const meta={'openai/session':'detail-read-budget'};
  const call=async(name:string,args:Record<string,unknown>)=>{
    const result=await server.client.callTool({name,arguments:args,_meta:meta});
    assert.notEqual(result.isError,true,JSON.stringify(result.content));return structured(result);
  };
  const task=await call('start_session',{title:'真实详情慢源测试',request_key:'detail-budget'});
  const first=await call('open_workspace',{path:server.project});
  const second=await call('attach_workspace',{session_id:task.session_id,path:server.secondRoot});
  for(const [workspace,path] of [[first,'first.txt'],[second,'second.txt']] as const){
    const result=await server.client.callTool({name:'apply_patch',arguments:{workspace_id:workspace.workspace_id,
      patch:`*** Begin Patch\n*** Add File: ${path}\n+actual saved detail\n*** End Patch`},_meta:meta});
    assert.notEqual(result.isError,true,JSON.stringify(result.content));
    await waitForRecordedTool(server,{sessionId:String(task.session_id),workspaceId:String(workspace.workspace_id),
      conversationId:meta['openai/session'],paths:[path]},result);
  }
  const phases=readLocalTaskIndex(server.config).items.filter(value=>value.taskId===task.task_id);
  assert.equal(phases.length,2,'both phases come from real recorded workspace changes');
  assert.ok(phases.every(value=>value.currentPhase),'both workspace phases must remain current');
  const slow=phases.find(value=>value.root===server.secondRoot)!;
  assert.ok(slow);
  const ownerNode=slow.nodeId;
  const login=async(baseUrl:string)=>{
    const response=await fetch(baseUrl+'/console/api/login',{method:'POST',headers:{origin:baseUrl,'content-type':'application/json'},
      body:JSON.stringify({password:server.config.oauth.ownerToken})});
    assert.equal(response.status,200,await response.clone().text());
    return response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
  };
  const ownerCookie=await login(server.baseUrl);
  const readOwnerDetail=async(reference:string)=>{
    const response=await fetch(server.baseUrl+'/console/api/v4/runs/'+encodeURIComponent(reference)+'?fresh=1',
      {headers:{cookie:ownerCookie},signal:AbortSignal.timeout(3000)});
    assert.equal(response.status,200,await response.clone().text());return await response.json() as any;
  };
  // Tool recording and change capture settle separately. Wait for the actual
  // collector's two idle snapshots before introducing any network delay.
  const captureDeadline=Date.now()+10_000;
  let settled=false,last:any[]=[];
  while(Date.now()<captureDeadline){
    last=await Promise.all(phases.map(phase=>readOwnerDetail(phase.id)));
    settled=last.every(detail=>detail.run.currentPhase&&detail.changeCaptures.length>0
      &&detail.changeCaptures.every((capture:any)=>capture.state==='idle'))
      &&last.flatMap(detail=>detail.files.map((file:any)=>file.path)).sort().join(',')==='first.txt,second.txt';
    if(settled)break;
    await delay(25);
  }
  assert.ok(settled,JSON.stringify(last.map(detail=>({root:detail.run.root,files:detail.files,captures:detail.changeCaptures}))));
  const database=openDatabase(server.config.stateDir),store=new SessionStore(database.sqlite);
  const held=new Set<string>(),failed=new Set<string>(),invalid=new Set<string>();
  const requests:string[]=[];
  const counts=new Map<string,number>(),waiting=new Map<string,Array<{response:ServerResponse;body:unknown}>>();
  const send=(response:ServerResponse,body:unknown,status=200)=>{
    if(response.destroyed)return;
    response.writeHead(status,{'content-type':'application/json'});response.end(JSON.stringify(body));
  };
  const release=(path:string)=>{
    held.delete(path);
    for(const item of waiting.get(path)??[])send(item.response,item.body);
    waiting.delete(path);
  };
  const peer=createHttpServer((request,response)=>{void(async()=>{
    const url=new URL(request.url!,'http://127.0.0.1'),path=url.pathname.replace('/isolated-v1','');
    requests.push(request.url!);
    counts.set(path,(counts.get(path)??0)+1);
    if(failed.has(path)){send(response,{message:'peer detail read failed',code:'peer_read_failed'},503);return;}
    let body:unknown;
    if(path==='/workbench/task-index')body=readLocalTaskIndex(server.config);
    else if(path==='/workbench/session-titles')body=readLocalSessionTitles(server.config);
    else if(path==='/workbench/task-state-index')body=readLocalTaskStateIndex(server.config);
    else if(path==='/workbench/task-index-scoped')body=readLocalTaskIndex(server.config,undefined,parseTaskReadScopeQuery(Object.fromEntries(url.searchParams)));
    else if(path==='/workbench/session-titles-scoped')body=readLocalSessionTitles(server.config,parseTaskReadScopeQuery(Object.fromEntries(url.searchParams)));
    else if(path==='/workbench/run-summaries')body=readLocalRunSummaries(server.config,(url.searchParams.get('ids')??'').split(',').filter(Boolean));
    else if(path===`/workbench/tasks/${task.task_id}/messages-state`){
      body={available:true,ownerNodeId:ownerNode,observedAt:Date.now(),...store.taskMessageState(String(task.task_id))};
      if(invalid.has(path))delete (body as {pending?:number}).pending;
    }else if(path.startsWith('/workbench/runs/')){
      const local=decodeURIComponent(path.slice('/workbench/runs/'.length));
      body=await readOwnerDetail(workspaceHandle(ownerNode,local));
    }else throw new Error('Unexpected peer path: '+path);
    if(held.has(path)){
      const items=waiting.get(path)??[];items.push({response,body});waiting.set(path,items);
    }else send(response,body);
  })().catch(error=>send(response,{message:String(error)},500));});
  peer.listen(0,'127.0.0.1');await once(peer,'listening');
  const peerAddress=peer.address();assert.ok(peerAddress&&typeof peerAddress==='object');
  const runtime={nodes:()=>[{id:ownerNode,nickname:'Slow HTTP owner',online:true}],status:()=>({events:[]}),
    request:async(_node:string,method:string,args:{method:string;path:string},timeout:number)=>{
      assert.equal(method,'console');assert.equal(args.method,'GET');assert.equal(timeout,30_000);
      const response=await fetch(`http://127.0.0.1:${peerAddress.port}${args.path}`,{signal:AbortSignal.timeout(timeout)});
      return {status:response.status,body:await response.json()};
    }} as unknown as FederationRuntime;
  const config={...server.config,stateDir:join(server.root,'reader-state'),federation:{...server.config.federation,
    enabled:true,nodeId:'detail-reader',coordinatorId:ownerNode,
    capabilities:{...server.config.federation?.capabilities,coordinator:false}}} as ServerConfig;
  const console=createProjectConsoleRouter(config,{assetDirectory:join(server.root,'unused-assets'),federation:runtime});
  const app=express();app.use(express.json());app.use('/console',console.router);
  const http=app.listen(0,'127.0.0.1');await once(http,'listening');
  const address=http.address();assert.ok(address&&typeof address==='object');
  const baseUrl=`http://127.0.0.1:${address.port}`,cookie=await login(baseUrl);
  t.after(async()=>{
    for(const path of waiting.keys())release(path);
    peer.closeAllConnections();http.closeAllConnections();
    await Promise.all([new Promise<void>(resolve=>peer.close(()=>resolve())),new Promise<void>(resolve=>http.close(()=>resolve()))]);
    console.close();database.close();
  });
  const get=async(reference='qmtask:'+task.task_id,fresh=false)=>{
    const response=await fetch(baseUrl+'/console/api/v4/runs/'+encodeURIComponent(reference)+(fresh?'?fresh=1':''),
      {headers:{cookie},signal:AbortSignal.timeout(5000)});
    assert.equal(response.status,200,await response.clone().text());return await response.json() as any;
  };
  const slowPath='/workbench/runs/'+encodeURIComponent(parseWorkspaceHandle(slow.id)!.local);
  const messagesPath=`/workbench/tasks/${task.task_id}/messages-state`;
  return {get,held,failed,invalid,counts,requests,waiting,release,slow,slowPath,messagesPath,ownerNode,config,runtime,phases};
}

test('the final Task detail keeps its complete indexed seed while summaries and one phase are pending',{timeout:30_000},async t=>{
  const f=await fixture(t);f.held.add('/workbench/run-summaries');f.held.add(f.slowPath);
  const detail=await f.get();
  assert.equal(detail.complete,false);
  assert.deepEqual(new Set(detail.run.phaseRefs),new Set(f.phases.map(phase=>phase.id)));
  assert.deepEqual(new Set(detail.run.currentPhaseRefs),new Set(f.phases.map(phase=>phase.id)));
  assert.deepEqual(detail.run.nodeIds,[f.ownerNode]);
  assert.equal(detail.run.workspaceCount,2,'a loaded detail cannot replace the complete membership with its subset');
  assert.ok(detail.files.some((file:any)=>file.path==='first.txt'),'detail content is usable before its summary batch finishes');
  assert.ok(detail.missingPhases.some((phase:any)=>phase.id===f.slow.id&&phase.pending));
  assert.equal(detail.run.actions.patch,false);assert.equal(detail.run.actions.revert,false);
  assert.equal(detail.run.actions.review,false);assert.equal(detail.run.actions.complete,false);
  f.release('/workbench/run-summaries');f.release(f.slowPath);
  const complete=await f.get();assert.equal(complete.complete,true);
  assert.deepEqual(new Set(complete.run.phaseRefs),new Set(f.phases.map(phase=>phase.id)));
  assert.deepEqual(complete.files.map((file:any)=>file.path).sort(),['first.txt','second.txt']);
});

test('a real slow phase returns partial detail promptly, shares the pending HTTP read, then fills the same Task',{timeout:30_000},async t=>{
  const f=await fixture(t);f.held.add(f.slowPath);
  const start=performance.now(),first=await f.get();
  assert.ok(performance.now()-start<2500,'a slow phase must not consume the 30-second peer deadline');
  assert.equal(first.complete,false);
  assert.ok(first.files.some((file:any)=>file.path==='first.txt'),'the healthy saved phase must already be visible');
  assert.ok(!first.files.some((file:any)=>file.path==='second.txt'));
  assert.equal(first.sources.find((source:any)=>source.nodeId===f.ownerNode)?.state,'loading');
  assert.equal(first.missingPhases.find((phase:any)=>phase.id===f.slow.id)?.pending,true);
  assert.ok(!first.warnings.some((warning:string)=>warning.includes('阶段读取失败')));
  assert.equal(first.run.actions.patch,false);assert.equal(first.run.actions.revert,false);
  const next=[f.get(),f.get()];await delay(50);
  assert.equal(f.counts.get(f.slowPath),1,'simultaneous screens must share the actual pending network read');
  f.release(f.slowPath);
  for(const detail of await Promise.all(next)){
    assert.equal(detail.complete,true);
    assert.deepEqual(detail.files.map((file:any)=>file.path).sort(),['first.txt','second.txt']);
    assert.equal(detail.sources.find((source:any)=>source.nodeId===f.ownerNode)?.state,'ready');
  }
  // The same public read primitive must bound an entire multi-wave screen.
  const feed=new WorkbenchFeed(f.config,f.runtime),before=f.counts.get(f.slowPath)??0;
  const paths=Array.from({length:12},(_,index)=>f.slowPath+'?snapshot='+index);
  const local=()=>{throw new Error('must use the real HTTP peer');};
  for(let wave=0;wave<3;wave++){
    f.held.add(f.slowPath);
    const deadline=Date.now()+1200,batchStart=performance.now();
    const sorted=[...paths].sort((left,right)=>feed.nodeReadPriority(f.ownerNode,left)-feed.nodeReadPriority(f.ownerNode,right));
    await mapConcurrent(sorted,4,path=>feed.readNode(f.ownerNode,path,local,{fresh:true,deadline}));
    assert.ok(performance.now()-batchStart<2000,'later phase waves must not each add another 1.2 seconds');
    assert.equal((f.counts.get(f.slowPath)??0)-before,4*(wave+1),'only four actual peer reads may be in flight');
    const sampled=f.requests.filter(path=>path.includes('?snapshot='));
    assert.equal(new Set(sampled).size,4*(wave+1),'explicit refresh must advance unread phases instead of refreshing the same prefix');
    f.release(f.slowPath);
    const completed=await Promise.all(paths.slice(wave*4,wave*4+4).map(path=>feed.readNode(f.ownerNode,path,local)));
    assert.ok(completed.every(value=>value.data!==null&&value.source.state==='ready'));
  }
  assert.ok((await Promise.all(paths.map(path=>feed.readNode(f.ownerNode,path,local)))).every(value=>value.data!==null&&value.source.state==='ready'));
});

test('real failed refreshes retain saved phase content and unknown messages never become an empty mailbox',{timeout:30_000},async t=>{
  const f=await fixture(t),saved=await f.get();assert.equal(saved.complete,true);
  const paths=saved.files.map((file:any)=>file.path).sort();assert.deepEqual(paths,['first.txt','second.txt']);
  const phase=await f.get(f.slow.id);assert.equal(phase.run.actions.patch,true);
  f.held.add(f.slowPath);
  const refreshing=await f.get(f.slow.id,true);
  assert.deepEqual(refreshing.files.map((file:any)=>file.path),['second.txt']);
  assert.equal(refreshing.sources.find((source:any)=>source.nodeId===f.ownerNode)?.state,'refreshing');
  assert.equal(refreshing.run.actions.patch,false,'a cached phase awaiting confirmation must not enable evidence-dependent actions');
  assert.equal(refreshing.run.actions.revert,false);assert.equal(refreshing.run.actions.review,false);
  f.release(f.slowPath);await f.get(f.slow.id);
  f.failed.add(f.slowPath);
  const failed=await f.get(undefined,true);
  assert.deepEqual(failed.files.map((file:any)=>file.path).sort(),paths,'a partial refresh must preserve the previous successful detail');
  assert.equal(failed.complete,false);
  assert.match(failed.sources.find((source:any)=>source.nodeId===f.ownerNode)?.error,/peer detail read failed/);
  const count=f.counts.get(f.slowPath);await f.get();assert.equal(f.counts.get(f.slowPath),count,'a failed peer read must keep its retry backoff');
  f.failed.delete(f.slowPath);await f.get(undefined,true);
  f.held.add(f.messagesPath);
  const start=performance.now(),unknown=await f.get(undefined,true);
  assert.ok(performance.now()-start<2500,'message confirmation must also use the bounded shared read');
  assert.equal(unknown.taskMessages.available,false);
  assert.equal('pending' in unknown.taskMessages,false,'unknown is not a confirmed zero pending messages');
  assert.equal('sequence' in unknown.taskMessages,false);
  assert.equal(unknown.run.actions.complete,false);assert.equal(unknown.complete,false);
  assert.deepEqual(unknown.files.map((file:any)=>file.path).sort(),paths);
  assert.equal(unknown.sources.find((source:any)=>source.nodeId===f.ownerNode)?.state,'refreshing','the existing UI must see a pending source and continue filling the detail');
  const messageRequests=f.counts.get(f.messagesPath),next=f.get();await delay(30);
  assert.equal(f.counts.get(f.messagesPath),messageRequests);
  f.release(f.messagesPath);
  const restored=await next;
  assert.equal(restored.taskMessages.available,true);assert.equal(typeof restored.taskMessages.pending,'number');
  assert.equal(restored.complete,true);
  f.invalid.add(f.messagesPath);
  const malformed=await f.get(undefined,true);
  assert.equal(malformed.taskMessages.available,false,'a malformed confirmation must still fail the original schema');
  assert.equal('pending' in malformed.taskMessages,false);
  assert.equal(malformed.run.actions.complete,false);
  assert.equal(malformed.sources.find((source:any)=>source.nodeId===f.ownerNode)?.state,'error');
});
