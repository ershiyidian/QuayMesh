import type { CommandSummary, Snapshot } from "../../session/types.js";

export const DEFAULT_SILENCE_WARNING_MS=10*60_000;

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

export function hasBackground(snapshot:Snapshot|null):boolean {
  return Boolean(snapshot&&(
    snapshot.commands.some(command=>command.status==="run"||command.status==="queued")
    ||snapshot.agents.some(agent=>agent.state==="working"||agent.state==="queued")
    ||snapshot.runningCommand?.status==="run"||snapshot.runningCommand?.status==="queued"
  ));
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
  const background=hasBackground(snapshot);
  const finalizationPending=snapshot.notices.some(value=>value.includes("正在确认")||value.includes("结束尚未确认"));
  const modelAt=modelActivityAt(snapshot),executionAt=snapshot.lastExecutionActivityAt??snapshot.lastOperation?.endedAt??snapshot.lastOperation?.startedAt??null;
  const modelAge=age(now,modelAt),executionAge=age(now,executionAt),outputAge=age(now,snapshot.lastOutputAt??null);
  let status:CardStatus,label:string;
  if(snapshot.taskResult==="failed") {status="failed";label="未完成";}
  else if(snapshot.taskResult==="cancelled") {status="cancelled";label="已停止";}
  else if(snapshot.taskResult==="handed_off") {status="handed_off";label=background?"已交接 · 后台执行中":"已交接";}
  else if(snapshot.taskResult==="completed") {status="success";label="已完成";}
  else if(snapshot.closureReason==="superseded"||snapshot.closureReason==="legacy_archive") {status="archived";label="已归档 · 结束未确认";}
  else if(finalizationPending) {status="finalizing";label="正在确认结束";}
  else if(snapshot.host_status==="disconnected") {status="unavailable";label="节点状态暂不可用";}
  else if(snapshot.status==="failed"||snapshot.execution_status==="failed") {status="failed";label="未完成";}
  else if(background) {status="running";label="执行中";}
  else if(modelAge!==null&&modelAge>=silenceWarningMs) {status="stalled";label="长时间无新工具活动，可能中断";}
  else {status="idle";label="等待下一步";}
  const command=snapshot.runningCommand??snapshot.lastCommand??snapshot.currentCommand??null;
  return {
    status,label,taskElapsedMs:taskElapsedMs(snapshot,now),commandElapsedMs:commandElapsedMs(command,now),
    modelActivityAgeMs:modelAge,executionActivityAgeMs:executionAge,outputAgeMs:outputAge,
    taskClockDynamic:deliveryEnd(snapshot)===null&&snapshot.closureReason!=="superseded"&&snapshot.closureReason!=="legacy_archive",
    commandClockDynamic:Boolean(command&&command.startedAt!==null&&command.endedAt===null),
  };
}

export function isFinal(snapshot:Snapshot|null):boolean {
  if(!snapshot)return false;
  // Explicit Task delivery is authoritative. An old member snapshot can still
  // contain a stale running command; it must not keep a completed card polling.
  if(snapshot.taskState==="closed"&&snapshot.taskResult&&snapshot.taskResult!=="handed_off")return true;
  if(hasBackground(snapshot))return false;
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
