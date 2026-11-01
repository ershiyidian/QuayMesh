import { readRunArtifact, type ConsoleArtifactRequest, type ConsoleArtifactRead } from "./detail-read-artifacts.js";
import type { ServerConfig } from "../config.js";
import { openReadonlyDatabase } from "../db/client.js";
import { WorkLedger } from "../work-ledger.js";
import { runOperations } from "../console-run-data.js";
import { SessionStore } from "../session/store.js";
import { SessionProjector } from "../session/projection.js";
import { readRunCheckpoint } from "../session/run-checkpoints.js";
import type { FileSummary, Snapshot } from "../session/types.js";
import type { CaptureReadFence, CaptureReadScope } from "../session/capture-read-observation.js";
import { linkForRun, permitted, readLocalIndex, requireRun } from "./local.js";
import { presentRunDetail, type FileRow } from "./detail-presentation.js";
import { WorkbenchError, type Run } from "./types.js";

export interface DetailReadScope extends CaptureReadScope { nodeId: string; runId: string }
export interface DetailReadEvidence {
  kind: "checkpoint" | "live" | "legacy";
  scope: DetailReadScope | null;
  fence: CaptureReadFence | null;
  revisions: { run: number; task: number | null; member: number | null; checkpoint: number | null };
  contentComplete: boolean;
  /** Saved eligibility only; live capture and mutating endpoints must still revalidate it. */
  candidateActions: Run["actions"];
}
export type ReadonlyRunDetail = Omit<ReturnType<typeof presentRunDetail>, "missingPhases"> & {
  missingPhases: Array<{ id: string; nodeId: string; error: string; pending?: boolean }>;
};
export interface ConsoleDetailRead {
  value: ReadonlyRunDetail;
  read: DetailReadEvidence;
}
export interface ConsoleDetailRequest { kind: "detail"; runId: string }
export type ConsoleSavedReadRequest = ConsoleDetailRequest | ConsoleArtifactRequest;
export type ConsoleSavedRead = ConsoleDetailRead | ConsoleArtifactRead;


function snapshotInScope(snapshot: Snapshot, scope: DetailReadScope): void {
  if (snapshot.sessionId !== scope.sessionId || (snapshot.taskId ?? null) !== scope.taskId
    || snapshot.workspace?.id !== scope.memberId || snapshot.workspace.node_id !== scope.nodeId) {
    throw new WorkbenchError("保存的详情与任务范围不一致", 409, "snapshot_scope", "none");
  }
}

function fileRows(files: Array<FileSummary & { patchRef: string; versionRef: string }>): FileRow[] {
  return files.map(file => ({ id: file.id, path: file.path, kind: file.status,
    add: file.additions, del: file.removals, revision: file.hash, generated: file.large,
    binary: file.binary, revertible: false }));
}

/**
 * Fixed readonly entry point for the isolated worker. It never creates a
 * SessionRuntime, schedules projection/capture, migrates a database or checks
 * live filesystem mutation eligibility. All SQL shares one readonly snapshot.
 */
export function readConsoleDetail(config: ServerConfig, request: ConsoleDetailRequest, fence?: CaptureReadFence): Promise<ConsoleDetailRead>;
export function readConsoleDetail(config: ServerConfig, request: ConsoleArtifactRequest, fence?: CaptureReadFence): Promise<ConsoleArtifactRead>;
export function readConsoleDetail(config: ServerConfig, request: ConsoleSavedReadRequest, fence?: CaptureReadFence): Promise<ConsoleSavedRead>;
export async function readConsoleDetail(config: ServerConfig, request: ConsoleSavedReadRequest,
  fence?: CaptureReadFence): Promise<ConsoleSavedRead> {
  if (!["detail", "file-diff", "patch", "command-output"].includes(request.kind)
    || typeof request.runId !== "string" || !request.runId || request.runId.length > 512
    || "cursor" in request && request.cursor !== undefined && (typeof request.cursor !== "string" || request.cursor.length > 512)
    || request.kind === "file-diff" && (typeof request.fileId !== "string" || !request.fileId || request.fileId.length > 512)
    || request.kind === "command-output" && (typeof request.commandId !== "string" || !request.commandId || request.commandId.length > 512)
    || request.kind !== "detail" && (request.expectedTaskId !== undefined && (typeof request.expectedTaskId !== "string" || !request.expectedTaskId || request.expectedTaskId.length > 512)
      || request.expectedSessionId !== undefined && (typeof request.expectedSessionId !== "string" || !request.expectedSessionId || request.expectedSessionId.length > 512)
      || request.expectedTaskId !== undefined && request.expectedSessionId !== undefined)) {
    throw new WorkbenchError("详情读取参数无效", 400, "invalid_read", "none");
  }
  const database = openReadonlyDatabase(config.stateDir);
  const ledger = new WorkLedger(config.stateDir, database);
  try {
    database.sqlite.exec("BEGIN");
    const row = requireRun(config, ledger, request.runId);
    if (request.kind !== "detail") return await readRunArtifact(config, ledger, request, fence);
    const run = readLocalIndex(config, [request.runId], ledger).runs[0];
    if (!run) throw new WorkbenchError("任务不在当前节点范围内", 404, "run_not_found", "none");
    const operations = runOperations(ledger, request.runId);
    const executions = ledger.executions(request.runId);
    const link = linkForRun(ledger, request.runId);
    const store = new SessionStore(database.sqlite);
    const nodeId = config.federation?.nodeId ?? "local";
    let scope: DetailReadScope | null = null;
    let memberRevision: number | null = null, taskRevision: number | null = null;
    let snapshot: Snapshot | null = null;
    let files: FileRow[] = [];
    let kind: DetailReadEvidence["kind"] = "legacy";
    let checkpointRevision: number | null = null;
    let contentComplete = true;
    const warnings = [...run.warnings];
    if (link) {
      const member = store.getMember(link.session_id, link.member_id);
      if (member.node_id !== nodeId || link.node_id !== nodeId || !permitted(config, member.root)) {
        throw new WorkbenchError("任务成员不在当前节点范围内", 403, "task_scope", "none");
      }
      const task = link.task_id ? store.getTask(link.task_id) : null;
      if (task) store.taskData.requireScope(task.id, link.session_id, link.member_id);
      scope = { nodeId, runId: request.runId, sessionId: link.session_id, memberId: link.member_id, taskId: link.task_id };
      memberRevision = member.revision;
      taskRevision = task?.revision ?? null;
      const checkpoint = readRunCheckpoint(database.sqlite, request.runId)
        ?? (task?.state === "closed" ? store.getTaskSnapshot(task.id, member.id) : null);
      if (checkpoint) {
        snapshotInScope(checkpoint.snapshot, scope);
        if (checkpoint.files.some(file => file.member_id !== scope!.memberId)) throw new WorkbenchError("保存的文件成员范围不一致", 409, "snapshot_scope", "none");
        snapshot = checkpoint.snapshot;
        files = fileRows(checkpoint.files);
        kind = "checkpoint";
        checkpointRevision = checkpoint.revision;
      } else if (link.task_id || link.latest_run === request.runId && store.getSession(link.session_id).current_task_id === null) {
        // readSnapshot composes current saved evidence but never persists it.
        snapshot = await new SessionProjector(store, config.stateDir, null, undefined, nodeId)
          .readSnapshot(link.session_id, link.member_id, link.task_id ?? undefined);
        snapshotInScope(snapshot, scope);
        files = fileRows(store.fileSummaries(link.session_id, link.member_id, link.task_id ?? undefined));
        kind = "live";
      } else {
        contentComplete = false;
        warnings.push("此历史阶段没有独立保存的文件快照，不能用后续任务的状态补齐。");
        run.branch = null; run.baseSha = null; run.diff = null;
      }
      if (snapshot?.changeSummary?.state === "incomplete") {
        contentComplete = false;
        warnings.push("保存的文件改动摘要不完整；已取得的执行证据仍可查看。");
      }
    } else {
      // An unlinked historical run has no trustworthy member/Task capture scope.
      // It may still show its own saved operation history, never a later session.
      contentComplete = false;
      warnings.push("此历史记录没有关联的任务文件快照；文件、指令和技能记录尚未完整取得。");
    }
    const candidateActions = { ...run.actions, revert: false, patch: contentComplete && files.length > 0 };
    run.actions = { ...candidateActions, review: false, complete: false, patch: false };
    const value: ReadonlyRunDetail = presentRunDetail({ row, run, operations, executions, snapshot, files,
      warnings, changeCaptures: [],
      agentMetadata: id => {
        const agent = database.sqlite.prepare("SELECT profile_name,task_name FROM local_agent_sessions WHERE id=?")
          .get(id) as { profile_name: string; task_name: string | null } | undefined;
        return agent ? { name: agent.profile_name, role: agent.task_name ?? "" } : undefined;
      },
    });
    value.complete = kind === "checkpoint" && contentComplete;
    if (!value.complete) value.missingPhases = [{ id: run.id, nodeId, error: "文件改动状态等待当前节点核对", pending: true }];
    return { value, read: { kind, scope, fence: fence ? { ...fence } : null,
      revisions: { run: row.revision, task: taskRevision, member: memberRevision, checkpoint: checkpointRevision },
      contentComplete, candidateActions } };
  } finally {
    try { if (database.sqlite.inTransaction) database.sqlite.exec("ROLLBACK"); }
    finally { ledger.close(); }
  }
}
