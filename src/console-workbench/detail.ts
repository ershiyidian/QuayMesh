import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { formatPatch, parsePatch } from "diff";
import type { ServerConfig } from "../config.js";
import { WorkLedger } from "../work-ledger.js";
import { runOperations } from "../console-run-data.js";
import { LocalAgentStore } from "../local-agent-store.js";
import type { SessionRuntime } from "../session/runtime.js";
import type { CaptureObservation } from "../session/changes.js";
import { linkForRun, readLocalIndex, requireRun } from "./local.js";
import { WorkbenchError } from "./types.js";
import { presentRunDetail, type FileRow } from "./detail-presentation.js";
import { diffPage } from "./diff.js";
import { readRunCheckpoint } from "../session/run-checkpoints.js";

export interface ChangeCapture extends CaptureObservation {
  runId: string;
  nodeId: string;
  projectName: string;
  root: string;
}

function requireIdleCapture(runtime: SessionRuntime, memberId: string, taskId?: string): void {
  const capture = runtime.changes.captureObservation(memberId, taskId);
  if (capture.state === "pending") throw new WorkbenchError(
    "文件改动仍在整理，请稍后刷新再导出补丁", 409, "change_capture_pending", "none");
  if (capture.state === "failed") throw new WorkbenchError(
    `文件改动整理失败，无法导出完整补丁：${capture.error ?? "原因未知"}`, 409, "change_capture_failed", "none");
}

function checkpointForRun(ledger:WorkLedger,id:string,runtime?:SessionRuntime) {
  const checkpoint=readRunCheckpoint(ledger.db,id);
  if(checkpoint)return checkpoint;
  const link=linkForRun(ledger,id);
  return runtime && link?.task_id && runtime.store.getTask(link.task_id).state==='closed'
    ? runtime.store.getTaskSnapshot(link.task_id,link.member_id) : null;
}


async function legacyFiles(config: ServerConfig, operations: ReturnType<typeof runOperations>): Promise<FileRow[]> {
  const files: FileRow[] = [];
  for (const operation of operations) {
    const evidence = JSON.parse(operation.evidence) as Array<{ label: string; reference: string; outcome: string }>;
    if (!evidence.some((item) => item.label === "console.changes" && item.reference === operation.id && item.outcome === "passed")) continue;
    const manifest = JSON.parse(await readFile(join(config.stateDir, "console-changes", `${operation.id}.json`), "utf8")) as {
      files: Array<{ path: string; type: string; additions: number; removals: number }>;
    };
    manifest.files.forEach((file, index) => files.push({ id: `${operation.id}:${index}`, path: file.path,
      kind: file.type === "new" ? "A" : file.type === "deleted" ? "D" : file.type === "rename-changed" ? "R" : "M",
      add: file.additions, del: file.removals, generated: /(?:lock\.|\.lock$)/.test(file.path),
      revision: 1, binary: false, revertible: false, operationId: operation.id, fileIndex: index }));
  }
  return files;
}

export async function readRunDetail(config: ServerConfig, id: string, runtime?: SessionRuntime) {
  const ledger = new WorkLedger(config.stateDir);
  const agents = new LocalAgentStore(config.stateDir);
  try {
    const row = requireRun(config, ledger, id);
    const run = readLocalIndex(config, [id]).runs[0];
    if (!run) throw new WorkbenchError("任务已不在当前节点的可见范围内", 404, "run_not_found");
    const operations = runOperations(ledger, id);
    const executions = ledger.executions(id);
    const link = linkForRun(ledger, id);
    const archived = checkpointForRun(ledger,id,runtime);
    const currentMember = runtime && link ? runtime.store.getMember(link.session_id, link.member_id) : null;
    const snapshot = archived?.snapshot ?? (runtime && link
      ? await runtime.projector.materialize(link.session_id, link.member_id,link.task_id ?? undefined) : null);
    let files: FileRow[] = [];
    const changeCaptures: ChangeCapture[] = [];
    const warnings = [...run.warnings];
    if (archived) {
      const currentFiles = runtime && currentMember && link ? runtime.store.fileSummaries(link.session_id, link.member_id,link.task_id ?? undefined) : [];
      files = archived.files.map((file) => ({ id: file.id, path: file.path, kind: file.status,
        add: file.additions, del: file.removals, revision: file.hash, generated: file.large, binary: file.binary,
        revertible: currentFiles.some((current) => current.id === file.id && current.hash === file.hash && current.revertible && current.coverage === "session_owned") }));
      const candidates = files.filter((file) => file.revertible).map((file) => file.id);
      run.actions.revert = Boolean(runtime && currentMember && link && candidates.length
        && (await runtime.reverter.eligibility(link.owner_id, link.session_id, link.member_id, candidates,link.task_id)).allowed);
    } else if (runtime && currentMember && link && (link.task_id || link.latest_run === id)) {
      // Read the observation and saved files without yielding between them. A
      // capture finishing during eligibility checks must not turn an older empty
      // list into an apparently settled one. Frozen checkpoints stay independent.
      const capture = runtime.changes.captureObservation(link.member_id, link.task_id ?? undefined);
      changeCaptures.push({ runId: run.id, nodeId: run.nodeId, projectName: run.projectName, root: run.root, ...capture });
      if (capture.state === "pending") warnings.push("文件改动正在整理，当前列表尚未确认完整。");
      if (capture.state === "failed") warnings.push(`文件改动整理失败，当前列表可能不完整：${capture.error ?? "原因未知"}`);
      files = runtime.store.fileSummaries(link.session_id, link.member_id,link.task_id ?? undefined).map((file) => ({
        id: file.id, path: file.path, kind: file.status, add: file.additions, del: file.removals,
        revision: file.hash, generated: file.large, binary: file.binary, revertible: file.revertible && file.coverage === "session_owned",
      }));
      const eligibility = await runtime.reverter.eligibility(link.owner_id, link.session_id, link.member_id,undefined,link.task_id);
      run.actions.revert = eligibility.allowed;
    } else {
      try { files = await legacyFiles(config, operations); }
      catch (error) { warnings.push(`已保存的差异文件不可读：${error instanceof Error ? error.message : String(error)}`); }
      run.actions.revert = false;
    }
    if (changeCaptures.some(capture => capture.state !== "idle")) {
      run.actions = { ...run.actions, review: false, complete: false, patch: false, revert: false };
    }
    return presentRunDetail({ row, run, operations, executions, snapshot, files, warnings, changeCaptures,
      agentMetadata: id => { const agent = agents.getById(id); return agent ? { name: agent.profileName, role: agent.taskName ?? "" } : undefined; },
    });
  } finally { agents.close(); ledger.close(); }
}

export function textPage(text: string, cursor = "0", maxBytes = 64 * 1024) {
  const buffer = Buffer.from(text, "utf8");
  const start = Number(cursor);
  if (!Number.isSafeInteger(start) || start < 0 || start > buffer.length) throw new WorkbenchError("输出游标无效", 400, "invalid_cursor");
  let end = Math.min(buffer.length, start + maxBytes);
  while (end > start && end < buffer.length && (buffer[end] & 0xc0) === 0x80) end--;
  return { text: buffer.subarray(start, end).toString("utf8"), nextCursor: end < buffer.length ? String(end) : null };
}

export async function readFileDiff(config: ServerConfig, id: string, fileId: string, cursor: string | undefined, runtime?: SessionRuntime) {
  const ledger = new WorkLedger(config.stateDir);
  try {
    requireRun(config, ledger, id);
    const link = linkForRun(ledger, id);
    let patch: string;
    let path: string;
    let revision: string | number;
    let binary = false;
    const archived = checkpointForRun(ledger,id,runtime);
    if (archived) {
      const file = archived.files.find((file) => file.id === fileId);
      if (!file) throw new WorkbenchError("这段工作没有保存此文件的差异", 404, "file_not_found");
      patch = await readFile(file.patchRef, "utf8"); path = file.path; revision = file.hash; binary = file.binary;
    } else if (runtime && link && (link.task_id || link.latest_run === id)) {
      const file = runtime.store.fileSummaries(link.session_id, link.member_id,link.task_id ?? undefined).find((file) => file.id === fileId);
      if (!file) throw new WorkbenchError("任务中没有此文件", 404, "file_not_found");
      const result = await runtime.changes.fileDiff(link.session_id, file.id, file.hash,link.task_id ?? undefined);
      patch = result.patch; path = file.path; revision = file.hash; binary = file.binary;
    } else {
      const files = await legacyFiles(config, runOperations(ledger, id));
      const file = files.find((file) => file.id === fileId);
      if (!file) throw new WorkbenchError("任务中没有此文件", 404, "file_not_found");
      const saved = await readFile(join(config.stateDir, "console-changes", `${file.operationId}.patch`), "utf8");
      patch = formatPatch(parsePatch(saved)[file.fileIndex!]); path = file.path; revision = file.revision;
    }
    const page = binary ? { rows: [], totalRows: 0, nextCursor: null } : diffPage(patch, cursor);
    return { file: { id: fileId, path, rows: page.rows, totalRows: page.totalRows, revision, binary }, complete: page.nextCursor === null, nextCursor: page.nextCursor };
  } finally { ledger.close(); }
}

export async function readRunPatch(config: ServerConfig, id: string, cursor?: string, runtime?: SessionRuntime) {
  const ledger = new WorkLedger(config.stateDir);
  try {
    requireRun(config, ledger, id);
    const link = linkForRun(ledger, id);
    const archived = checkpointForRun(ledger,id,runtime);
    if (archived) {
      const patches = await Promise.all(archived.files.map((file) => readFile(file.patchRef, "utf8")));
      const page = textPage(patches.join("\n"), cursor);
      return { patch: page.text, complete: page.nextCursor === null, nextCursor: page.nextCursor, revision: archived.revision };
    }
    if (runtime && link && (link.task_id || link.latest_run === id)) {
      requireIdleCapture(runtime, link.member_id, link.task_id ?? undefined);
      const revision = runtime.store.memberRevision(link.member_id);
      const result = await runtime.changes.patch(link.session_id, link.member_id, cursor,link.task_id ?? undefined);
      requireIdleCapture(runtime, link.member_id, link.task_id ?? undefined);
      if (runtime.store.memberRevision(link.member_id) !== revision) throw new WorkbenchError(
        "文件改动已更新，请刷新后重新导出补丁", 409, "revision_conflict", "none");
      return { patch: result.patch, complete: result.nextCursor === null, nextCursor: result.nextCursor,
        revision };
    }
    const files = await legacyFiles(config, runOperations(ledger, id));
    const patches = await Promise.all([...new Set(files.map((file) => file.operationId))].map((operation) => readFile(join(config.stateDir, "console-changes", `${operation}.patch`), "utf8")));
    const page = textPage(patches.join("\n"), cursor);
    return { patch: page.text, complete: page.nextCursor === null, nextCursor: page.nextCursor, scope: "operation_history", revision: ledger.run(id).revision };
  } finally { ledger.close(); }
}

export async function readCommandOutput(config: ServerConfig, id: string, commandId: string, cursor?: string, runtime?: SessionRuntime) {
  const ledger = new WorkLedger(config.stateDir);
  try {
    requireRun(config, ledger, id);
    if (!runOperations(ledger, id).some((operation) => operation.id === commandId && ["command", "exec_command", "bash"].includes(operation.kind))) throw new WorkbenchError("命令不属于这个任务", 404, "command_not_found");
    const link = linkForRun(ledger, id);
    if (!runtime || !link) throw new WorkbenchError("此历史命令没有保存可读取的输出", 404, "output_unavailable");
    const result = await runtime.output.uiRead(link.session_id, commandId, Number(cursor ?? 0), 32 * 1024);
    return { chunk: result.chunk, cursor: result.nextCursor, done: result.done, hasMore: result.nextCursor < result.totalBytes,
      totalBytes: result.totalBytes, truncated: result.truncated, retainedFrom: result.retainedFrom };
  } finally { ledger.close(); }
}
