import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { valid } from "semver";
import { localAgentProviderEnvironment } from "../src/local-agent-config.js";
import { isCodexAppServerSupported, resolveCodexCommand } from "../src/local-agent-codex.js";
import { loadQuayMeshFiles, setQuayMeshConfigValues } from "../src/user-config.js";

const execFileAsync = promisify(execFile);

export interface PrepareOptions {
  version?: string;
  installRoot?: string;
  executable?: string;
  configDir?: string;
  activateForNewRuns?: boolean;
  report?: string;
}

export interface PrepareReport {
  timestamp: string;
  inspect: {
    configPath: string;
    configuredCommand?: string;
    resolvedExecutable?: string;
    resolvedVersion?: string;
  };
  installed?: { version: string; installPath: string; executable: string };
  activated?: boolean;
  activation?: {
    configPath: string;
    executable: string;
    version: string;
    scope: "next_provider_configuration";
    runningProcessesChanged: false;
  };
}

export async function prepareCodexVersion(
  options: PrepareOptions,
  inherited: NodeJS.ProcessEnv = process.env,
): Promise<PrepareReport> {
  if (options.version && !valid(options.version)) throw new Error("CODEX_VERSION_INVALID");
  if (options.installRoot && !options.version) throw new Error("CODEX_VERSION_REQUIRED");
  if (options.activateForNewRuns && !options.executable && !(options.version && options.installRoot)) {
    throw new Error("CODEX_ACTIVATION_TARGET_REQUIRED");
  }
  if (options.executable && options.installRoot) throw new Error("CODEX_ACTIVATION_TARGET_AMBIGUOUS");
  const env = options.configDir
    ? { ...inherited, QUAYMESH_CONFIG_DIR: resolve(options.configDir) }
    : inherited;
  const files = loadQuayMeshFiles(env);
  const provider = files.config.subagents.providers.find((item) => item.id === "codex");
  const current = resolveCodexCommand(localAgentProviderEnvironment(files.config.subagents, "codex", env));
  const report: PrepareReport = {
    timestamp: new Date().toISOString(),
    inspect: {
      configPath: files.configPath,
      ...(provider && "command" in provider && provider.command ? { configuredCommand: provider.command } : {}),
      ...(current ? { resolvedExecutable: current.executable, resolvedVersion: current.version } : {}),
    },
  };

  let selected = options.executable;
  if (options.version && options.installRoot) {
    const targetDir = resolve(options.installRoot, options.version);
    await mkdir(targetDir, { recursive: true });
    const windows = process.platform === "win32";
    await execFileAsync(windows ? "npm.cmd" : "npm", [
      "install", "--prefix", targetDir, `@openai/codex@${options.version}`, "--no-save",
    ], { shell: windows, windowsHide: true, env });
    selected = join(targetDir, "node_modules", ".bin", windows ? "codex.cmd" : "codex");
    const installed = resolveCodexCommand({ ...env, CODEX_COMMAND: selected });
    if (!installed || installed.version !== options.version) throw new Error("CODEX_INSTALLED_VERSION_MISMATCH");
    if (!isCodexAppServerSupported(installed.executable, env)) throw new Error("CODEX_APP_SERVER_UNAVAILABLE");
    report.installed = { version: installed.version, installPath: targetDir, executable: installed.executable };
    selected = installed.executable;
  }

  if (options.activateForNewRuns) {
    const candidate = resolveCodexCommand({ ...env, CODEX_COMMAND: selected! });
    if (!candidate?.version) throw new Error("CODEX_ACTIVATION_TARGET_UNAVAILABLE");
    if (options.version && candidate.version !== options.version) throw new Error("CODEX_ACTIVATION_VERSION_MISMATCH");
    if (!isCodexAppServerSupported(candidate.executable, env)) throw new Error("CODEX_APP_SERVER_UNAVAILABLE");
    const index = files.config.subagents.providers.findIndex((item) => item.id === "codex");
    if (index < 0) throw new Error("CODEX_PROVIDER_NOT_CONFIGURED");
    // 只更新真实执行配置；协议生成记录由生成脚本维护。
    setQuayMeshConfigValues([
      { path: ["subagents", "providers", index, "command"], value: candidate.executable },
    ], env);
    const updated = loadQuayMeshFiles(env);
    const resolved = resolveCodexCommand(localAgentProviderEnvironment(updated.config.subagents, "codex", env));
    if (resolved?.executable !== candidate.executable || resolved.version !== candidate.version) {
      throw new Error("CODEX_ACTIVATION_VERIFICATION_FAILED");
    }
    report.activated = true;
    report.activation = {
      configPath: updated.configPath,
      executable: resolved.executable,
      version: resolved.version,
      scope: "next_provider_configuration",
      runningProcessesChanged: false,
    };
  }
  if (options.report) {
    const path = resolve(options.report);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: {
    version: { type: "string" },
    "install-root": { type: "string" },
    executable: { type: "string" },
    "config-dir": { type: "string" },
    "activate-for-new-runs": { type: "boolean", default: false },
    report: { type: "string" },
  } });
  const report = await prepareCodexVersion({
    version: values.version,
    installRoot: values["install-root"],
    executable: values.executable,
    configDir: values["config-dir"],
    activateForNewRuns: values["activate-for-new-runs"],
    report: values.report,
  });
  console.log(JSON.stringify(report, null, 2));
}
