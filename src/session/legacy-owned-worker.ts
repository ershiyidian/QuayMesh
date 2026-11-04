import { readFile } from "node:fs/promises";
import { parentPort, workerData } from "node:worker_threads";
import { externalizeInlineState } from "./file-content.js";
import type { OwnedFiles } from "./write-evidence.js";

const { path, directory } = workerData as { path: string; directory: string };
try {
  const owned = JSON.parse(await readFile(path, "utf8")) as OwnedFiles;
  for (const file of Object.values(owned)) {
    file.before = await externalizeInlineState(file.before, directory, 0);
    file.after = await externalizeInlineState(file.after, directory, 0);
  }
  parentPort!.postMessage({ value: owned });
} catch (error) {
  parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) });
}
