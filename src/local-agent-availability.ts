import {
  LOCAL_AGENT_PROVIDERS,
  type LocalAgentProvider,
} from "./local-agent-profiles.js";
import { resolveExecutableCommand, mergeEnvironment } from "./local-agent-command.js";
import { codexCommandEnvironment } from "./local-agent-codex.js";
import {
  localAgentProviderEnvironment,
  type SubagentsConfig,
} from "./local-agent-config.js";

export interface LocalAgentProviderAvailability {
  name: LocalAgentProvider;
  available: boolean;
  reason?: string;
  note?: string;
  verification?: "command_resolved" | "package_resolved" | "unavailable";
  executable?: string;
  accountVerified?: boolean;
}

export function getLocalAgentProviderAvailabilitySnapshot(
  env: NodeJS.ProcessEnv = process.env,
  config?: SubagentsConfig,
): LocalAgentProviderAvailability[] {
  return LOCAL_AGENT_PROVIDERS.map((provider) => (
    checkLocalAgentProviderAvailability(provider, env, config)
  ));
}

function checkLocalAgentProviderAvailability(
  provider: LocalAgentProvider,
  env: NodeJS.ProcessEnv = process.env,
  config?: SubagentsConfig,
): LocalAgentProviderAvailability {
  const providerEnv = config ? localAgentProviderEnvironment(config, provider, env) : mergeEnvironment(process.platform, env);
  switch (provider) {
    case "codex":
      return codexAvailability(providerEnv);
    case "claude":
      return providerEnv.CLAUDE_COMMAND
        ? commandAvailability(provider, providerEnv.CLAUDE_COMMAND, providerEnv)
        : packageAvailability(provider, "@anthropic-ai/claude-agent-sdk");
    case "opencode":
      return packageAvailability(provider, "@opencode-ai/sdk/v2");
    case "pi":
      return packageAvailability(provider, "@earendil-works/pi-coding-agent");
    case "cursor":
      return commandAvailability(provider, providerEnv.CURSOR_COMMAND ?? "cursor-agent", providerEnv);
    case "copilot":
      return commandAvailability(provider, providerEnv.COPILOT_COMMAND ?? "copilot", providerEnv);
    case "grok":
      return commandAvailability(provider, providerEnv.GROK_COMMAND ?? "grok", providerEnv);
  }
}

export function assertLocalAgentProviderAvailable(
  provider: LocalAgentProvider,
  env: NodeJS.ProcessEnv = process.env,
  config?: SubagentsConfig,
): void {
  const availability = checkLocalAgentProviderAvailability(provider, env, config);
  if (availability.available) return;
  throw new Error(
    `${provider} provider is not available: ${availability.reason ?? "provider preflight failed"}`,
  );
}

function packageAvailability(
  provider: LocalAgentProvider,
  packageName: string,
): LocalAgentProviderAvailability {
  try {
    import.meta.resolve(packageName);
    return { name: provider, available: true, verification: "package_resolved", accountVerified: false };
  } catch {
    return {
      name: provider,
      available: false,
      verification: "unavailable",
      reason: `${packageName} package not found`,
    };
  }
}

function codexAvailability(env: NodeJS.ProcessEnv): LocalAgentProviderAvailability {
  const availability = commandAvailability("codex", env.CODEX_COMMAND ?? "codex", codexCommandEnvironment(env));
  return availability.available
    ? {
        ...availability,
        note: "已找到程序",
      }
    : availability;
}

function commandAvailability(
  provider: LocalAgentProvider,
  command: string,
  env: NodeJS.ProcessEnv,
): LocalAgentProviderAvailability {
  const executable = resolveExecutableCommand(command, env);
  if (executable) return { name: provider, available: true, verification: "command_resolved", executable, accountVerified: false };
  return {
    name: provider,
    available: false,
    verification: "unavailable",
    reason: `${command} executable not found`,
  };
}
