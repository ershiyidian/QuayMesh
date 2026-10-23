import assert from "node:assert/strict";
import test from "node:test";
import {taskView} from "../src/task-view.js";
import {withTaskLifecycle,observeSourceStates} from "../src/console-task-state.js";
import {mergeExecutionObservations,sameExecutionObservation} from "../src/execution-observation.js";
import {cardPresentation,isFinal} from "../src/ui/session-card/timing.js";
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
    assert.equal(activeView.status,'running');assert.match(activeView.label,/请求已结束/);
    assert.equal(activeView.taskClockDynamic,false);assert.equal(activeView.commandClockDynamic,true);
    assert.equal(isFinal(active,now),false);
    const unknown={...active,executionObservation:{observedAt:now,activeOperationIds:[],preparingOperationIds:[],staleOperationIds:['op']}};
    assert.equal(cardPresentation(unknown,now).status,'unavailable');assert.equal(isFinal(unknown,now),false);
    assert.equal(withTaskLifecycle({...run,executionStatus:'unknown'},task).executionStatus,'unknown');
  });
}

test("一小时无进展时停止执行计时，不伪造结束时间",()=>{
  const view=cardPresentation(snapshot({lastModelToolAt:now-3_600_000}),now);
  assert.equal(view.status,"stalled");assert.equal(view.taskClockDynamic,false);assert.equal(view.taskElapsedMs,null);
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
  assert.equal(view.commandElapsedMs,null);assert.equal(view.taskClockDynamic,false);
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
});

test("来源过期不覆盖已知终态，同时不同在线节点不相互拖累",()=>{
  const rows=[{nodeId:"offline",executionStatus:"running"},{nodeId:"online",executionStatus:"running"},{nodeId:"offline",executionStatus:"completed"}];
  const out=observeSourceStates(rows,[{nodeId:"offline",online:false,observedAt:now},{nodeId:"online",online:true,observedAt:now}],now);
  assert.deepEqual(out.map(x=>x.executionStatus),["unknown","running","completed"]);
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
