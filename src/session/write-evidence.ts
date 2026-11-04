import { chmod, mkdir, open, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { isPathInsideRoot } from "../roots.js";
import { resolvePhysicalPath } from "../physical-paths.js";
import { externalizeInlineState, fileIdentity, readFileContent, restoreContent, sameFileState, statIdentity, type FileState } from "./file-content.js";

export { sameFileState, type FileState } from "./file-content.js";

export interface WriteEvidence {
  path: string;
  before: FileState;
}

export interface OwnedFile {
  before: FileState;
  after: FileState;
  safe: boolean;
}

export type OwnedFiles = Record<string, OwnedFile>;

export async function readFileState(path: string, evidenceDirectory?: string): Promise<FileState> {
  return (await readFileContent(path, evidenceDirectory)).state;
}

export function memberFile(root: string, path: string, cwd = root): { absolute: string; path: string } {
  const absolute = resolve(cwd, path), physicalRoot = resolvePhysicalPath(root);
  const physical = resolvePhysicalPath(absolute);
  if (!isPathInsideRoot(physical, physicalRoot)) throw new Error("WRITE_OUTSIDE_WORKSPACE: " + path);
  return { absolute, path: relative(physicalRoot, physical).replaceAll("\\", "/") };
}

export async function beginWrite(root: string, paths: string[], cwd = root, evidenceDirectory?: string): Promise<WriteEvidence[]> {
  const files = new Map(paths.map((path) => {
    const file = memberFile(root, path, cwd);
    return [file.path, file];
  }));
  const evidence: WriteEvidence[] = [];
  for (const file of files.values()) {
    const before = await readFileState(file.absolute, evidenceDirectory);
    if (before.exists && before.content === undefined && !before.contentRef)
      throw new Error("FILE_EVIDENCE_DIRECTORY_REQUIRED: " + file.path);
    evidence.push({ path: file.path, before });
  }
  return evidence;
}

const ownedCache = new Map<string, { identity: string; value: Promise<OwnedFiles> }>();
// 每份旧 JSON 可达数百 MiB，串行转换避免多个工作线程同时扩展这类记录。
let legacyConversion: Promise<unknown> = Promise.resolve();
const INLINE_OWNED_BYTES = 8 * 1024 * 1024;

export function evidenceDirectory(stateDir: string, sessionId: string, memberId: string, taskId?: string): string {
  return join(stateDir, "session-evidence", sessionId, memberId, ...(taskId ? [taskId] : []));
}

function ownedEvidenceDirectory(path: string): string {
  const directory = dirname(path), root = resolve(directory, "../../..");
  if (basename(root) === "session-file-baselines")
    return join(dirname(root), "session-evidence", relative(root, directory));
  return join(directory, "evidence");
}

function convertLegacyOwned(path: string): Promise<OwnedFiles> {
  const run = () => new Promise<OwnedFiles>((resolve, reject) => {
    const packaged = new URL("./legacy-owned-worker.js", import.meta.url);
    const entry = !existsSync(packaged) && import.meta.url.endsWith(".ts")
      ? new URL("../../dist/session/legacy-owned-worker.js", import.meta.url) : packaged;
    const worker = new Worker(entry, { workerData: { path, directory: ownedEvidenceDirectory(path) },
      execArgv: [], env: {}, name: "legacy-file-evidence" });
    let value: OwnedFiles | undefined, failure: Error | undefined;
    worker.once("message", (message: { value?: OwnedFiles; error?: string }) => {
      if (message.error) failure = new Error(message.error);
      else value = message.value;
    });
    worker.once("error", error => { failure = error instanceof Error ? error : new Error(String(error)); });
    worker.once("exit", code => {
      if (failure) reject(failure);
      else if (code !== 0 || !value) reject(new Error("FILE_EVIDENCE_WORKER_EXIT: " + code));
      else resolve(value);
    });
  });
  const pending = legacyConversion.then(run, run);
  legacyConversion = pending.catch(() => {});
  return pending;
}

export async function readOwnedFiles(path: string): Promise<OwnedFiles> {
  for (;;) {
    const source = await open(path, "r").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!source) { ownedCache.delete(path); return {}; }
    let identity: string;
    try {
      const info = await source.stat({ bigint: true }); identity = statIdentity(info);
      if (info.size <= BigInt(INLINE_OWNED_BYTES)) {
        ownedCache.delete(path);
        return JSON.parse(await source.readFile("utf8")) as OwnedFiles;
      }
    } finally { await source.close(); }
    let cached = ownedCache.get(path);
    if (!cached || cached.identity !== identity) {
      const value = convertLegacyOwned(path);
      cached = { identity, value };
      ownedCache.set(path, cached);
      void value.catch(() => { if (ownedCache.get(path)?.value === value) ownedCache.delete(path); });
    }
    const result = await cached.value;
    if (await fileIdentity(path) !== identity) continue;
    // 调用者会修改、删除条目；缓存只保存隔离转换后的原始结果。
    return structuredClone(result);
  }
}

export async function finishWrite(root: string, file: string, evidence: WriteEvidence[]): Promise<void> {
  const owned = await readOwnedFiles(file);
  for (const entry of evidence) {
    const after = await readFileState(memberFile(root, entry.path).absolute, ownedEvidenceDirectory(file));
    if (sameFileState(entry.before, after)) continue;
    const previous = owned[entry.path];
    // 已有写入之间出现外部改动时，继续展示差异，停止自动撤销该文件。
    owned[entry.path] = {
      before: previous?.before ?? entry.before,
      after,
      safe: previous ? previous.safe && sameFileState(previous.after, entry.before) : true,
    };
  }
  await writeOwnedFiles(file, owned);
}

export async function writeOwnedFiles(path: string, owned: OwnedFiles): Promise<void> {
  const compact: OwnedFiles = {}, directory = ownedEvidenceDirectory(path);
  for (const [name, file] of Object.entries(owned)) {
    compact[name] = { ...file, before: await externalizeInlineState(file.before, directory, 0),
      after: await externalizeInlineState(file.after, directory, 0) };
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + ".pending-" + randomUUID();
  await writeFile(temporary, JSON.stringify(compact), { mode: 0o600 });
  await rename(temporary, path);
  ownedCache.delete(path);
}

export function ownershipPath(stateDir: string, sessionId: string, memberId: string, taskId?: string): string {
  return join(stateDir, "session-file-baselines", sessionId, memberId, taskId ?? "legacy", "owned.json");
}

export async function restoreFileState(path: string, state: FileState): Promise<void> {
  await restoreContent(path, state);
  if (state.exists && state.mode !== null && process.platform !== "win32") await chmod(path, state.mode);
}
