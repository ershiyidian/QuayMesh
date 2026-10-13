import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { terminateProcessTree } from "../src/process-platform.js";

type GroupStatus = "passed" | "failed" | "not_run";

interface CommandSpec {
  executable: string;
  args: string[];
  timeoutMs: number;
}

interface GroupSpec {
  id: string;
  title: string;
  required: boolean;
  commands: CommandSpec[];
  run: boolean;
}

interface CommandResult {
  command: string;
  startedAt: string;
  finishedAt: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  error: string | null;
  logPath: string;
}

interface GroupResult {
  id: string;
  title: string;
  required: boolean;
  status: GroupStatus;
  startedAt: string | null;
  finishedAt: string | null;
  commands: CommandResult[];
  error: string | null;
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const acceptanceDirectory = join(repositoryRoot, "releases", "session-acceptance");
const logDirectory = join(acceptanceDirectory, "logs");
const summaryPath = join(acceptanceDirectory, "summary.json");
const withCodex = process.argv.includes("--with-codex");
const runStartedAt = new Date().toISOString();
const runId = runStartedAt.replace(/[:.]/g, "-") + "-" + randomUUID();
let activeChild: ReturnType<typeof spawn> | undefined;
let interrupted = false;

const processTests = [
  "src/process-sessions.test.ts",
  "src/process-platform.test.ts",
  "src/process-descendants.test.ts",
  "src/process-recovery.test.ts",
  "src/process-evidence.test.ts",
  "src/process-cancel-live.test.ts",
  "src/session/output.test.ts",
];

const groups: GroupSpec[] = [
  {
    id: "typecheck",
    title: "TypeScript 类型检查",
    required: true,
    run: true,
    commands: [tscCommand(180_000)],
  },
  {
    id: "session-core",
    title: "会话存储、调用、上下文与恢复",
    required: true,
    run: true,
    commands: [testCommand([
      "src/db/migrations.test.ts",
      "src/session/session-store.test.ts",
      "src/session/binding.test.ts",
      "src/session/invocations.test.ts",
      "src/session/context-reads.test.ts",
      "src/session/recovery.test.ts",
      "src/session/agent-operations.test.ts",
      "src/session/agent-results.test.ts",
      "src/session/prompts.test.ts",
    ], 300_000)],
  },
  {
    id: "real-git",
    title: "真实 Git 差异、撤销与解析",
    required: true,
    run: true,
    commands: [testCommand([
      "src/session/changes.test.ts",
      "src/session/revert.test.ts",
      "src/apply-patch.test.ts",
      "src/ui/patch-display.test.ts",
      "src/workspace-context-tool.test.ts",
      "src/workspace-store.test.ts",
      "src/workspaces.test.ts",
      "src/git-worktrees.test.ts",
      "src/cli-worktrees.test.ts",
    ], 360_000)],
  },
  {
    id: "real-process",
    title: "真实进程、输出与恢复",
    required: true,
    run: true,
    commands: [testCommand(processTests, 360_000)],
  },
  {
    id: "classic-modern-surface",
    title: "传统与现代 MCP 接口",
    required: true,
    run: true,
    commands: [testCommand([
      "src/server.test.ts",
      "src/mcp-modern-server.test.ts",
      "src/tool-surfaces/codex.test.ts",
      "src/tool-surfaces/subagents.test.ts",
      "test/session-card/surface.test.ts",
      "test/session-card/current-issues.test.ts",
      "test/session-card/prompts.test.ts",
    ], 600_000)],
  },
  {
    id: "real-federation",
    title: "真实双节点联邦",
    required: true,
    run: true,
    commands: [testCommand([
      "test/federation/core.test.ts",
      "test/federation/runtime.test.ts",
      "test/federation/transport-edge.test.ts",
      "test/session-card/federation.test.ts",
      "test/session-card/current-federation.test.ts",
    ], 360_000)],
  },
  {
    id: "build-surface",
    title: "正式构建与生产界面检查",
    required: true,
    run: true,
    commands: [
      { executable: pnpmExecutable(), args: ["run", "build:app"], timeoutMs: 300_000 },
      { executable: pnpmExecutable(), args: ["check:session-surface"], timeoutMs: 300_000 },
    ],
  },
  {
    id: "browser",
    title: "真实 MCP Apps 浏览器验收",
    required: true,
    run: true,
    commands: [{
      executable: pnpmExecutable(),
      args: ["exec", "playwright", "test", "--config", "test/session-card/playwright.config.ts", "--reporter=line"],
      timeoutMs: 240_000,
    }],
  },
  {
    id: "codex",
    title: "真实 Codex 与子代理验收",
    required: false,
    run: withCodex,
    commands: [{
      executable: pnpmExecutable(),
      args: ["exec", "tsx", "--test", "--test-concurrency=1", "test/session-card/codex-live.test.ts"],
      timeoutMs: 600_000,
    }],
  },
];

function testCommand(files: string[], timeoutMs: number): CommandSpec {
  return {
    executable: pnpmExecutable(),
    args: ["exec", "tsx", "--test", "--test-concurrency=1", ...files],
    timeoutMs,
  };
}

function tscCommand(timeoutMs: number): CommandSpec {
  return {
    executable: pnpmExecutable(),
    args: ["exec", "tsc", "-p", "tsconfig.json", "--noEmit"],
    timeoutMs,
  };
}

function pnpmExecutable(): string {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

await mkdir(logDirectory, { recursive: true });
const results: GroupResult[] = [];
let requiredFailure = false;

process.once("SIGINT", () => {
  interrupted = true;
  void stopActiveChild("SIGINT");
});
process.once("SIGTERM", () => {
  interrupted = true;
  void stopActiveChild("SIGTERM");
});

try {
  for (const group of groups) {
    if (!group.run) {
      results.push(notRun(group, "not requested"));
      continue;
    }
    if (requiredFailure || interrupted) {
      results.push(notRun(group, interrupted ? "interrupted" : "blocked by an earlier required failure"));
      continue;
    }

    const groupResult: GroupResult = {
      id: group.id,
      title: group.title,
      required: group.required,
      status: "failed",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      commands: [],
      error: null,
    };
    results.push(groupResult);
    process.stdout.write("[session-acceptance] " + group.id + ": start\n");

    for (const [index, command] of group.commands.entries()) {
      const logPath = join(logDirectory, runId + "-" + group.id + "-" + (index + 1) + ".log");
      const result = await runCommand(command, logPath);
      groupResult.commands.push(result);
      const passed = result.exitCode === 0 && !result.timedOut && result.error === null;
      process.stdout.write("[session-acceptance] " + group.id + ": " + (passed ? "passed" : "failed") + " (" + commandLabel(command) + ")\n");
      if (!passed) break;
    }

    groupResult.finishedAt = new Date().toISOString();
    groupResult.status = groupResult.commands.length === group.commands.length
      && groupResult.commands.every((command) => command.exitCode === 0 && !command.timedOut && command.error === null)
      ? "passed"
      : "failed";
    if (groupResult.status === "failed") {
      groupResult.error = groupResult.commands.find((command) => command.timedOut || command.error || command.exitCode !== 0)?.error
        ?? "command exited nonzero";
      if (group.required) requiredFailure = true;
      process.stdout.write("[session-acceptance] " + group.id + ": failed\n");
    } else {
      process.stdout.write("[session-acceptance] " + group.id + ": passed\n");
    }
  }
} finally {
  const required = results.filter((group) => group.required);
  const failed = results.find((group) => group.status === "failed");
  const codex = results.find((group) => group.id === "codex");
  const browser = results.find((group) => group.id === "browser");
  const allRequiredPassed = required.length > 0 && required.every((group) => group.status === "passed");
  const fullyVerified = allRequiredPassed && withCodex && codex?.status === "passed" && !interrupted;
  const overallStatus = failed ? "failed" : fullyVerified ? "passed" : "passed_with_unrun_optional";
  const summary = {
    status: overallStatus,
    fullyVerified,
    interrupted,
    withCodex,
    startedAt: runStartedAt,
    finishedAt: new Date().toISOString(),
    command: "pnpm test:session" + (withCodex ? " -- --with-codex" : ""),
    groups: results,
    locallyVerifiedBridge: {
      status: browser?.status === "passed" ? "passed" : browser?.status ?? "not_run",
      evidencePath: browser?.commands.at(-1)?.logPath ?? null,
      note: "真实浏览器进程、真实 MCP 服务、真实 AppBridge 卡片资源",
    },
    currentHostRendering: {
      status: "not_run",
      reason: "当前 Desktop 或聊天宿主中的最终视觉呈现不在本地自动验收范围内",
    },
  };
  await writeFile(summaryPath, JSON.stringify(summary, null, 2) + "\n", "utf8");
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  if (overallStatus === "failed") process.exitCode = interrupted ? 130 : 1;
}

async function stopActiveChild(signal: NodeJS.Signals): Promise<void> {
  const child = activeChild;
  if (!child?.pid) return;
  await terminateProcessTree(child, signal, process.platform !== "win32");
}

async function runCommand(command: CommandSpec, logPath: string): Promise<CommandResult> {
  const startedAt = new Date().toISOString();
  const log = createWriteStream(logPath, { flags: "wx" });
  const child = spawn(command.executable, command.args, {
    cwd: repositoryRoot,
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: process.platform === "win32",
    detached: process.platform !== "win32",
  });
  activeChild = child;
  let timedOut = false;
  let error: string | null = null;
  child.stdout?.on("data", (chunk: Buffer) => log.write(chunk));
  child.stderr?.on("data", (chunk: Buffer) => log.write(chunk));
  child.once("error", (failure) => { error = failure.message; });
  const timer = setTimeout(() => {
    timedOut = true;
    void terminateProcessTree(child, "SIGTERM", process.platform !== "win32");
  }, command.timeoutMs);
  timer.unref();
  const [exitCode, signal] = await once(child, "close") as [number | null, NodeJS.Signals | null];
  clearTimeout(timer);
  activeChild = undefined;
  log.end();
  await once(log, "finish");
  return {
    command: commandLabel(command),
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode,
    signal,
    timedOut,
    error,
    logPath,
  };
}

function commandLabel(command: CommandSpec): string {
  return [command.executable, ...command.args].map((part) => /\s/.test(part) ? JSON.stringify(part) : part).join(" ");
}

function notRun(group: GroupSpec, reason: string): GroupResult {
  return {
    id: group.id,
    title: group.title,
    required: group.required,
    status: "not_run",
    startedAt: null,
    finishedAt: null,
    commands: [],
    error: reason,
  };
}
