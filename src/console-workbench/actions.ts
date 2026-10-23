import { ConsoleAudit } from "./audit.js";
export { ConsoleAudit } from "./audit.js";
import type { ProcessSessionManager } from "../process-sessions.js";
import { controlRun, reconcileControl, type ControlInput } from "./control-actions.js";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import type { ServerConfig } from "../config.js";
import { WorkLedger } from "../work-ledger.js";
import { LocalAgentStore } from "../local-agent-store.js";
import { workspaceHandle } from "../federation/routing.js";
import type { SessionRuntime } from "../session/runtime.js";
import { ReviewState } from "../session/types.js";
import { RevertPreconditionError } from "../session/revert.js";
import { ProjectArchive } from "../project-archive.js";
import { CodexThreadControl } from "../codex-thread-control.js";
import { linkForRun, permitted, requireRun, readLocalIndex } from "./local.js";
import { WorkbenchError } from "./types.js";
import { stage } from "./query.js";
import { readRunCheckpoint, saveRunCheckpoint, type RunCheckpoint } from "../session/run-checkpoints.js";
import { aggregateTasks,taskReference } from './task-aggregation.js';
import { activeExecution } from '../console-task-state.js';
import { ExecutionCoordinator } from '../execution-coordinator.js';
import { taskView } from "../task-view.js";

interface RevertPreview {
  id: string; runId: string; sessionId: string; memberId: string; owner: string;
  revision: number; files: string[]; expiresAt: number;
  taskId?:string|null;
}

function archiveResponse(result: ReturnType<ProjectArchive["view"]>) {
  return { id: result.batchId, projectId: result.projectId, mode: result.mode, effect: result.effect,
    status: result.status === "succeeded" ? "completed" : result.status,
    confirmationHash: result.confirmationHash, expiresAt: Date.parse(result.expiresAt),
    readyCount: result.readyCount, succeededCount: result.succeededCount, reconciliationCount: result.reconciliationCount,
    skippedCount: result.skippedCount, acceptPartial: result.acceptPartial,
    entries: result.entries.map(entry => ({ id: entry.managedThreadId, title: entry.title, ready: entry.status === "ready", reason: entry.reason, status: entry.status })),
    results: result.entries.map(entry => ({ id: entry.managedThreadId, ok: entry.status === "succeeded", state: entry.status,
      error: entry.reason, pending: ["ready", "executing", "reconciliation_required"].includes(entry.status) })),
  };
}

export class LocalActions {
  readonly audit: ConsoleAudit;
  constructor(readonly config: ServerConfig, readonly session?: SessionRuntime, readonly processSessions?: ProcessSessionManager) {
    mkdirSync(config.stateDir, { recursive: true });
    this.audit = new ConsoleAudit(config.stateDir, config.federation?.nodeId ?? "local");
  }

  private assertFileCaptureReady(memberId: string, taskId?: string) {
    const capture = this.session?.changes?.captureObservation(memberId, taskId);
    if (!capture || capture.state === "idle") return;
    const failed = capture.state === "failed";
    throw new WorkbenchError(failed
      ? `文件改动采集失败，请处理后刷新并重新确认${capture.error ? `：${capture.error}` : ""}`
      : "文件改动正在采集，请等待完成并刷新后重新确认", 409, failed ? "file_capture_failed" : "file_capture_pending", "none");
  }

  async review(ref: { id: string; expectedRevision: number; completeExecution?: boolean }, verdict: "accept" | "reject", note: string, requestKey: string) {
    const ledger = new WorkLedger(this.config.stateDir);
    try {
      const original = requireRun(this.config, ledger, ref.id);
      if (original.revision !== ref.expectedRevision) throw new WorkbenchError("任务已更新，请刷新后再次确认", 409, "revision_conflict", "none");
      const link = linkForRun(ledger, ref.id);
      const frozen = original.status === "completed" && readRunCheckpoint(ledger.db, original.id);
      const live = this.session && link && !frozen ? { memberId: link.member_id, taskId: link.task_id ?? undefined,
        revision: this.session.store.getMember(link.session_id, link.member_id).revision } : null;
      const assertLiveEvidence = () => {
        if (!live || !link || !this.session) return;
        this.assertFileCaptureReady(live.memberId, live.taskId);
        if (this.session.store.getMember(link.session_id, live.memberId).revision !== live.revision)
          throw new WorkbenchError("文件或工作证据已更新，请刷新并重新核对后验收", 409, "revision_conflict", "none");
      };
      assertLiveEvidence();
      let checkpoint: RunCheckpoint | null = null;
      if (original.status === "running") {
        if (!ref.completeExecution || !this.session || link?.latest_run !== original.id) {
          throw new WorkbenchError("请明确确认结束当前工作后再验收", 409, "completion_confirmation_required", "none");
        }
        if (ledger.hasActiveChild(original.id)) throw new WorkbenchError("当前工作仍有执行中的操作或代理", 409, "work_active", "none");
        const unresolved = ledger.db.prepare("SELECT 1 FROM console_operations WHERE run_id=? AND status IN ('unknown','reconciliation_required') LIMIT 1").get(original.id);
        if (unresolved) throw new WorkbenchError("存在尚未确认的操作结果，请先核对", 409, "work_unresolved", "none");
        try { checkpoint = await this.session.service.prepareRunCheckpoint(link.session_id, link.member_id,link.task_id ?? undefined); }
        catch (error) { assertLiveEvidence(); throw error; }
        assertLiveEvidence();
      }
      const commitReview = () => {
        assertLiveEvidence();
        const run = requireRun(this.config, ledger, ref.id);
        if (run.revision !== ref.expectedRevision) throw new WorkbenchError("任务已更新，请刷新后再次确认", 409, "revision_conflict", "none");
        if (run.status === "running" && ref.completeExecution) {
          const currentRevision = ledger.db.prepare("SELECT revision FROM qm_session_members WHERE id=?")
            .get(link!.member_id) as { revision: number };
          if (!checkpoint || (checkpoint.snapshot.changeRev ?? checkpoint.revision) !== currentRevision.revision) {
            throw new WorkbenchError("工作内容已更新，请重新核对后验收", 409, "revision_conflict", "none");
          }
          ledger.finish(run.id, { status: "completed", acceptance: verdict === "accept" ? "passed" : "failed",
            summary: note || "用户已确认当前工作结束", evidence: [{ label: "用户验收", reference: note || "用户在控制台明确结束并验收当前工作", outcome: verdict === "accept" ? "passed" : "failed" }] });
          saveRunCheckpoint(ledger.db, run.id, { ...checkpoint, snapshot: { ...checkpoint.snapshot,
            review_status: verdict === "accept" ? ReviewState.passed : ReviewState.failed } });
          return;
        }
        if (run.status !== "completed" || run.acceptance !== "pending") throw new WorkbenchError("只有执行完成且待验收的任务可以验收", 409, "operation_rejected", "none");
        const evidence = JSON.parse(run.evidence);
        evidence.push({ label: "用户验收", reference: note || "用户在控制台确认执行结果", outcome: verdict === "accept" ? "passed" : "failed" });
        ledger.db.prepare("UPDATE console_work_runs SET acceptance=?, evidence=?, revision=revision+1 WHERE id=? AND revision=?")
          .run(verdict === "accept" ? "passed" : "failed", JSON.stringify(evidence), run.id, run.revision);
      };
      if (this.session && link?.task_id) this.session.store.commitTaskReviewState(link.session_id, link.task_id, link.member_id, ref.id,
        verdict === "accept" ? ReviewState.passed : ReviewState.failed, ledger.db, commitReview);
      else ledger.db.transaction(commitReview).immediate();
      this.audit.record("run.review", ref.id, { acceptance: "pending" }, { verdict, note }, requestKey);
      return { id: ref.id, ok: true, revision: ref.expectedRevision + 1 };
    } finally { ledger.close(); }
  }

  sessions(projectId: string) {
    const ledger = new WorkLedger(this.config.stateDir);
    const agents = new LocalAgentStore(this.config.stateDir);
    try {
      const project = ledger.getProject(projectId);
      if (!permitted(this.config, project.root)) throw new WorkbenchError("项目不在允许访问的范围内", 403, "project_scope", "none");
      const node = this.config.federation?.nodeId ?? "local";
      const projectRunIds = (ledger.db.prepare("SELECT id FROM console_work_runs WHERE project_id=?").all(projectId) as Array<{ id: string }>).map((row) => row.id);
      const runs = readLocalIndex(this.config, projectRunIds).runs;
      const sessionRows = ledger.db.prepare(`SELECT DISTINCT s.id,s.title,s.last_activity_at,s.created_at FROM qm_sessions s
        JOIN qm_session_members m ON m.session_id=s.id
        WHERE m.node_id=? AND m.root=? ORDER BY s.last_activity_at DESC,s.id`).all(node,project.root) as Array<{
          id:string;title:string;last_activity_at:string;created_at:string;
        }>;
      const conversations=sessionRows.map(row=>{
        const actual=aggregateTasks(runs.filter(run=>run.sessionId===row.id));
        const taskRows=ledger.db.prepare(`SELECT DISTINCT t.id,t.title,t.state,t.result_status,t.created_at,t.finished_at,t.last_activity_at
          FROM qm_tasks t JOIN qm_task_members tm ON tm.task_id=t.id JOIN qm_session_members m ON m.id=tm.member_id
          WHERE t.session_id=? AND m.node_id=? AND m.root=?`).all(row.id,node,project.root) as Array<{
            id:string;title:string;state:string;result_status:string|null;created_at:string;finished_at:string|null;last_activity_at:string;
          }>;
        const tasks=actual.map(task=>({id:task.id,taskId:task.taskId,title:task.title,status:stage(task),root:task.root,workspaces:task.workspaces,
          executionStatus:task.executionStatus,acceptanceStatus:task.acceptanceStatus,lastActivityAt:task.lastActivityAt,
          startedAt:task.startedAt,finishedAt:task.finishedAt,hasRun:true}));
        for(const task of taskRows)if(!tasks.some(value=>value.taskId===task.id)){
          const execution=taskView({requestState:task.state,result:task.result_status,execution:'waiting',lastProgressAt:Date.parse(task.last_activity_at),now:Date.now()}).status;
          tasks.push({id:taskReference(task.id),taskId:task.id,title:task.title,status:stage({executionStatus:execution,acceptanceStatus:'not_required'}),
            root:project.root,workspaces:[{nodeId:node,projectId:workspaceHandle(node,projectId),memberId:null,name:project.name,root:project.root}],
            executionStatus:execution,acceptanceStatus:'not_required',lastActivityAt:Date.parse(task.last_activity_at),startedAt:Date.parse(task.created_at),
            finishedAt:task.finished_at ? Date.parse(task.finished_at) : null,hasRun:false});
        }
        tasks.sort((a,b)=>b.startedAt-a.startedAt);
        return {id:row.id,title:row.title,projectId:workspaceHandle(node,projectId),nodeId:node,
          createdAt:Date.parse(row.created_at),updatedAt:Date.parse(row.last_activity_at),
          taskCount:tasks.length,activeCount:tasks.filter(task=>activeExecution(task.executionStatus)).length,
          tasks};
      });
      const items = ledger.threads(projectId).map((thread) => {
        const agent = agents.getById(thread.agent_id);
        const nativeRuns = ledger.threadRuns(thread.id);
        const mapped = nativeRuns.flatMap((run) => { const visible = runs.find((item) => item.localId === run.id); return visible ? [visible] : []; });
        const control = agent?.controlState === "desktop_owned" || agent?.controlState === "desktop_pending" ? "desktop"
          : agent?.controlState === "qm_active" || agent?.controlState === "interrupting" ? "quaymesh" : "idle";
        const reason = thread.protected ? "已设置保留" : !thread.identity_verified ? "归属未核实"
          : thread.external_activity ? "存在外部续写" : control !== "idle" ? "当前会话仍在执行" : mapped.some((run) => stage(run) === "review") ? "执行结果待验收" : null;
        return { id: workspaceHandle(node, thread.id), localId: thread.id, projectId: workspaceHandle(node, projectId), title: thread.title,
          runIds: mapped.map((run) => run.id), runs: mapped.map((run) => ({ id: run.id, title: run.title, status: stage(run) })),
          control, turnId: agent?.providerTurnId ?? null, revision: agent?.controlRevision ?? thread.revision,
          protectRevision: thread.revision, protected: Boolean(thread.protected), verified: Boolean(thread.identity_verified),
          external: Boolean(thread.external_activity), archiveState: thread.archive_state,
          updatedAt: Date.parse(thread.updated_at), skipReason: reason };
      });
      const batches = ledger.db.prepare("SELECT id,mode,status,created_at FROM console_archive_batches WHERE project_id=? ORDER BY created_at DESC LIMIT 50").all(projectId) as Array<{ id: string; mode: string; status: string; created_at: string }>;
      const execution=new ExecutionCoordinator(this.config.stateDir);
      let executionClaims:Array<ReturnType<ExecutionCoordinator['inspect']>[number] & {waiting?:ReturnType<ExecutionCoordinator['waitingState']>}>;
      try { executionClaims=execution.inspect(project.root).map(claim=>({...claim,
        ...(claim.state==='queued' && claim.agentId ? {waiting:execution.waitingState(project.root,claim.agentId)} : {})})); }
      finally { execution.close(); }
      return { conversations,executionClaims,items, batches: batches.map((batch) => ({ id: workspaceHandle(node, batch.id), mode: batch.mode,
        status: batch.status === "succeeded" ? "completed" : batch.status, createdAt: Date.parse(batch.created_at) })),
        claims: items.filter((thread) => thread.control !== "idle").map((thread) => ({ id: thread.id, owner: thread.control, turnId: thread.turnId, updatedAt: thread.updatedAt })) };
    } finally { agents.close(); ledger.close(); }
  }

  runControl(id: string, input: ControlInput) {
    return controlRun(this.config, this.session, this.processSessions, id, input);
  }

  reconcileControl(id: string, requestKey: string) {
    return reconcileControl(this.config, id, requestKey);
  }

  reconcileReview(id: string, verdict: "accept" | "reject", note: string) {
    const ledger = new WorkLedger(this.config.stateDir);
    try {
      const run = requireRun(this.config, ledger, id);
      const target = verdict === "accept" ? "passed" : "failed";
      const evidence = JSON.parse(run.evidence) as Array<{label: string; reference: string; outcome: string}>;
      const link = linkForRun(ledger, id);
      const taskRecorded = !this.session || !link?.task_id || Boolean(ledger.db.prepare(`SELECT 1 FROM qm_events
        WHERE session_id=? AND task_id=? AND member_id=? AND event_type='verification_recorded'
          AND json_extract(data_json,'$.run_id')=? AND json_extract(data_json,'$.decision')=? LIMIT 1`)
        .get(link.session_id, link.task_id, link.member_id, id, target));
      const verified = run.status === "completed" && run.acceptance === target
        && taskRecorded
        && evidence.some(value => value.label === "用户验收" && value.outcome === target
          && (note ? value.reference === note : ["用户在控制台确认执行结果", "用户在控制台明确结束并验收当前工作"].includes(value.reference)));
      return { verified, effect: "applied" as const, response: { id, ok: true, revision: run.revision } };
    } finally { ledger.close(); }
  }

  async revertPreview(id: string, files: string[], expectedRevision: number) {
    if (!this.session) throw new WorkbenchError("运行版本尚未提供会话撤销", 409, "revert_unavailable", "none");
    const ledger = new WorkLedger(this.config.stateDir);
    try {
      const run = requireRun(this.config, ledger, id);
      if (run.revision !== expectedRevision) throw new WorkbenchError("任务已经更新", 409, "revision_conflict", "none");
      const link = linkForRun(ledger, id);
      if (!link) throw new WorkbenchError("此任务没有可自动撤销的会话写入证据", 409, "operation_rejected", "none");
      this.assertFileCaptureReady(link.member_id, link.task_id ?? undefined);
      const session = this.session;
      const revision = session.store.getMember(link.session_id, link.member_id).revision;
      const checkpoint = readRunCheckpoint(ledger.db, id);
      if (!checkpoint && !link.task_id && link.latest_run !== id) throw new WorkbenchError("此历史任务没有保存可验证的文件版本，无法自动撤销", 409, "operation_rejected", "none");
      const assertPreviewEvidence = () => {
        this.assertFileCaptureReady(link.member_id, link.task_id ?? undefined);
        if (session.store.getMember(link.session_id, link.member_id).revision !== revision)
          throw new WorkbenchError("文件或工作证据已更新，请刷新并重新确认撤销", 409, "revision_conflict", "none");
        if (checkpoint) {
          const current = session.store.fileSummaries(link.session_id, link.member_id,link.task_id ?? undefined);
          if (files.some((id) => {
            const recorded = checkpoint.files.find((file) => file.id === id);
            return !recorded || !current.some((file) => file.id === id && file.hash === recorded.hash);
          })) throw new WorkbenchError("文件已不再是这段工作保存的版本，请重新查看改动", 409, "revision_conflict", "none");
        }
      };
      assertPreviewEvidence();
      const eligibility = await session.reverter.eligibility(link.owner_id, link.session_id, link.member_id, files,link.task_id);
      assertPreviewEvidence();
      if (eligibility.revision !== revision)
        throw new WorkbenchError("文件或工作证据已更新，请刷新并重新确认撤销", 409, "revision_conflict", "none");
      if (!eligibility.allowed) throw new WorkbenchError(`当前无法撤销：${eligibility.reason}`, 409, "operation_rejected", "none");
      ledger.db.prepare("DELETE FROM console_revert_previews WHERE expires_at<=?").run(Date.now());
      const preview: RevertPreview = { id: randomUUID(), runId: id, sessionId: link.session_id, memberId: link.member_id,
        owner: link.owner_id,taskId:link.task_id, revision, files, expiresAt: Date.now() + 300_000 };
      ledger.db.prepare("INSERT INTO console_revert_previews(id,data_json,expires_at) VALUES (?,?,?)")
        .run(preview.id, JSON.stringify(preview), preview.expiresAt);
      return { id: preview.id, hash: preview.id, files, expiresAt: preview.expiresAt, revision: preview.revision };
    } finally { ledger.close(); }
  }

  async revertCommit(previewId: string, confirmation: string, requestKey: string) {
    const ledger = new WorkLedger(this.config.stateDir);
    try {
      const saved = ledger.db.prepare("SELECT data_json FROM console_revert_previews WHERE id=?").get(previewId) as { data_json: string } | undefined;
      const preview = saved ? JSON.parse(saved.data_json) as RevertPreview : null;
      if (!preview || preview.id !== confirmation || preview.expiresAt <= Date.now()) throw new WorkbenchError("撤销预览已失效，请重新确认", 409, "preview_expired", "none");
      if (!this.session) throw new WorkbenchError("当前服务没有会话撤销能力", 409, "operation_rejected", "none");
      // 旧预览没有 taskId 字段时从原 Run 的持久归属恢复，不能落到会话当前 Task。
      const originalLink = preview.taskId === undefined ? linkForRun(ledger, preview.runId) : null;
      if (preview.taskId === undefined && (!originalLink || originalLink.session_id !== preview.sessionId || originalLink.member_id !== preview.memberId))
        throw new WorkbenchError("原撤销预览的任务归属无法确认，请刷新并重新预览", 409, "preview_expired", "none");
      const targetTaskId = preview.taskId === undefined ? originalLink!.task_id : preview.taskId;
      let result;
      try { result = await this.session.reverter.revert(preview.owner, preview.sessionId, preview.memberId, preview.revision, true, preview.files,targetTaskId); }
      catch (error) {
        if (error instanceof RevertPreconditionError) throw new WorkbenchError(error.message, 409, error.code, error.effect);
        throw error;
      }
      ledger.db.prepare("DELETE FROM console_revert_previews WHERE id=?").run(previewId);
      this.audit.record("run.revert", preview.runId, null, {previewId, files: result.changed_paths,revision:result.revision}, requestKey);
      return { status: "completed", files: result.changed_paths, revision: result.revision };
    } finally { ledger.close(); }
  }

  async reconcileArchive(projectId: string, batchId: string, requestKey: string) {
    const ledger = new WorkLedger(this.config.stateDir);
    const service = new ProjectArchive(ledger, new CodexThreadControl());
    try {
      if (!permitted(this.config, ledger.getProject(projectId).root)) throw new WorkbenchError("项目不在允许访问的范围内", 403, "project_scope", "none");
      const step = service.step(projectId, batchId, requestKey);
      if (!step || step.managed_thread_id && !["succeeded", "skipped"].includes(step.status ?? "")) return { verified: false };
      const response = archiveResponse(service.view(projectId, batchId));
      return { verified: true, effect: response.effect, response };
    } finally { await service.close(); ledger.close(); }
  }

  async archive(projectId: string, input: { mode?: "archive" | "restore"; ids?: string[]; batchId?: string; confirmationHash?: string; externalIdleConfirmed?: boolean; acceptPartial?: boolean; requestKey?: string }) {
    const ledger = new WorkLedger(this.config.stateDir);
    const service = new ProjectArchive(ledger, new CodexThreadControl());
    try {
      if (!permitted(this.config, ledger.getProject(projectId).root)) throw new WorkbenchError("项目不在允许访问的范围内", 403, "project_scope", "none");
      const result = input.batchId
        ? await service.execute(projectId, input.batchId, input.confirmationHash!, input.externalIdleConfirmed === true, input.requestKey)
        : await service.plan(projectId, { mode: input.mode!, threadKeys: input.ids, acceptPartial: input.acceptPartial });
      return archiveResponse(result);
    } finally { await service.close(); ledger.close(); }
  }
}
