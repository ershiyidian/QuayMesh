/** 已应答的写请求仍可能等待后台执行，核验应跟随同一回执直到确认终态。 */
export function receiptResponsePending(response: unknown): boolean {
  const queue: unknown[] = [response], seen = new Set<object>();
  while (queue.length) {
    const value = queue.pop();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) { queue.push(...value); continue; }
    const record = value as Record<string, unknown>;
    if (record.pending === true || record.status === "accepted" || record.status === "pending") return true;
    // 只检查回执的已知包装字段，不把用户内容里的状态文本解释为执行状态。
    for (const key of ["results", "targets", "receipts", "receipt", "response", "batch"]) queue.push(record[key]);
  }
  return false;
}
