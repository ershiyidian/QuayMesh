import assert from "node:assert/strict";
import test from "node:test";
import {taskView} from "../src/task-view.js";
import {withTaskLifecycle,observeSourceStates} from "../src/console-task-state.js";
import {mergeExecutionObservations,sameExecutionObservation} from "../src/execution-observation.js";
import {activityAgeText,cardPresentation,durationText,isFinal} from "../src/ui/session-card/timing.js";
import {createCardState,applySnapshot} from "../src/ui/session-card/state.js";
import {executionObservationSchema} from "../src/session/schema.js";
import {ExecutionState,HostState,ReviewState,type Snapshot,type CommandSummary} from "../src/session/types.js";

const now=1_800_000_000_000;
const command:CommandSummary={id:"op",operation_id:"op",member_id:"member",cmd:"silent build",agent:"host",status:"run",
  startedAt:now-1_800_000,endedAt:null,exitCode:null,signal:null,attempt:1,supersededBy:null,summary:null,output_ref:"op",output_available:true};
function snapshot(value:Partial<Snapshot>={}):Snapshot{return {
  sessionId:"session",taskId:"task",taskState:"active",taskResult:null,rev:7,changeRev:0,title:"Task",status:"idle",
  execution_status:ExecutionState.idle,review_status:ReviewState.unknown,host_status:HostState.connected,
  startedAt:now-3_600_000,endedAt:null,observedAt:now,serverNow:now,lastModelToolAt:now-30_000,lastActivityAt:now-30_000,
  consoleUrl:"http://localhost/console",workspace:null,workspaces:[],files:[],commands:[],agents:[],instructions:[],skills:[],
  totals:{files:0,commands:0,agents:0},cursors:{files:null,commands:null,agents:null},
  capabilities:{refresh:true,revert:false,continue:false,open_file:false},notices:[],...value};}

for(const result of ["completed","failed","cancelled"] as const){
  test(`卡片和 Console 采用相同的明确终态 ${result}`,()=>{
    const task={id:"task",sessionId:"session",title:"Task",state:"closed",resultStatus:result,revision:8,finishedAt:now,lastActivityAt:now};
    const run=withTaskLifecycle({taskId:"task",executionStatus:result,acceptanceStatus:"pending",finishedAt:now,lastActivityAt:now},task);
    const view=cardPresentation(snapshot({taskState:"closed",taskResult:result,commands:[command],runningCommand:command,
      executionObservation:{observedAt:now,activeOperationIds:[],preparingOperationIds:[],staleOperationIds:[]}}),now);
    assert.equal(run.executionStatus,result);
    assert.equal(view.status,result==="completed"?"success":result);
    assert.equal(view.taskClockDynamic,false);
  });
  test(`历史交付 ${result} 不掩盖实时后台活动与待核对事实`,()=>{
    const task={id:"task",sessionId:"session",title:"Task",state:"closed",resultStatus:result,revision:8,finishedAt:now,lastActivityAt:now};
    const run=withTaskLifecycle({taskId:"task",executionStatus:"running",acceptanceStatus:"pending",finishedAt:null,lastActivityAt:now},task);
    assert.equal(run.executionStatus,'running');
    const active=snapshot({taskState:'closed',taskResult:result,commands:[command],runningCommand:command,
      executionObservation:{observedAt:now,activeOperationIds:['op'],preparingOperationIds:[],staleOperationIds:[]}});
    const activeView=cardPresentation(active,now);
    assert.equal(activeView.status,result==='completed'?'success':result);assert.equal(activeView.backgroundStatus,'running');assert.equal(activeView.backgroundLabel,'后台仍在执行');
    assert.equal(activeView.taskClockDynamic,false);assert.equal(activeView.commandClockDynamic,true);
    assert.equal(isFinal(active,now),false);
    const unknown={...active,executionObservation:{observedAt:now,activeOperationIds:[],preparingOperationIds:[],staleOperationIds:['op']}};
    assert.equal(cardPresentation(unknown,now).status,result==='completed'?'success':result);assert.equal(cardPresentation(unknown,now).backgroundStatus,'unconfirmed');assert.equal(isFinal(unknown,now),false);
    assert.equal(withTaskLifecycle({...run,executionStatus:'unknown'},task).executionStatus,'unknown');
  });
}

test("本轮耗时按请求起点持续计算，静默提示只描述执行活动",()=>{
  const view=cardPresentation(snapshot({lastModelToolAt:now-3_600_000,lastActivityAt:now-3_600_000}),now);
  assert.equal(view.status,"stalled");assert.equal(view.taskClockDynamic,true);assert.equal(view.taskElapsedMs,3_600_000);
  assert.equal(view.taskClockLabel,'本轮耗时');
});

test("三十分钟无输出的真实活跃执行仍显示运行",()=>{
  const value=snapshot({commands:[command],runningCommand:command,lastModelToolAt:now-1_800_000,
    executionObservation:{observedAt:now,activeOperationIds:["op"],preparingOperationIds:[],staleOperationIds:[]}});
  const view=cardPresentation(value,now);assert.equal(view.status,"running");assert.equal(view.commandElapsedMs,1_800_000);
  assert.equal(view.commandClockDynamic,true);
});

test("同一快照失去活性观察后显示待确认，不把时间当成进展",()=>{
  const value=snapshot({commands:[command],runningCommand:command,executionObservation:{observedAt:now-31_000,
    activeOperationIds:["op"],preparingOperationIds:[],staleOperationIds:[]}});
  const view=cardPresentation(value,now);assert.equal(view.status,"unavailable");assert.equal(view.commandClockDynamic,false);
  assert.equal(view.commandElapsedMs,1_769_000);assert.equal(view.taskClockDynamic,true);
  assert.equal(cardPresentation(value,now+60_000).commandElapsedMs,1_769_000);
});

test("明确中断不会因一分钟前的工具活动又显示等待下一步",()=>{
  assert.equal(cardPresentation(snapshot({execution_status:ExecutionState.interrupted}),now).label,"执行已中断");
});

test("不同来源的观察分别过期，新鲜来源可确认相同操作",()=>{
  const combined=mergeExecutionObservations([
    {observedAt:now-40_000,activeOperationIds:["old","both"],preparingOperationIds:[],staleOperationIds:[]},
    {observedAt:now,activeOperationIds:["both"],preparingOperationIds:["new"],staleOperationIds:[]},
  ],now);
  assert.deepEqual(combined.activeOperationIds,["both"]);assert.deepEqual(combined.staleOperationIds,["old"]);
  assert.deepEqual(combined.preparingOperationIds,["new"]);
});

test("相同版本重复一百次不触发重绘，活性时间独立更新",()=>{
  const state=createCardState(),first=snapshot({executionObservation:{observedAt:now,activeOperationIds:["op"],preparingOperationIds:[],staleOperationIds:[]}});
  assert.equal(applySnapshot(state,first).snapshot,true);
  for(let i=1;i<=100;i++)assert.equal(applySnapshot(state,{...first,executionObservation:{...first.executionObservation!,observedAt:now+i}}).snapshot,false);
  assert.equal(state.snapshot?.executionObservation?.observedAt,now+100);
  const stale={...first,executionObservation:{observedAt:now+101,activeOperationIds:[],preparingOperationIds:[],staleOperationIds:["op"]}};
  assert.equal(applySnapshot(state,stale).snapshot,true);
  assert.equal(applySnapshot(state,{...first,rev:6}).snapshot,false);
  assert.equal(state.snapshot?.executionObservation?.staleOperationIds[0],"op");
  assert.throws(()=>applySnapshot(state,{...first,taskId:"another"}),/TASK_CHANGED/);
  assert.throws(()=>applySnapshot(state,{...first,taskId:null}),/TASK_CHANGED/);
});

test("来源过期不覆盖已知终态，同时不同在线节点不相互拖累",()=>{
  const rows=[{nodeId:"offline",executionStatus:"running"},{nodeId:"online",executionStatus:"running"},{nodeId:"offline",executionStatus:"completed"}];
  const out=observeSourceStates(rows,[{nodeId:"offline",online:false,observedAt:now},{nodeId:"online",online:true,observedAt:now}],now);
  assert.deepEqual(out.map(x=>x.executionStatus),["unknown","running","completed"]);
});

test('单个节点离线不遮蔽其他节点的新鲜执行，未知回执仍单独显示',()=>{
  const value=snapshot({host_status:HostState.disconnected,commands:[command],runningCommand:command,
    executionObservation:{observedAt:now,activeOperationIds:['op'],preparingOperationIds:[],staleOperationIds:['offline-op']}});
  const active=cardPresentation(value,now);
  assert.equal(active.status,'running');assert.equal(active.commandClockDynamic,true);
  assert.equal(active.backgroundLabel,'后台仍在执行 · 另有命令结果待核对');
  const expired=cardPresentation(value,now+31_000);
  assert.equal(expired.status,'unavailable');assert.equal(expired.commandClockDynamic,false);
});

test("外部活性载荷拒绝非法集合和时间戳",()=>{
  assert.throws(()=>executionObservationSchema.parse({observedAt:NaN,activeOperationIds:[],preparingOperationIds:[],staleOperationIds:[]}));
  assert.throws(()=>executionObservationSchema.parse({observedAt:now,activeOperationIds:"op",preparingOperationIds:[],staleOperationIds:[]}));
  assert.equal(sameExecutionObservation(undefined,undefined),true);
});

test("交付结束和后台活跃分别保留，失联后台继续允许核对",()=>{
  const view=taskView({requestState:"closed",result:"handed_off",execution:"running",active:true});
  assert.equal(view.requestEnded,true);assert.equal(view.backgroundActive,true);assert.equal(view.clockRunning,false);
  assert.equal(isFinal(snapshot({taskState:"closed",taskResult:"handed_off",executionObservation:{observedAt:now,activeOperationIds:[],preparingOperationIds:[],staleOperationIds:["op"]}})),false);
});

for(const execution of ["stalled","finalizing","unknown","interrupted_recoverable"]){
  test(`Task 生命周期叠加保留已判定状态 ${execution}`,()=>{
    const result=withTaskLifecycle({taskId:"task",executionStatus:execution,acceptanceStatus:"pending",finishedAt:null,lastActivityAt:now},
      {id:"task",sessionId:"session",title:"Task",state:"active",resultStatus:null,revision:1,finishedAt:null,lastActivityAt:now});
    assert.equal(result.executionStatus,execution);
  });
}

test('开放请求没有后台命令时仍显示完整本轮耗时，活动年龄独立增加',()=>{
  const value=snapshot({lastModelToolAt:now-15_000,lastActivityAt:now-15_000});
  const first=cardPresentation(value,now),later=cardPresentation(value,now+30_000);
  assert.equal(first.status,'idle');assert.equal(later.status,'idle');
  assert.equal(first.taskClockDynamic,true);assert.equal(later.taskElapsedMs!-first.taskElapsedMs!,30_000);
  assert.equal(later.activityAgeMs-first.activityAgeMs,30_000);
  assert.equal(value.taskState,'active');assert.equal(value.taskResult,null);
});

test('只有任务创建事件时也能判定全任务静默，本轮耗时保留完整时长',()=>{
  const value=snapshot({startedAt:now-11*60_000,lastModelToolAt:null,lastActivityAt:null,lastExecutionActivityAt:null});
  const view=cardPresentation(value,now);
  assert.equal(view.status,'stalled');assert.equal(view.taskElapsedMs,11*60_000);assert.equal(view.taskClockDynamic,true);
});

test('已完成主状态与丢失命令回执独立，重复刷新不会让任务复活',()=>{
  const value=snapshot({taskState:'closed',taskResult:'completed',deliveryEndedAt:now-10_000,endedAt:now-10_000,
    commands:[{...command,status:'unknown'}],executionObservation:{observedAt:now,activeOperationIds:[],preparingOperationIds:[],staleOperationIds:['op']}});
  const first=cardPresentation(value,now);
  for(const elapsed of [30_000,60_000,30*60_000]){
    const view=cardPresentation({...value,serverNow:now+elapsed,executionObservation:{...value.executionObservation!,observedAt:now+elapsed}},now+elapsed);
    assert.equal(view.status,'success');assert.equal(view.backgroundStatus,'unconfirmed');
    assert.equal(view.taskElapsedMs,first.taskElapsedMs);assert.equal(view.taskClockDynamic,false);
  }
});

test('终态任务拒绝延迟高版本活动快照改写结果和结束时间，仍可补充回执',()=>{
  const state=createCardState();
  applySnapshot(state,snapshot({rev:8,taskState:'closed',taskResult:'completed',deliveryEndedAt:now-5000,endedAt:now-5000}));
  applySnapshot(state,snapshot({rev:9,taskState:'active',taskResult:null,endedAt:null,
    finalization:{state:'pending',requestedAt:now-10_000,error:null},
    executionObservation:{observedAt:now+5000,activeOperationIds:[],preparingOperationIds:[],staleOperationIds:['missing-receipt']}}));
  assert.equal(state.snapshot!.taskState,'closed');assert.equal(state.snapshot!.taskResult,'completed');
  assert.equal(state.snapshot!.deliveryEndedAt,now-5000);
  assert.equal(state.snapshot!.finalization,null);
  assert.deepEqual(state.snapshot!.executionObservation!.staleOperationIds,['missing-receipt']);
});

test('未确认交付的归档也是终态，待核对后台和延迟快照不让它复活',()=>{
  const state=createCardState();
  applySnapshot(state,snapshot({rev:8,taskState:'closed',taskResult:null,closureReason:'superseded',archivedAt:now-5000}));
  applySnapshot(state,snapshot({rev:9,taskState:'active',taskResult:null,finalization:{state:'pending',requestedAt:now-10_000,error:null},
    executionObservation:{observedAt:now,activeOperationIds:[],preparingOperationIds:[],staleOperationIds:['missing-receipt']}}));
  const view=cardPresentation(state.snapshot!,now);
  assert.equal(state.snapshot!.taskState,'closed');assert.equal(state.snapshot!.taskResult,null);
  assert.equal(view.status,'archived');assert.equal(view.label,'已归档 · 交付未确认');
  assert.equal(view.backgroundStatus,'unconfirmed');assert.equal(view.taskClockDynamic,false);
  assert.equal(view.taskElapsedMs,null);assert.equal(state.snapshot!.finalization,null);
  assert.equal(isFinal(state.snapshot,now),false,'后台回执仍可继续核对');
});

test('同业务版本的实时状态可恢复连接，过时观测不能覆盖新的状态',()=>{
  const state=createCardState();
  const base=snapshot({host_status:HostState.disconnected,execution_status:ExecutionState.interrupted,
    live:{observedAt:now,hostStatus:HostState.disconnected,executionStatus:ExecutionState.interrupted}});
  applySnapshot(state,base);
  assert.equal(applySnapshot(state,{...base,live:{observedAt:now+1000,hostStatus:HostState.connected,executionStatus:ExecutionState.idle}}).snapshot,true);
  assert.equal(state.snapshot!.host_status,HostState.connected);assert.equal(state.snapshot!.execution_status,ExecutionState.idle);
  applySnapshot(state,{...base,rev:base.rev+1});
  assert.equal(state.snapshot!.host_status,HostState.connected);assert.equal(state.snapshot!.live!.observedAt,now+1000);
});

test('交付最终确认有独立结构化状态，不依赖提示文案',()=>{
  const value=snapshot({notices:[],finalization:{state:'pending',requestedAt:now-5000,error:null}});
  const view=cardPresentation(value,now);
  assert.equal(view.status,'finalizing');assert.equal(view.taskClockDynamic,true);assert.equal(isFinal(value,now),false);
  const failed=cardPresentation({...value,finalization:{state:'failed',requestedAt:now-5000,error:'receipt unavailable'}},now);
  assert.equal(failed.label,'交付确认失败');assert.equal(failed.taskClockDynamic,true);
  const executing=cardPresentation({...value,finalization:{state:'failed',requestedAt:now-5000,error:'receipt unavailable'},
    executionObservation:{observedAt:now,activeOperationIds:['op'],preparingOperationIds:[],staleOperationIds:[]}},now);
  assert.equal(executing.status,'running');assert.equal(executing.taskClockDynamic,true);
});

test('过期空闲观测显示更新延迟，刷新成功后才允许判断全任务静默',()=>{
  const value=snapshot({lastActivityAt:now-11*60_000,lastModelToolAt:now-11*60_000,
    executionObservation:{observedAt:now-60_000,activeOperationIds:[],preparingOperationIds:[],staleOperationIds:[]}});
  const delayed=cardPresentation(value,now);
  assert.equal(delayed.status,'unavailable');assert.equal(delayed.label,'状态更新延迟');
  assert.equal(delayed.observationStale,true);assert.equal(delayed.confirmedAt,now-60_000);
  const confirmed=cardPresentation({...value,executionObservation:{...value.executionObservation!,observedAt:now}},now);
  assert.equal(confirmed.status,'stalled');assert.equal(confirmed.label,'10 分钟没有新的执行记录');
  const completed={...value,taskState:'closed' as const,taskResult:'completed' as const,deliveryEndedAt:now-30_000};
  assert.equal(cardPresentation(completed,now).status,'success');assert.equal(isFinal(completed,now),true);
});

test('新的响应能够报告更早的源确认时间，晚到旧响应不能覆盖恢复状态',()=>{
  const state=createCardState();
  const fresh=snapshot({executionObservation:{observedAt:now,activeOperationIds:[],preparingOperationIds:[],staleOperationIds:[]},
    live:{observedAt:now,hostStatus:HostState.connected,executionStatus:ExecutionState.idle}});
  applySnapshot(state,fresh);
  const delayed={...fresh,executionObservation:{...fresh.executionObservation!,observedAt:now-60_000,stale:true},
    live:{...fresh.live!,observedAt:now+1000}};
  assert.equal(applySnapshot(state,delayed).snapshot,true);
  assert.equal(state.snapshot!.executionObservation!.observedAt,now-60_000);
  assert.equal(state.snapshot!.executionObservation!.stale,true);
  const recovered={...fresh,executionObservation:{...fresh.executionObservation!,observedAt:now+2000},live:{...fresh.live!,observedAt:now+2000}};
  assert.equal(applySnapshot(state,recovered).snapshot,true);
  applySnapshot(state,delayed);
  assert.equal(state.snapshot!.executionObservation!.stale,undefined);
  assert.equal(state.snapshot!.executionObservation!.observedAt,now+2000);
});

test('命令耗时显示单位和亚秒精度，最近活动使用自然时间',()=>{
  assert.equal(durationText(300),'0.3 秒');
  assert.equal(durationText(1000),'1 秒');
  assert.equal(durationText(61_000),'1 分 1 秒');
  assert.equal(durationText(3_661_000),'1 小时 1 分 1 秒');
  assert.equal(durationText(35),'不足 0.1 秒');
  assert.equal(activityAgeText(300),'刚刚');
  assert.equal(activityAgeText(10_500),'10 秒前');
});

test('不同节点确认时间经过卡片再次汇总，命令仍按自己的确认时间计时',()=>{
  const observation=mergeExecutionObservations([
    {observedAt:now-29_000,activeOperationIds:['earlier-node'],preparingOperationIds:[],staleOperationIds:[]},
    {observedAt:now,activeOperationIds:[command.operation_id],preparingOperationIds:[],staleOperationIds:[]},
  ],now);
  const value=snapshot({commands:[command],runningCommand:command,executionObservation:observation});
  const fresh=cardPresentation(value,now+2_000);
  assert.equal(fresh.status,'running');assert.equal(fresh.commandClockDynamic,true);
  assert.equal(fresh.commandElapsedMs,1_802_000);
  const expired=cardPresentation(value,now+31_000);
  assert.equal(expired.status,'unavailable');assert.equal(expired.commandClockDynamic,false);
  assert.equal(expired.commandElapsedMs,1_800_000,'停在该命令的最后确认时刻');
  const recorded=cardPresentation({...value,executionObservation:mergeExecutionObservations([observation],now+31_000)},now+40_000);
  assert.equal(recorded.commandElapsedMs,1_800_000,'服务器已将命令移入待核对集合时仍保留确认时长');
});
