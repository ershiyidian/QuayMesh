export const TOOL_DEADLINE_META = "quaymesh/deadline_at";

export function toolDeadline(name: string, input: unknown, meta: unknown, now = Date.now()): number {
  const args = input && typeof input==="object" ? input as Record<string,unknown> : {};
  const fields = meta && typeof meta==="object" ? meta as Record<string,unknown> : {};
  const requested = Number(fields[TOOL_DEADLINE_META]);
  const wait = Number(args.yield_time_ms ?? args.timeout_ms ?? args.wait_ms ?? (name==="write_stdin" ? 5000 : 2000));
  // 修改操作由执行节点去重并保存结果；前端快速获得受理回执，
  // 跨节点 RPC 可继续等待实际落盘，减少慢速 Git 基线和临时负载产生的未知结果。
  const budget = name==="download_artifact" ? 15 * 60_000
    : name==="open_workspace" || name==="attach_workspace" ? 25000
    : ["exec_command","bash","apply_patch","write","edit"].includes(name) ? 60_000
    : name==="write_stdin" ? Math.max(25_000, Math.min(12_000, Math.max(0,wait)) + 10_000)
    : ["wait_agent","read_output"].includes(name) && Number.isFinite(wait)
      ? Math.max(10_000,Math.min(12_000,Math.max(0,wait))+3000) : 10_000;
  return Math.min(now+budget,Number.isFinite(requested)&&requested>0 ? requested : Infinity);
}

export function remainingToolTime(deadline: number, now = Date.now()): number {
  const remaining = Math.floor(deadline-now);
  if(remaining<=0)throw new Error("TOOL_REQUEST_EXPIRED: query an accepted operation before retrying a write");
  return remaining;
}
