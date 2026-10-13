import type { SubagentProviderConfig } from "./local-agent-config.js";

const efforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

export function limitedReasoningEffort(provider: SubagentProviderConfig | undefined, model: string | undefined, effort: string | undefined): string | undefined {
  const limits = provider?.reasoningLimits;
  if (!limits?.length) return effort;
  if (provider?.id !== "codex") throw new Error("Reasoning limits require the Codex provider.");
  if (!model) throw new Error("An explicit resolved model is required when reasoning limits are configured.");
  const normalized = model.trim().toLowerCase();
  const matching = limits.filter((limit) => normalized === limit.model || normalized.startsWith(`${limit.model}-`));
  if (!matching.length) return effort;
  const maximum = Math.min(...matching.map((limit) => efforts.indexOf(limit.maxEffort)));
  if (maximum < 0) throw new Error("Unknown configured reasoning limit.");
  if (effort === undefined) return efforts[maximum];
  const requested = efforts.indexOf(effort);
  if (requested < 0) throw new Error("Unknown reasoning effort for a capped model; specify a supported effort.");
  return efforts[Math.min(requested, maximum)];
}
