import {
  isLocalAgentProvider,
  LOCAL_AGENT_PROVIDERS,
  type LocalAgentProfile,
  type LocalAgentProvider,
} from "./local-agent-profiles.js";
import type { SubagentProviderConfig } from "./local-agent-config.js";

export interface ParsedLocalAgentRunArgs {
  target: string;
  prompt: string;
  model?: string;
  effort?: string;
  writeMode?: "read_only";
  taskKey?: string;
  workItemId?: string;
  contextKey?: string;
  freshContext?: boolean;
  requestKey?: string;
}

export interface ParsedLocalAgentContinueArgs {
  agentId: string;
  prompt: string;
  model?: string;
  effort?: string;
  writeMode?: "read_only";
  requestKey?: string;
}

export type LocalAgentTarget =
  | {
      kind: "profile";
      name: string;
      provider: LocalAgentProvider;
      model?: string;
      effort?: string;
      profile: LocalAgentProfile;
    }
  | {
      kind: "provider";
      name: LocalAgentProvider;
      provider: LocalAgentProvider;
      model?: string;
      effort?: string;
    };

export function parseLocalAgentRunArgs(args: string[]): ParsedLocalAgentRunArgs {
  const parsed = parseAgentPromptArgs(
    args,
    'Usage: quaymesh agents run <profile-or-provider> [--task-key <key>] [--read-only] [--model <model>] [--effort <level>] "<prompt>"',
  );
  if (parsed.requestKey) throw new Error("--request-key is for continue; use --task-key for an initial run.");
  return parsed;
}

export function parseLocalAgentContinueArgs(args: string[]): ParsedLocalAgentContinueArgs {
  const parsed = parseAgentPromptArgs(
    args,
    'Usage: quaymesh agents continue <id> [--read-only] [--model <model>] [--effort <level>] "<prompt>"',
  );
  if (parsed.taskKey) throw new Error("--task-key is for an initial run; continue already identifies the existing agent.");
  if (parsed.workItemId || parsed.contextKey || parsed.freshContext) throw new Error("Session affinity is selected by run; continue already identifies a session.");
  return { agentId: parsed.target, prompt: parsed.prompt, model: parsed.model, effort: parsed.effort,
    ...(parsed.requestKey ? { requestKey: parsed.requestKey } : {}), ...(parsed.writeMode ? { writeMode: parsed.writeMode } : {}) };
}

function parseAgentPromptArgs(
  args: string[],
  usage: string,
): ParsedLocalAgentRunArgs {
  const [target, ...rest] = args;
  if (!target) {
    throw new Error(usage);
  }

  let model: string | undefined;
  let effort: string | undefined;
  let writeMode: "read_only" | undefined;
  let taskKey: string | undefined;
  const context: Pick<ParsedLocalAgentRunArgs, "workItemId" | "contextKey" | "freshContext" | "requestKey"> = {};
  const promptParts: string[] = [];
  let optionsEnded = false;
  for (let index = 0; index < rest.length; index += 1) {
    const part = rest[index];
    if (!optionsEnded && part === "--") {
      optionsEnded = true;
      continue;
    }
    if (optionsEnded) {
      promptParts.push(part ?? "");
      continue;
    }
    if (part === "--read-only") {
      writeMode = "read_only";
      continue;
    }
    if (part === "--fresh-context") { context.freshContext = true; continue; }
    const contextOptions = { "--work-item": "workItemId", "--context-key": "contextKey", "--request-key": "requestKey" } as const;
    const contextOption = Object.keys(contextOptions).find((option) => part === option || part?.startsWith(`${option}=`)) as keyof typeof contextOptions | undefined;
    if (contextOption) {
      const value = parseOptionValue(part === contextOption ? rest[++index] : part!.slice(contextOption.length + 1), contextOption);
      if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value) || (contextOption === "--request-key" && value.includes("/"))) throw new Error("Invalid context or request key.");
      context[contextOptions[contextOption]] = value;
      continue;
    }
    if (part === "--task-key" || part?.startsWith("--task-key=")) {
      taskKey = parseOptionValue(part === "--task-key" ? rest[++index] : part.slice("--task-key=".length), "--task-key");
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(taskKey)) throw new Error("Invalid task key.");
      continue;
    }
    if (part === "--model") {
      const value = parseOptionValue(rest[index + 1], "--model");
      model = value;
      index += 1;
      continue;
    }
    if (part?.startsWith("--model=")) {
      const value = parseOptionValue(part.slice("--model=".length), "--model");
      model = value;
      continue;
    }
    if (part === "--effort") {
      const value = parseOptionValue(rest[index + 1], "--effort");
      effort = value;
      index += 1;
      continue;
    }
    if (part?.startsWith("--effort=")) {
      const value = parseOptionValue(part.slice("--effort=".length), "--effort");
      effort = value;
      continue;
    }
    if (part?.startsWith("-")) {
      throw unknownOptionError(part);
    }
    promptParts.push(part ?? "");
  }

  const prompt = promptParts.join(" ").trim();
  if (!prompt) {
    throw new Error(usage);
  }

  return { target, prompt, model, effort, ...context, ...(writeMode ? { writeMode } : {}), ...(taskKey ? { taskKey } : {}) };
}

function parseOptionValue(value: string | undefined, option: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`Missing value for ${option}.`);
  if (trimmed.startsWith("-")) throw unknownOptionError(trimmed);
  return trimmed;
}

function unknownOptionError(option: string): Error {
  return new Error(`Unknown option: ${option}. Use -- before prompt text that starts with a dash.`);
}

export function resolveLocalAgentTarget(
  target: string,
  profiles: LocalAgentProfile[],
  modelOverride?: string,
  effortOverride?: string,
  providerConfigs: readonly SubagentProviderConfig[] = [],
): LocalAgentTarget | undefined {
  const profile = profiles.find((candidate) => candidate.name === target);
  if (profile) {
    const providerConfig = providerConfigs.find((entry) => entry.id === profile.provider);
    return {
      kind: "profile",
      name: profile.name,
      provider: profile.provider,
      model: modelOverride ?? profile.model ?? providerConfig?.model,
      effort: effortOverride ?? profile.effort ?? providerConfig?.effort,
      profile,
    };
  }

  if (isLocalAgentProvider(target)) {
    const providerConfig = providerConfigs.find((entry) => entry.id === target);
    return {
      kind: "provider",
      name: target,
      provider: target,
      model: modelOverride ?? providerConfig?.model,
      effort: effortOverride ?? providerConfig?.effort,
    };
  }

  return undefined;
}
