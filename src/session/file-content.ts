import { createHash, randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { copyFile, link, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

export const INLINE_FILE_BYTES = 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;

export interface FileState {
  exists: boolean;
  content?: string;
  sha256?: string;
  bytes?: number;
  contentRef?: string;
  mode: number | null;
}

export interface FileContent {
  state: FileState;
  binary: boolean;
  identity: string;
}

export function statIdentity(info: BigIntStats): string {
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs, info.mode].join(":");
}

export async function fileIdentity(path: string): Promise<string> {
  try { return statIdentity(await stat(path, { bigint: true })); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

export async function readFileContent(path: string, evidenceDirectory?: string): Promise<FileContent> {
  const source = await open(path, "r").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!source) return { state: { exists: false, content: "", bytes: 0, mode: null }, binary: false, identity: "missing" };
  let temporary: string | undefined;
  let output: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const before = await source.stat({ bigint: true });
    if (!before.isFile()) throw new Error(`FILE_EVIDENCE_NOT_REGULAR: ${path}`);
    const identity = statIdentity(before), inline = before.size <= BigInt(INLINE_FILE_BYTES);
    if (!inline && evidenceDirectory) {
      await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
      temporary = join(evidenceDirectory, `content-pending-${randomUUID()}.bin`);
      output = await open(temporary, "wx", 0o600);
    }
    const hash = createHash("sha256"), chunks: Buffer[] = [];
    let bytes = 0, binary = false;
    for await (const value of source.createReadStream({ autoClose: false, highWaterMark: CHUNK_BYTES })) {
      const chunk = value as Buffer;
      hash.update(chunk); bytes += chunk.length; binary ||= chunk.includes(0);
      if (inline && bytes <= INLINE_FILE_BYTES) chunks.push(chunk);
      if (output) await output.writeFile(chunk);
    }
    if (statIdentity(await source.stat({ bigint: true })) !== identity || await fileIdentity(path) !== identity)
      throw new Error(`FILE_CHANGED_DURING_CAPTURE: ${path}`);
    const sha256 = hash.digest("hex");
    let contentRef: string | undefined;
    if (output) {
      await output.close(); output = undefined;
      contentRef = join(evidenceDirectory!, `content-${sha256}.bin`);
      await publishContent(temporary!, contentRef, sha256, bytes); temporary = undefined;
    }
    return { state: { exists: true, mode: Number(before.mode & 0o777n), sha256, bytes,
      ...(inline ? { content: Buffer.concat(chunks, bytes).toString("base64") } : {}),
      ...(contentRef ? { contentRef } : {}) }, binary, identity };
  } finally {
    await output?.close(); await source.close();
    if (temporary) await rm(temporary, { force: true });
  }
}

export function contentDigest(state: FileState): string | null {
  if (!state.exists) return null;
  if (state.sha256) return state.sha256;
  if (typeof state.content !== "string") throw new Error("FILE_EVIDENCE_CONTENT_MISSING");
  return createHash("sha256").update(Buffer.from(state.content, "base64")).digest("hex");
}

async function publishContent(temporary: string, destination: string, sha256: string, bytes: number): Promise<void> {
  // 同一摘要只发布一次，避免替换既有 inode 使并行采集误判内容变化。
  try { await link(temporary, destination); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    await verifyStoredContent(destination, sha256, bytes);
  }
  await rm(temporary);
}

export function sameFileState(a: FileState, b: FileState): boolean {
  return a.exists === b.exists && (!a.exists || a.mode === b.mode && contentDigest(a) === contentDigest(b));
}

export async function assertRestorableState(state: FileState): Promise<void> {
  if (!state.exists || typeof state.content === "string") return;
  if (!state.contentRef || !state.sha256 || state.bytes === undefined) throw new Error("FILE_EVIDENCE_CONTENT_MISSING");
  await verifyStoredContent(state.contentRef, state.sha256, state.bytes);
}

export async function verifyStoredContent(path: string, sha256: string, expectedBytes: number): Promise<void> {
  const file = await open(path, "r").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new Error(`FILE_EVIDENCE_CONTENT_CHANGED: ${path}`);
    throw error;
  });
  try {
    const hash = createHash("sha256"); let bytes = 0;
    for await (const value of file.createReadStream({ autoClose: false, highWaterMark: CHUNK_BYTES })) {
      const chunk = value as Buffer; hash.update(chunk); bytes += chunk.length;
    }
    if (bytes !== expectedBytes || hash.digest("hex") !== sha256)
      throw new Error(`FILE_EVIDENCE_CONTENT_CHANGED: ${path}`);
  } finally { await file.close(); }
}

export async function hasRestorableState(state: FileState): Promise<boolean> {
  if (!state.exists || typeof state.content === "string") return true;
  if (!state.contentRef || !state.sha256 || state.bytes === undefined) return false;
  try { return (await stat(state.contentRef)).size === state.bytes; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function restoreContent(path: string, state: FileState): Promise<void> {
  if (!state.exists) { await rm(path); return; }
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.quaymesh-revert-${randomUUID()}`;
  try {
    if (typeof state.content === "string") {
      const file = await open(temporary, "wx", state.mode ?? 0o600);
      try { await file.writeFile(Buffer.from(state.content, "base64")); } finally { await file.close(); }
    } else {
      if (!state.contentRef || !state.sha256 || state.bytes === undefined) throw new Error("FILE_EVIDENCE_CONTENT_MISSING");
      await copyFile(state.contentRef, temporary);
      await verifyStoredContent(temporary, state.sha256, state.bytes);
    }
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

// 旧版本以整个 base64 数组作为版本身份；分块保持相同字节，避免建立巨型字符串。
export async function ordinaryVersion(before: string | null, after: string | null): Promise<string> {
  const hash = createHash("sha256"); hash.update("[");
  for (const [index, path] of [before, after].entries()) {
    if (index) hash.update(",");
    if (path === null) { hash.update("null"); continue; }
    hash.update('"');
    const file = await open(path, "r");
    try {
      const identity = statIdentity(await file.stat({ bigint: true }));
      let carry: Buffer = Buffer.alloc(0);
      for await (const value of file.createReadStream({ autoClose: false, highWaterMark: CHUNK_BYTES })) {
        const chunk = carry.length ? Buffer.concat([carry, value as Buffer]) : value as Buffer;
        const end = chunk.length - chunk.length % 3;
        hash.update(chunk.subarray(0, end).toString("base64")); carry = chunk.subarray(end);
      }
      if (carry.length) hash.update(carry.toString("base64"));
      if (identity !== statIdentity(await file.stat({ bigint: true })) || await fileIdentity(path) !== identity)
        throw new Error(`FILE_CHANGED_DURING_CAPTURE: ${path}`);
    } finally { await file.close(); }
    hash.update('"');
  }
  return hash.update("]").digest("hex");
}

export async function externalizeInlineState(state: FileState, directory: string, maxInlineBytes = INLINE_FILE_BYTES): Promise<FileState> {
  if (!state.exists || typeof state.content !== "string" || state.content.length <= Math.ceil(maxInlineBytes / 3) * 4) return state;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `content-pending-${randomUUID()}.bin`), file = await open(temporary, "wx", 0o600);
  const hash = createHash("sha256"); let bytes = 0;
  try {
    // 输入是旧 JSON 中的完整 base64；按四字符边界解码，工作线程也无需第二个大 Buffer。
    for (let offset = 0; offset < state.content.length; offset += CHUNK_BYTES) {
      const chunk = Buffer.from(state.content.slice(offset, offset + CHUNK_BYTES), "base64");
      hash.update(chunk); bytes += chunk.length; await file.writeFile(chunk);
    }
    await file.close();
    const sha256 = hash.digest("hex"), contentRef = join(directory, `content-${sha256}.bin`);
    await publishContent(temporary, contentRef, sha256, bytes);
    return { exists: true, mode: state.mode, bytes, sha256, contentRef };
  } finally { await file.close(); await rm(temporary, { force: true }); }
}
