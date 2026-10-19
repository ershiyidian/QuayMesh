import type { SessionEvent } from "./types.js";

/** 读取时只展示当前尝试，原始事件历史保持完整。 */
export function currentOperationEvents(events: SessionEvent[]): SessionEvent[] {
  const retried = new Set<string>(), superseded = new Set<string>(), current = new Map<string, string>();
  for (const event of events) {
    if (event.type !== "operation_started" || typeof event.payload.retry_of_invocation_id !== "string") continue;
    retried.add(String(event.payload.operation_id ?? event.source_id));
    superseded.add(event.payload.retry_of_invocation_id);
  }
  for (const event of events) {
    if (event.type !== "operation_started" && event.type !== "operation_finished") continue;
    const id = String(event.payload.operation_id ?? event.source_id), attempt = event.payload.invocation_id;
    if (retried.has(id) && typeof attempt === "string" && !superseded.has(attempt)) current.set(id, attempt);
  }
  return events.filter(event => {
    if (event.type !== "operation_started" && event.type !== "operation_finished") return true;
    const id = String(event.payload.operation_id ?? event.source_id);
    return !current.has(id) || event.payload.invocation_id === current.get(id);
  });
}

export interface TaskActivity {
  operation_id:string;
  member_id:string;
  kind:string;
  label:string;
  state:string;
  startedAt:number;
  endedAt:number|null;
}

export interface TaskActivityTimes {
  lastModelToolAt:number|null;
  lastExecutionActivityAt:number|null;
  lastOutputAt:number|null;
}

export function activityTimes(events:SessionEvent[],memberId?:string):TaskActivityTimes {
  let lastModelToolAt:number|null=null,lastExecutionActivityAt:number|null=null,lastOutputAt:number|null=null;
  for(const event of events) {
    if(memberId&&event.member_id!==memberId)continue;
    const timestamp=Date.parse(event.timestamp);
    if(!Number.isFinite(timestamp))continue;
    const actor=String(event.payload.actor??"model");
    if(event.type==="operation_started"||event.type==="context_read") {
      if(actor==="model")lastModelToolAt=Math.max(lastModelToolAt??0,timestamp);
    }
    if(event.type==="operation_started"||event.type==="operation_finished"||event.type==="operation_output"||event.type==="agent_changed") {
      lastExecutionActivityAt=Math.max(lastExecutionActivityAt??0,timestamp);
    }
    if(event.type==="operation_output")lastOutputAt=Math.max(lastOutputAt??0,timestamp);
  }
  return {lastModelToolAt,lastExecutionActivityAt,lastOutputAt};
}

export function latestActivity(events: SessionEvent[], memberId?: string): TaskActivity | null {
  const operations=new Map<string,TaskActivity>();
  let latest:TaskActivity|null=null;
  for(const event of currentOperationEvents(events)) {
    if(memberId && event.member_id!==memberId)continue;
    if(!["operation_started","operation_finished"].includes(event.type))continue;
    const id=String(event.payload.operation_id ?? event.source_id);
    const previous=operations.get(id);
    if(event.type==="operation_started" && previous?.endedAt!==null && previous?.endedAt!==undefined)continue;
    const next:TaskActivity={
      operation_id:id,member_id:event.member_id,
      kind:String(event.payload.kind ?? previous?.kind ?? "read"),
      label:String(event.payload.label ?? previous?.label ?? "工具操作"),
      state:String(event.payload.status ?? (event.type==="operation_finished"?"unknown":"running")),
      startedAt:previous?.startedAt ?? Date.parse(event.timestamp),
      endedAt:event.type==="operation_finished"?Date.parse(event.timestamp):null,
    };
    operations.set(id,next);
    if(!latest || (next.endedAt ?? next.startedAt)>=(latest.endedAt ?? latest.startedAt))latest=next;
  }
  return latest;
}
