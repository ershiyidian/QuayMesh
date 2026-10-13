import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { ServerConfig } from "../config.js";
import { WorkLedger } from "../work-ledger.js";
import { LocalAgentStore } from "../local-agent-store.js";
import { createLocalAgentClient } from "../local-agent-client.js";
import { workspaceHandle } from "../federation/routing.js";
import type { SessionRuntime } from "../session/runtime.js";
import { ReviewState } from "../session/types.js";
import { ProjectArchive } from "../project-archive.js";
import { CodexThreadControl } from "../codex-thread-control.js";
import { linkForRun, permitted, requireRun, readLocalIndex } from "./local.js";
import { WorkbenchError } from "./types.js";
import { stage } from "./query.js";
import { readRunCheckpoint, saveRunCheckpoint, type RunCheckpoint } from "../session/run-checkpoints.js";
import { aggregateTasks,taskReference } from './task-aggregation.js';
import { activeExecution } from '../console-task-state.js';
import { ExecutionCoordinator } from '../execution-coordinator.js';

interface AuditEntry {
  id: string; time: number; nodeId: string; action: string; target: string; actor: string;
  before: unknown; after: unknown; requestKey: string;
}

interface RevertPreview {
  id: string; runId: string; sessionId: string; memberId: string; owner: string;
  revision: number; files: string[]; expiresAt: number;
  taskId?:string;
}

export class ConsoleAudit {
  private readonly path: string;
  constructor(stateDir: string, readonly nodeId: string) {
    this.path = join(stateDir, "console-workbench-audit.json");
  }
  entries(): AuditEntry[] { return existsSync(this.path) ? JSON.parse(readFileSync(this.path, "utf8")) : []; }
  record(action: string, target: string, before: unknown, after: unknown, requestKey: string): void {
    const entries = this.entries();
    entries.unshift({ id: randomUUID(), time: Date.now(), nodeId: this.nodeId, action, target, actor: "owner", before, after, requestKey });
    const temporary = this.path + ".tmp";
    writeFileSync(temporary, JSON.stringify(entries.slice(0, 250)), { mode: 0o600 });
    renameSync(temporary, this.path);
  }
}

export class LocalActions {
  readonly audit: ConsoleAudit;
  constructor(readonly config: ServerConfig, readonly session?: SessionRuntime) {
    mkdirSync(config.stateDir, { recursive: true });
    this.audit = new ConsoleAudit(config.stateDir, config.federation?.nodeId ?? "local");
  }

  async review(ref: { id: string; expectedRevision: number; completeExecution?: boolean }, verdict: "accept" | "reject", note: string, requestKey: string) {
    const ledger = new WorkLedger(this.config.stateDir);
    try {
      const original = requireRun(this.config, ledger, ref.id);
      if (original.revision !== ref.expectedRevision) throw new WorkbenchError("任务已更新，请刷新后再次确认", 409, "revision_conflict");
      const link = linkForRun(ledger, ref.id);
      let checkpoint: RunCheckpoint | null = null;
      if (original.status === "running") {
        if (!ref.completeExecution || !this.session || link?.latest_run !== original.id) {
          throw new WorkbenchError("请明确确认结束当前工作后再验收", 409, "completion_confirmation_required");
        }
        if (ledger.hasActiveChild(original.id)) throw new WorkbenchError("当前工作仍有执行中的操作或代理", 409, "work_active");
        const unresolved = ledger.db.prepare("SELECT 1 FROM console_operations WHERE run_id=? AND status IN ('unknown','reconciliation_required') LIMIT 1").get(original.id);
        if (unresolved) throw new WorkbenchError("存在尚未确认的操作结果，请先核对", 409, "work_unresolved");
        checkpoint = await this.session.service.prepareRunCheckpoint(link.session_id, link.member_id,link.task_id ?? undefined);
      }
      ledger.db.transaction(() => {
        const run = requireRun(this.config, ledger, ref.id);
        if (run.revision !== ref.expectedRevision) throw new WorkbenchError("任务已更新，请刷新后再次确认", 409, "revision_conflict");
        if (run.status === "running" && ref.completeExecution) {
          const currentRevision = ledger.db.prepare("SELECT revision FROM qm_session_members WHERE id=?")
            .get(link!.member_id) as { revision: number };
          if (!checkpoint || (checkpoint.snapshot.changeRev ?? checkpoint.revision) !== currentRevision.revision) {
            throw new WorkbenchError("工作内容已更新，请重新核对后验收", 409, "revision_conflict");
          }
          ledger.finish(run.id, { status: "completed", acceptance: verdict === "accept" ? "passed" : "failed",
            summary: note || "用户已确认当前工作结束", evidence: [{ label: "用户验收", reference: note || "用户在控制台明确结束并验收当前工作", outcome: verdict === "accept" ? "passed" : "failed" }] });
          saveRunCheckpoint(ledger.db, run.id, { ...checkpoint, snapshot: { ...checkpoint.snapshot,
            review_status: verdict === "accept" ? ReviewState.passed : ReviewState.failed } });
          return;
        }
        if (run.status !== "completed" || run.acceptance !== "pending") throw new WorkbenchError("只有执行完成且待验收的任务可以验收");
        const evidence = JSON.parse(run.evidence);
        evidence.push({ label: "用户验收", reference: note || "用户在控制台确认执行结果", outcome: verdict === "accept" ? "passed" : "failed" });
        ledger.db.prepare("UPDATE console_work_runs SET acceptance=?, evidence=?, revision=revision+1 WHERE id=? AND revision=?")
          .run(verdict === "accept" ? "passed" : "failed", JSON.stringify(evidence), run.id, run.revision);
      }).immediate();
      if (this.session && link?.latest_run === ref.id) this.session.store.setReviewState(link.session_id, verdict === "accept" ? ReviewState.passed : ReviewState.failed);
      this.audit.record("run.review", ref.id, { acceptance: "pending" }, { verdict, note }, requestKey);
      return { id: ref.id, ok: true, revision: ref.expectedRevision + 1 };
    } finally { ledger.close(); }
  }

  sessions(projectId: string) {
    const ledger = new WorkLedger(this.config.stateDir);
    const agents = new LocalAgentStore(this.config.stateDir);
    try {
      const project = ledger.getProject(projectId);
      if (!permitted(this.config, project.root)) throw new WorkbenchError("项目不在允许访问的范围内", 403, "project_scope");
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
          const execution=task.state==='closed' ? ['completed','failed','cancelled'].includes(task.result_status ?? '') ? task.result_status! : 'ended' : 'waiting';
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
      let executionClaims:ReturnType<ExecutionCoordinator['inspect']>;
      try { executionClaims=execution.inspect(project.root); } finally { execution.close(); }
      return { conversations,executionClaims,items, batches: batches.map((batch) => ({ id: workspaceHandle(node, batch.id), mode: batch.mode,
        status: batch.status === "succeeded" ? "completed" : batch.status, createdAt: Date.parse(batch.created_at) })),
        claims: items.filter((thread) => thread.control !== "idle").map((thread) => ({ id: thread.id, owner: thread.control, turnId: thread.turnId, updatedAt: thread.updatedAt })) };
    } finally { agents.close(); ledger.close(); }
  }

  async runControl(id: string, input: { action: "resume" | "interrupt"; expectedRevision: number; requestKey: string }) {
    const ledger = new WorkLedger(this.config.stateDir);
    const store = new LocalAgentStore(this.config.stateDir);
    try {
      const run = requireRun(this.config, ledger, id);
      if (run.revision !== input.expectedRevision) throw new WorkbenchError("任务已更新，请刷新后继续", 409, "revision_conflict");
      const executions = ledger.executions(id);
      const latest = executions.at(-1);
      const agent = latest ? store.getById(latest.agent_id) : undefined;
      if (!agent) throw new WorkbenchError("这个记录没有可控制的受管代理，请从原来的工作入口继续", 409, "agent_unavailable");
      const scope = { workspaceId: agent.workspaceId, workspaceRoot: agent.workspaceRoot };
      const client = createLocalAgentClient(this.config);
      if (input.action === "resume") {
        if (!["interrupted", "reconciliation_required"].includes(run.status)) throw new WorkbenchError("当前任务不处于可恢复的中断状态");
        if (new Set(executions.map((entry) => entry.agent_id)).size !== 1) throw new WorkbenchError("此任务包含多个代理，请从原工作入口选择要继续的部分");
        ledger.resume(id);
        const result = await client.continue(agent.id, "继续完成当前任务。先检查已经保存的工作进度和执行结果，再完成尚未结束的部分。", { workRunId: id, requestKey: input.requestKey }, scope);
        if (result.isErr()) {
          if (!ledger.hasActiveChild(id)) ledger.db.prepare("UPDATE console_work_runs SET status='reconciliation_required',summary=?,revision=revision+1 WHERE id=? AND status='running'")
            .run(`恢复请求尚未确认：${result.error.message}`, id);
          throw result.error;
        }
      } else {
        const activeIds = [...new Set(executions.filter((entry) => ["starting", "queued", "running"].includes(entry.status)).map((entry) => entry.agent_id))];
        if (!activeIds.length) throw new WorkbenchError("当前任务已经没有执行中的受管代理");
        for (const agentId of activeIds) {
          const current = store.getById(agentId);
          if (!current) throw new WorkbenchError("受管代理记录已不存在，请刷新任务状态");
          const agentScope = { workspaceId: current.workspaceId, workspaceRoot: current.workspaceRoot };
          if (current.status === "queued" || current.status === "starting") {
            const cancelled = await client.cancelQueued(current.id, agentScope);
            if (cancelled.isErr()) throw cancelled.error;
          } else {
            const interrupted = await client.control({ agentId: current.id, action: "interrupt", workRunId: id,
              requestKey: input.requestKey, expectedTurnId: current.providerTurnId, scope: agentScope });
            if (interrupted.isErr()) throw interrupted.error;
          }
        }
      }
      this.audit.record(`run.${input.action}`, id, null, { agent: agent.id, status: "accepted" }, input.requestKey);
      return { status: "accepted", agentId: agent.id };
    } finally { store.close(); ledger.close(); }
  }

  async revertPreview(id: string, files: string[], expectedRevision: number) {
    if (!this.session) throw new WorkbenchError("运行版本尚未提供会话撤销", 409, "revert_unavailable");
    const ledger = new WorkLedger(this.config.stateDir);
    try {
      const run = requireRun(this.config, ledger, id);
      if (run.revision !== expectedRevision) throw new WorkbenchError("任务已经更新", 409, "revision_conflict");
      const link = linkForRun(ledger, id);
      if (!link) throw new WorkbenchError("此任务没有可自动撤销的会话写入证据");
      const checkpoint = readRunCheckpoint(ledger.db, id);
      if (!checkpoint && !link.task_id && link.latest_run !== id) throw new WorkbenchError("此历史任务没有保存可验证的文件版本，无法自动撤销");
      if (checkpoint) {
        const current = this.session.store.fileSummaries(link.session_id, link.member_id,link.task_id ?? undefined);
        if (files.some((id) => {
          const recorded = checkpoint.files.find((file) => file.id === id);
          return !recorded || !current.some((file) => file.id === id && file.hash === recorded.hash);
        })) throw new WorkbenchError("文件已不再是这段工作保存的版本，请重新查看改动", 409, "revision_conflict");
      }
      const eligibility = await this.session.reverter.eligibility(link.owner_id, link.session_id, link.member_id, files,link.task_id ?? undefined);
      if (!eligibility.allowed) throw new WorkbenchError(`当前无法撤销：${eligibility.reason}`);
      ledger.db.prepare("DELETE FROM console_revert_previews WHERE expires_at<=?").run(Date.now());
      const preview: RevertPreview = { id: randomUUID(), runId: id, sessionId: link.session_id, memberId: link.member_id,
        owner: link.owner_id,taskId:link.task_id ?? undefined, revision: eligibility.revision, files, expiresAt: Date.now() + 300_000 };
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
      if (!preview || preview.id !== confirmation || preview.expiresAt <= Date.now()) throw new WorkbenchError("撤销预览已失效，请重新确认", 409, "preview_expired");
      if (!this.session) throw new WorkbenchError("当前服务没有会话撤销能力");
      const result = await this.session.reverter.revert(preview.owner, preview.sessionId, preview.memberId, preview.revision, true, preview.files,preview.taskId);
      ledger.db.prepare("DELETE FROM console_revert_previews WHERE id=?").run(previewId);
      this.audit.record("run.revert", preview.runId, null, { files: result.changed_paths }, requestKey);
      return { status: "completed", files: result.changed_paths, revision: result.revision };
    } finally { ledger.close(); }
  }

  async archive(projectId: string, input: { mode?: "archive" | "restore"; ids?: string[]; batchId?: string; confirmationHash?: string; externalIdleConfirmed?: boolean }) {
    const ledger = new WorkLedger(this.config.stateDir);
    const service = new ProjectArchive(ledger, new CodexThreadControl());
    try {
      if (!permitted(this.config, ledger.getProject(projectId).root)) throw new WorkbenchError("项目不在允许访问的范围内", 403, "project_scope");
      const result = input.batchId
        ? await service.execute(projectId, input.batchId, input.confirmationHash!, input.externalIdleConfirmed === true)
        : await service.plan(projectId, { mode: input.mode!, threadKeys: input.ids });
      return { id: result.batchId, projectId, mode: result.mode,
        status: result.status === "succeeded" ? "completed" : result.status,
        confirmationHash: result.confirmationHash, expiresAt: Date.parse(result.expiresAt),
        entries: result.entries.map((entry) => ({ id: entry.managedThreadId, title: entry.title, ready: entry.status === "ready", reason: entry.reason, status: entry.status })),
        results: result.entries.map((entry) => ({ id: entry.managedThreadId, ok: entry.status === "succeeded", error: entry.reason, pending: entry.status === "ready" })),
      };
    } finally { await service.close(); ledger.close(); }
  }
}
