import { join } from "node:path";
import type { SessionOutputMetadata, SessionOutputRead } from "./output.js";
import { readUtf8BytePage } from "./output-codec.js";
import { SavedArtifactError, readSavedArtifactRange, readSavedTextArtifact, savedArtifactId } from "./saved-artifacts.js";

export interface SavedOutputScope { sessionId: string; commandId: string; operationId: string }

function validateMetadata(value: unknown, scope: SavedOutputScope): SessionOutputMetadata {
  const m = value as SessionOutputMetadata;
  if (!m || ![1, 2, 3].includes(m.version) || m.session_id !== scope.sessionId
    || m.command_id !== scope.commandId || m.operation_id !== scope.operationId
    || !Number.isSafeInteger(m.total_bytes) || m.total_bytes < 0
    || !Number.isSafeInteger(m.retained_from) || m.retained_from < 0 || m.retained_from > m.total_bytes
    || typeof m.done !== "boolean") throw new SavedArtifactError("artifact_scope");
  if (m.state !== undefined && !["writing", "ready", "incomplete", "expired"].includes(m.state)
    || m.exit_code !== null && !Number.isInteger(m.exit_code)
    || m.signal !== null && typeof m.signal !== "string") throw new SavedArtifactError("artifact_unavailable");
  if (m.expired || m.state === "expired") throw new SavedArtifactError("artifact_unavailable");
  if (m.version !== 1) {
    if (!Array.isArray(m.segments) || m.segments.length > 4096) throw new SavedArtifactError("artifact_unavailable");
    let lastEnd = -1;
    for (const segment of m.segments) {
      if (!segment || !Number.isSafeInteger(segment.start) || segment.start < 0
        || !Number.isSafeInteger(segment.bytes) || segment.bytes <= 0 || segment.start < lastEnd
        || segment.start + segment.bytes > m.total_bytes) throw new SavedArtifactError("artifact_unavailable");
      savedArtifactId(segment.file);
      lastEnd = segment.start + segment.bytes;
    }
  }
  return m;
}

/** Reads durable output only. No output writer, event emitter, watcher, queue or directory creation. */
export async function readSavedOutputPage(stateDir: string, scope: SavedOutputScope, cursor: number,
  requestedBytes = 32 * 1024): Promise<SessionOutputRead> {
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("OUTPUT_CURSOR_INVALID");
  if (!Number.isSafeInteger(requestedBytes) || requestedBytes < 1 || requestedBytes > 64 * 1024) throw new Error("OUTPUT_BYTES_INVALID");
  const commandId = savedArtifactId(scope.commandId);
  const root = join(stateDir, "session-output");
  const metadataPath = join(root, `${commandId}.json`);
  const readMetadata = async () => validateMetadata(JSON.parse(await readSavedTextArtifact(root, metadataPath, 256 * 1024)), scope);
  const metadata = await readMetadata();
  if (cursor > metadata.total_bytes) throw new Error("OUTPUT_CURSOR_AHEAD");
  const offset = Math.max(cursor, metadata.retained_from);
  const length = Math.min(requestedBytes + 4, metadata.total_bytes - offset);
  let raw: Buffer;
  if (length === 0) {
    raw = Buffer.alloc(0);
  } else if (metadata.version === 1) {
    raw = await readSavedArtifactRange(root, join(root, `${commandId}.bin`), offset - metadata.retained_from, length);
  } else {
    const parts: Buffer[] = [];
    let position = offset;
    for (const segment of metadata.segments!) {
      const end = segment.start + segment.bytes;
      if (end <= offset || segment.start >= offset + length) continue;
      const from = Math.max(segment.start, offset);
      if (from !== position) throw new SavedArtifactError("artifact_changed");
      const count = Math.min(end, offset + length) - from;
      parts.push(await readSavedArtifactRange(join(root, commandId), join(root, commandId, segment.file), from - segment.start, count));
      position += count;
    }
    if (position !== offset + length) throw new SavedArtifactError("artifact_changed");
    raw = Buffer.concat(parts, length);
  }
  // Rotation may remove a segment while reading. Never silently return a gap or
  // bytes whose retained offset has changed; the caller retries its original cursor.
  const after = await readMetadata();
  if (after.version !== metadata.version || after.retained_from > offset || after.total_bytes < metadata.total_bytes
    || metadata.version === 1 && after.retained_from !== metadata.retained_from) throw new SavedArtifactError("artifact_changed");
  const page = readUtf8BytePage(raw, requestedBytes, metadata.done && offset + raw.length === metadata.total_bytes);
  const chunk = page.chunk;
  const nextCursor = offset + page.consumedBytes;
  const outputState = metadata.state ?? (metadata.done ? "ready" : "writing");
  return { chunk, cursor: offset, nextCursor, done: metadata.done && nextCursor >= metadata.total_bytes,
    retainedFrom: metadata.retained_from, truncated: cursor < metadata.retained_from, totalBytes: metadata.total_bytes,
    processDone: metadata.done, exitCode: metadata.exit_code, signal: metadata.signal,
    outputState, errorCode: metadata.error_code ?? null };
}
