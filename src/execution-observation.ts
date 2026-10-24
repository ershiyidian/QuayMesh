export const EXECUTION_OBSERVATION_TTL_MS = 30_000;

export interface ExecutionObservation {
  observedAt: number;
  activeOperationIds: string[];
  preparingOperationIds: string[];
  staleOperationIds: string[];
  operationObservedAt?: Record<string, number>;
  stale?: boolean;
}

export function mergeExecutionObservations(values: readonly ExecutionObservation[], now = Date.now()): ExecutionObservation {
  const active = new Set<string>(), preparing = new Set<string>(), staleOperations = new Set<string>();
  const confirmedTimes: number[] = [];
  const operationTimes = new Map<string, number>();
  const remember = (id: string, at: number) => operationTimes.set(id, Math.max(operationTimes.get(id) ?? at, at));
  let stale = false;
  for (const value of values) {
    const expired = now - value.observedAt > EXECUTION_OBSERVATION_TTL_MS;
    stale ||= expired || value.stale === true;
    if (!expired) confirmedTimes.push(value.observedAt);
    for (const [ids, target] of [[value.activeOperationIds, active], [value.preparingOperationIds, preparing]] as const) {
      for (const id of ids) {
        const confirmedAt = value.operationObservedAt?.[id] ?? value.observedAt;
        const operationExpired = now - confirmedAt > EXECUTION_OBSERVATION_TTL_MS;
        (operationExpired ? staleOperations : target).add(id);
        stale ||= operationExpired;
        remember(id, confirmedAt);
      }
    }
    for (const id of value.staleOperationIds) {
      staleOperations.add(id);
      const confirmedAt = value.operationObservedAt?.[id];
      if (confirmedAt !== undefined) remember(id, confirmedAt);
    }
  }
  for (const id of active) { staleOperations.delete(id); preparing.delete(id); }
  for (const id of preparing) staleOperations.delete(id);
  // 过期成员保留待确认状态；其旧时间不能让其它成员的新鲜执行一同过期。
  const observedAt = confirmedTimes.length ? Math.min(...confirmedTimes)
    : values.length ? Math.max(...values.map(value => value.observedAt)) : now;
  // 操作的确认时间随聚合传递；再次合并时各自过期，已过期命令也能固定到最后确认时刻。
  return { observedAt, activeOperationIds: [...active].sort(), preparingOperationIds: [...preparing].sort(),
    staleOperationIds: [...staleOperations].sort(),
    ...(operationTimes.size ? {operationObservedAt: Object.fromEntries(operationTimes)} : {}), stale };
}

export function sameExecutionObservation(a?: ExecutionObservation,b?: ExecutionObservation): boolean {
  if(!a||!b)return a===b;
  return Boolean(a.stale) === Boolean(b.stale) && ['activeOperationIds','preparingOperationIds','staleOperationIds'].every(key=>{
    const k=key as 'activeOperationIds';
    return a[k].length===b[k].length&&a[k].every((id,index)=>id===b[k][index]);
  });
}
