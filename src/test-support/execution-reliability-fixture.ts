/** Read-only managed-state evidence, 2026-09-07. No prompt, output, command or provider identity. */
export const executionReliabilityTrace = {
  runId: "run_f6c071568422400f88a81effd9cdfccd",
  executionId: "exec_4a6bf10bfb4c487186b2a7e7858c6307",
  executionMs: 4_521_951,
  providerLogMs: 4_521_948,
  queueMs: 300_057,
  queueProviderRequests: 0,
  acceptance: "pending",
  delta: { inputTokens: 23_492_003, cachedInputTokens: 23_140_736, cacheWriteInputTokens: 0,
    outputTokens: 73_403, reasoningOutputTokens: 22_144, totalTokens: 23_565_406 },
  // Exact host call count is unavailable locally. Synthetic stress events replay the mechanism only.
  syntheticUsageUpdates: 120,
} as const;
