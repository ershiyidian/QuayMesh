import { mergeExecutionObservations } from "../../execution-observation.js";
import type { CommandSummary, Snapshot } from "../../session/types.js";

import { taskView, TASK_SILENCE_MS } from "../../task-view.js";

export const DEFAULT_SILENCE_WARNING_MS=TASK_SILENCE_MS;

export type CardStatus="running"|"stalled"|"failed"|"success"|"cancelled"|"handed_off"|"finalizing"|"archived"|"idle"|"unavailable";

export interface CardPresentation {
  status:CardStatus;
  label:string;
  taskElapsedMs:number|null;
  commandElapsedMs:number|null;
  modelActivityAgeMs:number|null;
  executionActivityAgeMs:number|null;
  outputAgeMs:number|null;
  taskClockDynamic:boolean;
  commandClockDynamic:boolean;
}

export function hasBackground(snapshot:Snapshot|null,now=Date.now()):boolean {
  if(!snapshot)return false;
  const value=backgroundObservation(snapshot,now);
  return value.activeOperationIds.length>0||value.preparingOperationIds.length>0;
}

function backgroundObservation(snapshot:Snapshot,now:number){
  if(snapshot.executionObservation)return mergeExecutionObservations([snapshot.executionObservation],now);
  // 旧快照也必须使用采样时间，不让缓存中的 running 永久冒充实时活性。
  const commands=[...snapshot.commands,...(snapshot.runningCommand?[snapshot.runningCommand]:[])];
  return mergeExecutionObservations([{observedAt:snapshot.observedAt,
    activeOperationIds:[...commands.filter(command=>command.status==='run').map(command=>command.operation_id),
      ...snapshot.agents.filter(agent=>agent.state==='working').map(agent=>`agent:${agent.id}`)],
    preparingOperationIds:[...commands.filter(command=>command.status==='queued').map(command=>command.operation_id),
      ...snapshot.agents.filter(agent=>agent.state==='queued').map(agent=>`agent:${agent.id}`)],
    staleOperationIds:[...commands.filter(command=>command.status==='unknown').map(command=>command.operation_id),
      ...snapshot.agents.filter(agent=>agent.state==='unknown').map(agent=>`agent:${agent.id}`)]}],now);
}

export function deliveryEnd(snapshot:Snapshot):number|null {
  if(typeof snapshot.deliveryEndedAt==="number")return snapshot.deliveryEndedAt;
  if(snapshot.taskResult&&typeof snapshot.endedAt==="number")return snapshot.endedAt;
  return null;
}

export function taskElapsedMs(snapshot:Snapshot,now:number):number|null {
  const end=deliveryEnd(snapshot);
  if(end!==null)return nonNegative(end-snapshot.startedAt);
  if(snapshot.closureReason==="superseded"||snapshot.closureReason==="legacy_archive")return null;
  return nonNegative(now-snapshot.startedAt);
}

export function commandElapsedMs(command:CommandSummary|null|undefined,now:number):number|null {
  if(!command||command.startedAt===null)return null;
  return nonNegative((command.endedAt??now)-command.startedAt);
}

export function modelActivityAt(snapshot:Snapshot):number|null {
  return snapshot.lastModelToolAt??snapshot.lastActivityAt??null;
}

export function cardPresentation(snapshot:Snapshot,now:number,silenceWarningMs=DEFAULT_SILENCE_WARNING_MS):CardPresentation {
  const observation=backgroundObservation(snapshot,now);
  const finalizationPending=snapshot.notices.some(value=>value.includes("正在确认")||value.includes("结束尚未确认"));
  const modelAt=modelActivityAt(snapshot),executionAt=snapshot.lastExecutionActivityAt??snapshot.lastOperation?.endedAt??snapshot.lastOperation?.startedAt??null;
  const modelAge=age(now,modelAt),executionAge=age(now,executionAt),outputAge=age(now,snapshot.lastOutputAt??null);
  const shared=taskView({requestState:snapshot.taskState,result:snapshot.taskResult,
    execution:snapshot.execution_status,active:observation.activeOperationIds.length>0,queued:observation.preparingOperationIds.length>0,finalizing:finalizationPending,
    unresolved:observation.staleOperationIds.length>0,
    stale:snapshot.host_status==="disconnected",lastProgressAt:modelAt,
    now:now+(TASK_SILENCE_MS-silenceWarningMs)});
  let status:CardStatus,label:string;
  if(shared.status==="running"||shared.status==="queued"||shared.status==="stopping") {
    status="running";label=shared.status==='queued'?"准备执行":shared.status==='stopping'?"正在停止":"执行中";
    if(snapshot.taskState==='closed')label=`${snapshot.taskResult==='handed_off'?'已交接':'请求已结束'} · 后台${label}`;
  }
  else if(shared.status==="unknown") {status="unavailable";label=snapshot.taskState==='closed'?"请求已结束 · 后台结果待核对":snapshot.host_status==='disconnected'?"节点状态暂不可用":"执行状态待确认";}
  else if(shared.status==="finalizing") {status="finalizing";label="交付确认中";}
  else if(shared.status==="failed") {status="failed";label="未完成";}
  else if(shared.status==="cancelled") {status="cancelled";label="已停止";}
  else if(shared.status==="handed_off") {status="handed_off";label="已交接";}
  else if(shared.status==="completed") {status="success";label="已完成";}
  else if(snapshot.closureReason==="superseded"||snapshot.closureReason==="legacy_archive") {status="archived";label="已归档 · 结束未确认";}
  else if(shared.status==="interrupted_recoverable") {status="stalled";label="执行已中断";}
  else if(shared.status==="stalled") {status="stalled";label="长时间没有新的执行进展";}
  else {status="idle";label="当前无后台执行";}
  const command=snapshot.runningCommand??snapshot.lastCommand??snapshot.currentCommand??null;
  const commandLive=Boolean(command&&observation.activeOperationIds.includes(command.operation_id)&&shared.backgroundActive);
  const commandTime=command?.endedAt!=null||commandLive?commandElapsedMs(command,now):null;
  return {
    status,label,taskElapsedMs:shared.clockRunning||deliveryEnd(snapshot)!==null?taskElapsedMs(snapshot,now):null,
    commandElapsedMs:commandTime,
    modelActivityAgeMs:modelAge,executionActivityAgeMs:executionAge,outputAgeMs:outputAge,
    taskClockDynamic:shared.clockRunning&&deliveryEnd(snapshot)===null&&snapshot.closureReason!=="superseded"&&snapshot.closureReason!=="legacy_archive",
    commandClockDynamic:commandLive&&Boolean(command&&command.startedAt!==null&&command.endedAt===null),
  };
}

export function isFinal(snapshot:Snapshot|null,now=Date.now()):boolean {
  if(!snapshot)return false;
  const observation=backgroundObservation(snapshot,now);
  // 交付关闭不代表后台停止；未决或仍活跃的后台必须继续读取真实结果。
  if(observation.activeOperationIds.length||observation.preparingOperationIds.length||observation.staleOperationIds.length)return false;
  if(snapshot.notices.some(value=>value.includes("正在确认")||value.includes("结束尚未确认")))return false;
  return snapshot.taskState==="closed"||(snapshot.taskState===undefined&&!snapshot.capabilities.refresh);
}

export function refreshDelay(snapshot:Snapshot|null,collapsed=false):number|null {
  if(isFinal(snapshot))return null;
  if(collapsed)return 15000;
  return hasBackground(snapshot)||snapshot?.status==="running"?5000:15000;
}

export function needsLocalTimer(snapshot:Snapshot|null):boolean {
  if(!snapshot)return false;
  if(isFinal(snapshot))return false;
  const now=Date.now();
  const view=cardPresentation(snapshot,now);
  return view.taskClockDynamic||view.commandClockDynamic||view.modelActivityAgeMs!==null||view.executionActivityAgeMs!==null;
}

export function elapsedText(milliseconds:number):string {
  const seconds=Math.max(0,Math.floor(milliseconds/1000));
  const minutes=Math.floor(seconds/60);
  return seconds<3600
    ?`${String(minutes).padStart(2,"0")}:${String(seconds%60).padStart(2,"0")}`
    :`${Math.floor(seconds/3600)}:${String(minutes%60).padStart(2,"0")}:${String(seconds%60).padStart(2,"0")}`;
}

export function taskLabel(snapshot:Snapshot):string{return cardPresentation(snapshot,Date.now()).label;}

function age(now:number,value:number|null):number|null{return value===null?null:nonNegative(now-value);}
function nonNegative(value:number):number{return Math.max(0,value);}
