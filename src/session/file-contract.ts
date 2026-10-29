import type { FileSummary } from "./types.js";

/** Nested file readers were strict before recordedAt was introduced. */
export function filesForReader<T extends FileSummary>(files: T[], recordedAtSupported: boolean): T[] {
  if (recordedAtSupported) return files;
  return files.map(file => {
    if (!Object.hasOwn(file, "recordedAt")) return file;
    const compatible = { ...file };
    delete compatible.recordedAt;
    return compatible;
  });
}
