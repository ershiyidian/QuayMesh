import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { isPathInsideRoot } from "../roots.js";

export interface FileState {
  exists: boolean;
  content: string;
  mode: number | null;
}

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

export async function readFileState(path: string): Promise<FileState> {
  try {
    const [content, info] = await Promise.all([readFile(path), stat(path)]);
    return { exists: true, content: content.toString("base64"), mode: info.mode & 0o777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, content: "", mode: null };
    throw error;
  }
}

export function sameFileState(a: FileState, b: FileState): boolean {
  return a.exists === b.exists && (!a.exists || a.content === b.content && a.mode === b.mode);
}

export function memberFile(root: string, path: string, cwd = root): { absolute: string; path: string } {
  const absolute = resolve(cwd, path);
  if (!isPathInsideRoot(absolute, root)) throw new Error(`WRITE_OUTSIDE_WORKSPACE: ${path}`);
  return { absolute, path: relative(root, absolute).replaceAll("\\", "/") };
}

export async function beginWrite(root: string, paths: string[], cwd = root): Promise<WriteEvidence[]> {
  const files = new Map(paths.map((path) => {
    const file = memberFile(root, path, cwd);
    return [file.path, file];
  }));
  return Promise.all([...files.values()].map(async (file) => ({ path: file.path, before: await readFileState(file.absolute) })));
}

export async function readOwnedFiles(path: string): Promise<OwnedFiles> {
  try { return JSON.parse(await readFile(path, "utf8")) as OwnedFiles; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export async function finishWrite(root: string, file: string, evidence: WriteEvidence[]): Promise<void> {
  const owned = await readOwnedFiles(file);
  for (const entry of evidence) {
    const after = await readFileState(memberFile(root, entry.path).absolute);
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
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.pending-${randomUUID()}`;
  await writeFile(temporary, JSON.stringify(owned), { mode: 0o600 });
  await rename(temporary, path);
}

export function ownershipPath(stateDir: string, sessionId: string, memberId: string, taskId?: string): string {
  return join(stateDir, "session-file-baselines", sessionId, memberId, taskId ?? "legacy", "owned.json");
}

export async function restoreFileState(path: string, state: FileState): Promise<void> {
  if (!state.exists) { await rm(path); return; }
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.quaymesh-revert-${randomUUID()}`;
  await writeFile(temporary, Buffer.from(state.content, "base64"), { mode: state.mode ?? 0o600 });
  await rename(temporary, path);
  if (state.mode !== null && process.platform !== "win32") await chmod(path, state.mode);
}
