import { accessSync, constants, statSync } from "node:fs";
import { delimiter, extname, resolve } from "node:path";
import { createRequire } from "node:module";
import { environmentValue, mergeEnvironment } from "../node/environment-values.mjs";

export { environmentValue, mergeEnvironment } from "../node/environment-values.mjs";

const crossSpawn = createRequire(import.meta.url)("cross-spawn") as typeof import("node:child_process").spawn & {
  sync: typeof import("node:child_process").spawnSync;
};
export const spawnCommand = crossSpawn;
export const spawnCommandSync = crossSpawn.sync;

export function resolveExecutableCommand(
  command: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (!command) return undefined;
  return executableCommandCandidates(command, env).find(isExecutableFile);
}

export function executableCommandCandidates(command: string, environment: NodeJS.ProcessEnv): string[] {
  const env = mergeEnvironment(process.platform, environment);
  const windows = process.platform === "win32";
  const extensions = windows
    ? (environmentValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  const namedExtensions = !windows || extname(command) ? [""] : extensions;
  if (command.includes("/") || command.includes("\\")) {
    return namedExtensions.map(extension => command + extension);
  }
  const path = environmentValue(env, "PATH");
  if (!path) return [];
  const result: string[] = [];
  for (const directory of path.split(delimiter)) {
    if (!directory) continue;
    for (const extension of namedExtensions) result.push(resolve(directory.replace(/^"|"$/g, ""), command + extension));
  }
  return result;
}

function isExecutableFile(command: string): boolean {
  const mode = process.platform === "win32" ? constants.F_OK : constants.X_OK;
  try {
    accessSync(command, mode);
    return statSync(command).isFile();
  } catch {
    return false;
  }
}
