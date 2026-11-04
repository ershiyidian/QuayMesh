import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { readUtf8BytePage } from "./output-codec.js";

export const PATCH_PREVIEW_BYTES = 8 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
export type PreviewOmission = "not_generated" | "too_large";
export type PatchPiece = { text: string } | { path: string };
export interface PatchFile {
  path: string;
  patchRef: string;
  binary: boolean;
  large: boolean;
  additions: number | null;
  removals: number | null;
}

export function textPatchWasOmitted(file: Pick<PatchFile, "binary" | "large" | "additions" | "removals">): boolean {
  return !file.binary && file.large && file.additions === null && file.removals === null;
}

export async function requireCompletePatches(files: readonly PatchFile[]): Promise<void> {
  for (const file of files) {
    if (textPatchWasOmitted(file) || file.binary && (await stat(file.patchRef)).size === 0)
      throw new Error(`PATCH_NOT_GENERATED: ${file.path} 未生成完整补丁。`);
  }
}

export async function captureGitPatch(input: {
  repoRoot: string; args: string[]; destination: string;
  currentRef: string; previousRef: string; path: string;
}): Promise<{ patchRef: string; hash: string; previousHash: string; bytes: number; binary: boolean }> {
  await mkdir(dirname(input.destination), { recursive: true, mode: 0o700 });
  const temporary = `${input.destination}.pending-${randomUUID()}`;
  let output: Awaited<ReturnType<typeof open>> | undefined = await open(temporary, "wx", 0o600);
  const hashes = [input.currentRef, input.previousRef].map(ref => createHash("sha256")
    .update(JSON.stringify([ref, input.path]).slice(0, -1) + ',"'));
  const decoder = new StringDecoder("utf8");
  let bytes = 0, binary = false, tail = "", stderr = "";
  const child = spawn("git", input.args, { cwd: input.repoRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < CHUNK_BYTES) stderr += chunk.toString("utf8").slice(0, CHUNK_BYTES - stderr.length); });
  const closed = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => code === 0 ? resolve()
      : reject(new Error(`Git patch failed (${signal ?? code}): ${stderr.trim()}`)));
  });
  void closed.catch(() => {});
  const append = async (text: string) => {
    if (!text) return;
    const escaped = JSON.stringify(text).slice(1, -1);
    for (const hash of hashes) hash.update(escaped);
    binary ||= (tail + text).includes("GIT binary patch");
    tail = text.slice(-16);
    bytes += Buffer.byteLength(text);
    await output!.writeFile(text, "utf8");
  };
  try {
    for await (const chunk of child.stdout) await append(decoder.write(chunk as Buffer));
    await append(decoder.end());
    await closed;
    await output.close(); output = undefined;
    await rename(temporary, input.destination);
    const [hash, previousHash] = hashes.map(value => value.update('"]').digest("hex"));
    return { patchRef: input.destination, hash: hash!, previousHash: previousHash!, bytes, binary };
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed.catch(() => {});
    throw error;
  } finally {
    await output?.close();
    await rm(temporary, { force: true });
  }
}

export async function readPatchPreview(path: string, budget = PATCH_PREVIEW_BYTES): Promise<{ patch: string; previewOmitted?: PreviewOmission }> {
  const file = await open(path, "r");
  try {
    const before = await file.stat();
    if (!before.isFile()) throw new Error("PATCH_EVIDENCE_NOT_REGULAR");
    if (before.size > budget) return { patch: "", previewOmitted: "too_large" };
    const buffer = Buffer.alloc(before.size);
    let consumed = 0;
    while (consumed < buffer.length) {
      const { bytesRead } = await file.read(buffer, consumed, buffer.length - consumed, consumed);
      if (!bytesRead) throw new Error("PATCH_EVIDENCE_CHANGED");
      consumed += bytesRead;
    }
    const after = await file.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error("PATCH_EVIDENCE_CHANGED");
    return { patch: buffer.toString("utf8") };
  } finally { await file.close(); }
}

interface Position { piece: number; byte: number; point: number }
interface Continuation { offset: number; position: Position; revision: string }
// 旧 app 游标以码点计数；只记最近续读位置，连续下载无需逐页扫描前文。
const continuations = new Map<string, Continuation>();
function remember(key: string, value: Continuation): void {
  continuations.delete(key); continuations.set(key, value);
  if (continuations.size > 64) continuations.delete(continuations.keys().next().value!);
}

async function* patchChunks(pieces: readonly PatchPiece[], start: Position) {
  for (let index = start.piece; index < pieces.length; index++) {
    const piece = pieces[index]!;
    if ("text" in piece) {
      const point = index === start.piece ? start.point : 0;
      yield { text: Array.from(piece.text).slice(point).join(""), position: { piece: index, byte: 0, point } };
      continue;
    }
    const file = await open(piece.path, "r"), decoder = new StringDecoder("utf8");
    let position = index === start.piece ? start.byte : 0, decodedPosition = position;
    try {
      const buffer = Buffer.alloc(CHUNK_BYTES);
      for (;;) {
        const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
        if (!bytesRead) break;
        position += bytesRead;
        const text = decoder.write(buffer.subarray(0, bytesRead));
        if (text) yield { text, position: { piece: index, byte: decodedPosition, point: 0 } };
        decodedPosition += Buffer.byteLength(text);
      }
      const text = decoder.end();
      if (text) yield { text, position: { piece: index, byte: decodedPosition, point: 0 } };
    } finally { await file.close(); }
  }
}

export async function readPatchTextPage(pieces: readonly PatchPiece[], offset = 0, budget = 12 * 1024): Promise<{ text: string; nextOffset: number | null }> {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(budget) || budget < 8 || budget > CHUNK_BYTES)
    throw new Error("Invalid patch response offset or budget.");
  const key = JSON.stringify(pieces), cached = continuations.get(key);
  const revision = JSON.stringify(await Promise.all(pieces.map(async piece => {
    if (!("path" in piece)) return null;
    const info = await stat(piece.path, { bigint: true });
    return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
  })));
  const resumable = cached?.offset === offset && cached.revision === revision;
  const resume = resumable ? cached.position : { piece: 0, byte: 0, point: 0 };
  let skip = resumable ? 0 : offset, used = 2, count = 0;
  const output: string[] = [];
  for await (const chunk of patchChunks(pieces, resume)) {
    const points = Array.from(chunk.text), skipped = Math.min(skip, points.length);
    skip -= skipped;
    if (skipped === points.length) continue;
    const available = points.slice(skipped);
    let low = 0, high = available.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (used + Buffer.byteLength(JSON.stringify(available.slice(0, middle).join(""))) - 2 <= budget) low = middle;
      else high = middle - 1;
    }
    const text = available.slice(0, low).join("");
    output.push(text); count += low; used += Buffer.byteLength(JSON.stringify(text)) - 2;
    if (low < available.length) {
      const consumed = points.slice(0, skipped + low).join("");
      const piece = pieces[chunk.position.piece]!;
      const position = "path" in piece
        ? { piece: chunk.position.piece, byte: chunk.position.byte + Buffer.byteLength(consumed), point: 0 }
        : { piece: chunk.position.piece, byte: 0, point: chunk.position.point + skipped + low };
      remember(key, { offset: offset + count, position, revision });
      return { text: output.join(""), nextOffset: offset + count };
    }
  }
  continuations.delete(key);
  if (skip) throw new Error("Invalid patch response offset.");
  return { text: output.join(""), nextOffset: null };
}

export async function readPatchBytePage(pieces: readonly PatchPiece[], offset = 0, budget = CHUNK_BYTES): Promise<{ text: string; nextOffset: number | null }> {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(budget) || budget < 4 || budget > CHUNK_BYTES)
    throw new Error("Invalid patch response offset or budget.");
  const sizes = await Promise.all(pieces.map(async piece => "text" in piece ? Buffer.byteLength(piece.text) : (await stat(piece.path)).size));
  const total = sizes.reduce((sum, bytes) => sum + bytes, 0);
  if (!Number.isSafeInteger(total) || offset > total) throw new Error("Invalid patch response offset.");
  const wanted = Math.min(budget + 4, total - offset), chunks: Buffer[] = [];
  let skipped = 0, collected = 0;
  for (const [index, piece] of pieces.entries()) {
    const bytes = sizes[index]!, start = Math.max(0, offset - skipped);
    if (start < bytes && collected < wanted) {
      const count = Math.min(bytes - start, wanted - collected);
      if ("text" in piece) chunks.push(Buffer.from(piece.text).subarray(start, start + count));
      else {
        const file = await open(piece.path, "r"), buffer = Buffer.alloc(count);
        try {
          let consumed = 0;
          while (consumed < count) {
            const { bytesRead } = await file.read(buffer, consumed, count - consumed, start + consumed);
            if (!bytesRead) throw new Error("PATCH_EVIDENCE_CHANGED");
            consumed += bytesRead;
          }
        } finally { await file.close(); }
        chunks.push(buffer);
      }
      collected += count;
    }
    skipped += bytes;
    if (collected >= wanted) break;
  }
  const raw = Buffer.concat(chunks, collected);
  if (raw.length && (raw[0]! & 0xc0) === 0x80) throw new Error("Invalid patch response offset.");
  const page = readUtf8BytePage(raw, budget, offset + collected === total), next = offset + page.consumedBytes;
  if (next === offset && offset < total) throw new Error("PATCH_EVIDENCE_CHANGED");
  return { text: page.chunk, nextOffset: next < total ? next : null };
}
