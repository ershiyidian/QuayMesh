export const EXECUTION_OBSERVATION_TTL_MS = 30_000;

export interface ExecutionObservation {
  observedAt: number;
  activeOperationIds: string[];
  preparingOperationIds: string[];
  staleOperationIds: string[];
}

export function mergeExecutionObservations(values: readonly ExecutionObservation[], now = Date.now()): ExecutionObservation {
  const active=new Set<string>(),preparing=new Set<string>(),stale=new Set<string>();
  for(const value of values) {
    const expired=now-value.observedAt>EXECUTION_OBSERVATION_TTL_MS;
    for(const id of value.activeOperationIds)(expired?stale:active).add(id);
    for(const id of value.preparingOperationIds)(expired?stale:preparing).add(id);
    for(const id of value.staleOperationIds)stale.add(id);
  }
  for(const id of active){stale.delete(id);preparing.delete(id);}
  for(const id of preparing)stale.delete(id);
  return {observedAt:now,activeOperationIds:[...active].sort(),preparingOperationIds:[...preparing].sort(),staleOperationIds:[...stale].sort()};
}

export function sameExecutionObservation(a?: ExecutionObservation,b?: ExecutionObservation): boolean {
  if(!a||!b)return a===b;
  return ['activeOperationIds','preparingOperationIds','staleOperationIds'].every(key=>{
    const k=key as 'activeOperationIds';
    return a[k].length===b[k].length&&a[k].every((id,index)=>id===b[k][index]);
  });
}
