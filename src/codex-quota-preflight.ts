/** Whitelisted, non-billing quota metadata. Percentages are not token balances. */
export function quotaPreflight(value: unknown) {
  const record = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
  const root = record(value), limits = record(root.rateLimits);
  const window = (v: unknown) => {
    const w = record(v);
    if (typeof w.usedPercent !== "number" || !Number.isFinite(w.usedPercent)) return null;
    return { usedPercent: w.usedPercent,
      windowDurationMins: typeof w.windowDurationMins === "number" ? w.windowDurationMins : null,
      resetsAt: typeof w.resetsAt === "number" ? w.resetsAt : null };
  };
  const reached = limits.rateLimitReachedType;
  // A 100% window may coexist with usable credits or another model bucket.
  // Block only on an explicit provider restriction, never on a guessed window.
  const explicitRestriction = typeof reached === "string" && reached !== "" && reached !== "none";
  return { providerInvoked: false, spendControlReached: root.spendControlReached === true,
    blockedByProvider: root.spendControlReached === true || explicitRestriction,
    restriction: explicitRestriction ? reached.slice(0, 80) : null,
    primary: window(limits.primary), secondary: window(limits.secondary),
    resetCreditConsumed: false, source: "account/rateLimits/read" };
}
