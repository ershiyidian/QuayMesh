import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import {
  ExecutionState,
  HostState,
  OperationState,
  ReviewState,
  type InvocationContext,
  type OperationRecord,
  type RecoveryRow,
  type SessionId,
  type SessionMember,
  type SessionRecord,
  type TaskRecord,
  type Snapshot,
  type FileSummary,
  type WorkspaceId,
} from "./types.js";
import type { SessionStore } from "./store.js";
import type { WorkspaceRegistry, Workspace } from "../workspaces.js";
import type { WorkLedger } from "../work-ledger.js";
import type { LocalAgentStore } from "../local-agent-store.js";
import type { RecoveryService } from "./recovery.js";
import type { WorkspaceMetadata } from "./workspace-metadata.js";
import { readRunCheckpoint, saveRunCheckpoint, type RunCheckpoint } from "./run-checkpoints.js";
import type { SessionChangeCollector } from "./changes.js";
import type { SessionProjector } from "./projection.js";
import type { TaskFinalStatus } from "./task-data.js";

export interface TaskOwnerReceipt {
  taskId: string;
  nodeId: string;
  backgroundRuns: string[];
  activeWork: number;
  snapshots: Array<{ memberId: string; revision: number; snapshot: Snapshot; files: Array<FileSummary & { patchRef: string; versionRef: string }> }>;
}

export interface OperationTicket {
  ticket_id: string;
  operation_id: string;
  session_id: SessionId;
  task_id: string;
  member_id: string;
  run_id: string;
  kind: string;
  label: string;
  started_at: number;
  actor: InvocationContext["actor"];
}

export interface OperationFinishResult {
  status: OperationState;
  effect: "not_started" | "started" | "partial" | "completed" | "unknown";
  exit_code?: number | null;
  error_code?: string | null;
  error_message?: string | null;
  result_ref?: string | null;
  known_paths?: string[];
}

export interface OperationProgressResult {
  effect: "not_started" | "started" | "partial" | "completed" | "unknown";
  result_ref?: string | null;
}

export class SessionService {
  private stopped = false;
  private retryingFinalizations: Promise<void> | undefined;
  private finalizationCursor: { requested_at: string; task_id: string } | undefined;

  retryFinalizations(): Promise<void> {
    if(this.stopped)return Promise.resolve();
    if(this.retryingFinalizations)return this.retryingFinalizations;
    const work=(async()=>{
      // 按持久顺序轮转，前面的长任务或坏归档不能饿死后续已完成任务。
      const batch=this.store.taskData.pendingFinalizations(4,this.finalizationCursor);
      this.finalizationCursor=batch.at(-1);
      for(const intent of batch) {
        if(this.stopped)break;
        const task=this.store.getTask(intent.task_id);
        if(this.finalizing.has(task.id)||this.finalizingLocal.has(task.id))continue;
        if(intent.status!=="handed_off"&&(this.localBackground(task.id).length||this.store.taskData.activeWork(task.id)))continue;
        const owner=this.store.getSession(task.session_id).owner_id;
        try {
          if(task.source_kind==="federation_mirror")await this.finishOwnedTask(owner,task.id,intent.status,intent.summary);
          else await this.finishTask(owner,task.id,intent.status,intent.summary);
        } catch(error) {
          // finishTask 已保存精确失败信息，下一轮仅接续原意图，不重执行操作。
          console.error("QuayMesh 任务收尾仍待处理",task.id,error instanceof Error?error.message:String(error));
        }
      }
    })().finally(()=>{this.retryingFinalizations=undefined;});
    this.retryingFinalizations=work;
    return work;
  }
  private readonly listeners: (() => void)[] = [];
  private readonly pendingRecovery = new Set<Promise<void>>();
  private readonly finalizing = new Map<string, Promise<TaskRecord>>();
  private readonly finalizingLocal = new Map<string, Promise<TaskOwnerReceipt>>();
  private remoteFinalizer?: (task: TaskRecord, status: TaskFinalStatus, summary: string) => Promise<TaskOwnerReceipt[]>;
  private remoteArchiver?: (task:TaskRecord)=>Promise<TaskOwnerReceipt[]>;

  constructor(
    private readonly store: SessionStore,
    private readonly workspaces: WorkspaceRegistry,
    private readonly ledger?: WorkLedger,
    private readonly agents?: LocalAgentStore,
    private readonly changes?: SessionChangeCollector,
    private readonly projections?: SessionProjector,
    private readonly recovery?: RecoveryService,
    private readonly nodeId = "local",
  ) {}

  start(
    context: { owner_id: string; conversation_id?: string | null },
    title: string,
  ): SessionRecord {
    const existing = context.conversation_id
      ? this.store.findByConversation(context.owner_id, context.conversation_id)
      : null;
    if (existing) return existing;
    return this.store.createSession(context.owner_id, context.conversation_id ?? null, title);
  }

  async startTask(
    context: { owner_id: string; conversation_id?: string | null },
    title: string,
    requestKey?: string,
    sourceTaskId?: string,
  ): Promise<{ session: SessionRecord; task: TaskRecord }> {
    if (sourceTaskId) this.store.requireSession(context.owner_id,this.store.getTask(sourceTaskId).session_id);
    let session = this.start(context, title);
    if (requestKey) {
      const saved=this.store.taskForRequest(session.id,requestKey);
      if (saved) return {session,task:saved};
    }
    const previous = this.store.currentTask(session.id);
    if (previous?.state === "active") await this.freezeTask(previous);

    const task = this.store.createTask(session.id, title, requestKey, sourceTaskId);
    session = this.store.getSession(session.id);
    return { session, task };
  }

  ensureCurrentTask(session: SessionRecord, title = session.title): TaskRecord {
    const task = this.store.currentTask(session.id);
    return task ?? this.store.createTask(session.id, title);
  }

  async adoptTask(sessionId: SessionId, taskId: string, title: string, createdAt?: string, sourceTaskId?: string): Promise<TaskRecord> {
    const existing=this.store.findTask(taskId);
    if(existing) return existing;
    return this.store.adoptRemoteTask(sessionId, taskId, title, createdAt, sourceTaskId);
  }

  async finishTask(ownerId: string, taskId: string, status: "completed"|"failed"|"cancelled"|"handed_off", summary: string): Promise<TaskRecord> {
    const pending=this.finalizing.get(taskId);
    if(pending)return pending;
    const work=this.completeTask(ownerId,taskId,status,summary).finally(()=>this.finalizing.delete(taskId));
    this.finalizing.set(taskId,work);
    return work;
  }

  setRemoteFinalizer(finalizer: (task: TaskRecord, status: TaskFinalStatus, summary: string) => Promise<TaskOwnerReceipt[]>): void {
    this.remoteFinalizer=finalizer;
  }
  setRemoteArchiver(archiver:(task:TaskRecord)=>Promise<TaskOwnerReceipt[]>):void {this.remoteArchiver=archiver;}

  private localBackground(taskId: string): string[] {
    return this.ledger?this.store.runIdsForTask(taskId).filter(id=>this.ledger!.hasActiveChild(id)):[];
  }

  private assertTaskIdle(taskId: string, status: TaskFinalStatus): void {
    if(status!=="handed_off" && (this.localBackground(taskId).length || this.store.taskData.activeWork(taskId))) {
      throw new Error(`TASK_HAS_ACTIVE_EXECUTIONS: ${taskId}`);
    }
  }

  private async completeTask(ownerId: string, taskId: string, status: TaskFinalStatus, summary: string): Promise<TaskRecord> {
    const task=this.store.getTask(taskId);
    this.store.requireSession(ownerId,task.session_id);
    if(task.state==="closed"&&task.result_status) return task;
    this.store.taskData.requestFinalization(taskId,status,summary);
    try {
      this.assertTaskIdle(taskId,status);
      const remote=this.store.taskMemberIds(taskId).map(id=>this.store.getMember(task.session_id,id)).filter(member=>member.node_id!==this.nodeId);
      if(remote.length&&!this.remoteFinalizer)throw new Error("TASK_REMOTE_FINALIZER_UNAVAILABLE");
      const receipts=remote.length?await this.remoteFinalizer!(task,status,summary):[];
      for(const member of remote) {
        const receipt=receipts.find(value=>value.nodeId===member.node_id && value.taskId===taskId);
        const frozen=receipt?.snapshots.find(value=>value.memberId===member.id);
        if(!receipt||!frozen)throw new Error(`TASK_OWNER_RECEIPT_MISSING: ${member.node_id}:${member.id}`);
        if(status!=="handed_off"&&(receipt.activeWork||receipt.backgroundRuns.length))throw new Error(`TASK_HAS_ACTIVE_EXECUTIONS: ${member.node_id}`);
        this.store.putTaskSnapshot(taskId,member.id,frozen.revision,frozen.snapshot,frozen.files);
      }
      this.assertTaskIdle(taskId,status);
      await this.captureTask(task,true);
      this.finishLocalRuns(taskId,status,summary);
      this.store.taskData.finishFinalization(taskId);
      return this.store.closeTask(taskId,status,summary);
    } catch(error) {
      this.store.taskData.finishFinalization(taskId,error instanceof Error?error.message:String(error));
      throw error;
    }
  }

  private finishLocalRuns(taskId: string, status: TaskFinalStatus, summary: string): void {
    if (status === "handed_off") {
      this.ledger?.archiveTaskRuns(taskId);
      return;
    }
    if(this.ledger) {
      for(const id of this.store.runIdsForTask(taskId)) {
        if(this.ledger.run(id).status==="running")
          this.ledger.finish(id,{status,acceptance:"not_applicable",summary,evidence:[]});
      }
    }
  }

  async finishOwnedTask(ownerId: string, taskId: string, status: TaskFinalStatus, summary: string): Promise<TaskOwnerReceipt> {
    const pending=this.finalizingLocal.get(taskId);
    if(pending)return pending;
    const work=(async()=>{
      const task=this.store.getTask(taskId);
      this.store.requireSession(ownerId,task.session_id);
      if(!(task.state==="closed"&&task.result_status)) {
        this.store.taskData.requestFinalization(taskId,status,summary);
        try {
          this.assertTaskIdle(taskId,status);
          await this.captureTask(task,false);
          this.assertTaskIdle(taskId,status);
          this.finishLocalRuns(taskId,status,summary);
          this.store.taskData.finishFinalization(taskId);
          this.store.closeTask(taskId,status,summary);
        } catch(error) {
          this.store.taskData.finishFinalization(taskId,error instanceof Error?error.message:String(error));
          throw error;
        }
      }
      return {taskId,nodeId:this.nodeId,backgroundRuns:this.localBackground(taskId),activeWork:this.store.taskData.activeWork(taskId),
        snapshots:this.store.taskSnapshots(taskId).filter(value=>this.store.getMember(task.session_id,value.memberId).node_id===this.nodeId)};
    })().finally(()=>this.finalizingLocal.delete(taskId));
    this.finalizingLocal.set(taskId,work);
    return work;
  }

  private async freezeTask(task: TaskRecord): Promise<void> {
    let remoteError:string|null=null;
    if(this.remoteArchiver) {
      try {
        const receipts=await this.remoteArchiver(task);
        for(const receipt of receipts)for(const frozen of receipt.snapshots)
          this.store.putTaskSnapshot(task.id,frozen.memberId,frozen.revision,frozen.snapshot,frozen.files);
      } catch(error) {remoteError=error instanceof Error?error.message:String(error);}
    }
    await this.captureTask(task,true);
    // 旧轮次不再接受下一步时，停止没有活跃子任务的 Console 计时。
    this.ledger?.archiveTaskRuns(task.id);
    if(remoteError)this.store.setTaskChangeSummary(task.id,"incomplete",`TASK_ARCHIVE_REMOTE_PENDING: ${remoteError}`);
    this.store.archiveTask(task.id,"superseded");
  }

  async archiveOwnedTask(ownerId:string,taskId:string):Promise<TaskOwnerReceipt>{
    const task=this.store.getTask(taskId);this.store.requireSession(ownerId,task.session_id);
    if(task.state!=="closed"){
      await this.captureTask(task,false);
      this.ledger?.archiveTaskRuns(task.id);
      this.store.archiveTask(task.id,"superseded");
    }
    return {taskId,nodeId:this.nodeId,backgroundRuns:this.localBackground(taskId),activeWork:this.store.taskData.activeWork(taskId),
      snapshots:this.store.taskSnapshots(taskId).filter(value=>this.store.getMember(task.session_id,value.memberId).node_id===this.nodeId)};
  }

  private async captureTask(task: TaskRecord, includeRemote: boolean): Promise<void> {
    const changeErrors:string[]=[];
    if (this.projections) {
      for (const memberId of this.store.taskMemberIds(task.id)) {
        const member = this.store.getMember(task.session_id, memberId);
        if(member.node_id!==this.nodeId) {
          if(!includeRemote || this.store.getTaskSnapshot(task.id,member.id))continue;
        } else {
          const exists = await stat(member.root).then(info=>info.isDirectory(),(error:NodeJS.ErrnoException)=>{
            if(error.code==="ENOENT")return false;
            throw error;
          });
          if(!exists)changeErrors.push(`${member.node_id}: WORKSPACE_REMOVED: ${member.root}`);
          else try {
            await this.changes?.flushTask(member.id, task.id);
            await this.changes?.capture(member.id,task.id);
          } catch(error){changeErrors.push(`${member.node_id}: ${error instanceof Error?error.message:String(error)}`);}
        }
        const stored = this.store.taskData.projection(task.id, member.id)?.snapshot;
        const snapshot = member.node_id !== this.nodeId && stored?.taskId === task.id
          ? stored
          : await this.projections.materialize(task.session_id, member.id, task.id);
        const files = this.store.fileSummaries(task.session_id, member.id, task.id);
        this.store.putTaskSnapshot(task.id, member.id, snapshot.rev, snapshot, files);
        if (member.node_id === this.nodeId) {
          const paths = [...new Set([
            ...snapshot.instructions.map((item) => item.path),
            ...snapshot.skills.map((item) => item.path),
          ])];
          for (const path of paths) {
            if (this.store.taskContext(task.id, member.id, path)) continue;
            const content = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return null;
              throw error;
            });
            if (content !== null) this.store.putTaskContext(task.id, member.id, path, content);
          }
        }
        if (this.ledger) {
          for (const runId of this.store.runIdsForMember(task.session_id, member.id, task.id)) {
            if (!readRunCheckpoint(this.ledger.db, runId)) {
              saveRunCheckpoint(this.ledger.db, runId, { revision: snapshot.rev, snapshot, files });
            }
          }
        }
      }
    }
    this.store.setTaskChangeSummary(task.id,changeErrors.length?"incomplete":"complete",changeErrors.length?changeErrors.join(" | "):null);
  }

  async open(
    context: { owner_id: string; conversation_id?: string | null },
    workspace: { id: WorkspaceId; node: string; root: string; mode: "checkout" | "worktree"; sourceRoot: string | null; metadata?: WorkspaceMetadata },
    title: string,
  ): Promise<{ session: SessionRecord; member: SessionMember; bootstrap: Record<string, unknown> }> {
    const session = this.start(context, title);

    const member = this.store.addMember(
      session.id,
      workspace.node,
      workspace.id,
      workspace.root,
      workspace.mode,
      workspace.sourceRoot,
    );
    const task = this.ensureCurrentTask(session, title);
    this.store.touchTaskMember(task.id, member.id);

    this.store.appendEvent({
      session_id: session.id,
      member_id: member.id,
      type: "session_opened",
      source_id: `open-${session.id}-${member.id}`,
      timestamp: new Date().toISOString(),
      payload: { workspace_id: workspace.id, root: workspace.root, metadata: workspace.metadata },
    });

    if (this.projections?.schedule) {
      this.projections.schedule(session.id, member.id);
    }
    this.scheduleRecovery(member.root);

    const bootstrap = {
      session_id: session.id,
      member_id: member.id,
      workspace_id: workspace.id,
      title: session.title,
    };

    return { session, member, bootstrap };
  }

  async attach(
    context: { owner_id: string; conversation_id?: string | null },
    sessionId: SessionId,
    workspace: { id: WorkspaceId; node: string; root: string; mode: "checkout" | "worktree"; sourceRoot: string | null; metadata?: WorkspaceMetadata },
  ): Promise<{ member: SessionMember }> {
    const session = this.store.requireSession(context.owner_id, sessionId);
    if (context.conversation_id && session.conversation_id && session.conversation_id !== context.conversation_id) {
      throw new Error(`SESSION_SCOPE_MISMATCH: ${sessionId}`);
    }

    const member = this.store.addMember(
      session.id,
      workspace.node,
      workspace.id,
      workspace.root,
      workspace.mode,
      workspace.sourceRoot,
    );
    const task = this.ensureCurrentTask(session);
    this.store.touchTaskMember(task.id, member.id);

    this.store.appendEvent({
      session_id: session.id,
      member_id: member.id,
      type: "session_opened",
      source_id: `attach-${session.id}-${member.id}`,
      timestamp: new Date().toISOString(),
      payload: { workspace_id: workspace.id, root: workspace.root, mode: "attach", metadata: workspace.metadata },
    });

    for (const existing of this.store.getMembers(session.id)) {
      if (existing.node_id !== this.nodeId) continue;
      if (existing.id !== member.id) this.store.appendEvent({
        session_id: session.id, member_id: existing.id, type: "session_opened",
        source_id: `member-attached-${existing.id}-${member.id}`, timestamp: new Date().toISOString(),
        payload: { attached_member_id: member.id },
      });
      this.refreshMember(session.id, existing.id);
    }

    return { member };
  }

  async resolveForWorkspace(
    context: { owner_id: string; conversation_id?: string | null },
    workspaceId: WorkspaceId,
  ): Promise<{ session: SessionRecord; member: SessionMember }> {
    const ws: Workspace = await this.workspaces.getWorkspace(workspaceId);

    let session: SessionRecord | null = null;
    if (context.conversation_id) {
      session = this.store.findByConversation(context.owner_id, context.conversation_id);
    }

    if (!session) {
      session = this.store.createSession(context.owner_id, context.conversation_id ?? null, ws.root);
    }

    let members = this.store.getMembers(session.id);
    let member = members.find((m) => m.workspace_id === workspaceId);
    if (!member) {
      member = this.store.addMember(
        session.id,
        this.nodeId,
        ws.id,
        ws.root,
        ws.mode === "worktree" ? "worktree" : "checkout",
        ws.sourceRoot ?? null,
      );
    }

    this.store.touchTaskMember(this.ensureCurrentTask(session).id, member.id);

    return { session, member };
  }

  async ensureRun(
    session: SessionRecord,
    member: SessionMember,
    operation: { kind: string; label: string },
    taskId?: string,
  ): Promise<string> {
    if (this.ledger) {
      const ledger = this.ledger;
      const task = taskId ? this.store.getTask(taskId) : this.ensureCurrentTask(session);
      if (task.session_id !== session.id || task.state !== "active") throw new Error(`TASK_NOT_ACTIVE: ${task.id}`);
      for (const runId of this.store.runIdsForMember(session.id, member.id, task.id)) {
        const current = ledger.run(runId);
        if (current.status === "running") {
          ledger.setRunTitle(current.id, task.title);
          return current.id;
        }
      }
      const previousRun = this.store.runIdsForMember(session.id, member.id, task.id)[0];
      if (previousRun) await this.checkpointRun(previousRun, session.id, member.id, task.id);
      const run = this.ledger.begin({
        root: member.root,
        workspaceId: member.workspace_id,
        workItemId: `task-${task.id}`,
        runKey: `task-${task.id}-${member.id}-${randomUUID()}`,
        title: task.title,
        origin: { entryPoint: "chatgpt_mcp", evidence: "server_entry" },
      });
      this.store.linkRun(session.id, member.id, run.id, task.id);
      this.store.setReviewState(session.id, ReviewState.unknown);
      return run.id;
    }
    throw new Error("SESSION_WORK_LEDGER_REQUIRED");
  }

  async beforeOperation(
    context: InvocationContext,
    kind: OperationRecord["kind"],
    label: string,
  ): Promise<OperationTicket> {
    const session = this.store.requireSession(context.owner_id, context.session_id);
    const member = this.store.getMember(session.id, context.member_id);
    const task = context.task_id ? this.store.getTask(context.task_id) : this.ensureCurrentTask(session);
    context.task_id = task.id;
    if (task.session_id !== session.id || task.state !== "active") throw new Error(`TASK_NOT_ACTIVE: ${task.id}`);
    const finalization=this.store.taskData.finalization(task.id);
    if(finalization && !finalization.error)throw new Error(`TASK_FINISHING: ${task.id}`);
    const runId = await this.ensureRun(session, member, { kind, label }, task.id);
    const ledger = this.requireLedger();
    const operationId = ledger.operation({
      id: context.operation_id,
      runId,
      requestKey: context.invocation_id,
      kind,
      label,
      status: "running",
    });
    const ticket: OperationTicket = {
      ticket_id: randomUUID(),
      operation_id: operationId,
      session_id: session.id,
      task_id: task.id,
      member_id: member.id,
      run_id: runId,
      kind,
      label,
      started_at: Date.now(),
      actor: context.actor,
    };
    context.run_id = runId;

    this.store.appendEvent({
      session_id: session.id,
      task_id: task.id,
      member_id: member.id,
      type: "operation_started",
      source_id: operationId,
      timestamp: new Date().toISOString(),
      payload: { operation_id: operationId, kind, label, run_id: runId, actor: context.actor },
    });

    return ticket;
  }

  async checkpointRun(runId: string, sessionId: string, memberId: string, taskId?: string): Promise<void> {
    const db = this.requireLedger().db;
    if (!this.projections || readRunCheckpoint(db, runId)) return;
    saveRunCheckpoint(db, runId, await this.prepareRunCheckpoint(sessionId, memberId, taskId));
  }

  async prepareRunCheckpoint(sessionId: string, memberId: string, taskId?: string): Promise<RunCheckpoint> {
    if (!this.projections) throw new Error("SESSION_PROJECTOR_REQUIRED");
    await this.changes?.flushTask(memberId, taskId);
    const snapshot = await this.projections.materialize(sessionId, memberId, taskId);
    return { revision: snapshot.rev, snapshot, files: this.store.fileSummaries(sessionId, memberId, taskId) };
  }

  async finishOperationById(operationId: string, result: OperationFinishResult): Promise<void> {
    const event = this.store.findOperationEvent(operationId);
    if (!event) throw new Error(`OPERATION_NOT_FOUND: ${operationId}`);
    const invocation = this.store.findInvocationByOperationId(operationId);
    if (invocation) {
      this.store.updateInvocation({
        ownerId: invocation.owner_id,
        transportInstanceId: invocation.transport_instance_id,
        requestId: invocation.request_id,
        state: result.status,
        effect: result.effect,
        resultRef: result.result_ref ?? invocation.result_ref,
        finished: true,
      });
    }
    await this.operationFinished({
      ticket_id: operationId,
      operation_id: operationId,
      session_id: event.session_id,
      task_id: event.task_id ?? this.store.currentTask(event.session_id)?.id ?? "",
      member_id: event.member_id,
      run_id: String(event.payload.run_id ?? ""),
      kind: String(event.payload.kind ?? "command"),
      label: String(event.payload.label ?? "command"),
      started_at: Date.parse(event.timestamp),
      actor: event.payload.actor === "app" ? "app"
        : event.payload.actor === "agent" ? "agent"
          : event.payload.actor === "system" ? "system" : "model",
    }, result);
  }

  async operationFinished(ticket: OperationTicket, result: OperationFinishResult): Promise<void> {
    if (this.store.hasOperationFinished(ticket.operation_id)) return;
    if (result.status === OperationState.accepted || result.status === OperationState.queued || result.status === OperationState.running) {
      this.operationProgress(ticket, { effect: result.effect, result_ref: result.result_ref });
      return;
    }
    const ledger = this.requireLedger();
    const ledgerStatus = result.status === OperationState.succeeded
      ? "completed"
      : result.status === OperationState.cancelled
        ? "cancelled"
      : result.status === OperationState.unknown
        ? "reconciliation_required"
        : "failed";
    ledger.endOperation(ticket.operation_id, ledgerStatus, result.error_message || result.error_code
      ? [{
          label: result.error_code ?? "operation_failed",
          reference: JSON.stringify({ error: result.error_message ?? null, effect: result.effect, result_ref: result.result_ref ?? null }),
          outcome: "failed",
        }]
      : [{ label: "operation_completed", reference: JSON.stringify({ effect: result.effect, result_ref: result.result_ref ?? null }), outcome: "passed" }]);
    this.store.appendEvent({
      session_id: ticket.session_id,
      task_id: ticket.task_id,
      member_id: ticket.member_id,
      type: "operation_finished",
      source_id: `${ticket.operation_id}-finish`,
      timestamp: new Date().toISOString(),
      payload: {
        operation_id: ticket.operation_id,
        status: result.status,
        actor: ticket.actor,
        effect: result.effect,
        exit_code: result.exit_code,
        error_code: result.error_code,
        error_message: result.error_message,
        result_ref: result.result_ref,
      },
    });

    if (result.effect !== "not_started" && (["patch", "command", "copy", "agent_control"].includes(ticket.kind) || result.known_paths?.length)) {
      this.changes?.markDirty(ticket.member_id, result.known_paths ?? [], ticket.task_id);
      // 文件差异异步生成；已完成操作的回执和资源释放不等待扫描。
    }

    await this.reconcile(ticket.session_id);

    if (this.projections?.schedule) {
      this.projections.schedule(ticket.session_id, ticket.member_id, ticket.task_id);
    }
    const member = this.store.getMember(ticket.session_id, ticket.member_id);
    this.scheduleRecovery(member.root);
  }

  operationProgress(ticket: OperationTicket, result: OperationProgressResult): void {
    if (this.store.hasOperationFinished(ticket.operation_id)) return;
    this.store.setExecutionState(ticket.session_id, ExecutionState.active);
    this.store.appendEvent({
      session_id: ticket.session_id,
      task_id: ticket.task_id,
      member_id: ticket.member_id,
      type: "operation_started",
      source_id: `${ticket.operation_id}-progress`,
      timestamp: new Date().toISOString(),
      payload: {
        operation_id: ticket.operation_id,
        kind: ticket.kind,
        label: ticket.label,
        run_id: ticket.run_id,
        status: OperationState.running,
        effect: result.effect,
        result_ref: result.result_ref ?? null,
      },
    });
    if (this.projections?.schedule) {
      this.projections.schedule(ticket.session_id, ticket.member_id);
    }
  }

  operationTransportLost(ticket: OperationTicket): void {
    this.store.updateObservedHostState(ticket.session_id, HostState.disconnected);
  }

  async agentEvent(sessionId: SessionId, memberId: string, event: Record<string, unknown>, taskId?: string): Promise<void> {
    const sourceId = (event.source_id as string) || `agent-${Date.now()}-${randomUUID().slice(0, 6)}`;
    this.store.appendEvent({
      session_id: sessionId,
      task_id: taskId ?? this.store.currentTask(sessionId)?.id ?? null,
      member_id: memberId,
      type: "agent_changed",
      source_id: sourceId,
      timestamp: new Date().toISOString(),
      payload: event,
    });

    if (this.projections?.schedule) {
      this.projections.schedule(sessionId, memberId);
    }
  }

  contextRead(
    sessionId: SessionId,
    memberId: string,
    actorId: string,
    path: string,
    contentRef?: string | null,
  ): void {
    this.store.appendEvent({
      session_id: sessionId,
      member_id: memberId,
      type: "context_read",
      source_id: `read-${path}-${Date.now()}`,
      timestamp: new Date().toISOString(),
      payload: { actor_id: actorId, path, content_ref: contentRef },
    });
  }

  async reconcile(sessionId: SessionId): Promise<ExecutionState> {
    const ledger = this.requireLedger();
    const session = this.store.getSession(sessionId);
    let state = ExecutionState.idle;
    for (const member of session.members) {
      const linkedRuns = this.store.runIdsForMember(sessionId, member.id);
      const currentRunId = linkedRuns[0];
      if (!currentRunId) continue;
      // 旧阶段的后台工作继续参与活性汇总；旧失败记录不污染当前请求。
      if (linkedRuns.some(runId => ledger.hasConfirmedChild(runId))) state = ExecutionState.active;
      const linkedAgentIds = new Set(ledger.executions(currentRunId).map((execution) => execution.agent_id));
      const activeAgent = [...linkedAgentIds].some((agentId) => {
        const agent = this.agents?.getById(agentId);
        return agent?.status === "starting" || agent?.status === "queued" || agent?.status === "running";
      });
      if (activeAgent) state = ExecutionState.active;
      const currentRun = ledger.run(currentRunId);
      if (currentRun.status === "running" && ledger.hasConfirmedChild(currentRunId)) state = ExecutionState.active;
      else if(ledger.hasActiveChild(currentRunId)&&state!==ExecutionState.active)state=ExecutionState.interrupted;
      if (currentRun.status === "interrupted" || currentRun.status === "reconciliation_required") {
        if (state !== ExecutionState.active) state = ExecutionState.interrupted;
      }
      if (currentRun.status === "failed" && state === ExecutionState.idle) state = ExecutionState.failed;
    }
    this.store.setExecutionState(sessionId, state);
    return state;
  }

  async recordReview(sessionId: SessionId, ownerId: string, decision: ReviewState): Promise<void> {
    const session = this.store.requireSession(ownerId, sessionId);
    if (session.execution_state === ExecutionState.active) {
      throw new Error("CANNOT_REVIEW_ACTIVE_WORK");
    }

    this.store.appendEvent({
      session_id: sessionId,
      member_id: session.selected_member_id || "",
      type: "verification_recorded",
      source_id: `review-${Date.now()}`,
      timestamp: new Date().toISOString(),
      payload: { decision },
    });
  }

  async recoverSummary(
    context: { owner_id: string },
    workspaceRoot: string,
    limit = 30,
    cursor?: string,
  ): Promise<{ rows: RecoveryRow[]; nextCursor: string | null }> {
    return this.store.recentRecoveryRows(context.owner_id, workspaceRoot, limit, cursor);
  }

  private scheduleRecovery(root: string): void {
    if (!this.recovery || this.stopped) return;
    const pending = stat(root).then(info => info.isDirectory(),(error:NodeJS.ErrnoException)=>{
      if(error.code==="ENOENT")return false;
      throw error;
    }).then(exists => exists ? this.recovery!.ensureGitIgnore(root).then(() => this.recovery!.exportRoot(root)) : undefined)
      .catch((error) => {
        console.error(JSON.stringify({ event: "session_recovery_export_failed", root, error: error instanceof Error ? error.message : String(error) }));
      })
      .finally(() => {
        this.pendingRecovery.delete(pending);
      });
    this.pendingRecovery.add(pending);
  }

  private requireLedger(): WorkLedger {
    if (!this.ledger) throw new Error("SESSION_WORK_LEDGER_REQUIRED");
    return this.ledger;
  }

  refreshMember(sessionId: SessionId, memberId: string, taskId?: string): void {
    if (this.store.getMember(sessionId, memberId).node_id !== this.nodeId) return;
    this.projections?.schedule(sessionId, memberId, taskId);
    this.scheduleRecovery(this.store.getMember(sessionId, memberId).root);
  }

  async close(): Promise<void> {
    this.stopped = true;
    await this.retryingFinalizations;
    await Promise.allSettled([...this.finalizing.values(),...this.finalizingLocal.values()]);
    for (const dispose of this.listeners) {
      try {
        dispose();
      } catch {
        // Ignored
      }
    }
    this.listeners.length = 0;
    await Promise.allSettled([...this.pendingRecovery]);
  }
}
