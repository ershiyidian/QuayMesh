import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const operationIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const channelPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface RetainedRange { start: number; end: number }
export interface EvidenceRead { offset: number; limit: number; nextOffset: number; bytes: Buffer; totalBytes: number; droppedBytes: number; retainedRanges: RetainedRange[]; }
export interface EvidenceMetadata { operationId: string; channels: Record<string, { totalBytes: number; droppedBytes: number; retainedRanges: RetainedRange[] }>; closedAt?: string; }

interface ChannelBuffer {
  totalBytes: number;
  droppedBytes: number;
  head: Buffer;
  tail: Buffer;
}

function validOperationId(operationId: string): void {
  if (!operationIdPattern.test(operationId)) throw new Error("Invalid operation evidence identifier.");
}

function validChannel(channel: string): void {
  if (!channelPattern.test(channel)) throw new Error("Invalid operation evidence channel.");
}

function retain(buffer: ChannelBuffer, bytes: Buffer, maximumBytes: number): void {
  if (bytes.length === 0) return;
  const previous = buffer.totalBytes;
  buffer.totalBytes += bytes.length;
  if (buffer.totalBytes <= maximumBytes) {
    buffer.head = Buffer.concat([buffer.head, bytes]);
    return;
  }
  const headSize = Math.ceil(maximumBytes / 2);
  const tailSize = Math.floor(maximumBytes / 2);
  if (previous <= maximumBytes) {
    const combined = Buffer.concat([buffer.head, bytes]);
    buffer.head = combined.subarray(0, headSize);
    buffer.tail = combined.subarray(Math.max(0, combined.length - tailSize));
  } else {
    buffer.tail = Buffer.concat([buffer.tail, bytes]).subarray(-tailSize);
  }
  buffer.droppedBytes = buffer.totalBytes - buffer.head.length - buffer.tail.length;
}

function ranges(buffer: ChannelBuffer): RetainedRange[] {
  const headEnd = buffer.head.length;
  const tailStart = Math.max(headEnd, buffer.totalBytes - buffer.tail.length);
  return buffer.tail.length && tailStart > headEnd
    ? [{ start: 0, end: headEnd }, { start: tailStart, end: buffer.totalBytes }]
    : [{ start: 0, end: buffer.totalBytes }].filter((range) => range.end > range.start);
}

export class OperationEvidenceWriter {
  private readonly channels = new Map<string, ChannelBuffer>();
  private closed = false;

  constructor(private readonly store: OperationEvidenceStore, readonly operationId: string) {}

  append(channel: string, bytes: Uint8Array | string): void {
    if (this.closed) throw new Error("Operation evidence writer is closed.");
    validChannel(channel);
    const buffer = this.channels.get(channel) ?? { totalBytes: 0, droppedBytes: 0, head: Buffer.alloc(0), tail: Buffer.alloc(0) };
    retain(buffer, typeof bytes === "string" ? Buffer.from(bytes) : Buffer.from(bytes), this.store.maximumBytes);
    this.channels.set(channel, buffer);
  }

  async read(channel: string, offset: number, limit: number): Promise<EvidenceRead> {
    if (this.closed) return this.store.read(this.operationId, channel, offset, limit);
    validChannel(channel);
    return this.store.readBuffer(this.operationId, channel, this.channels.get(channel), offset, limit);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.store.persist(this.operationId, this.channels, new Date().toISOString());
  }
}

export class OperationEvidenceStore {
  readonly root: string;
  constructor(root: string, readonly maximumBytes = 10 * 1024 * 1024) {
    if (!Number.isInteger(maximumBytes) || maximumBytes < 2) throw new Error("Evidence size limit must be at least two bytes.");
    this.root = resolve(root);
  }

  async openWriter(operationId: string): Promise<OperationEvidenceWriter> {
    validOperationId(operationId);
    await mkdir(join(this.root, operationId), { recursive: true, mode: 0o700 });
    return new OperationEvidenceWriter(this, operationId);
  }

  async read(operationId: string, channel: string, offset: number, limit: number): Promise<EvidenceRead> {
    validOperationId(operationId);
    validChannel(channel);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) throw new Error("Evidence offset and limit are invalid.");
    const directory = join(this.root, operationId);
    const metadata = JSON.parse(await readFile(join(directory, "metadata.json"), "utf8")) as EvidenceMetadata;
    const channelMetadata = metadata.channels[channel];
    if (!channelMetadata) return { offset, limit, nextOffset: offset, bytes: Buffer.alloc(0), totalBytes: 0, droppedBytes: 0, retainedRanges: [] };
    const buffer = JSON.parse(await readFile(join(directory, `${channel}.json`), "utf8")) as { head: string; tail: string };
    const value: ChannelBuffer = { totalBytes: channelMetadata.totalBytes, droppedBytes: channelMetadata.droppedBytes, head: Buffer.from(buffer.head, "base64"), tail: Buffer.from(buffer.tail, "base64") };
    return this.readBuffer(operationId, channel, value, offset, limit);
  }

  async cleanup(olderThan: Date): Promise<number> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    let removed = 0;
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !operationIdPattern.test(entry.name)) continue;
      const info = await stat(join(this.root, entry.name));
      if (info.mtime < olderThan) { await rm(join(this.root, entry.name), { recursive: true, force: true }); removed++; }
    }
    return removed;
  }

  async persist(operationId: string, channels: Map<string, ChannelBuffer>, closedAt: string): Promise<void> {
    validOperationId(operationId);
    const directory = join(this.root, operationId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const metadata: EvidenceMetadata = { operationId, channels: {}, closedAt };
    for (const [channel, buffer] of channels) {
      validChannel(channel);
      metadata.channels[channel] = { totalBytes: buffer.totalBytes, droppedBytes: buffer.droppedBytes, retainedRanges: ranges(buffer) };
      await writeFile(join(directory, `${channel}.json`), JSON.stringify({ head: buffer.head.toString("base64"), tail: buffer.tail.toString("base64") }), { mode: 0o600 });
    }
    await writeFile(join(directory, "metadata.json"), JSON.stringify(metadata), { mode: 0o600 });
  }

  async readBuffer(_operationId: string, _channel: string, buffer: ChannelBuffer | undefined, offset: number, limit: number): Promise<EvidenceRead> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) throw new Error("Evidence offset and limit are invalid.");
    if (!buffer) return { offset, limit, nextOffset: offset, bytes: Buffer.alloc(0), totalBytes: 0, droppedBytes: 0, retainedRanges: [] };
    const retained = ranges(buffer);
    const chunks: Buffer[] = [];
    const headStart = Math.max(offset, 0), headEnd = Math.min(offset + limit, buffer.head.length);
    if (headEnd > headStart) chunks.push(buffer.head.subarray(headStart, headEnd));
    const tailStart = Math.max(buffer.totalBytes - buffer.tail.length, offset);
    const tailEnd = Math.min(offset + limit, buffer.totalBytes);
    if (tailEnd > tailStart) chunks.push(buffer.tail.subarray(tailStart - (buffer.totalBytes - buffer.tail.length), tailEnd - (buffer.totalBytes - buffer.tail.length)));
    const bytes = Buffer.concat(chunks).subarray(0, limit);
    return { offset, limit, nextOffset: offset + bytes.length, bytes, totalBytes: buffer.totalBytes, droppedBytes: buffer.droppedBytes, retainedRanges: retained };
  }
}
