import assert from "node:assert/strict";
import test from "node:test";
import {ExecutionState,HostState,ReviewState,type CommandSummary,type Snapshot} from "../../src/session/types.js";
import {cardPresentation,commandElapsedMs,DEFAULT_SILENCE_WARNING_MS,isFinal,taskElapsedMs} from "../../src/ui/session-card/timing.js";

const NOW=1_800_000_000_000;

function command(status:CommandSummary["status"],startedAt=NOW-60_000,endedAt:number|null=null):CommandSummary {
  return{id:"op",operation_id:"op",member_id:"member",cmd:"real command",agent:"host",status,startedAt,endedAt,exitCode:status==="ok"?0:null,
    signal:null,attempt:1,supersededBy:null,summary:null,output_ref:"op",output_available:true};
}

function snapshot(overrides:Partial<Snapshot>={}):Snapshot {
  return {
    sessionId:"session",taskId:"task",rev:1,changeRev:0,title:"Task",status:"idle",
    execution_status:ExecutionState.idle,review_status:ReviewState.unknown,host_status:HostState.connected,
    taskState:"active",taskResult:null,startedAt:NOW-3_600_000,endedAt:null,observedAt:NOW,serverNow:NOW,
    lastActivityAt:NOW-30_000,lastModelToolAt:NOW-30_000,lastExecutionActivityAt:NOW-30_000,lastOutputAt:null,
    consoleUrl:null,workspace:null,workspaces:[],files:[],commands:[],agents:[],instructions:[],skills:[],
    totals:{files:0,commands:0,agents:0},cursors:{files:null,commands:null,agents:null},
    capabilities:{refresh:true,revert:false,continue:false,open_file:false},notices:[],
    currentCommand:null,runningCommand:null,lastCommand:null,lastOperation:null,
    ...overrides,
  };
}

test("CD01/CD04：完成命令和完成Task在一小时后仍使用固定结束时间",()=>{
  const completedCommand=command("ok",NOW-50_000,NOW-49_500);
  assert.equal(commandElapsedMs(completedCommand,NOW+3_600_000),500);
  const done=snapshot({taskState:"closed",taskResult:"completed",deliveryEndedAt:NOW-10_000,endedAt:NOW-10_000,
    lastCommand:completedCommand,currentCommand:completedCommand,capabilities:{refresh:false,revert:false,continue:false,open_file:false}});
  assert.equal(taskElapsedMs(done,NOW+3_600_000),3_590_000);
  const view=cardPresentation(done,NOW+3_600_000);
  assert.equal(view.status,"success");assert.equal(view.commandElapsedMs,500);
  assert.equal(view.taskClockDynamic,false);assert.equal(view.commandClockDynamic,false);
});

test("CD02/CD06：无后台的一小时静默显示明确提示，卡片查询时间不冒充模型活动",()=>{
  const silent=snapshot({lastModelToolAt:NOW-3_600_000,lastActivityAt:NOW-3_600_000,serverNow:NOW+3_600_000,observedAt:NOW+3_600_000});
  const view=cardPresentation(silent,NOW);
  assert.equal(view.status,"stalled");assert.equal(view.label,"长时间没有新的执行进展");
  assert.equal(view.modelActivityAgeMs,3_600_000);
});

test("CD03：后台运行和无输出只显示事实，不自动判定失败或取消",()=>{
  const running=command("run",NOW-20*60_000,null);
  const active=snapshot({status:"running",execution_status:ExecutionState.active,commands:[running],runningCommand:running,currentCommand:running,
    lastModelToolAt:NOW-30*60_000,lastExecutionActivityAt:NOW-20*60_000,lastOutputAt:NOW-18*60_000});
  const view=cardPresentation(active,NOW);
  assert.equal(view.status,"running");assert.equal(view.commandClockDynamic,true);
  assert.equal(view.outputAgeMs,18*60_000);
});

test("CD05：交接固定本轮时长，后台时长继续；归档空结果不显示成功",()=>{
  const running=command("run",NOW-120_000,null);
  const handed=snapshot({taskState:"closed",taskResult:"handed_off",deliveryEndedAt:NOW-90_000,endedAt:NOW-90_000,
    commands:[running],runningCommand:running,currentCommand:running});
  const handedView=cardPresentation(handed,NOW);
  assert.equal(handedView.status,"running");assert.match(handedView.label,/已交接/);assert.equal(handedView.taskClockDynamic,false);assert.equal(handedView.commandClockDynamic,true);

  const archived=snapshot({taskState:"closed",taskResult:null,closureReason:"superseded",archivedAt:NOW-10_000,endedAt:null,
    capabilities:{refresh:false,revert:false,continue:false,open_file:false}});
  const archivedView=cardPresentation(archived,NOW+60_000);
  assert.equal(archivedView.status,"archived");assert.equal(archivedView.taskElapsedMs,null);
});

test("CD07：静默阈值边界明确",()=>{
  assert.equal(cardPresentation(snapshot({lastModelToolAt:NOW-DEFAULT_SILENCE_WARNING_MS+1}),NOW).status,"idle");
  assert.equal(cardPresentation(snapshot({lastModelToolAt:NOW-DEFAULT_SILENCE_WARNING_MS}),NOW).status,"stalled");
});

test("CD08：明确交付结果优先于临时节点离线/历史执行错误",()=>{
  const done=snapshot({taskState:"closed",taskResult:"completed",deliveryEndedAt:NOW-1000,endedAt:NOW-1000,
    status:"failed",execution_status:ExecutionState.failed,host_status:HostState.disconnected});
  const view=cardPresentation(done,NOW+3600_000);
  assert.equal(view.status,"success");
  assert.equal(view.taskClockDynamic,false);
  assert.equal(view.taskElapsedMs,NOW-1000-done.startedAt);
  const stale=command("run",NOW-2000,null);
  const cached=snapshot({taskState:"closed",taskResult:"completed",deliveryEndedAt:NOW-1000,commands:[stale],runningCommand:stale});
  assert.equal(isFinal(cached,NOW+60_000),false);
  const unknown={...cached,commands:[command('unknown')],runningCommand:null};
  assert.equal(cardPresentation(unknown,NOW).status,'unavailable');assert.equal(isFinal(unknown,NOW),false);
  assert.equal(isFinal({...cached,executionObservation:{observedAt:NOW,activeOperationIds:[],preparingOperationIds:[],staleOperationIds:[]}},NOW),true);
});
