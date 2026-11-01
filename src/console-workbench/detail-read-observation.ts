import { WorkbenchError } from "./types.js";
import type { ConsoleArtifactRead } from "./detail-read-artifacts.js";
import type { CaptureReadObservation, CaptureReadScope } from "../session/capture-read-observation.js";
import type { ConsoleDetailRead, ReadonlyRunDetail } from "./detail-read-model.js";

function sameScope(a: CaptureReadScope, b: CaptureReadScope): boolean {
  return a.sessionId === b.sessionId && a.memberId === b.memberId && a.taskId === b.taskId;
}


/** Parent-only merge. The observation is obtained from the live collector after the worker returns. */
export function applyDetailReadObservation(result: ConsoleDetailRead, observation?: CaptureReadObservation): ReadonlyRunDetail {
  const { read } = result;
  const value = { ...result.value, run: { ...result.value.run, actions: { ...result.value.run.actions } },
    warnings: [...result.value.warnings], changeCaptures: [...result.value.changeCaptures],
    missingPhases: [...result.value.missingPhases] };
  const current = read.scope && read.fence && observation && sameScope(read.scope, observation.scope)
    && observation.generation === read.fence.generation && observation.sequence >= read.fence.sequence
    && observation.unchanged;
  const settled = read.kind === "checkpoint" || Boolean(current && observation?.state === "idle");
  if (read.kind === "live" && current && observation) {
    value.changeCaptures = [{ runId: value.run.id, nodeId: value.run.nodeId,
      projectName: value.run.projectName, root: value.run.root, state: observation.state, error: observation.error }];
  }
  value.complete = read.contentComplete && settled;
  if (value.complete) {
    value.missingPhases = [];
    value.run.actions = { ...read.candidateActions, revert: false };
  } else {
    const reason = !read.contentComplete ? "保存的详情证据不完整"
      : current && observation?.state === "failed" ? "文件改动整理失败"
      : current && observation?.state === "pending" ? "文件改动仍在整理"
      : "详情读取期间状态已变化或实时观察尚未取得，请刷新后再确认";
    const failed = !read.contentComplete || current && observation?.state === "failed";
    value.missingPhases = [{ id: value.run.id, nodeId: value.run.nodeId, error: reason, ...(!failed ? {pending: true} : {}) }];
    if (failed && !value.warnings.includes(reason)) value.warnings.push(reason);
    value.run.actions = { ...value.run.actions, review: false, complete: false, patch: false, revert: false };
  }
  // The same phase object is displayed by aggregate detail and must use the same action gates.
  value.phases = value.phases.map(phase => phase.id === value.run.id ? { ...phase, run: value.run } : phase);
  return value;
}

/** Saved output is independently bound to its operation; live patches/diffs need the same capture fence as detail. */
export function applyArtifactReadObservation<T extends ConsoleArtifactRead>(result: T, observation?: CaptureReadObservation): T["value"] {
  const { read } = result;
  if (result.kind === "command-output") return result.value;
  if (!read.contentComplete) throw new WorkbenchError("保存的改动摘要不完整", 409, "task_incomplete", "none");
  if (read.kind === "checkpoint") return result.value;
  const current = read.scope && read.fence && observation && sameScope(read.scope, observation.scope)
    && observation.generation === read.fence.generation && observation.sequence >= read.fence.sequence
    && observation.unchanged;
  if (!current) throw new WorkbenchError("文件改动已变化，请刷新后重试", 409, "revision_conflict", "none");
  if (observation!.state !== "idle") throw new WorkbenchError(
    observation!.state === "failed" ? "文件改动整理失败，不能确认完整内容" : "文件改动仍在整理，请稍后重试", 409,
    observation!.state === "failed" ? "change_capture_failed" : "change_capture_pending", "none");
  return result.value;
}
