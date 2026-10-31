import assert from 'node:assert/strict';
import test from 'node:test';
import { taskActivityView, taskLifecycleView, TASK_SILENCE_MS } from './task-view.js';
import { resolveTaskTitle } from './task-title.js';
import { selectOverviewTasks, overviewTaskProgress } from './console-workbench/overview-tasks.js';
import type { TaskIndex } from './console-workbench/task-aggregation.js';

const now=Date.parse('2026-10-31T12:00:00Z');
const old=now-16*60*60_000;
const activity=(extra:Partial<Parameters<typeof taskActivityView>[0]>={})=>taskActivityView({
  requestState:'active',execution:'waiting',lastProgressAt:old,now,...extra,
});
const task=(id:string,extra:Partial<TaskIndex>={}):TaskIndex=>({
  key:'task:'+id,taskId:id,sessionId:'session',title:id,phaseRefs:[],nodeIds:['node'],projectIds:[],projectNames:[],roots:[],
  executionStatus:'waiting',acceptanceStatus:'not_required',startedAt:old,finishedAt:null,lastActivityAt:old,lastProgressAt:old,
  tokens:0,changed:false,actionableInterruption:false,currentPhaseRefs:[],requestState:'active',...extra,
});

test('an open Task with sixteen hours of silence is resumable, not working',()=>{
  assert.deepEqual(taskLifecycleView({requestState:'active'}),{status:'open',label:'未关闭'});
  assert.equal(activity().label,'等待继续');assert.equal(activity().current,false);
  assert.equal(activity({lastProgressAt:now-TASK_SILENCE_MS}).state,'idle');
  assert.equal(activity({lastProgressAt:now-TASK_SILENCE_MS+1}).state,'recent');
});

test('recent activity needs no background command and has no ongoing-work claim',()=>{
  const view=activity({lastProgressAt:now-5*60_000});
  assert.equal(view.current,true);assert.equal(view.label,'最近有活动');
});

test('only a fresh execution-owner observation keeps an otherwise silent training Task current',()=>{
  assert.equal(activity({execution:'running'}).state,'idle');
  assert.equal(activity({execution:'running',executionObservedAt:now-31_000}).current,false);
  assert.equal(activity({execution:'running',executionObservedAt:now+1}).current,false);
  const live=activity({execution:'running',executionObservedAt:now-2000,stale:true});
  assert.equal(live.state,'executing');assert.equal(live.current,true);
  assert.match(live.detail??'',/后台执行仍在运行/);
});

test('a closed Task keeps its delivery result even with background activity',()=>{
  const ended=activity({requestState:'closed',result:'completed',execution:'running',executionObservedAt:now});
  assert.equal(ended.state,'ended');assert.equal(ended.label,'已完成');assert.equal(ended.current,false);
});

test('invalid activity times are unknown and never renewed by a read',()=>{
  for(const value of [null,NaN,Infinity,now+1]){
    const view=activity({lastProgressAt:value});assert.equal(view.state,'unknown');assert.equal(view.current,false);
  }
});

test('overview groups use the same activity boundary and ignore saved-running membership',()=>{
  const rows=[task('old',{lastActivityAt:now}),task('recent',{lastProgressAt:now-1000}),
    task('training',{executionStatus:'running',executionObservedAt:now-1000}),
    task('saved-running',{executionStatus:'running'}),task('old-finalizing',{finalization:{status:'pending',requestedAt:old,error:null}})];
  const groups=selectOverviewTasks(rows,now,()=>true,new Set(['task:old','task:saved-running']));
  assert.deepEqual(groups.current.map(row=>row.taskId),['training','recent']);
  assert.deepEqual(new Set(groups.olderOpen.map(row=>row.taskId)),new Set(['old','saved-running','old-finalizing']));
  assert.equal(groups.current.length+groups.olderOpen.length,rows.length);
  assert.equal(overviewTaskProgress(rows[0]!,'older',now).progressLabel,'等待继续');
});

test('titles preserve explicit task names and derive placeholders from saved user context',()=>{
  assert.deepEqual(resolveTaskTitle({title:'Keep my custom task name',userMessage:'Different message'}),
    {title:'Keep my custom task name',titleSource:'task'});
  assert.deepEqual(resolveTaskTitle({title:'QuayMesh task',userMessage:'修复训练数据加载失败并验证恢复',sessionTitle:'Federated session'}),
    {title:'修复训练数据加载失败并验证恢复',titleSource:'user_message'});
});

test('wrapper-only and generic continuation messages produce honest workspace context',()=>{
  for(const userMessage of ['继续','<environment_context>internal metadata</environment_context>','```json\n{}\n```']){
    const title=resolveTaskTitle({title:'QuayMesh task',userMessage,workspaceNames:['Model training'],createdAt:old});
    assert.equal(title.titleSource,'workspace');assert.match(title.title,/Model training/);
    assert.match(title.title,/2026-10-30 20:00 UTC/);
  }
});
