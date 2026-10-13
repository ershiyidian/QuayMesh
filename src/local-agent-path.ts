import { existsSync, readFileSync } from "node:fs";
import { delimiter, resolve, sep } from "node:path";

export function removeQuayMeshNodeModulesBinFromPath(pathValue: string): string {
  return pathValue
    .split(delimiter)
    .filter((entry) => entry && !isQuayMeshNodeModulesBin(entry))
    .join(delimiter);
}

function isQuayMeshNodeModulesBin(pathEntry: string): boolean {
  const resolvedEntry = resolve(pathEntry);
  if (!resolvedEntry.endsWith(`${sep}node_modules${sep}.bin`)) {
    return false;
  }

  const packageJson = resolve(resolvedEntry, "..", "..", "package.json");
  if (!existsSync(packageJson)) return false;

  try {
    const packageInfo = JSON.parse(readFileSync(packageJson, "utf8")) as { name?: unknown };
    // Keep the historical package name compatible, but never allow this
    // checkout's executables to shadow the user's actual provider binaries.
    return packageInfo.name === "quaymesh" || packageInfo.name === "@waishnav/quaymesh";
  } catch {
    return false;
  }
}
