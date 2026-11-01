import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { type ExecutionResource } from "../execution-resources.js";
import { ExecutionCoordinator } from "../execution-coordinator.js";
import type { LocalAgentStore } from "../local-agent-store.js";
import type { SessionChangeCollector } from "./changes.js";
import type { SessionStore } from "./store.js";
import type { FileSummary, SessionMember } from "./types.js";
import { memberFile, ownershipPath, readFileState, readOwnedFiles, restoreFileState, sameFileState, writeOwnedFiles } from "./write-evidence.js";

export type { RevertEligibility } from "./revert-read.js";
import { readRevertEligibility, type RevertEligibility } from "./revert-read.js";

export interface RevertResult {
  ok: true;
  session_id: string;
  member_id: string;
  revision: number;
  changed_paths: string[];
}

export class RevertPreconditionError extends Error {
  effect: "none" | "partial" = "none";
  constructor(readonly code: "file_capture_pending" | "file_capture_failed" | "revision_conflict", message: string) { super(message); }
}

export class SessionReverter {
  constructor(
    private readonly store: SessionStore,
    private readonly stateDir: string,
    private readonly execution: ExecutionCoordinator,
    private readonly changes?: SessionChangeCollector,
    private readonly agents?: LocalAgentStore,
  ) {}

  async eligibility(ownerId: string, sessionId: string, memberId: string, fileIds?: readonly string[], targetTaskId: string | null | undefined = this.store.currentTask(sessionId)?.id): Promise<RevertEligibility> {
    const member = this.member(ownerId, sessionId, memberId);
    return this.eligibilityForMember(sessionId, member, new Set(), fileIds, targetTaskId ?? undefined);
  }

  async revert(ownerId: string, sessionId: string, memberId: string, expectedRevision: number, confirm: boolean, fileIds?: readonly string[], targetTaskId: string | null | undefined = this.store.currentTask(sessionId)?.id): Promise<RevertResult> {
    if (confirm !== true) throw new Error("REVERT_CONFIRMATION_REQUIRED");
    const taskId = targetTaskId ?? undefined;
    let member = this.member(ownerId, sessionId, memberId);
    this.assertCaptureReady(member.id, taskId);
    member = this.memberAtRevision(sessionId, member.id, expectedRevision);
    const workspace = await stat(member.root).then(info=>info.isDirectory(),(error:NodeJS.ErrnoException)=>{
      if(error.code==="ENOENT")return false;
      throw error;
    });
    if(!workspace)throw new Error("REVERT_NOT_ALLOWED: workspace_missing");
    // 采集完成后必须由调用者重新查看证据；不能等待后沿用旧 revision 或旧文件范围。
    this.assertCaptureReady(member.id, taskId);
    member = this.memberAtRevision(sessionId, member.id, expectedRevision);
    const selected=this.files(sessionId,memberId,taskId).filter(file=>!fileIds||fileIds.includes(file.id));
    const paths=[...new Set(selected.flatMap(file=>file.from?[file.from,file.path]:[file.path]))];
    const scopes:ExecutionResource[]=paths.map(path=>({kind:"file",path:memberFile(member.root,path).absolute,access:"write"}));
    const claim = this.execution.acquire({ workspaceRoot:member.root,kind:"mutation",scopes,taskId,title:"撤销文件改动" });
    try {
      const eligibility = await this.eligibilityForMember(sessionId, member, new Set([claim.id]), fileIds, taskId);
      this.assertCaptureReady(member.id, taskId);
      member = this.memberAtRevision(sessionId, member.id, expectedRevision);
      if (!eligibility.allowed) throw new Error(`REVERT_NOT_ALLOWED: ${eligibility.reason}`);
      if (eligibility.revision !== expectedRevision || paths.length !== eligibility.paths.length || eligibility.paths.some(path => !paths.includes(path)))
        throw new RevertPreconditionError("revision_conflict", "SESSION_REVISION_CHANGED: 文件范围已更新，请刷新并重新确认撤销");
      const path = ownershipPath(this.stateDir, sessionId, member.id, taskId);
      const owned = await readOwnedFiles(path);
      // 全部目标先检查，再开始写入；其他文件的改动保持原样。
      for (const file of eligibility.paths) {
        const proof = owned[file];
        if (!proof?.safe) throw new Error(`REVERT_EVIDENCE_MISSING: ${file}`);
        const current = await readFileState(memberFile(member.root, file).absolute);
        if (!sameFileState(current, proof.after)) throw new Error(`REVERT_CONFLICT: ${file}`);
      }
      this.assertCaptureReady(member.id, taskId);
      member = this.memberAtRevision(sessionId, member.id, expectedRevision);
      const operationId = `revert_${randomUUID()}`;
      this.store.appendEvent({
        session_id: sessionId, task_id: taskId ?? null, member_id: member.id, type: "operation_started", source_id: operationId,
        timestamp: new Date().toISOString(),
        payload: { operation_id: operationId, kind: "patch", label: "Revert session changes", actor: "user" },
      });
      const writeRevision = this.store.getMember(sessionId, member.id).revision;
      const restored: string[] = [];
      const attempted: string[] = [];
      try {
        for (const file of eligibility.paths) {
          this.assertCaptureReady(member.id, taskId);
          this.memberAtRevision(sessionId, member.id, writeRevision);
          // A restore may replace the file before a later step (for example
          // chmod) fails. Entering it loses the guarantee of no side effects.
          attempted.push(file);
          await restoreFileState(memberFile(member.root, file).absolute, owned[file]!.before);
          delete owned[file];
          restored.push(file);
        }
        await writeOwnedFiles(path, owned);
        await this.changes?.capture(member.id, taskId);
        this.store.appendEvent({
          session_id: sessionId, task_id: taskId ?? null, member_id: member.id, type: "operation_finished", source_id: `${operationId}-finish`,
          timestamp: new Date().toISOString(),
          payload: { operation_id: operationId, status: "succeeded", effect: "completed", actor: "user", changed_paths: restored },
        });
      } catch (error) {
        if (error instanceof RevertPreconditionError && restored.length) error.effect = "partial";
        this.store.appendEvent({
          session_id: sessionId, task_id: taskId ?? null, member_id: member.id, type: "operation_finished", source_id: `${operationId}-finish`,
          timestamp: new Date().toISOString(),
          payload: { operation_id: operationId, status: "failed", effect: restored.length ? "partial" : attempted.length ? "unknown" : "not_started", actor: "user",
            changed_paths: restored, attempted_paths: attempted, error_message: error instanceof Error ? error.message : String(error) },
        });
        throw error;
      }
      return { ok: true, session_id: sessionId, member_id: member.id, revision: this.store.getMember(sessionId, member.id).revision, changed_paths: restored };
    } finally { claim.release(); }
  }

  private member(ownerId: string, sessionId: string, memberId: string): SessionMember {
    const session = this.store.requireSession(ownerId, sessionId);
    return this.store.getMember(session.id, memberId);
  }

  private memberAtRevision(sessionId: string, memberId: string, revision: number): SessionMember {
    const member = this.store.getMember(sessionId, memberId);
    if (member.revision !== revision) throw new RevertPreconditionError("revision_conflict",
      `SESSION_REVISION_CHANGED: expected ${revision}, current ${member.revision}；文件或工作证据已更新，请刷新并重新确认撤销`);
    return member;
  }

  private captureBlock(memberId: string, taskId?: string): RevertPreconditionError | null {
    const capture = this.changes?.captureObservation(memberId, taskId);
    if (!capture || capture.state === "idle") return null;
    return capture.state === "pending"
      ? new RevertPreconditionError("file_capture_pending", "文件改动正在采集，请等待完成并刷新后重新确认撤销")
      : new RevertPreconditionError("file_capture_failed", `文件改动采集失败，请处理后刷新并重新确认撤销${capture.error ? `：${capture.error}` : ""}`);
  }

  private assertCaptureReady(memberId: string, taskId?: string): void {
    const blocked = this.captureBlock(memberId, taskId);
    if (blocked) throw blocked;
  }

  private files(sessionId: string, memberId: string, taskId?: string): FileSummary[] {
    return this.store.fileSummaries(sessionId, memberId, taskId).filter((file) => file.revertible && file.coverage === "session_owned");
  }

  private async eligibilityForMember(sessionId: string, member: SessionMember, ignored: Set<string>, fileIds?: readonly string[], taskId?: string): Promise<RevertEligibility> {
    return readRevertEligibility(this.store,sessionId,member, {
      captureBlock:(id,task)=>this.captureBlock(id,task)?.message??null,
      inspect:root=>this.execution.inspect(root),
    },ignored,fileIds,taskId);
  }
}
