import type { Counts, Usage } from "./types.js";

export function mergeUsage(list: Usage[]): Usage {
  const known = list.filter((item) => item.codexUsage !== null && item.codexUsage !== undefined);
  const missing = list.some((item) => item.usageStatus === "partial" || item.usageStatus === "unavailable");
  const notUsed = list.length > 0 && list.every((item) => item.usageStatus === "not_used");
  const sum = (key: keyof Counts) => known.reduce((total, item) => total + (item.codexUsage?.[key] ?? 0), 0);
  const counts: Counts | null = known.length || notUsed
    ? { totalTokens: sum("totalTokens"), inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens") }
    : null;
  for (const key of ["cachedInputTokens", "reasoningOutputTokens", "cacheWriteInputTokens"] as const) {
    if (counts && known.some((item) => item.codexUsage?.[key] !== undefined)) counts[key] = sum(key);
  }
  return {
    usageStatus: notUsed ? "not_used" : !counts ? "unavailable" : missing ? "partial" : "complete",
    codexUsage: counts,
    missingExecutions: list.reduce((total, item) => total + (item.missingExecutions ?? 0), 0),
    executions: list.reduce((total, item) => total + (item.executions ?? 0), 0),
    pendingExecutions: list.reduce((total, item) => total + (item.pendingExecutions ?? 0), 0),
  };
}
