import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { canonicalResourcePath,resourcesConflict,type ExecutionResource } from "../execution-resources.js";
import { ExecutionCoordinator } from "../execution-coordinator.js";
import type { LocalAgentStore } from "../local-agent-store.js";
import type { SessionChangeCollector } from "./changes.js";
import type { SessionStore } from "./store.js";
import type { FileSummary, SessionMember } from "./types.js";
import { memberFile, ownershipPath, readFileState, readOwnedFiles, restoreFileState, sameFileState, writeOwnedFiles } from "./write-evidence.js";

export interface RevertEligibility {
  allowed: boolean;
  reason: string | null;
  session_id: string;
  member_id: string;
  revision: number;
  paths: string[];
}

export interface RevertResult {
  ok: true;
  session_id: string;
  member_id: string;
  revision: number;
  changed_paths: string[];
}

export class SessionReverter {
  constructor(
    private readonly store: SessionStore,
    private readonly stateDir: string,
    private readonly execution: ExecutionCoordinator,
    private readonly changes?: SessionChangeCollector,
    private readonly agents?: LocalAgentStore,
  ) {}

  async eligibility(ownerId: string, sessionId: string, memberId: string, fileIds?: readonly string[], taskId = this.store.currentTask(sessionId)?.id): Promise<RevertEligibility> {
    const member = this.member(ownerId, sessionId, memberId);
    return this.eligibilityForMember(sessionId, member, new Set(), fileIds, taskId);
  }

  async revert(ownerId: string, sessionId: string, memberId: string, expectedRevision: number, confirm: boolean, fileIds?: readonly string[], taskId = this.store.currentTask(sessionId)?.id): Promise<RevertResult> {
    if (confirm !== true) throw new Error("REVERT_CONFIRMATION_REQUIRED");
    const member = this.member(ownerId, sessionId, memberId);
    const workspace = await stat(member.root).then(info=>info.isDirectory(),(error:NodeJS.ErrnoException)=>{
      if(error.code==="ENOENT")return false;
      throw error;
    });
    if(!workspace)throw new Error("REVERT_NOT_ALLOWED: workspace_missing");
    const selected=this.files(sessionId,memberId,taskId).filter(file=>!fileIds||fileIds.includes(file.id));
    const paths=[...new Set(selected.flatMap(file=>file.from?[file.from,file.path]:[file.path]))];
    const scopes:ExecutionResource[]=paths.map(path=>({kind:"file",path:memberFile(member.root,path).absolute,access:"write"}));
    const claim = this.execution.acquire({ workspaceRoot:member.root,kind:"mutation",scopes,taskId,title:"撤销文件改动" });
    try {
      const eligibility = await this.eligibilityForMember(sessionId, member, new Set([claim.id]), fileIds, taskId);
      if (!eligibility.allowed) throw new Error(`REVERT_NOT_ALLOWED: ${eligibility.reason}`);
      if (eligibility.revision !== expectedRevision) throw new Error(`SESSION_REVISION_CHANGED: expected ${expectedRevision}, current ${eligibility.revision}`);
      const path = ownershipPath(this.stateDir, sessionId, member.id, taskId);
      const owned = await readOwnedFiles(path);
      // 全部目标先检查，再开始写入；其他文件的改动保持原样。
      for (const file of eligibility.paths) {
        const proof = owned[file];
        if (!proof?.safe) throw new Error(`REVERT_EVIDENCE_MISSING: ${file}`);
        const current = await readFileState(memberFile(member.root, file).absolute);
        if (!sameFileState(current, proof.after)) throw new Error(`REVERT_CONFLICT: ${file}`);
      }
      const operationId = `revert_${randomUUID()}`;
      this.store.appendEvent({
        session_id: sessionId, task_id: taskId ?? null, member_id: member.id, type: "operation_started", source_id: operationId,
        timestamp: new Date().toISOString(),
        payload: { operation_id: operationId, kind: "patch", label: "Revert session changes", actor: "user" },
      });
      const restored: string[] = [];
      try {
        for (const file of eligibility.paths) {
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
        this.store.appendEvent({
          session_id: sessionId, task_id: taskId ?? null, member_id: member.id, type: "operation_finished", source_id: `${operationId}-finish`,
          timestamp: new Date().toISOString(),
          payload: { operation_id: operationId, status: "failed", effect: restored.length ? "partial" : "not_started", actor: "user",
            changed_paths: restored, error_message: error instanceof Error ? error.message : String(error) },
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

  private files(sessionId: string, memberId: string, taskId?: string): FileSummary[] {
    return this.store.fileSummaries(sessionId, memberId, taskId).filter((file) => file.revertible && file.coverage === "session_owned");
  }

  private async eligibilityForMember(sessionId: string, member: SessionMember, ignored: Set<string>, fileIds?: readonly string[], taskId = this.store.currentTask(sessionId)?.id): Promise<RevertEligibility> {
    const workspace = await stat(member.root).then(info=>info.isDirectory(),(error:NodeJS.ErrnoException)=>{
      if(error.code==="ENOENT")return false;
      throw error;
    });
    if(!workspace)return {allowed:false,reason:"workspace_missing",session_id:sessionId,member_id:member.id,revision:member.revision,paths:[]};
    const owned = this.files(sessionId, member.id, taskId);
    const selected = fileIds ? owned.filter((file) => fileIds.includes(file.id)) : owned;
    if (fileIds && (fileIds.length === 0 || new Set(fileIds).size !== selected.length)) throw new Error("REVERT_FILE_SELECTION_INVALID");
    const paths = [...new Set(selected.flatMap((file) => file.from ? [file.from, file.path] : [file.path]))];
    let reason: string | null = paths.length ? null : "no_owned_changes";
    const requested:ExecutionResource[]=paths.map(path=>({kind:"file",path:canonicalResourcePath(memberFile(member.root,path).absolute),access:"write"}));
    if (this.execution.inspect(member.root).some(claim=>!ignored.has(claim.id)&&claim.scopes.some(scope=>requested.some(target=>resourcesConflict(scope,target))))) reason="active_writer";
    return { allowed: reason === null, reason, session_id: sessionId, member_id: member.id, revision: member.revision, paths };
  }
}
