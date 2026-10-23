import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkbenchFeed,mergeSources } from '../../src/console-workbench/feed.js';
import { workspaceHandle } from '../../src/federation/routing.js';
import { totals } from '../../src/console-workbench/query.js';
import type { TaskLifecycle } from '../../src/console-task-state.js';
import type { Run,SourceState } from '../../src/console-workbench/types.js';
import type { TaskPhaseIndex } from '../../src/console-workbench/local-queries.js';
import type { ServerConfig } from '../../src/config.js';
import type { FederationRuntime } from '../../src/federation/runtime.js';

function phase(taskId:string,nodeId='a',status='waiting',tokens=1):Run {
  const localId=taskId+'-'+nodeId,id=workspaceHandle(nodeId,localId),at=Date.now()-1000;
  return {id,localId,title:taskId,nodeId,projectId:workspaceHandle(nodeId,'project'),projectLocalId:'project',projectName:'project',root:'/project',
    executionStatus:status,acceptanceStatus:'pending',startedAt:at,finishedAt:null,lastActivityAt:at,revision:1,workspaceRevision:1,
    sessionId:'session',taskId,memberId:nodeId,usage:{total:tokens,input:tokens,cached:0,output:0,reasoning:0,quality:'complete'},diff:null,
    origin:'chatgpt_mcp',branch:null,baseSha:null,command:null,agent:null,reason:null,warnings:[],currentPhase:true,phaseRefs:[id],
    actions:{interrupt:status==='running',resume:false,review:status==='completed',revert:false,complete:status!=='running'}};
}
function index(run:Run):TaskPhaseIndex {
  return {...run,tokens:run.usage.total,changed:Boolean(run.diff),currentPhase:run.currentPhase!==false,actionableInterruption:run.actionableInterruption===true};
}
function fixture(runs:Run[],tasks:TaskLifecycle[]=[]) {
  const nodes=[{id:'a',nickname:'A',online:true},{id:'b',nickname:'B',online:true},{id:'c',nickname:'C',online:false}];
  const calls:Array<{node:string;path:string}>=[];
  const usageIds=new Set<string>();
  const runtime={nodes:()=>nodes,request:async(node:string,method:string,args:{path:string})=>{
    assert.equal(method,'console');calls.push({node,path:args.path});
    const url=new URL(args.path,'http://test.invalid'),own=runs.filter(run=>run.nodeId===node);
    let body:unknown;
    if(url.pathname==='/workbench/task-index')body={items:own.map(index),observedAt:Date.now()};
    else if(url.pathname==='/workbench/session-titles')body={items:[{id:'session',title:'conversation',revision:1,lastActivityAt:Date.now()}],tasks:node==='a'?tasks:[],authoritative:node==='a'};
    else if(url.pathname==='/workbench/run-summaries')body={items:own.filter(run=>url.searchParams.get('ids')!.split(',').includes(run.localId))};
    else if(url.pathname==='/workbench/overview-usage')body={todayUsage:totals([]),projects:[]};
    else if(url.pathname==='/workbench/usage')body={...totals([]),daily:[],top:[],projects:[],pendingUsage:totals([]),undatedUsage:totals([]),runIds:own.filter(run=>usageIds.has(run.id)).map(run=>run.id)};
    else throw new Error('Unexpected path '+args.path);
    return {status:200,body};
  }} as unknown as FederationRuntime;
  const feed=new WorkbenchFeed({federation:{nodeId:'controller'}} as ServerConfig,runtime);
  return {feed,runs,nodes,calls,usageIds};
}
function lifecycle(id:string,nodes=['a']):TaskLifecycle {
  return {id,sessionId:'session',title:id,state:'active',resultStatus:null,revision:1,finishedAt:null,createdAt:Date.now()-1000,lastActivityAt:Date.now()-1000,
    nodeId:'a',memberNodeIds:nodes,workspaces:nodes.map(nodeId=>({nodeId,projectId:workspaceHandle(nodeId,'project'),memberId:nodeId,name:'project',root:'/project'}))};
}

test('task pagination freezes ordering while tokens and new tasks change, then expires explicitly',async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.now()});
  const f=fixture([phase('one','a','waiting',10),phase('two','a','waiting',9),phase('three','a','waiting',8),phase('four','a','waiting',7)]);
  const query={days:'0',sort:'tokens',limit:'2'};
  const first=await f.feed.runs(query);assert.deepEqual(first.items.map(run=>run.taskId),['one','two']);
  f.runs[2].usage.total=100;f.runs.push(phase('new','a','waiting',200));f.feed.invalidate();
  const next=await f.feed.runs({...query,cursor:first.nextCursor!});
  assert.deepEqual(next.items.map(run=>run.taskId),['three','four']);assert.equal(next.total,4);
  assert.deepEqual((await f.feed.runs({...query,cursor:next.previousCursor!})).items.map(run=>run.taskId),['one','two']);
  assert.deepEqual((await f.feed.runs(query)).items.map(run=>run.taskId),['new','three']);
  t.mock.timers.tick(16*60_000);
  await assert.rejects(f.feed.runs({...query,cursor:first.nextCursor!}),{code:'cursor_expired',status:409});
});

test('node counts use local phases and scoped reads expand only to related task members',async()=>{
  const f=fixture([phase('shared','a','running'),phase('shared','b','waiting')],[lifecycle('shared',['a','b'])]);
  const list=await f.feed.runs({node:'a',days:'0'});
  assert.equal(list.items[0].executionStatus,'running');assert.equal(list.items[0].workspaceCount,2);assert.equal(list.complete,true);
  assert.deepEqual(list.sources.map(source=>source.nodeId).sort(),['a','b']);
  assert.equal(f.calls.some(call=>call.node==='c'&&call.path==='/workbench/task-index'),false);
  const overview=await f.feed.overview('UTC');
  assert.equal(overview.nodeCounts.a.running,1);assert.equal(overview.nodeCounts.b.running,0);assert.equal(overview.nodeCounts.b.waiting,1);
  assert.equal(overview.nodeCounts.c.running,null);assert.equal(overview.activeCount,null);assert.equal(overview.knownCounts.active,1);
  const related=await f.feed.taskRuns('shared');assert.equal(related.complete,true);assert.deepEqual(related.missingNodes,[]);
});

test('navigation groups use request execution facts while review remains an independent facet',async()=>{
  const completed={...lifecycle('finished'),state:'closed',resultStatus:'completed',finishedAt:Date.now()};
  const f=fixture([phase('reviewable','a','completed'),phase('busy','a','running'),phase('finished','a','completed')],
    [lifecycle('reviewable'),lifecycle('busy'),completed]);
  const open=await f.feed.runs({node:'a',days:'0',stage:'waiting,stalled,finalizing'});
  assert.deepEqual(open.items.map(run=>run.taskId),['reviewable']);assert.equal(open.counts.review,1);
  assert.equal(open.counts.scopeAll,3);assert.equal(open.counts.scopeActive,1);assert.equal(open.counts.scopeWaiting,1);assert.equal(open.counts.scopeResults,1);
  assert.deepEqual((await f.feed.overview('UTC')).waiting.map(run=>run.taskId),['reviewable']);
});

test('explicit task refresh reads only its known owner and members and rebuilds the header from returned phase facts',async()=>{
  const task=lifecycle('fresh',['a']),f=fixture([phase(task.id)],[task]);
  await f.feed.taskRuns(task.id);
  f.runs[0]={...f.runs[0],executionStatus:'running',revision:3,actions:{...f.runs[0].actions,interrupt:true}};
  const before=f.calls.length;
  const refreshed=await f.feed.taskRuns(task.id,true);
  assert.equal(refreshed.task?.executionStatus,'running');assert.equal(refreshed.task?.revision,4);
  assert.ok(f.calls.slice(before).every(call=>call.node==='a'));
  const actual={...refreshed.runs[0],executionStatus:'failed',revision:4,actionableInterruption:true};
  const rebuilt=f.feed.taskFromPhases([actual],refreshed.lifecycle)!;
  assert.equal(rebuilt.executionStatus,'failed');assert.equal(rebuilt.revision,5);
});

test('a task with no run remains addressable and a missing registered member never becomes an empty successful scope',async()=>{
  const task=lifecycle('empty'),f=fixture([],[task]);
  const list=await f.feed.runs({node:'a',days:'0'});assert.equal(list.items[0].id,'qmtask:empty');assert.equal(list.items[0].taskRevision,1);
  const detail=await f.feed.taskRuns('empty');assert.equal(detail.task?.actions.complete,true);assert.equal(detail.runs.length,0);
  task.memberNodeIds=['a','removed-node'];f.feed.invalidate();
  const partial=await f.feed.runs({node:'a',days:'0'});assert.equal(partial.complete,false);assert.equal(partial.items[0].executionStatus,'unknown');
  assert.equal(partial.sources.find(source=>source.nodeId==='removed-node')?.state,'offline');
});

test('offline detail preserves an unknown execution even when the delivery result was completed',async()=>{
  const task=lifecycle('background'),f=fixture([phase('background','a','running')],[task]);
  await f.feed.taskRuns(task.id);task.state='closed';task.resultStatus='completed';task.finishedAt=Date.now();
  f.nodes[0].online=false;f.feed.invalidate();
  const detail=await f.feed.taskRuns(task.id);assert.equal(detail.task?.executionStatus,'unknown');assert.equal(detail.complete,false);
});

test('usage drilldown selects execution finish contributors and source merging retains the oldest evidence',async()=>{
  const f=fixture([phase('old-request'),phase('no-usage')]);f.usageIds.add(f.runs[0].id);
  const result=await f.feed.runs({days:'0',usageDate:'2026-10-22',usageDays:'14'});
  assert.deepEqual(result.items.map(run=>run.taskId),['old-request']);
  assert.ok(f.calls.some(call=>call.path.includes('date=2026-10-22')&&call.path.includes('days=14')));
  const source=(nodeId:string,time:number|null):SourceState=>({nodeId,name:nodeId,online:true,state:'ready',stale:false,observedAt:time,error:null});
  const merged=mergeSources([source('a',10)],[source('a',20),source('b',30)]);
  assert.equal(merged[0].observedAt,10);assert.equal(merged[1].nodeId,'b');
  assert.equal(mergeSources(merged,[source('a',null)])[0].observedAt,null);
});
