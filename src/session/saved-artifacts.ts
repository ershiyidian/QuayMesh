import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export class SavedArtifactError extends Error {
  constructor(readonly code: "artifact_scope" | "artifact_too_large" | "artifact_changed" | "artifact_unavailable") {
    super(code);
  }
}

export function savedArtifactId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(value)) throw new SavedArtifactError("artifact_scope");
  return value;
}

function inside(root: string, path: string): boolean {
  const delta = relative(root, path);
  return delta !== "" && delta !== ".." && !delta.startsWith(`..${sep}`) && !isAbsolute(delta) && dirname(delta) === ".";
}

/** Writers save direct child files. Do not let a legacy member scope reach a later Task subdirectory. */
async function openArtifact(root: string, path: string) {
  if (!inside(resolve(root), resolve(path))) throw new SavedArtifactError("artifact_scope");
  try {
    const [directory, file] = await Promise.all([realpath(root), realpath(path)]);
    if (!inside(directory, file)) throw new SavedArtifactError("artifact_scope");
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await handle.stat();
      if (!info.isFile() || !Number.isSafeInteger(info.size)) throw new SavedArtifactError("artifact_unavailable");
      return { handle, size: info.size };
    } catch (error) { await handle.close(); throw error; }
  } catch (error) {
    if (error instanceof SavedArtifactError) throw error;
    throw new SavedArtifactError("artifact_unavailable");
  }
}

export async function savedArtifactSize(root: string, path: string): Promise<number> {
  const { handle, size } = await openArtifact(root, path);
  try { return size; } finally { await handle.close(); }
}

export async function readSavedArtifactRange(root: string, path: string, offset: number, length: number): Promise<Buffer> {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || length > 8 * 1024 * 1024) {
    throw new SavedArtifactError("artifact_too_large");
  }
  const { handle, size } = await openArtifact(root, path);
  try {
    if (offset + length > size) throw new SavedArtifactError("artifact_changed");
    const bytes = Buffer.alloc(length);
    let consumed = 0;
    while (consumed < length) {
      const read = await handle.read(bytes, consumed, length - consumed, offset + consumed);
      if (read.bytesRead === 0) throw new SavedArtifactError("artifact_changed");
      consumed += read.bytesRead;
    }
    return bytes;
  } finally { await handle.close(); }
}

export async function readSavedTextArtifact(root: string, path: string, maximumBytes: number): Promise<string> {
  const size = await savedArtifactSize(root, path);
  if (size > maximumBytes) throw new SavedArtifactError("artifact_too_large");
  return (await readSavedArtifactRange(root, path, 0, size)).toString("utf8");
}
