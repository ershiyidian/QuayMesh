import { EventEmitter } from "node:events";
import { mkdir, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ObservationGate, observeWithSignal } from "../observation-budget.js";

const DEFAULT_MAXIMUM_BYTES = 4 * 1024 * 1024;
const DEFAULT_SEGMENT_BYTES = 64 * 1024;

interface OutputSegment { start: number; bytes: number; file: string }
export interface SessionOutputMetadata {
  version: 1 | 2 | 3;
  session_id: string;
  command_id: string;
  operation_id: string;
  total_bytes: number;
  retained_from: number;
  done: boolean;
  exit_code: number | null;
  signal: string | null;
  updated_at: string;
  segments?: OutputSegment[];
  expired?: boolean;
  retained_until?: string;
  state?: "writing" | "ready" | "incomplete" | "expired";
  error_code?: string;
}
export interface SessionOutputRead {
  chunk: string; cursor: number; nextCursor: number; done: boolean;
  retainedFrom: number; truncated: boolean; totalBytes: number;
  processDone: boolean; exitCode: number | null; signal: string | null;
  outputState: "writing" | "ready" | "incomplete" | "expired" | "unknown";
  errorCode: string | null;
}
export type SessionOutputReaderScope = "model" | "ui";

export class SessionOutputStore {
  private readonly root: string;
  private readonly segmentBytes: number;
  private readonly pending = new Map<string, Promise<void>>();
  private readonly writeErrors = new Map<string, Error>();
  private closed = false;
  private readonly changes = new EventEmitter().setMaxListeners(0);
  private readonly readers = new ObservationGate(16, 64);
  private queuedReads = 0;

  constructor(stateDir: string, private readonly maximumBytes = DEFAULT_MAXIMUM_BYTES) {
    if (!Number.isInteger(maximumBytes) || maximumBytes < 16) throw new Error("Session output retention must be an integer of at least 16 bytes.");
    this.root = join(stateDir, "session-output");
    this.segmentBytes = Math.min(DEFAULT_SEGMENT_BYTES, maximumBytes);
  }

  open(sessionId: string, commandId: string, operationId: string): Promise<SessionOutputMetadata> {
    this.assertOpen();
    return this.enqueue(commandId, async () => {
      await mkdir(this.commandDirectory(commandId), { recursive: true, mode: 0o700 });
      const existing = await readFile(this.metadataPath(commandId), "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (existing) throw new Error(`OUTPUT_ALREADY_OPEN: ${commandId}`);
      const metadata: SessionOutputMetadata = {
        version: 3, session_id: sessionId, command_id: commandId, operation_id: operationId,
        total_bytes: 0, retained_from: 0, done: false, exit_code: null, signal: null,
        updated_at: new Date().toISOString(), segments: [], state: "writing",
      };
      await this.writeMetadata(metadata);
      return metadata;
    });
  }

  append(commandId: string, rawBytes: Uint8Array | string): Promise<void> {
    this.assertOpen();
    const bytes = typeof rawBytes === "string" ? Buffer.from(rawBytes, "utf8") : Buffer.from(rawBytes);
    if (bytes.length === 0) return Promise.resolve();
    return this.enqueue(commandId, async () => {
      const previousFailure = this.writeErrors.get(commandId);
      if (previousFailure) throw previousFailure;
      try {
        const metadata = await this.readMetadata(commandId);
        if (metadata.done) throw new Error(`OUTPUT_ALREADY_FINISHED: ${commandId}`);
        if (metadata.version === 1) throw new Error(`OUTPUT_RUNTIME_ENDED: ${commandId}`);
        const segments = metadata.segments!;
        let position = 0;
        while (position < bytes.length) {
          let segment = segments.at(-1);
          const fresh = !segment || segment.bytes >= this.segmentBytes;
          if (fresh) {
            segment = { start: metadata.total_bytes, bytes: 0, file: `segment-${metadata.total_bytes}.bin` };
            segments.push(segment);
          }
          const active = segment!;
          const size = Math.min(bytes.length - position, this.segmentBytes - active.bytes);
          const handle = await open(join(this.commandDirectory(commandId), active.file), fresh ? "wx" : "r+", 0o600);
          try {
            let written = 0;
            while (written < size) {
              const result = await handle.write(bytes, position + written, size - written, active.bytes + written);
              if (result.bytesWritten === 0) throw new Error("输出文件没有写入进度");
              written += result.bytesWritten;
            }
          } finally { await handle.close(); }
          active.bytes += size; metadata.total_bytes += size; position += size;
        }
        metadata.retained_from = Math.max(metadata.retained_from, metadata.total_bytes - this.maximumBytes);
        if (metadata.retained_from > 0) {
          const prefix = await this.readRange(metadata, metadata.retained_from, 4);
          metadata.retained_from += completeUtf8PrefixStart(prefix);
        }
        const expired = segments.filter(segment => segment.start + segment.bytes <= metadata.retained_from);
        metadata.segments = segments.filter(segment => segment.start + segment.bytes > metadata.retained_from);
        metadata.updated_at = new Date().toISOString();
        await this.writeMetadata(metadata);
        for (const segment of expired) await unlink(join(this.commandDirectory(commandId), segment.file));
      } catch (error) {
        this.writeErrors.set(commandId, error instanceof Error ? error : new Error(String(error)));
        this.changes.emit("output",commandId);
        throw error;
      }
    });
  }

  finish(commandId: string, exitCode: number | null, signal: string | null): Promise<void> {
    this.assertOpen();
    return this.enqueue(commandId, async () => {
      const failure = this.writeErrors.get(commandId);
      if (failure) throw failure;
      const metadata = await this.readMetadata(commandId);
      if (metadata.done) {
        if (metadata.exit_code !== exitCode || metadata.signal !== signal) throw new Error("OUTPUT_FINISH_CONFLICT");
        return;
      }
      await this.writeMetadata({ ...metadata, done: true, exit_code: exitCode, signal, state: "ready", error_code: undefined,
        updated_at: new Date().toISOString() });
    });
  }

  fail(commandId: string, errorCode: string, exitCode: number | null, signal: string | null): Promise<void> {
    this.assertOpen();
    return this.enqueue(commandId, async () => {
      const metadata = await this.readMetadata(commandId);
      if (metadata.done && metadata.state === "ready") throw new Error("OUTPUT_FINISH_CONFLICT");
      await this.writeMetadata({ ...metadata, done: true, exit_code: exitCode, signal, state: "incomplete", error_code: errorCode,
        updated_at: new Date().toISOString() });
    });
  }

  read(sessionId: string, commandId: string, cursor: number, requestedBytes: number, _scope: SessionOutputReaderScope, signal?: AbortSignal): Promise<SessionOutputRead> {
    this.assertOpen();
    signal?.throwIfAborted();
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("OUTPUT_CURSOR_INVALID");
    if (!Number.isSafeInteger(requestedBytes) || requestedBytes < 0) throw new Error("OUTPUT_BYTES_INVALID");
    if (this.queuedReads >= 128) throw Object.assign(new Error("OBSERVATION_BUSY: output reader queue is full; retry later"), {
      code: "OBSERVATION_BUSY", effect: "not_started", retryHint: "retry_later",
    });
    this.queuedReads++;
    const work = this.enqueue(commandId, () => this.readers.run<SessionOutputRead>(async () => {
      signal?.throwIfAborted();
      const metadata = await this.readMetadata(commandId, signal);
      const writeFailure=this.writeErrors.get(commandId);if(writeFailure)throw writeFailure;
      if (metadata.session_id !== sessionId) throw new Error("OUTPUT_SESSION_MISMATCH");
      if (metadata.expired || metadata.state === "expired") throw new Error(`OUTPUT_EXPIRED: ${metadata.retained_until}`);
      if (cursor > metadata.total_bytes) throw new Error(`OUTPUT_CURSOR_AHEAD: ${metadata.total_bytes}`);
      const retainedFrom = metadata.retained_from;
      const offset = Math.min(metadata.total_bytes, Math.max(cursor, retainedFrom));
      const wanted = Math.max(1, requestedBytes);
      const raw = await this.readRange(metadata, offset, Math.min(wanted + 4, metadata.total_bytes - offset), signal);
      signal?.throwIfAborted();
      const complete = raw.subarray(0, completeUtf8PrefixEnd(raw));
      const chunk = fitUtf8(complete.toString("utf8"), wanted);
      const nextCursor = offset + Buffer.byteLength(chunk, "utf8");
      const outputState = metadata.state ?? (metadata.expired ? "expired" : metadata.done ? "ready" : "writing");
      return { chunk, cursor: offset, nextCursor, done: metadata.done && nextCursor >= metadata.total_bytes,
        retainedFrom, truncated: cursor < retainedFrom, totalBytes: metadata.total_bytes,
        processDone: metadata.done, exitCode: metadata.exit_code, signal: metadata.signal,
        outputState, errorCode: metadata.error_code ?? null };
    }, signal)).finally(() => { this.queuedReads--; });
    return observeWithSignal(work, signal);
  }

  modelRead(sessionId: string, commandId: string, cursor: number, requestedBytes: number, signal?: AbortSignal): Promise<SessionOutputRead> {
    return this.read(sessionId, commandId, cursor, requestedBytes, "model", signal);
  }
  uiRead(sessionId: string, commandId: string, cursor: number, requestedBytes: number, signal?: AbortSignal): Promise<SessionOutputRead> {
    return this.read(sessionId, commandId, cursor, requestedBytes, "ui", signal);
  }
  async expire(commandId: string, retainedUntil: string): Promise<void> {
    this.assertOpen();
    return this.enqueue(commandId, async () => {
      const metadata = await readFile(this.metadataPath(commandId), "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (!metadata) return;
      const value = JSON.parse(metadata) as SessionOutputMetadata;
      if (!value.done) return;
      await this.writeMetadata({...value,expired:true,state:"expired",retained_until:retainedUntil,segments:[]});
      await rm(this.commandDirectory(commandId), {recursive:true,force:true});
      if (value.version === 1) await rm(join(this.root, `${safeName(commandId)}.bin`), {force:true});
    });
  }

  watch(commandIds:readonly string[],milliseconds:number,signal?:AbortSignal):{changed:Promise<void>;dispose:()=>void} {
    this.assertOpen();
    const ids=new Set(commandIds);
    let finish!:()=>void;
    const changed=new Promise<void>(resolve=>{
      const listener=(id:string)=>{if(ids.has(id))finish();};
      const timer=setTimeout(()=>finish(),milliseconds);
      finish=()=>{clearTimeout(timer);this.changes.off("output",listener);this.changes.off("close",finish);
        signal?.removeEventListener("abort",finish);resolve();};
      this.changes.on("output",listener);this.changes.once("close",finish);
      signal?.addEventListener("abort",finish,{once:true});if(signal?.aborted)finish();
    });
    return {changed,dispose:()=>finish()};
  }

  async close(): Promise<void> {
    this.closed = true;
    this.changes.emit("close");
    await Promise.all(this.pending.values());
  }

  private enqueue<T>(commandId: string, operation: () => Promise<T>): Promise<T> {
    safeName(commandId);
    const task = (this.pending.get(commandId) ?? Promise.resolve()).then(operation);
    const settled = task.then(() => undefined, () => undefined);
    this.pending.set(commandId, settled);
    void settled.then(() => { if (this.pending.get(commandId) === settled) this.pending.delete(commandId); });
    return task;
  }
  private assertOpen(): void { if (this.closed) throw new Error("SESSION_OUTPUT_CLOSED"); }
  private commandDirectory(commandId: string): string { return join(this.root, safeName(commandId)); }
  private metadataPath(commandId: string): string { return join(this.root, `${safeName(commandId)}.json`); }

  private async readMetadata(commandId: string, signal?: AbortSignal): Promise<SessionOutputMetadata> {
    const text = await readFile(this.metadataPath(commandId), { encoding: "utf8", signal }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") throw new Error(`OUTPUT_NOT_FOUND: ${commandId}`);
      throw error;
    });
    const value = JSON.parse(text) as SessionOutputMetadata;
    if (value.version !== 1 && value.version !== 2 && value.version !== 3) throw new Error("OUTPUT_VERSION_UNSUPPORTED");
    if (value.version !== 1 && !Array.isArray(value.segments)) throw new Error("OUTPUT_SEGMENTS_MISSING");
    return value;
  }

  private async writeMetadata(metadata: SessionOutputMetadata): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const path = this.metadataPath(metadata.command_id);
    const temporary = `${path}.pending-${process.pid}-${randomUUID()}`;
    await writeFile(temporary, JSON.stringify(metadata), { mode: 0o600 });
    try { await rename(temporary, path); this.changes.emit("output",metadata.command_id); }
    catch (error) { await unlink(temporary).catch(() => {}); throw error; }
  }

  private async readRange(metadata: SessionOutputMetadata, offset: number, length: number, signal?: AbortSignal): Promise<Buffer> {
    signal?.throwIfAborted();
    if (length <= 0) return Buffer.alloc(0);
    const buffer = Buffer.alloc(length);
    let consumed = 0;
    if (metadata.version === 1) {
      const handle = await open(join(this.root, `${safeName(metadata.command_id)}.bin`), "r");
      try {
        signal?.throwIfAborted();
        const result = await handle.read(buffer, 0, length, offset - metadata.retained_from);
        return buffer.subarray(0, result.bytesRead);
      } finally { await handle.close(); }
    }
    for (const segment of metadata.segments!) {
      signal?.throwIfAborted();
      const end = segment.start + segment.bytes;
      if (end <= offset || segment.start >= offset + length) continue;
      const from = Math.max(segment.start, offset);
      const count = Math.min(end, offset + length) - from;
      const handle = await open(join(this.commandDirectory(metadata.command_id), segment.file), "r");
      try {
        let read = 0;
        while (read < count) {
          signal?.throwIfAborted();
          const result = await handle.read(buffer, consumed + read, count - read, from - segment.start + read);
          if (result.bytesRead === 0) throw new Error("OUTPUT_SEGMENT_INCOMPLETE");
          read += result.bytesRead;
        }
      } finally { await handle.close(); }
      consumed += count;
    }
    return buffer.subarray(0, consumed);
  }
}

function safeName(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(value)) throw new Error("OUTPUT_ID_INVALID");
  return value;
}
function completeUtf8PrefixStart(bytes: Buffer): number {
  let index = 0;
  while (index < bytes.length && (bytes[index]! & 0xc0) === 0x80) index++;
  return index;
}
function completeUtf8PrefixEnd(bytes: Buffer): number {
  if (!bytes.length) return 0;
  let index = bytes.length - 1;
  while (index >= 0 && (bytes[index]! & 0xc0) === 0x80) index--;
  if (index < 0) return 0;
  const lead = bytes[index]!;
  const needed = lead < 0x80 ? 1 : lead >= 0xc2 && lead <= 0xdf ? 2 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xf0 && lead <= 0xf4 ? 4 : 1;
  return bytes.length - index < needed ? index : bytes.length;
}
export function fitUtf8(text: string, maximumBytes: number): string {
  let size = 0, result = "";
  for (const point of text) {
    const bytes = Buffer.byteLength(point);
    if (size + bytes > maximumBytes && result) break;
    result += point; size += bytes;
    if (size >= maximumBytes) break;
  }
  return result;
}
