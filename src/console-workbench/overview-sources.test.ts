import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkbenchFeed } from './feed.js';
import type { TaskPhaseIndex } from './local-queries.js';
import type { ServerConfig } from '../config.js';
import type { FederationRuntime } from '../federation/runtime.js';
import type { TaskLifecycle } from '../console-task-state.js';
import { READ_UPGRADE_MESSAGE } from './isolated-routes.js';

function fixture() {
  const at=Date.now();
  const nodes=[{id:'coordinator',nickname:'Coordinator',online:true},{id:'worker',nickname:'Worker',online:true}];
  const calls:Array<{node:string;path:string}>=[];
  const unsupported=new Set<string>();
  const tasks:TaskLifecycle[]=[{id:'task',sessionId:'session',title:'Long-running task',state:'active',resultStatus:null,
    revision:5,finishedAt:null,createdAt:at-60_000,lastActivityAt:at,lastProgressAt:at,nodeId:'coordinator',memberNodeIds:['worker'],
    workspaces:[{nodeId:'worker',projectId:'qm:worker:project',memberId:'member',name:'Research',root:'/research'}]}];
  const phases:TaskPhaseIndex[]=Array.from({length:500},(_,index)=>({
    id:'qm:worker:phase-'+index,localId:'phase-'+index,nodeId:'worker',sessionId:'session',taskId:'task',title:'Phase '+index,
    projectId:'qm:worker:project',projectName:'Research',root:'/research',executionStatus:index===499?'running':'completed',
    acceptanceStatus:'not_required',startedAt:at-60_000,finishedAt:index===499?null:at-1000,lastActivityAt:at,
    lastProgressAt:at,executionObservedAt:index===499?at:null,tokens:1,changed:false,actionableInterruption:false,currentPhase:index===499,
  }));
  const runtime={nodes:()=>nodes,request:async(node:string,method:string,args:{path:string})=>{
    assert.equal(method,'console');calls.push({node,path:args.path});
    const path=new URL(args.path,'http://test.invalid').pathname;
    if(unsupported.has(node))return {status:404,body:{code:'route_not_found'}};
    if(path==='/workbench/isolated-v1/task-state-index')return {status:200,body:{projection:'state',
      phases:node==='worker'?phases.map(({tokens:_tokens,changed:_changed,...value})=>value):[],
      sessions:[],tasks:node==='coordinator'?tasks:[],authoritative:node==='coordinator',observedAt:at}};
    throw new Error('The task overview must not read '+path);
  }} as unknown as FederationRuntime;
  return {feed:new WorkbenchFeed({federation:{nodeId:'observer'}} as ServerConfig,runtime),nodes,calls,at,tasks,phases,unsupported};
}

test('the task overview reads one combined state projection per node even with hundreds of historical phases',async()=>{
  const f=fixture();
  const page=await f.feed.overview('UTC');
  assert.equal(page.complete,true);
  assert.equal(page.currentCount,1);
  assert.equal(page.runningCount,1);
  assert.equal(page.current[0]!.title,'Long-running task');
  assert.equal(page.current[0]!.workspaceCount,1);
  assert.equal(page.current[0]!.workspaces?.[0]!.name,'Research');
  assert.equal(page.current[0]!.lastProgressAt,f.at);
  assert.equal(page.current[0]!.executionStatus,'running');
  assert.equal(page.current[0]!.phaseRefs?.length,500);
  assert.deepEqual(new Set(f.calls.map(call=>call.path)),new Set(['/workbench/isolated-v1/task-state-index']));
  assert.equal(f.calls.length,2);
  assert.equal(page.projection,'state');assert.equal(page.coverage.usage,false);assert.equal(page.coverage.changes,false);
  assert.equal(page.todayUsage.available,false);assert.equal(page.todayUsage.total,null);
  assert.deepEqual(page.usageSources,[]);assert.deepEqual(page.projects,[]);
  assert.equal(page.current[0]!.usage.quality,'unavailable');assert.equal(page.current[0]!.usage.total,null);
  await f.feed.overview('UTC');
  assert.equal(f.calls.length,2,'a cached preview does not re-read the task history');
});

test('closed requests retain fresh real background execution and queued counts without reopening current lifecycle groups',async()=>{
  for(const executionStatus of ['running','queued']){
    const f=fixture();f.tasks[0]={...f.tasks[0]!,state:'closed',resultStatus:'completed',finishedAt:f.at-1000};
    const current=f.phases.at(-1)!;current.executionStatus=executionStatus;current.requestState='closed';current.resultStatus='completed';
    const page=await f.feed.overview('UTC');
    assert.equal(page.activeCount,1);assert.equal(page.currentCount,0);assert.equal(page.olderOpenCount,0);
    assert.equal(page.active[0]!.executionStatus,executionStatus);assert.equal(page.active[0]!.requestState,'closed');
    assert.equal(page.recent[0]!.executionStatus,executionStatus);assert.equal(page.recent[0]!.resultStatus,'completed');
    assert.equal(executionStatus==='running'?page.runningCount:page.queuedCount,1);
  }
});

test('older nodes report the missing state capability and never fall back to full history routes',async()=>{
  const f=fixture(),first=await f.feed.overview('UTC');
  f.unsupported.add('worker');
  const failed=await f.feed.overview('UTC',true);
  assert.equal(failed.complete,false);assert.equal(failed.activeCount,null);
  const before=first.sources.find(source=>source.nodeId==='worker')!,after=failed.sources.find(source=>source.nodeId==='worker')!;
  assert.equal(after.online,true);assert.equal(after.error,READ_UPGRADE_MESSAGE);assert.equal(after.observedAt,before.observedAt);
  assert.ok([...failed.current,...failed.olderOpen].some(task=>task.taskId==='task'));
  assert.ok(f.calls.every(call=>call.path==='/workbench/isolated-v1/task-state-index'));
});

test('offline task sources retain their real failure without preventing available task records',async()=>{
  const f=fixture();
  await f.feed.overview('UTC');
  f.nodes[1]!.online=false;
  const page=await f.feed.overview('UTC',true);
  assert.equal(page.complete,false);
  assert.equal(page.coverage.tasks,false);
  assert.equal(page.currentCount,null);
  assert.ok([...page.current,...page.olderOpen].some(task=>task.taskId==='task'));
  assert.equal(page.taskSources.find(source=>source.nodeId==='worker')?.state,'offline');
  assert.deepEqual(page.sources,page.taskSources);
});
