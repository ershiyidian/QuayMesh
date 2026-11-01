import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ServerConfig } from "../config.js";
import type { WorkLedger } from "../work-ledger.js";
import { SessionStore } from "../session/store.js";
import type { FileSummary } from "../session/types.js";
import type { CaptureReadFence } from "../session/capture-read-observation.js";
import { completeUtf8PrefixEnd, fitUtf8 } from "../session/output-codec.js";
import { readSavedOutputPage } from "../session/output-reader.js";
import { SavedArtifactError, readSavedArtifactRange, readSavedTextArtifact, savedArtifactId, savedArtifactSize } from "../session/saved-artifacts.js";
import { linkForRun, permitted } from "./local.js";
import { diffPage } from "./diff.js";
import { WorkbenchError } from "./types.js";
import type { DetailReadEvidence, DetailReadScope } from "./detail-read-model.js";

type SavedFile = FileSummary & { patchRef: string; versionRef: string };
export interface ArtifactParentScope {
  expectedTaskId?: string;
  /** A legacy Session URL is scoped to phases with no Task binding. */
  expectedSessionId?: string;
}
export type ConsoleArtifactRequest = (
  | { kind: "file-diff"; runId: string; fileId: string; cursor?: string }
  | { kind: "patch"; runId: string; cursor?: string }
  | { kind: "command-output"; runId: string; commandId: string; cursor?: string }) & ArtifactParentScope;
type FileValue = { file: { id: string; path: string; rows: ReturnType<typeof diffPage>["rows"]; totalRows: number; revision: string; binary: boolean }; complete: boolean; nextCursor: string | null };
type PatchValue = { patch: string; complete: boolean; nextCursor: string | null; revision: number };
type OutputValue = { chunk: string; cursor: number; done: boolean; hasMore: boolean; totalBytes: number; truncated: boolean; retainedFrom: number;
  outputState: "writing" | "ready" | "incomplete" | "expired" | "unknown"; errorCode: string | null };
export type ConsoleArtifactRead =
  | { kind: "file-diff"; value: FileValue; read: DetailReadEvidence }
  | { kind: "patch"; value: PatchValue; read: DetailReadEvidence }
  | { kind: "command-output"; value: OutputValue; read: DetailReadEvidence };

function cursorOffset(cursor: string | undefined, revision: string): number {
  if (cursor === undefined || cursor === "0") return 0;
  if (cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new WorkbenchError("游标无效", 400, "invalid_cursor", "none");
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { v?: number; revision?: string; offset?: number };
    if (value.v !== 1 || !Number.isSafeInteger(value.offset) || value.offset! < 0) throw new Error("invalid");
    if (value.revision !== revision) throw new WorkbenchError("文件改动已更新，请从头重新读取", 409, "revision_conflict", "none");
    return value.offset!;
  } catch (error) {
    if (error instanceof WorkbenchError) throw error;
    throw new WorkbenchError("游标无效", 400, "invalid_cursor", "none");
  }
}
function nextCursor(offset: number, revision: string): string {
  return Buffer.from(JSON.stringify({ v: 1, revision, offset })).toString("base64url");
}
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function patchPage(root: string, runId: string, files: SavedFile[], live: boolean, cursor: string | undefined) {
  if (files.length > 4096) throw new SavedArtifactError("artifact_too_large");
  const pieces: Array<{ text: Buffer } | { path: string; bytes: number }> = [];
  for (let index = 0; index < files.length; index++) {
    const file = files[index]!;
    if (index) pieces.push({ text: Buffer.from("\n") });
    if (live) pieces.push({ text: Buffer.from(`# ${file.path}\n`) });
    pieces.push({ path: file.patchRef, bytes: await savedArtifactSize(root, file.patchRef) });
  }
  const revision = fingerprint({ runId, format: live ? "live-with-path-v1" : "checkpoint-v1", files: files.map(file => [file.id, file.hash, file.versionRef]) });
  const total = pieces.reduce((sum, piece) => sum + ("text" in piece ? piece.text.length : piece.bytes), 0);
  if (!Number.isSafeInteger(total)) throw new SavedArtifactError("artifact_too_large");
  const offset = cursorOffset(cursor, revision);
  if (offset > total) throw new WorkbenchError("游标超出补丁范围", 400, "invalid_cursor", "none");
  const wanted = Math.min(64 * 1024 + 4, total - offset);
  const chunks: Buffer[] = [];
  let skipped = 0, collected = 0;
  for (const piece of pieces) {
    const length = "text" in piece ? piece.text.length : piece.bytes;
    const start = Math.max(0, offset - skipped);
    if (start < length && collected < wanted) {
      const count = Math.min(length - start, wanted - collected);
      chunks.push("text" in piece ? piece.text.subarray(start, start + count)
        : await readSavedArtifactRange(root, piece.path, start, count));
      collected += count;
    }
    skipped += length;
    if (collected >= wanted) break;
  }
  const raw = Buffer.concat(chunks, collected);
  if (raw.length && (raw[0]! & 0xc0) === 0x80) throw new WorkbenchError("游标没有指向 UTF-8 边界", 400, "invalid_cursor", "none");
  const patch = fitUtf8(raw.subarray(0, completeUtf8PrefixEnd(raw)).toString("utf8"), 64 * 1024);
  const next = offset + Buffer.byteLength(patch);
  if (next === offset && offset < total) throw new SavedArtifactError("artifact_changed");
  return { patch, complete: next === total, nextCursor: next === total ? null : nextCursor(next, revision) };
}

/** Called inside the fixed entry point's readonly SQL snapshot. */
export async function readRunArtifact(config: ServerConfig, ledger: WorkLedger, request: ConsoleArtifactRequest,
  fence?: CaptureReadFence): Promise<ConsoleArtifactRead> {
  const link = linkForRun(ledger, request.runId);
  if (!link) throw new WorkbenchError("此历史阶段没有可验证的保存范围", 404, "snapshot_unavailable", "none");
  if (request.expectedSessionId !== undefined && (link.session_id !== request.expectedSessionId || link.task_id !== null)) {
    throw new WorkbenchError("此阶段不属于请求的历史会话", 403, "task_scope", "none");
  }
  if (request.expectedTaskId !== undefined && link.task_id !== request.expectedTaskId) {
    // Old qmtask URLs used a Session ID. Match the router's existing fallback:
    // only if that ID is not a real Task, and only an unbound phase of that exact Session.
    const legacyAlias = link.task_id === null && link.session_id === request.expectedTaskId
      && !ledger.db.prepare("SELECT 1 FROM qm_tasks WHERE id=?").get(request.expectedTaskId);
    if (!legacyAlias) throw new WorkbenchError("此阶段不属于请求的任务", 403, "task_scope", "none");
  }
  const store = new SessionStore(ledger.db);
  const member = store.getMember(link.session_id, link.member_id);
  const nodeId = config.federation?.nodeId ?? "local";
  if (member.node_id !== nodeId || link.node_id !== nodeId || !permitted(config, member.root)) {
    throw new WorkbenchError("任务成员不在当前节点范围内", 403, "task_scope", "none");
  }
  const task = link.task_id ? store.getTask(link.task_id) : null;
  if (task) store.taskData.requireScope(task.id, link.session_id, link.member_id);
  const scope: DetailReadScope = { nodeId, runId: request.runId, sessionId: link.session_id, memberId: link.member_id, taskId: link.task_id };
  const read: DetailReadEvidence = { kind: "live", scope, fence: fence ? { ...fence } : null,
    revisions: { run: ledger.run(request.runId).revision, task: task?.revision ?? null, member: member.revision, checkpoint: null },
    contentComplete: task?.change_summary_state !== "incomplete",
    candidateActions: { interrupt: false, resume: false, review: false, revert: false, complete: false, patch: false } };
  try {
    if (request.kind === "command-output") {
      const operation = ledger.db.prepare("SELECT id FROM console_operations WHERE id=? AND run_id=? AND kind IN ('command','exec_command','bash')")
        .get(request.commandId, request.runId);
      if (!operation) throw new WorkbenchError("命令不属于这个任务", 404, "command_not_found", "none");
      const cursor = request.cursor === undefined ? 0 : Number(request.cursor);
      if (!Number.isSafeInteger(cursor) || cursor < 0) throw new WorkbenchError("输出游标无效", 400, "invalid_cursor", "none");
      const output = await readSavedOutputPage(config.stateDir, { sessionId: scope.sessionId,
        commandId: request.commandId, operationId: request.commandId }, cursor);
      return { kind: request.kind, read, value: { chunk: output.chunk, cursor: output.nextCursor, done: output.done,
        hasMore: output.nextCursor > output.cursor && output.nextCursor < output.totalBytes, totalBytes: output.totalBytes, truncated: output.truncated,
        retainedFrom: output.retainedFrom, outputState: output.outputState, errorCode: output.errorCode } };
    }
    const checkpoint = ledger.db.prepare(`SELECT session_id,member_id,revision,files_json,
      json_extract(snapshot_json,'$.taskId') task_id, json_extract(snapshot_json,'$.changeSummary.state') change_summary_state FROM qm_run_checkpoints WHERE run_id=?`).get(request.runId) as { session_id: string; member_id: string; task_id: string | null; revision: number; files_json: string; change_summary_state: string | null } | undefined;
    if (checkpoint && (checkpoint.session_id !== scope.sessionId || checkpoint.member_id !== scope.memberId
      || checkpoint.task_id !== scope.taskId)) throw new WorkbenchError("保存的文件范围不匹配", 409, "snapshot_scope", "none");
    const frozen = !checkpoint && task?.state === "closed" ? ledger.db.prepare("SELECT revision,files_json,json_extract(snapshot_json,'$.changeSummary.state') change_summary_state FROM qm_task_snapshots WHERE task_id=? AND member_id=?")
      .get(task.id, member.id) as { revision: number; files_json: string; change_summary_state: string | null } | undefined : undefined;
    const saved = checkpoint ?? frozen;
    if (!saved && !link.task_id && (link.latest_run !== request.runId || store.getSession(link.session_id).current_task_id !== null)) throw new WorkbenchError("历史阶段没有独立文件快照", 404, "snapshot_unavailable", "none");
    const files: SavedFile[] = saved ? JSON.parse(saved.files_json) : store.fileSummaries(scope.sessionId, scope.memberId, scope.taskId ?? undefined);
    if (!Array.isArray(files) || files.some(file => file.member_id !== scope.memberId)) throw new WorkbenchError("保存的文件成员范围不一致", 409, "snapshot_scope", "none");
    if (saved) { read.kind = "checkpoint"; read.revisions.checkpoint = saved.revision; read.contentComplete = saved.change_summary_state !== "incomplete"; }
    if (!read.contentComplete) throw new WorkbenchError("保存的改动摘要不完整", 409, "task_incomplete", "none");
    const root = join(config.stateDir, "session-evidence", savedArtifactId(scope.sessionId), savedArtifactId(scope.memberId),
      ...(scope.taskId ? [savedArtifactId(scope.taskId)] : []));
    if (request.kind === "file-diff") {
      const file = files.find(file => file.id === request.fileId && file.member_id === scope.memberId);
      if (!file) throw new WorkbenchError("文件不属于这个阶段", 404, "file_not_found", "none");
      const revision = fingerprint([request.runId, file.id, file.hash]);
      const offset = cursorOffset(request.cursor, revision);
      const patch = file.binary ? "" : await readSavedTextArtifact(root, file.patchRef, 8 * 1024 * 1024);
      const page = file.binary ? { rows: [], totalRows: 0, nextCursor: null } : diffPage(patch, String(offset));
      if (file.binary && offset !== 0) throw new WorkbenchError("二进制差异游标无效", 400, "invalid_cursor", "none");
      return { kind: request.kind, read, value: { file: { id: file.id, path: file.path, rows: page.rows,
        totalRows: page.totalRows, revision: file.hash, binary: file.binary }, complete: page.nextCursor === null,
        nextCursor: page.nextCursor === null ? null : nextCursor(Number(page.nextCursor), revision) } };
    }
    const page = await patchPage(root, request.runId, files, read.kind === "live", request.cursor);
    return { kind: request.kind, read, value: { ...page, revision: saved?.revision ?? member.revision } };
  } catch (error) {
    if (error instanceof SavedArtifactError) throw new WorkbenchError(
      error.code === "artifact_too_large" ? "保存的内容超过单次读取预算" : error.code === "artifact_changed" ? "保存的内容在读取期间变化，请重试原游标" : "保存的内容当前不可读取",
      error.code === "artifact_too_large" ? 413 : error.code === "artifact_changed" ? 409 : 404,
      error.code, "none");
    if (error instanceof Error && ["OUTPUT_CURSOR_INVALID", "OUTPUT_CURSOR_AHEAD"].includes(error.message)) {
      throw new WorkbenchError("输出游标无效", 400, "invalid_cursor", "none");
    }
    throw error;
  }
}
