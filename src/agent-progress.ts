/** Deliberately closed vocabulary. Never retain provider text, arguments or output. */
export const toolCategories = ["build", "test", "command", "read", "edit", "tool"] as const;
export type ToolCategory = typeof toolCategories[number];
export interface AgentActivity { phase: "provider" | "tool"; toolCategory?: ToolCategory }
export interface AgentProgress {
  phase: "queued" | "preparing" | "provider" | "tool" | "finished";
  startedAt: string;
  admittedAt?: string;
  lastActivityAt: string;
  toolCategory?: ToolCategory;
}

/** Inspect only the executable and its immediate, known subcommand. Shell wrappers,
 * compound syntax and unfamiliar options deliberately fall back to command. */
function commandCategory(command: string): ToolCategory {
  const prefix = command.slice(0, 4096);
  if (/[;&|`$<>\r\n]/.test(prefix)) return "command";
  const match = /^\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s"']+))(?:\s+|$)(.*)$/.exec(prefix);
  if (!match) return "command";
  const executable = (match[1] ?? match[2] ?? match[3]!).split(/[\\/]/).pop()!.toLowerCase().replace(/\.(?:exe|cmd|bat)$/, "");
  const args = match[4]!.trim().split(/\s+/);
  if (["pytest", "py.test", "vitest", "jest"].includes(executable)) return "test";
  if (executable === "tsc") return "build";
  if (executable === "go") return args[0] === "test" ? "test" : args[0] === "build" ? "build" : "command";
  if (["npm", "pnpm", "yarn"].includes(executable)) {
    const task = args[0] === "run" ? args[1] : args[0];
    return task === "test" ? "test" : task === "build" ? "build" : "command";
  }
  if (["gradle", "gradlew"].includes(executable)) {
    return /^(?::[\w.-]+:|:)?test(?:[A-Z]\w*)?$/.test(args[0] ?? "") ? "test"
      : /^(?::[\w.-]+:|:)?(?:assemble\w*|build)$/.test(args[0] ?? "") ? "build" : "command";
  }
  if (["python", "python3", "py"].includes(executable) && args[0] === "-m" && args[1] === "pytest") return "test";
  return "command";
}

export function decodeAgentProgress(value: unknown): AgentProgress | undefined {
  if (!value || typeof value !== "object") return undefined;
  const p = value as Record<string, unknown>;
  const date = (v: unknown): v is string => typeof v === "string" && v.length <= 30 && Number.isFinite(Date.parse(v));
  if (!["queued", "preparing", "provider", "tool", "finished"].includes(String(p.phase)) || !date(p.startedAt) || !date(p.lastActivityAt)) return undefined;
  return { phase: p.phase as AgentProgress["phase"], startedAt: p.startedAt, lastActivityAt: p.lastActivityAt,
    ...(date(p.admittedAt) ? { admittedAt: p.admittedAt } : {}),
    ...(toolCategories.includes(p.toolCategory as ToolCategory) ? { toolCategory: p.toolCategory as ToolCategory } : {}) };
}

/** Classify only known item envelopes; command matching is a hint, never a claim of success. */
export function codexActivity(method: string, value: unknown): AgentActivity | undefined {
  if (method !== "item/started" && method !== "item/completed") return undefined;
  const item = value && typeof value === "object" ? (value as { item?: Record<string, unknown> }).item : undefined;
  if (!item || typeof item !== "object") return undefined;
  if (method === "item/completed") return { phase: "provider" };
  switch (item.type) {
    case "commandExecution": {
      const command = typeof item.command === "string" ? item.command.slice(0, 4096) : "";
      const toolCategory = commandCategory(command);
      return { phase: "tool", toolCategory };
    }
    case "fileChange": return { phase: "tool", toolCategory: "edit" };
    case "mcpToolCall": case "dynamicToolCall": case "webSearch": return { phase: "tool", toolCategory: "tool" };
    case "agentMessage": case "reasoning": return { phase: "provider" };
    default: return undefined;
  }
}
