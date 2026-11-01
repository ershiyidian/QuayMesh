import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {once} from 'node:events';
import express,{Router} from 'express';
import {loadConfig} from '../config.js';
import {writeTestQuayMeshConfig} from '../test-support/config.test.js';
import {WorkLedger} from '../work-ledger.js';
import {SessionStore} from '../session/store.js';
import {SessionProjector} from '../session/projection.js';
import {saveRunCheckpoint} from '../session/run-checkpoints.js';
import type {FederationRuntime} from '../federation/runtime.js';
import {ConsoleOperations} from '../federation/console-dispatch.js';
import {readLocalTaskIndex,readLocalSessionTitles,readLocalRunSummaries,readLocalTaskStateIndex} from './local-queries.js';
import {runQuery} from './run-query.js';
import {WorkbenchFeed} from './feed.js';
import {mountConsoleWorkbench} from './router.js';
import {closeConsoleReaders} from './isolated-queries.js';
import {consoleReadConfig,parseConsoleReadRequest} from './read-protocol.js';
import {parseTaskReadScope,parseTaskReadScopeQuery,scopedTaskReadPath} from './task-read-scope.js';
import {READ_UPGRADE_MESSAGE} from './isolated-routes.js';
import {readConsoleDetail} from './detail-read-model.js';
import {readTaskMessageState} from './read-task-state.js';

function fixture(nodeId='local',noise=0) {
  const directory=mkdtempSync(join(tmpdir(),'qm-task-scope-')),root=join(directory,'project'),hiddenRoot=join(directory,'hidden');
  mkdirSync(root);mkdirSync(hiddenRoot);
  const config=loadConfig(writeTestQuayMeshConfig(join(directory,'config'),{
    storage:{stateDir:join(directory,'state')},workspaces:{allowedRoots:[root],worktreeRoot:join(directory,'worktrees')},
  }));
  assert.ok(config.federation);config.federation.enabled=true;config.federation.nodeId=nodeId;config.federation.capabilities.coordinator=nodeId!=='worker';
  const ledger=new WorkLedger(config.stateDir),store=new SessionStore(ledger.db);
  const session=store.createSession('owner',nodeId+'-selected','Selected conversation');
  const member=store.addMember(session.id,nodeId,'selected-workspace',root,'checkout',null);
  const task=store.createTask(session.id,'Selected Task');store.touchTaskMember(task.id,member.id);
  const runFor=(taskId:string,sessionId=session.id,memberId=member.id,selectedRoot=root,key='phase')=>{
    const run=ledger.begin({root:selectedRoot,workspaceId:memberId,workItemId:taskId,runKey:key,title:'Recorded phase',
      origin:{entryPoint:'console',evidence:'server_entry'}});
    store.linkRun(sessionId,memberId,run.id,taskId);return run;
  };
  const first=runFor(task.id,undefined,undefined,undefined,'first'),last=runFor(task.id,undefined,undefined,undefined,'last');
  const sibling=store.createTask(session.id,'Other Task in selected conversation');store.touchTaskMember(sibling.id,member.id);
  const siblingRun=runFor(sibling.id);
  const unused=store.createTask(session.id,'A Task without a phase');store.touchTaskMember(unused.id,member.id);
  const other=store.createSession('owner',nodeId+'-other','Other history'),otherMember=store.addMember(other.id,nodeId,'other-workspace',root,'checkout',null);
  for(let index=0;index<noise;index++) {
    const older=store.createTask(other.id,'Unrelated Task '+index);store.touchTaskMember(older.id,otherMember.id);
    runFor(older.id,other.id,otherMember.id,root);
  }
  const hiddenSession=store.createSession('owner',nodeId+'-hidden','Hidden conversation');
  const hiddenMember=store.addMember(hiddenSession.id,nodeId,'hidden-workspace',hiddenRoot,'checkout',null);
  const hidden=store.createTask(hiddenSession.id,'Hidden Task');store.touchTaskMember(hidden.id,hiddenMember.id);
  runFor(hidden.id,hiddenSession.id,hiddenMember.id,hiddenRoot);
  return {config,ledger,store,root,session,member,task,first,last,sibling,siblingRun,unused,hidden,runFor,
    close:()=>{ledger.close();rmSync(directory,{recursive:true,force:true});}};
}

test('Task read scopes are bounded, canonical and cannot become unrestricted reads',()=>{
  assert.deepEqual(parseTaskReadScope({taskId:'one'}),{taskIds:['one']});
  assert.deepEqual(parseTaskReadScopeQuery({taskIds:'two,one,two'}),{taskIds:['one','two']});
  assert.deepEqual(parseTaskReadScopeQuery({sessionId:'session'}),{sessionId:'session'});
  assert.equal(scopedTaskReadPath('task-index',{taskIds:['two','one']}),'/workbench/task-index-scoped?taskIds=one%2Ctwo');
  for(const scope of [null,{},[],{taskIds:[]},{taskIds:['']},{taskIds:['one/other']},
    {taskIds:['one'],sessionId:'session'},{taskId:'one',unknown:true},{taskIds:Array(101).fill('one')}])
    assert.throws(()=>parseTaskReadScope(scope),{code:'invalid_read',status:400,effect:'none'});
  for(const query of [{},{taskIds:''},{taskIds:'one,'},{taskId:'one',limit:'1'}])
    assert.throws(()=>parseTaskReadScopeQuery(query),{code:'invalid_read'});
});

test('scoped SQLite reads retain all selected history and permissions without classifying unrelated Tasks',t=>{
  const f=fixture('local',200);t.after(f.close);
  const at=Date.now(),scope={taskIds:[f.task.id,f.unused.id]},projects=f.ledger.projects().map(project=>project.id);
  const old=new Date(at-90*86_400_000).toISOString();
  f.ledger.db.prepare('UPDATE qm_tasks SET created_at=? WHERE id=?').run(old,f.task.id);
  f.ledger.db.prepare('UPDATE console_work_runs SET created_at=? WHERE id=?').run(old,f.first.id);
  const legacy=f.ledger.begin({root:f.root,workItemId:'legacy',runKey:'before-task-binding',title:'Legacy session phase',
    origin:{entryPoint:'console',evidence:'server_entry'}});
  f.ledger.db.prepare('INSERT INTO qm_run_links(session_id,member_id,run_id,task_id) VALUES(?,?,?,NULL)')
    .run(f.session.id,f.member.id,legacy.id);
  const all=readLocalTaskIndex(f.config,at),selected=readLocalTaskIndex(f.config,at,scope);
  assert.deepEqual(selected.items,all.items.filter(item=>scope.taskIds.includes(item.taskId??'')));
  assert.deepEqual(new Set(selected.items.map(item=>item.localId)),new Set([f.first.id,f.last.id]));
  assert.ok(selected.items.some(item=>item.startedAt<at-89*86_400_000),'selected Task history must not acquire a date window');
  const titles=readLocalSessionTitles(f.config,scope);
  assert.deepEqual(new Set(titles.tasks.map(task=>task.id)),new Set(scope.taskIds));
  assert.deepEqual(titles.items.map(session=>session.id),[f.session.id]);
  assert.ok(titles.tasks.every(task=>task.workspaces?.length===1));
  assert.deepEqual(readLocalTaskIndex(f.config,at,{taskIds:[f.hidden.id]}).items,[]);
  assert.deepEqual(readLocalSessionTitles(f.config,{taskIds:[f.hidden.id]}).tasks,[]);
  assert.deepEqual(readLocalSessionTitles(f.config,{taskIds:['missing-task']}).items,[]);
  assert.deepEqual(readLocalTaskIndex(f.config,at,{sessionId:f.session.id}).items,
    all.items.filter(item=>item.sessionId===f.session.id));
  assert.ok(readLocalTaskIndex(f.config,at,{sessionId:f.session.id}).items.some(item=>item.localId===legacy.id&&item.taskId===null));

  const query=runQuery(f.ledger,'local',projects,{days:'0'},at,{counts:false,taskScope:scope});
  let classified=0;
  f.ledger.db.function('quaymesh_execution_status',{deterministic:true},
    (_state,_result,_status,_working,_queued,_unresolved,_progress,_finalizing,_lastOutcome)=>{classified++;return 'waiting';});
  const rows=f.ledger.db.prepare(`${query.sql} SELECT id,execution FROM selected`).all(...query.params) as {id:string}[];
  assert.equal(classified,2,'only the two selected phases may run execution classification');
  assert.deepEqual(new Set(rows.map(row=>row.id)),new Set([f.first.id,f.last.id]));
  const plan=f.ledger.db.prepare(`EXPLAIN QUERY PLAN ${query.sql} SELECT id,execution FROM selected`).all(...query.params) as {detail:string}[];
  assert.ok(plan.some(row=>/SEARCH r USING/.test(row.detail)));
  assert.ok(plan.some(row=>/qm_run_links_task.*task_id=/.test(row.detail)));
  t.diagnostic(plan.filter(row=>/SEARCH r |qm_run_links_task/.test(row.detail)).map(row=>row.detail).join('; '));
  const request=parseConsoleReadRequest({operation:'task-index',config:consoleReadConfig(f.config),scope:{taskId:f.task.id}});
  assert.deepEqual(request.scope,{taskIds:[f.task.id]});
  assert.equal(request.config.federation?.enabled,true,'isolated configuration must retain federation authority mode');
  assert.throws(()=>parseConsoleReadRequest({operation:'usage',config:consoleReadConfig(f.config),scope}),/invalid_read/);
});

test('real scoped node reads preserve authority, discover new Task members and never fall back on older nodes',{timeout:30_000},async t=>{
  const authority=fixture('authority',12),worker=fixture('worker',12),calls:Array<{node:string;path:string}>=[];
  const operations=new Map<string,ConsoleOperations>();
  for(const [node,f] of [['authority',authority],['worker',worker]] as const) {
    const router=Router(),nodeOperations=new ConsoleOperations(router);
    mountConsoleWorkbench(router,nodeOperations,f.config);operations.set(node,nodeOperations);
  }
  let olderWorker=false,authorityOnline=true,unscopedCalls=0;
  const http=createServer((request,response)=>{void(async()=>{
    const url=new URL(request.url!,'http://localhost'),node=url.pathname.split('/')[1]!,path=url.pathname.slice(node.length+1)+url.search;
    calls.push({node,path});
    if(/\/(task-index|session-titles)(?:\?|$)/.test(path))unscopedCalls++;
    const reply=olderWorker&&node==='worker'&&path.includes('-scoped?')
      ? {status:404,body:{code:'route_not_found'}} : await operations.get(node)!.dispatch('GET',path);
    response.writeHead(reply.status,{'content-type':'application/json'});response.end(JSON.stringify(reply.body));
  })().catch(error=>{response.writeHead(500);response.end(JSON.stringify({message:String(error)}));});});
  http.listen(0,'127.0.0.1');await once(http,'listening');
  t.after(async()=>{http.closeAllConnections();await new Promise<void>(resolve=>http.close(()=>resolve()));
    closeConsoleReaders();authority.close();worker.close();});
  const address=http.address();assert.ok(address&&typeof address==='object');
  const runtime={nodes:()=>[{id:'authority',nickname:'Authority',online:authorityOnline},{id:'worker',nickname:'Worker',online:true},
    {id:'unrelated-offline',nickname:'Unrelated offline node',online:false}],
    request:async(node:string,method:string,input:{path:string})=>{
      assert.equal(method,'console');
      const response=await fetch(`http://127.0.0.1:${address.port}/${node}${input.path}`,{signal:AbortSignal.timeout(10_000)});
      return {status:response.status,body:await response.json()};
    }} as unknown as FederationRuntime;
  const config={...authority.config,federation:{...authority.config.federation!,nodeId:'observer'}};
  const feed=new WorkbenchFeed(config,runtime),taskId=authority.task.id;
  assert.deepEqual(await feed.taskActivities([]),[]);assert.equal(calls.length,0);
  await feed.overview('UTC');
  const nodeCache=(feed as unknown as {cache:Map<string,{data?:{authoritative?:boolean}}>}).cache;
  assert.equal(nodeCache.get('worker:/workbench/task-state-index')?.data?.authoritative,false,
    'the isolated worker must not turn a federated mirror into standalone authority');
  const previewStart=calls.length;
  const initial=await feed.taskRuns(taskId);
  assert.equal(initial.complete,true);assert.equal(initial.runs.length,2);
  assert.deepEqual(initial.sources.map(source=>source.nodeId),['authority']);
  assert.ok(calls.slice(previewStart).every(call=>call.node==='authority'),
    'the new homepage state snapshot must provide the same cached authority/member scope');
  const activities=await feed.taskActivities([taskId]);
  assert.deepEqual(activities.map(task=>task.taskId),[taskId]);assert.equal(activities[0]!.title,authority.task.title);

  const mirror=worker.store.adoptRemoteSession({id:authority.session.id,ownerId:'owner',conversationId:null,title:'Mirror session'});
  worker.store.adoptRemoteTask(mirror.id,taskId,'Mirror must not override authority',authority.task.created_at);
  const member=worker.store.addMember(mirror.id,'worker','remote-workspace',worker.root,'checkout',null);
  worker.store.touchTaskMember(taskId,member.id);
  worker.ledger.db.prepare('UPDATE qm_tasks SET revision=999 WHERE id=?').run(taskId);
  authority.store.upsertRemoteMember({id:member.id,sessionId:mirror.id,nodeId:'worker',workspaceId:member.workspace_id,
    root:worker.root,sourceRoot:null,mode:'checkout',revision:0,online:true});
  authority.store.touchTaskMember(taskId,member.id);
  const remote=worker.runFor(taskId,mirror.id,member.id);
  const operation=worker.ledger.operation({runId:remote.id,requestKey:'active',kind:'command',label:'Active owner',status:'running'});
  worker.ledger.observeOperations([operation]);
  const before=calls.length,expanded=await feed.taskRuns(taskId,true);
  assert.equal(expanded.complete,true);assert.equal(expanded.runs.length,3);
  assert.equal(expanded.task?.title,authority.task.title);
  assert.equal(expanded.task?.executionStatus,'running');
  assert.deepEqual(new Set(expanded.sources.map(source=>source.nodeId)),new Set(['authority','worker']));
  assert.ok(calls.slice(before).some(call=>call.node==='worker'&&call.path.includes('/task-index-scoped?')),
    'a fresh authority membership must add the new worker even after a narrower cached observation');
  const conversation=await feed.sessionRuns(authority.session.id);
  assert.deepEqual(new Set(conversation.runs.map(run=>run.taskId)),new Set([taskId,authority.sibling.id]));
  assert.ok(calls.some(call=>call.path.includes('sessionId='+authority.session.id)));

  const cache=(feed as unknown as {cache:Map<string,{loadedAt:number;error:string|null}>}).cache;
  const savedObservations=new Map([...cache].map(([key,value])=>[key,value.loadedAt]));
  olderWorker=true;
  const previous=expanded.sources.find(source=>source.nodeId==='worker')!,failed=await feed.taskRuns(taskId,true);
  const source=failed.sources.find(source=>source.nodeId==='worker')!;
  assert.equal(failed.complete,false);assert.equal(source.error,READ_UPGRADE_MESSAGE);
  const failedSnapshots=[...cache].filter(([key,value])=>key.startsWith('worker:')&&value.error!==null);
  assert.ok(failedSnapshots.length>0);
  for(const [key,value] of failedSnapshots)assert.equal(value.loadedAt,savedObservations.get(key),'a failed scope read cannot renew its own saved observation');
  // This aggregate may now also include an older failed title snapshot. Its
  // conservative timestamp can move backward, never become a fresh read.
  assert.ok(source.observedAt!==null&&source.observedAt<=previous.observedAt!);assert.equal(source.online,true);
  assert.equal(failed.runs.length,3,'failed scoped reads retain the same previously confirmed Task history');
  assert.equal(unscopedCalls,0,'no detail or activity read may call the unrestricted index/title routes');
  const invalid=await operations.get('authority')!.dispatch('GET','/workbench/isolated-v1/task-index-scoped');
  assert.equal(invalid.status,400);
  olderWorker=false;authorityOnline=false;
  const cold=await new WorkbenchFeed(config,runtime).taskRuns(taskId);
  assert.equal(cold.runs.length,1,'the worker mirror remains readable while the authority is offline');
  assert.equal(cold.complete,false,'a worker-only mirror cannot establish complete Task membership');
  assert.ok(cold.sources.some(source=>source.nodeId==='authority'&&source.state==='offline'));
  assert.ok(cold.missingNodes.includes('authority'),'the missing authority must not disappear from coverage');
  assert.ok(calls.every(call=>call.path.startsWith('/workbench/isolated-v1/')));
  t.diagnostic(`Actual loopback RPC calls: ${calls.length}; unscoped task reads: ${unscopedCalls}`);
});

test('a 1200-phase Task shares one screen budget, keeps every reference, and eventually reads all history',{timeout:30_000},async t=>{
  const f=fixture('authority'),phaseCount=1200;
  f.ledger.db.transaction(()=>{for(let index=2;index<phaseCount;index++)f.runFor(f.task.id,undefined,undefined,undefined,'history-'+index);})();
  let held=true,immediate=1,summaryStarts=0;
  const waiting:Array<{response:import('node:http').ServerResponse;body:unknown}>=[];
  const send=(response:import('node:http').ServerResponse,body:unknown)=>{
    response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify(body));
  };
  const release=()=>{held=false;for(const item of waiting.splice(0))send(item.response,item.body);};
  const http=createServer((request,response)=>{try{
    const url=new URL(request.url!,'http://localhost'),path=url.pathname.replace('/isolated-v1','');
    let body:unknown;
    if(path==='/workbench/task-index-scoped')body=readLocalTaskIndex(f.config,undefined,parseTaskReadScopeQuery(Object.fromEntries(url.searchParams)));
    else if(path==='/workbench/session-titles-scoped')body=readLocalSessionTitles(f.config,parseTaskReadScopeQuery(Object.fromEntries(url.searchParams)));
    else if(path==='/workbench/task-index')body=readLocalTaskIndex(f.config);
    else if(path==='/workbench/session-titles')body=readLocalSessionTitles(f.config);
    else if(path==='/workbench/task-state-index')body=readLocalTaskStateIndex(f.config);
    else if(path==='/workbench/run-summaries'){
      summaryStarts++;body=readLocalRunSummaries(f.config,url.searchParams.get('ids')!.split(','));
      if(held&&immediate--<=0){waiting.push({response,body});return;}
    }else throw new Error('Unexpected read '+path);
    send(response,body);
  }catch(error){response.writeHead(500,{'content-type':'application/json'});response.end(JSON.stringify({message:String(error)}));}});
  http.listen(0,'127.0.0.1');await once(http,'listening');
  t.after(async()=>{release();http.closeAllConnections();await new Promise<void>(resolve=>http.close(()=>resolve()));f.close();});
  const address=http.address();assert.ok(address&&typeof address==='object');
  const runtime={nodes:()=>[{id:'authority',nickname:'Authority',online:true}],
    request:async(_node:string,_method:string,input:{path:string})=>{
      const response=await fetch(`http://127.0.0.1:${address.port}${input.path}`,{signal:AbortSignal.timeout(10_000)});
      return {status:response.status,body:await response.json()};
    }} as unknown as FederationRuntime;
  const config={...f.config,federation:{...f.config.federation!,nodeId:'observer'}};
  const feed=new WorkbenchFeed(config,runtime),started=performance.now(),first=await feed.taskRuns(f.task.id);
  assert.ok(performance.now()-started<2300,'all summary batches must share the original screen deadline');
  assert.equal(first.complete,false);assert.ok(first.runs.length>0&&first.runs.length<phaseCount);
  assert.equal(first.task?.phaseRefs?.length,phaseCount,'a partial summary cannot replace the complete index references');
  assert.equal(first.task?.currentPhaseRefs?.length,1);
  assert.ok(summaryStarts<=3,`only one fast prefix and two held batches may start, got ${summaryStarts}`);
  assert.equal(first.sources[0]?.state,'loading');assert.equal(first.sources[0]?.observedAt,null);
  const secondStarted=performance.now(),second=await feed.taskRuns(f.task.id,true);
  assert.ok(performance.now()-secondStarted<2300);
  assert.equal(second.task?.phaseRefs?.length,phaseCount);assert.equal(second.complete,false);
  assert.ok(waiting.length<=4,'concurrent preview rounds share the existing four-read node capacity');
  assert.ok(waiting.every(item=>!item.response.destroyed),'the screen deadline must not cancel shared background reads');
  release();
  let complete=await feed.taskRuns(f.task.id);
  for(let attempt=0;!complete.complete&&attempt<4;attempt++)complete=await feed.taskRuns(f.task.id);
  assert.equal(complete.complete,true);assert.equal(complete.runs.length,phaseCount);
  assert.equal(complete.task?.phaseRefs?.length,phaseCount);
  assert.equal(new Set(complete.runs.map(run=>run.id)).size,phaseCount);

  held=true;immediate=1;const beforeList=summaryStarts,listFeed=new WorkbenchFeed(config,runtime),listStarted=performance.now();
  const list=await listFeed.runs({days:'0',session:f.session.id,limit:'100'});
  assert.ok(performance.now()-listStarted<2300,'list summaries use the same one-screen budget');
  assert.equal(list.total,3,'summary limits cannot change the exact Task count');
  assert.equal(list.coverage.tasks,true);assert.equal(list.coverage.details,false);assert.equal(list.complete,false);
  assert.equal(list.items.find(task=>task.taskId===f.task.id)?.phaseRefs?.length,phaseCount);
  assert.ok(summaryStarts-beforeList<=3);
  release();
  const legacy=f.store.createSession('owner','legacy-budget','Saved legacy conversation');
  const member=f.store.addMember(legacy.id,'authority','legacy-workspace',f.root,'checkout',null);
  for(const key of ['first','last']) {
    const run=f.ledger.begin({root:f.root,workItemId:'legacy-budget',runKey:key,title:'Legacy phase',
      origin:{entryPoint:'console',evidence:'server_entry'}});
    f.ledger.db.prepare('INSERT INTO qm_run_links(session_id,member_id,run_id,task_id) VALUES(?,?,?,NULL)')
      .run(legacy.id,member.id,run.id);
  }
  held=true;immediate=0;
  const legacyPreview=await feed.sessionRuns(legacy.id);
  assert.equal(legacyPreview.complete,false);assert.equal(legacyPreview.runs.length,0);
  assert.equal(legacyPreview.task?.taskId,null);assert.equal(legacyPreview.task?.sessionId,legacy.id);
  assert.equal(legacyPreview.task?.phaseRefs?.length,2,'a legacy preview has a real indexed seed while summaries are pending');
  release();
  t.diagnostic(`Preserved ${phaseCount} phases; first preview ${first.runs.length} summaries; bounded pending reads <=4`);
});

test('real Task detail pages cross the 160-entry cache boundary without rereading or accumulating all phase bodies',{timeout:30_000},async t=>{
  const f=fixture('authority'),phaseCount=181;
  f.ledger.db.transaction(()=>{for(let index=2;index<phaseCount;index++)f.runFor(f.task.id,undefined,undefined,undefined,'page-'+index);})();
  const snapshot=await new SessionProjector(f.store,f.config.stateDir,null,undefined,'authority').readSnapshot(f.session.id,f.member.id,f.task.id);
  const indexed=readLocalTaskIndex(f.config,undefined,{taskIds:[f.task.id]}).items;
  for(const [index,phase] of indexed.entries()){
    f.ledger.db.prepare('UPDATE console_work_runs SET summary=?,evidence=? WHERE id=?')
      .run('Saved phase '+index,JSON.stringify([{label:'Saved evidence '+index,reference:phase.id,outcome:'passed'}]),phase.localId);
    saveRunCheckpoint(f.ledger.db,phase.localId,{revision:1,snapshot,files:[]});
  }
  let unavailableIndex=false;
  const starts:string[]=[];
  const peer=createServer((request,response)=>{void(async()=>{
    const url=new URL(request.url!,'http://localhost'),path=url.pathname.replace('/isolated-v1','');
    let body:unknown;
    if(path==='/workbench/task-index-scoped'){
      if(unavailableIndex){response.writeHead(503,{'content-type':'application/json'});response.end(JSON.stringify({message:'owner index unavailable'}));return;}
      body=readLocalTaskIndex(f.config,undefined,parseTaskReadScopeQuery(Object.fromEntries(url.searchParams)));
    }else if(path==='/workbench/session-titles-scoped')body=readLocalSessionTitles(f.config,parseTaskReadScopeQuery(Object.fromEntries(url.searchParams)));
    else if(path==='/workbench/run-summaries')body=readLocalRunSummaries(f.config,url.searchParams.get('ids')!.split(','));
    else if(path.startsWith('/workbench/runs/')){
      const id=decodeURIComponent(path.slice('/workbench/runs/'.length));starts.push(id);
      body=(await readConsoleDetail(f.config,{kind:'detail',runId:id})).value;
    }else if(path.startsWith('/workbench/tasks/')&&path.endsWith('/messages-state'))
      body=readTaskMessageState(f.config,decodeURIComponent(path.split('/')[3]!));
    else throw new Error('Unexpected page read '+path);
    response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify(body));
  })().catch(error=>{response.writeHead(500,{'content-type':'application/json'});response.end(JSON.stringify({message:String(error)}));});});
  peer.listen(0,'127.0.0.1');await once(peer,'listening');
  const peerAddress=peer.address();assert.ok(peerAddress&&typeof peerAddress==='object');
  const runtime={nodes:()=>[{id:'authority',nickname:'Authority',online:true}],
    request:async(_node:string,_method:string,input:{path:string})=>{
      const response=await fetch(`http://127.0.0.1:${peerAddress.port}${input.path}`,{signal:AbortSignal.timeout(10_000)});
      return {status:response.status,body:await response.json()};
    }} as unknown as FederationRuntime;
  const config={...f.config,federation:{...f.config.federation!,nodeId:'observer',coordinatorId:'authority',
    capabilities:{...f.config.federation!.capabilities,coordinator:false}}};
  const app=express(),router=Router();app.use(router);
  mountConsoleWorkbench(router,new ConsoleOperations(router),config,runtime);
  const http=app.listen(0,'127.0.0.1');await once(http,'listening');
  t.after(async()=>{peer.closeAllConnections();http.closeAllConnections();await Promise.all([
    new Promise<void>(resolve=>peer.close(()=>resolve())),new Promise<void>(resolve=>http.close(()=>resolve()))]);f.close();});
  const address=http.address();assert.ok(address&&typeof address==='object');
  const reference='qmtask:'+f.task.id;
  const request=async(query='',id=reference)=>fetch(`http://127.0.0.1:${address.port}/api/v4/runs/${encodeURIComponent(id)}${query?'?'+query:''}`,
    {signal:AbortSignal.timeout(5000)});
  const get=async(query='')=>{const response=await request(query);assert.equal(response.status,200,await response.clone().text());return await response.json() as any;};
  let page=await get();
  assert.equal(page.phasePage.limit,20);assert.equal(page.phasePage.references.length,20);assert.equal(starts.length,20);
  assert.equal(page.phasePage.total,phaseCount);assert.equal(page.phasePage.complete,true);assert.equal(page.taskComplete,true);
  assert.equal(page.complete,false,'one complete page is not complete Task history');
  const taskRevision=page.run.revision,execution=page.run.executionStatus,allRefs=page.run.phaseRefs;
  assert.equal(allRefs.length,phaseCount);
  const seen=new Set<string>(),firstCursor=page.phasePage.nextCursor;let pages=0,lastPrevious:string|null=null;
  while(true){
    pages++;assert.equal(page.phasePage.complete,true);assert.equal(page.taskComplete,true);
    assert.equal(page.run.revision,taskRevision);assert.equal(page.run.executionStatus,execution);
    assert.deepEqual(page.run.phaseRefs,allRefs,'page detail must never replace the Task-wide references');
    assert.ok(page.phases.length<=20);assert.equal(page.evidence.length,page.phasePage.references.length);
    assert.equal(page.complete,false);assert.deepEqual(page.missingPhases,[],'unselected history is deliberate paging, not pending IO');
    for(const id of page.phasePage.references){assert.ok(!seen.has(id),'page anchors must advance without duplicates');seen.add(id);}
    if(pages>1){assert.equal(page.run.actions.complete,false,'a complete historical page lacks current-phase evidence');
      assert.equal(page.run.actions.review,false);assert.equal(page.run.actions.patch,false);assert.equal(page.run.actions.revert,false);}
    lastPrevious=page.phasePage.previousCursor;
    if(!page.phasePage.nextCursor)break;
    const before=starts.length;
    page=await get('phaseCursor='+encodeURIComponent(page.phasePage.nextCursor));
    assert.ok(starts.length-before<=20,'each navigation can read only its selected page');
  }
  assert.equal(seen.size,phaseCount);assert.equal(starts.length,phaseCount);
  assert.ok(lastPrevious);
  const back=await get('phaseCursor='+encodeURIComponent(lastPrevious));
  assert.equal(back.phasePage.complete,true);assert.equal(back.phasePage.references.length,20);
  const returned=await get();assert.equal(returned.phasePage.complete,true);assert.equal(returned.phases.length,20);
  assert.ok(starts.length>phaseCount,'the oldest page was evicted, then reconstructed independently');
  assert.ok(starts.length<=phaseCount+20,'returning to an evicted page must not rehydrate the whole Task');
  const fifty=await get('phaseLimit=50');assert.equal(fifty.phasePage.limit,50);assert.equal(fifty.phases.length,50);
  assert.equal((await request('phaseLimit=51')).status,422);
  assert.equal((await request('phaseCursor='+encodeURIComponent(firstCursor),'qmtask:'+f.sibling.id)).status,400);
  unavailableIndex=true;
  const unknownResponse=await request('fresh=1','qmtask:'+f.unused.id);assert.equal(unknownResponse.status,200);
  const unknown=await unknownResponse.json() as any;
  assert.equal(unknown.phasePage.references.length,0);assert.equal(unknown.taskComplete,false);
  assert.equal(unknown.phasePage.complete,false,'an unread owner index cannot confirm an empty page');
  assert.equal(unknown.run.actions.complete,false);
  t.diagnostic(`${phaseCount} real saved phase bodies reached in ${pages} pages; first page 20 reads, max page 50`);
});

test('failed detail resources obey the same 160-entry bound and preserve the newest retry backoff',{timeout:10_000},async t=>{
  const f=fixture('authority');let requests=0;
  const peer=createServer((_request,response)=>{requests++;response.writeHead(503,{'content-type':'application/json'});
    response.end(JSON.stringify({message:'saved peer failure',code:'read_failed'}));});
  peer.listen(0,'127.0.0.1');await once(peer,'listening');
  t.after(async()=>{peer.closeAllConnections();await new Promise<void>(resolve=>peer.close(()=>resolve()));f.close();});
  const address=peer.address();assert.ok(address&&typeof address==='object');
  const runtime={nodes:()=>[{id:'authority',nickname:'Authority',online:true}],
    request:async(_node:string,_method:string,input:{path:string})=>{
      const response=await fetch(`http://127.0.0.1:${address.port}${input.path}`,{signal:AbortSignal.timeout(3000)});
      return {status:response.status,body:await response.json()};
    }} as unknown as FederationRuntime;
  const config={...f.config,federation:{...f.config.federation!,nodeId:'observer'}},feed=new WorkbenchFeed(config,runtime);
  const local=()=>{throw new Error('the real HTTP peer must own this read');};
  for(let index=0;index<181;index++){
    const read=await feed.readNode('authority','/workbench/runs/failed-'+index,local);
    assert.equal(read.source.state,'error');assert.equal(read.source.observedAt,null);
  }
  const cache=(feed as unknown as {cache:Map<string,{retryAt:number}>}).cache;
  assert.equal(cache.size,160);assert.equal(requests,181);
  assert.ok(cache.get('authority:/workbench/runs/failed-180')!.retryAt>Date.now());
  const retry=await feed.readNode('authority','/workbench/runs/failed-180',local);
  assert.equal(retry.source.error,'saved peer failure');assert.equal(requests,181,'the newest error retains its retry backoff');
  t.diagnostic('181 failed HTTP reads retained 160 cache entries; newest error reused without another RPC');
});
