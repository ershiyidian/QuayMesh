import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { runSqliteWrite } from "../db/async-write.js";
import { quiescenceSubject, recordExecutionQuiescence } from "../maintenance-status.js";
import { processOwner } from "../process-identity.js";
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
import { SessionStore } from "./store.js";
import type { WorkspaceRegistry, Workspace } from "../workspaces.js";
import { EXECUTION_OBSERVATION_MS, type WorkLedger } from "../work-ledger.js";
import { memberRunActivity } from "./member-run-activity.js";
import type { LocalAgentStore } from "../local-agent-store.js";
import type { RecoveryService } from "./recovery.js";
import type { WorkspaceMetadata } from "./workspace-metadata.js";
import { readRunCheckpoint, saveRunCheckpoint, type RunCheckpoint } from "./run-checkpoints.js";
import type { SessionChangeCollector } from "./changes.js";
import type { SessionProjector } from "./projection.js";
import type { TaskFinalStatus } from "./task-data.js";
import { admitTaskWorkInTransaction, finalizationBlocksNewWork, taskFinishingError, FinalizationDispatchError } from "./task-finalization.js";
import { assertTaskCompletionStatus, type TaskCompletionStatus } from "./task-completion.js";
import type { ExecutionCoordinator } from "../execution-coordinator.js";
import type { TaskExecutionEntry, TaskStartIntent, TaskCreationClient } from "../tasks/task-binding.js";

/** task_id 限定本次调用；访问任务时仍核对已认证 owner，不改变其他入口的选择。 */
export interface TaskExecutionIdentity {
  owner_id: string;
  conversation_id?: string | null;
  task_entry?: TaskExecutionEntry;
  task_creation?: TaskCreationClient;
  task_id?: string;
}

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
  invocation_id?: string;
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

interface FinalizationFlight<T> {
  status: TaskFinalStatus;
  summary: string;
  messageSequence: number;
  revision?: number;
  ready: Promise<void>;
  work: Promise<T>;
}

export class SessionService {
  private stopped = false;
  private retryingFinalizations: Promise<void> | undefined;
  private finalizationCursor: { requested_at: string; task_id: string } | undefined;

  retryFinalizations(): Promise<void> {
    if(this.stopped)return Promise.resolve();
    if(this.retryingFinalizations)return this.retryingFinalizations;
    const work=(async()=>{
      // flight 跨轮次保留；观察期限到达既不释放归档占用，也不重新发起同一任务。
      const active=()=>this.finalizing.size+this.finalizingLocal.size;
      if(active()>=4)return;
      const batch=this.store.taskData.pendingFinalizations(4,this.finalizationCursor);
      const observed:Promise<unknown>[]=[];
      for(const intent of batch) {
        if(this.stopped||active()>=4)break;
        this.finalizationCursor=intent;
        const task=this.store.getTask(intent.task_id);
        if(this.finalizing.has(task.id)||this.finalizingLocal.has(task.id))continue;
        if(this.localBackground(task.id).length||this.store.taskData.activeWork(task.id))continue;
        const owner=this.store.getSession(task.session_id).owner_id;
        const flight=task.source_kind==="federation_mirror"
          ? this.finishOwnedTask(owner,task.id,intent.status,intent.summary,intent.finalization_revision,{automaticRetry:true})
          : this.finishTask(owner,task.id,intent.status,intent.summary,undefined,intent.mailbox_sequence,intent.finalization_revision,{automaticRetry:true});
        observed.push(flight.catch(error=>{
          // finishTask 已保存精确失败信息，下一轮仅接续原意图，不重执行操作。
          console.error("QuayMesh 任务收尾仍待处理",task.id,error instanceof Error?error.message:String(error));
        }));
      }
      if(!observed.length)return;
      let timer:NodeJS.Timeout|undefined;
      try {
        await Promise.race([Promise.allSettled(observed),new Promise<void>(resolve=>{timer=setTimeout(resolve,2000);})]);
      } finally {if(timer)clearTimeout(timer);}
    })().finally(()=>{this.retryingFinalizations=undefined;});
    this.retryingFinalizations=work;
    return work;
  }
  private readonly listeners: (() => void)[] = [];
  private readonly pendingRecovery = new Set<Promise<void>>();
  private readonly finalizing = new Map<string, FinalizationFlight<TaskRecord>>();
  private readonly finalizingLocal = new Map<string, FinalizationFlight<TaskOwnerReceipt>>();
  private readonly pendingRuns = new Map<string, Promise<string>>();
  private remoteFinalizer?: (task: TaskRecord, status: TaskFinalStatus, summary: string) => Promise<TaskOwnerReceipt[]>;

  constructor(
    private readonly store: SessionStore,
    private readonly workspaces: WorkspaceRegistry,
    private readonly ledger?: WorkLedger,
    private readonly agents?: LocalAgentStore,
    private readonly changes?: SessionChangeCollector,
    private readonly projections?: SessionProjector,
    private readonly recovery?: RecoveryService,
    private readonly nodeId = "local",
    private readonly execution?: ExecutionCoordinator,
    private readonly bindingAuthority = true,
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
    context: TaskExecutionIdentity,
    title: string,
    requestKey?: string,
    sourceTaskId?: string,
    intent: TaskStartIntent = {},
  ): Promise<{ session: SessionRecord; task: TaskRecord }> {
    if (!context.task_entry && context.task_creation) {
      this.requireBindingAuthority();
      if (!requestKey) throw Object.assign(new Error("TASK_BINDING_REQUEST_KEY_REQUIRED"),
        {code: "TASK_BINDING_REQUEST_KEY_REQUIRED", effect: "not_started"});
      if (context.task_creation.principal.ownerId !== context.owner_id)
        throw Object.assign(new Error("TASK_ACCESS_DENIED"), {code: "TASK_ACCESS_DENIED", effect: "not_started"});
      const taskId = await this.store.taskBindings.startUnbound(context.task_creation, requestKey,
        {title, sourceTaskId, ...intent}, () => {
          if (sourceTaskId) this.store.requireSession(context.owner_id, this.store.getTask(sourceTaskId).session_id);
          const session = this.start(context, title);
          return this.store.createTask(session.id, title, requestKey, sourceTaskId).id;
        });
      const task = this.store.getTask(taskId);
      return {session: this.store.requireSession(context.owner_id, task.session_id), task};
    }
    if (context.task_entry && !requestKey)
      throw Object.assign(new Error("TASK_BINDING_REQUEST_KEY_REQUIRED"),
        { code: "TASK_BINDING_REQUEST_KEY_REQUIRED", effect: "not_started" });
    if (context.task_entry && requestKey) {
      this.requireBindingAuthority();
      this.requireEntryOwner(context);
      const result = await this.store.taskBindings.start(context.task_entry, requestKey, { title, sourceTaskId, ...intent }, () => {
        if (sourceTaskId) this.store.requireSession(context.owner_id, this.store.getTask(sourceTaskId).session_id);
        // The old Session is only a storage adapter. The start receipt belongs to
        // this authenticated entry, so another entry can use the same key safely.
        const session = this.start(context, title);
        return this.store.createTask(session.id, title, undefined, sourceTaskId).id;
      }, () => {
        const session = context.conversation_id
          ? this.store.findByConversation(context.owner_id, context.conversation_id)
          : null;
        return session ? {
          replayTaskId: this.store.taskForRequest(session.id, requestKey)?.id ?? null,
          currentTaskId: this.store.currentTask(session.id)?.id ?? null,
        } : null;
      });
      const task = this.store.getTask(result.taskId);
      return { session: this.store.requireSession(context.owner_id, task.session_id), task };
    }
    // Preserve older hosts without a stable entry. Their legacy receipt scope is
    // unchanged; a transport or owner ID must not masquerade as a binding version.
    const existingSession = context.conversation_id
      ? this.store.findByConversation(context.owner_id, context.conversation_id)
      : null;
    const saved = existingSession && requestKey ? this.store.taskForRequest(existingSession.id, requestKey) : null;
    if (existingSession && saved) return { session: existingSession, task: saved };
    if (intent.expectedBindingRevision !== undefined)
      throw Object.assign(new Error("TASK_ENTRY_REQUIRED: A binding revision requires a stable authenticated entry."),
        { code: "TASK_ENTRY_REQUIRED", effect: "not_started" });
    if (sourceTaskId) this.store.requireSession(context.owner_id, this.store.getTask(sourceTaskId).session_id);
    let session = this.start(context, title);
    if (requestKey) {
      const saved=this.store.taskForRequest(session.id,requestKey);
      if (saved) return {session,task:saved};
    }
    // A new independent goal changes the legacy entry selection, not other Tasks.
    const task = this.store.createTask(session.id, title, requestKey, sourceTaskId);
    session = this.store.getSession(session.id);
    return { session, task };
  }

  ensureCurrentTask(session: SessionRecord, title = session.title): TaskRecord {
    const task = this.store.currentTask(session.id);
    return task ?? this.store.createTask(session.id, title);
  }

  /** Pure lookup. Task identity is captured before asynchronous workspace work. */
  selectedExecution(context: TaskExecutionIdentity): { session: SessionRecord; task: TaskRecord } | null {
    this.requireEntryOwner(context);
    const selectedId = context.task_id ?? (context.task_entry && this.bindingAuthority ? this.store.taskBindings.current(context.task_entry)?.taskId : null);
    if (selectedId) {
      const task = this.store.getTask(selectedId);
      return { task, session: this.store.requireSession(context.owner_id, task.session_id) };
    }
    const session = context.conversation_id ? this.store.findByConversation(context.owner_id, context.conversation_id) : null;
    const task = session ? this.store.currentTask(session.id) : null;
    return session && task ? { session, task } : null;
  }

  async resolveExecution(context: TaskExecutionIdentity, title = "QuayMesh task"): Promise<{ session: SessionRecord; task: TaskRecord }> {
    if (context.task_entry && !context.task_id) this.requireBindingAuthority();
    const selected = this.selectedExecution(context);
    if (context.task_id) return selected!;
    if (context.task_entry) {
      if (selected) {
        const binding = await this.store.taskBindings.initializeLegacy(context.task_entry, selected.task.id);
        const task = this.store.getTask(binding.taskId!);
        return { task, session: this.store.requireSession(context.owner_id, task.session_id) };
      }
      const initialized = await this.store.taskBindings.initialize(context.task_entry, () => {
        const session = this.start(context, title);
        return this.ensureCurrentTask(session, title).id;
      });
      const task = this.store.getTask(initialized.taskId!);
      return { task, session: this.store.requireSession(context.owner_id, task.session_id) };
    }
    if (selected) return selected;
    // Compatibility for internal callers and hosts that have not established an
    // entry. Explicit cross-entry resume itself always requires a stable entry.
    const session = this.start(context, title);
    return { session, task: this.ensureCurrentTask(session, title) };
  }

  private requireEntryOwner(context: TaskExecutionIdentity): void {
    if (context.task_entry && context.task_entry.principal.ownerId !== context.owner_id) {
      throw Object.assign(new Error("TASK_ACCESS_DENIED"), { code: "TASK_ACCESS_DENIED", effect: "not_started" });
    }
  }

  private requireBindingAuthority(): void {
    if (!this.bindingAuthority) throw Object.assign(new Error("TASK_BINDING_AUTHORITY_REQUIRED: Select or resume the Task through the configured Coordinator."),
      { code: "TASK_BINDING_AUTHORITY_REQUIRED", effect: "not_started" });
  }

  async withTaskExecution<T>(context: TaskExecutionIdentity, title: string,
    work: (captured: TaskExecutionIdentity & { task_id: string }, scope: { session: SessionRecord; task: TaskRecord }) => Promise<T>): Promise<T> {
    const scope = await this.resolveExecution(context, title);
    const captured = { ...context, task_id: scope.task.id };
    const execute = async () => {
      await this.store.writeAsync(() => this.store.taskData.admitWorkInTransaction(scope.task.id));
      return work(captured, { session: scope.session, task: this.store.getTask(scope.task.id) });
    };
    return this.execution ? this.execution.withWork({ kind: "tool", taskId: scope.task.id }, execute) : execute();
  }

  async adoptTask(sessionId: SessionId, taskId: string, title: string, createdAt?: string, sourceTaskId?: string): Promise<TaskRecord> {
    const existing=this.store.findTask(taskId);
    if(existing) {
      if(existing.session_id!==sessionId)throw Object.assign(new Error(`TASK_SESSION_MISMATCH: ${taskId}`),
        {code:"TASK_SESSION_MISMATCH",effect:"not_started"});
      return existing;
    }
    return this.store.adoptRemoteTask(sessionId, taskId, title, createdAt, sourceTaskId);
  }

  async finishTask(ownerId: string, taskId: string, status: TaskFinalStatus, summary: string,
    expectedTaskRevision?: number, messageSequence = 0, expectedFinalizationRevision?: number,
    options: {automaticRetry?: boolean} = {}): Promise<TaskRecord> {
    const task = this.store.getTask(taskId);
    this.store.requireSession(ownerId,task.session_id);
    assertTaskCompletionStatus(status);
    return this.runFinalization(this.finalizing,taskId,status,summary,
      ready=>this.completeTask(ownerId,taskId,status,summary,expectedTaskRevision,ready,messageSequence,expectedFinalizationRevision,options),messageSequence);
  }

  private runFinalization<T>(
    flights: Map<string, FinalizationFlight<T>>,
    taskId: string,
    status: TaskFinalStatus,
    summary: string,
    finish: (ready: (revision: number) => void) => Promise<T>,
    messageSequence = 0
  ): Promise<T> {
    const pending = flights.get(taskId),
      current = this.store.taskData.finalization(taskId);
    if (pending && (
      pending.revision === undefined
      || current?.finalization_revision === pending.revision && current.recovery_state !== "superseded"
    )) {
      if (pending.status !== status || pending.summary !== summary || pending.messageSequence !== messageSequence)
        throw new Error('TASK_FINALIZATION_CONFLICT');
      return pending.work;
    }
    let markReady!: () => void;
    const ready = new Promise<void>(resolve => { markReady = resolve; });
    let flight: FinalizationFlight<T>;
    const run = () => finish(revision => {
      flight.revision = revision;
      markReady();
    });
    // Maintenance owns no Task execution lease: it must not count itself as active work.
    const work = Promise.resolve().then(() => this.execution
      ? this.execution.withWork({ kind: "tool", allowWhilePaused: true, blocking: true }, run) : run())
      .finally(() => {
        if (flights.get(taskId) === flight) flights.delete(taskId);
      });
    flight = { status, summary, messageSequence, ready, work };
    flights.set(taskId, flight);
    return work;
  }

  async finishTaskWithinBudget(ownerId: string, taskId: string, status: TaskFinalStatus, summary: string, waitMs=2000, messageSequence=0, expectedTaskRevision?: number): Promise<
    { task: TaskRecord; accepted: false } | { task: TaskRecord; accepted: true; pollAfterMs: number }
  > {
    const work=this.finishTask(ownerId,taskId,status,summary,expectedTaskRevision,messageSequence);
    const ready=this.finalizing.get(taskId)?.ready;
    // 持久 finalization 会记录后台错误，避免受理响应后的失败成为未处理拒绝。
    void work.catch(()=>{});
    let timer: NodeJS.Timeout | undefined;
    try {
      const result=await Promise.race([work.then(task=>({task,accepted:false as const})),
        new Promise<null>(resolve=>{timer=setTimeout(()=>resolve(null),waitMs);})]);
      if(result)return result;
      // 预算先于持久 intent 到达时，只等可恢复身份落盘，不把等待退化成整次归档。
      if(ready)await Promise.race([ready,work]);
      const task=this.store.getTask(taskId),intent=this.store.taskData.finalization(taskId);
      if(!intent || intent.status!==status || intent.summary!==summary || intent.error) return {task:await work,accepted:false};
      return task.state==='closed' ? {task,accepted:false} : {task,accepted:true,pollAfterMs:2000};
    } finally {if(timer)clearTimeout(timer);}
  }

  setRemoteFinalizer(finalizer: (task: TaskRecord, status: TaskFinalStatus, summary: string) => Promise<TaskOwnerReceipt[]>): void {
    this.remoteFinalizer=finalizer;
  }

  private localBackground(taskId: string): string[] {
    return this.ledger?this.store.runIdsForTask(taskId).filter(id=>this.ledger!.hasActiveChild(id)):[];
  }

  private assertTaskIdle(taskId: string): void {
    if(this.localBackground(taskId).length || this.store.taskData.activeWork(taskId)) {
      throw new Error(`TASK_HAS_ACTIVE_EXECUTIONS: ${taskId}`);
    }
    if(this.ledger && this.store.runIdsForTask(taskId).some(id=>this.ledger!.hasUnresolvedChild(id))) {
      throw new Error(`TASK_RECONCILIATION_REQUIRED: ${taskId}`);
    }
  }

  private async completeTask(
    ownerId: string,
    taskId: string,
    status: TaskCompletionStatus,
    summary: string,
    expectedTaskRevision?: number,
    ready?: (revision: number) => void,
    messageSequence = 0,
    expectedFinalizationRevision?: number,
    options: {automaticRetry?: boolean} = {}
  ): Promise<TaskRecord> {
    const task=this.store.getTask(taskId);
    this.store.requireSession(ownerId,task.session_id);
    if(task.state==="closed"&&task.result_status) {
      if(task.result_status!==status)throw new Error('TASK_ALREADY_FINISHED_WITH_DIFFERENT_RESULT');
      if(task.summary!==summary)throw new Error('TASK_FINALIZATION_ALREADY_CONFIRMED');
      return task;
    }
    const intent = await this.store.writeAsync(() => this.store.taskData.requestFinalization(
      taskId,
      status,
      summary,
      expectedTaskRevision,
      messageSequence,
      { expectedFinalizationRevision, automaticRetry: options.automaticRetry }
    ));
    ready?.(intent.finalization_revision);
    try {
      this.assertTaskIdle(taskId);
      const remote=this.store.taskMemberIds(taskId).map(id=>this.store.getMember(task.session_id,id)).filter(member=>member.node_id!==this.nodeId);
      if(remote.length&&!this.remoteFinalizer)throw new Error("TASK_REMOTE_FINALIZER_UNAVAILABLE");
      if (remote.length)
        await this.store.writeAsync(() => this.store.taskData.markFinalizationDispatched(taskId, intent.finalization_revision));
      const receipts=remote.length?await this.remoteFinalizer!(task,status,summary):[];
      for(const member of remote) {
        const receipt=receipts.find(value=>value.nodeId===member.node_id && value.taskId===taskId);
        const frozen=receipt?.snapshots.find(value=>value.memberId===member.id);
        if(!receipt||!frozen)throw new Error(`TASK_OWNER_RECEIPT_MISSING: ${member.node_id}:${member.id}`);
        if(receipt.activeWork||receipt.backgroundRuns.length)throw new Error(`TASK_HAS_ACTIVE_EXECUTIONS: ${member.node_id}`);
        await this.store.writeAsync(() => {
          this.store.taskData.requireFinalization(taskId, intent.finalization_revision);
          this.store.putTaskSnapshot(taskId, member.id, frozen.revision, frozen.snapshot, frozen.files);
        });
      }
      this.assertTaskIdle(taskId);
      this.store.taskData.requireFinalization(taskId, intent.finalization_revision);
      await this.captureTask(task, true, intent.finalization_revision);
      // Closing local runs is itself irreversible evidence; persist uncertainty before it.
      await this.store.writeAsync(() => this.store.taskData.markFinalizationDispatched(taskId, intent.finalization_revision));
      await this.finishLocalRuns(taskId, status, summary, intent.finalization_revision);
      return await this.store.writeAsync(() => this.store.completeTaskFinalization(taskId, status, summary, intent.finalization_revision));
    } catch (error) {
      const safe = intent.recovery_state === "safe"
        && error instanceof FinalizationDispatchError
        && error.allNotSent;
      await this.store.writeAsync(() => this.store.taskData.finishFinalization(
        taskId,
        error instanceof Error ? error.message : String(error),
        intent.finalization_revision,
        safe ? "safe" : undefined
      ));
      throw error;
    }
  }

  private async finishLocalRuns(taskId: string, status: TaskCompletionStatus, summary: string, revision: number): Promise<void> {
    if(this.ledger) {
      const linkedStore = new SessionStore(this.ledger.db);
      for(const id of this.store.runIdsForTask(taskId)) {
        await runSqliteWrite(this.ledger.db, () => {
          linkedStore.taskData.requireFinalization(taskId, revision);
          if(this.ledger!.run(id).status==="running")
            this.ledger!.finish(id,{status,acceptance:"not_applicable",summary,evidence:[]});
        });
      }
    }
  }

  async finishOwnedTask(ownerId: string, taskId: string, status: TaskFinalStatus, summary: string,
    expectedFinalizationRevision?: number, options: {automaticRetry?: boolean} = {}): Promise<TaskOwnerReceipt> {
    this.store.requireSession(ownerId,this.store.getTask(taskId).session_id);
    assertTaskCompletionStatus(status);
    return this.runFinalization(this.finalizingLocal,taskId,status,summary,async ready=>{
      const task=this.store.getTask(taskId);
      this.store.requireSession(ownerId,task.session_id);
      if(task.state==='closed' && task.result_status && task.result_status!==status)throw new Error('TASK_ALREADY_FINISHED_WITH_DIFFERENT_RESULT');
      if(task.state==='closed' && task.result_status && task.summary!==summary)throw new Error('TASK_FINALIZATION_ALREADY_CONFIRMED');
      if(!(task.state==="closed"&&task.result_status)) {
        // A delegated request has already reached an owner; this Worker cannot retire it independently.
        const intent = await this.store.writeAsync(() => this.store.taskData.requestFinalization(
          taskId,
          status,
          summary,
          undefined,
          0,
          { expectedFinalizationRevision, delegated: true, automaticRetry: options.automaticRetry }
        ));
        ready(intent.finalization_revision);
        try {
          this.assertTaskIdle(taskId);
          await this.captureTask(task, false, intent.finalization_revision);
          this.assertTaskIdle(taskId);
          await this.finishLocalRuns(taskId, status, summary, intent.finalization_revision);
          await this.store.writeAsync(() => this.store.completeTaskFinalization(taskId, status, summary, intent.finalization_revision));
        } catch (error) {
          await this.store.writeAsync(() => this.store.taskData.finishFinalization(
            taskId,
            error instanceof Error ? error.message : String(error),
            intent.finalization_revision
          ));
          throw error;
        }
      }
      return {taskId,nodeId:this.nodeId,backgroundRuns:this.localBackground(taskId),activeWork:this.store.taskData.activeWork(taskId),
        snapshots:this.store.taskSnapshots(taskId).filter(value=>this.store.getMember(task.session_id,value.memberId).node_id===this.nodeId)};
    });
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

  private async captureTask(task: TaskRecord, includeRemote: boolean, finalizationRevision?: number): Promise<void> {
    const assertCurrent = (store: SessionStore) => {
      if (finalizationRevision !== undefined) store.taskData.requireFinalization(task.id, finalizationRevision);
    };
    const persist = <T>(write: () => T) => this.store.writeAsync(() => {
      assertCurrent(this.store);
      return write();
    });
    assertCurrent(this.store);
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
        await persist(() => this.store.putTaskSnapshot(task.id, member.id, snapshot.rev, snapshot, files));
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
            if (content !== null) await persist(() => this.store.putTaskContext(task.id, member.id, path, content));
          }
        }
        if (this.ledger) {
          for (const runId of this.store.runIdsForMember(task.session_id, member.id, task.id)) {
            if (!readRunCheckpoint(this.ledger.db, runId)) {
              await runSqliteWrite(this.ledger.db, () => {
                assertCurrent(new SessionStore(this.ledger!.db));
                return saveRunCheckpoint(this.ledger!.db, runId, { revision: snapshot.rev, snapshot, files });
              });
            }
          }
        }
      }
    }
    await persist(() => this.store.setTaskChangeSummary(
      task.id,
      changeErrors.length ? "incomplete" : "complete",
      changeErrors.length ? changeErrors.join(" | ") : null
    ));
  }

  async open(
    context: TaskExecutionIdentity,
    workspace: { id: WorkspaceId; node: string; root: string; mode: "checkout" | "worktree"; sourceRoot: string | null; metadata?: WorkspaceMetadata },
    title: string,
  ): Promise<{ session: SessionRecord; task: TaskRecord; member: SessionMember; bootstrap: Record<string, unknown> }> {
    const { session, task } = await this.resolveExecution(context, title);

    const member = this.store.addMember(
      session.id,
      workspace.node,
      workspace.id,
      workspace.root,
      workspace.mode,
      workspace.sourceRoot,
    );
    this.store.touchTaskMember(task.id, member.id);

    this.store.appendEvent({
      session_id: session.id,
      task_id: task.id,
      member_id: member.id,
      type: "session_opened",
      source_id: `open-${task.id}-${member.id}`,
      timestamp: new Date().toISOString(),
      payload: { workspace_id: workspace.id, root: workspace.root, metadata: workspace.metadata },
    });

    if (this.projections?.schedule) {
      this.projections.schedule(session.id, member.id, task.id);
    }
    this.scheduleRecovery(member.root);

    const bootstrap = {
      session_id: session.id,
      member_id: member.id,
      workspace_id: workspace.id,
      title: session.title,
    };

    return { session, task, member, bootstrap };
  }

  async attach(
    context: TaskExecutionIdentity,
    sessionId: SessionId,
    workspace: { id: WorkspaceId; node: string; root: string; mode: "checkout" | "worktree"; sourceRoot: string | null; metadata?: WorkspaceMetadata },
  ): Promise<{ member: SessionMember }> {
    const { session, task } = await this.resolveExecution(context);
    if (session.id !== sessionId) throw new Error(`TASK_SESSION_MISMATCH: ${task.id}`);

    const member = this.store.addMember(
      session.id,
      workspace.node,
      workspace.id,
      workspace.root,
      workspace.mode,
      workspace.sourceRoot,
    );
    // A Task can observe an attached workspace without creating an execution.
    // Register only its existing project identity for directory/filter metadata.
    const ledger=this.ledger;
    if(ledger&&member.node_id===this.nodeId)await runSqliteWrite(ledger.db,()=>ledger.project(member.root));
    this.store.touchTaskMember(task.id, member.id);

    this.store.appendEvent({
      session_id: session.id,
      task_id: task.id,
      member_id: member.id,
      type: "session_opened",
      source_id: `attach-${task.id}-${member.id}`,
      timestamp: new Date().toISOString(),
      payload: { workspace_id: workspace.id, root: workspace.root, mode: "attach", metadata: workspace.metadata },
    });

    for (const existing of this.store.taskMemberIds(task.id).map(id => this.store.getMember(session.id, id))) {
      if (existing.node_id !== this.nodeId) continue;
      if (existing.id !== member.id) this.store.appendEvent({
        session_id: session.id, task_id: task.id, member_id: existing.id, type: "session_opened",
        source_id: `member-attached-${task.id}-${existing.id}-${member.id}`, timestamp: new Date().toISOString(),
        payload: { attached_member_id: member.id },
      });
      this.refreshMember(session.id, existing.id, task.id);
    }

    return { member };
  }

  async resolveForWorkspace(
    context: TaskExecutionIdentity,
    workspaceId: WorkspaceId,
  ): Promise<{ session: SessionRecord; task: TaskRecord; member: SessionMember }> {
    const { session, task } = await this.resolveExecution(context);
    const ws: Workspace = await this.workspaces.getWorkspace(workspaceId);

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

    this.store.touchTaskMember(task.id, member.id);

    return { session, task, member };
  }

  async ensureRun(
    session: SessionRecord,
    member: SessionMember,
    operation: { kind: string; label: string; invocationId?: string; operationId?: string },
    taskId?: string,
  ): Promise<string> {
    const ledger = this.requireLedger();
    const task = taskId ? this.store.getTask(taskId) : this.ensureCurrentTask(session);
    if (task.session_id !== session.id || task.state !== "active") throw new Error(`TASK_NOT_ACTIVE: ${task.id}`);
    const key = `${task.id}:${member.id}`;
    const pending = this.pendingRuns.get(key);
    if (pending) return pending;
    const create = async () => {
      const previousRun = this.store.runIdsForMember(session.id, member.id, task.id)[0];
      if (previousRun && ledger.run(previousRun).status !== "running") {
        await this.checkpointRun(previousRun, session.id, member.id, task.id);
      }
      const runKey = `task-${task.id}-${member.id}-${randomUUID()}`;
      // 同一连接验证身份并提交 run 与关联，不能在两个连接间分段提交。
      const linkedStore = new SessionStore(ledger.db);
      const run = await runSqliteWrite(ledger.db, () => {
        linkedStore.requireSession(session.owner_id, session.id);
        const currentMember = linkedStore.getMember(session.id, member.id);
        const currentTask = linkedStore.getTask(task.id);
        if (currentTask.session_id !== session.id || currentTask.state !== "active") throw new Error(`TASK_NOT_ACTIVE: ${task.id}`);
        admitTaskWorkInTransaction(ledger.db,task.id);
        if (operation.invocationId !== undefined || operation.operationId !== undefined) {
          const attempt = operation.operationId ? linkedStore.findInvocationSummaryByOperation(session.owner_id, operation.operationId) : null;
          if (!attempt || attempt.id !== operation.invocationId || attempt.task_id !== task.id
            || attempt.session_id !== session.id || attempt.member_id !== member.id) throw new Error("OPERATION_RETRY_SUPERSEDED");
        }
        for (const runId of linkedStore.runIdsForMember(session.id, member.id, task.id)) {
          const current = ledger.run(runId);
          if (current.status === "running") {
            if (current.title !== currentTask.title) ledger.setRunTitle(current.id, currentTask.title);
            return current;
          }
        }
        const created = ledger.begin({
          root: currentMember.root,
          workspaceId: currentMember.workspace_id,
          workItemId: `task-${task.id}`,
          runKey,
          title: currentTask.title,
          origin: { entryPoint: "chatgpt_mcp", evidence: "server_entry" },
        });
        linkedStore.linkRun(session.id, member.id, created.id, task.id);
        return created;
      });
      await this.store.setReviewStateAsync(session.id, ReviewState.unknown, task.id);
      return run.id;
    };
    const work = create().finally(() => { this.pendingRuns.delete(key); });
    this.pendingRuns.set(key, work);
    return work;
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
    if (finalizationBlocksNewWork(finalization)) throw taskFinishingError(task.id, finalization!);
    const runId = await this.ensureRun(session, member, {
      kind, label, invocationId: context.invocation_id, operationId: context.operation_id,
    }, task.id);
    const ledger = this.requireLedger();
    const attempt = context.operation_id ? this.store.findInvocationSummaryByOperation(context.owner_id, context.operation_id) : null;
    if (attempt && attempt.id !== context.invocation_id) throw new Error("OPERATION_RETRY_SUPERSEDED");
    const linkedStore = new SessionStore(ledger.db);
    const operationId = await runSqliteWrite(ledger.db, () => {
      admitTaskWorkInTransaction(ledger.db, task.id);
      const currentAttempt = context.operation_id ? linkedStore.findInvocationSummaryByOperation(context.owner_id, context.operation_id) : null;
      if (currentAttempt && currentAttempt.id !== context.invocation_id) throw new Error("OPERATION_RETRY_SUPERSEDED");
      linkedStore.touchTaskMember(task.id, member.id);
      return ledger.operation({
        id: context.operation_id,
        runId,
        requestKey: context.invocation_id,
        kind,
        label,
        status: "running",
        retryOfInvocationId: attempt?.retry_of_invocation_id ?? undefined,
      });
    });
    const ticket: OperationTicket = {
      ticket_id: randomUUID(),
      operation_id: operationId,
      invocation_id: context.invocation_id,
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

    await this.store.appendEventAsync({
      session_id: session.id,
      task_id: task.id,
      member_id: member.id,
      type: "operation_started",
      source_id: `${operationId}:${context.invocation_id}`,
      timestamp: new Date().toISOString(),
      payload: { operation_id: operationId, invocation_id: context.invocation_id,
        retry_of_invocation_id: attempt?.retry_of_invocation_id ?? undefined, kind, label, run_id: runId, actor: context.actor },
    });

    return ticket;
  }

  async checkpointRun(runId: string, sessionId: string, memberId: string, taskId?: string): Promise<void> {
    const db = this.requireLedger().db;
    if (!this.projections || readRunCheckpoint(db, runId)) return;
    const checkpoint = await this.prepareRunCheckpoint(sessionId, memberId, taskId);
    await runSqliteWrite(db, () => saveRunCheckpoint(db, runId, checkpoint));
  }

  async prepareRunCheckpoint(sessionId: string, memberId: string, taskId?: string): Promise<RunCheckpoint> {
    if (!this.projections) throw new Error("SESSION_PROJECTOR_REQUIRED");
    await this.changes?.flushTask(memberId, taskId);
    const snapshot = await this.projections.materialize(sessionId, memberId, taskId);
    return { revision: snapshot.rev, snapshot, files: this.store.fileSummaries(sessionId, memberId, taskId) };
  }

  async finishOperationById(operationId: string, result: OperationFinishResult, invocationId?: string): Promise<void> {
    const event = this.store.findOperationEvent(operationId);
    if (!event) throw new Error(`OPERATION_NOT_FOUND: ${operationId}`);
    const invocation = this.store.findInvocationSummaryByOperationId(operationId);
    if (invocationId && invocation?.id !== invocationId) return;
    // Terminal callbacks may run after every entry has selected another Task.
    // Only the accepted invocation/event/run link can identify their original work.
    const linkedTaskId = this.store.taskIdForRun(event.session_id, event.member_id, String(event.payload.run_id ?? ""));
    const taskIds = [event.task_id, invocation?.task_id, linkedTaskId].filter((value): value is string => Boolean(value));
    const taskId = taskIds[0];
    if (!taskId || taskIds.some(value => value !== taskId)
      || invocation && (invocation.session_id !== event.session_id || invocation.member_id !== event.member_id)) {
      throw new Error(`OPERATION_TASK_SCOPE_UNKNOWN: ${operationId}`);
    }
    this.store.taskData.requireScope(taskId, event.session_id, event.member_id);
    if (invocation) {
      await this.store.writeAsync(() => this.store.updateInvocation({
        ownerId: invocation.owner_id,
        transportInstanceId: invocation.transport_instance_id,
        requestId: invocation.request_id,
        state: result.status,
        effect: result.effect,
        resultRef: result.result_ref ?? invocation.result_ref,
        finished: true,
      }));
    }
    await this.operationFinished({
      ticket_id: operationId,
      operation_id: operationId,
      invocation_id: invocation?.id,
      session_id: event.session_id,
      task_id: taskId,
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
    if (this.supersededAttempt(ticket) || this.store.hasOperationFinished(ticket.operation_id, ticket.invocation_id)) return;
    if (result.status === OperationState.accepted || result.status === OperationState.queued || result.status === OperationState.running) {
      await this.operationProgress(ticket, { effect: result.effect, result_ref: result.result_ref });
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
    await runSqliteWrite(ledger.db, () => ledger.endOperation(ticket.operation_id, ledgerStatus, result.error_message || result.error_code
      ? [{
          label: result.error_code ?? "operation_failed",
          reference: JSON.stringify({ error: result.error_message ?? null, effect: result.effect, result_ref: result.result_ref ?? null }),
          outcome: "failed",
        }]
      : [{ label: "operation_completed", reference: JSON.stringify({ effect: result.effect, result_ref: result.result_ref ?? null }), outcome: "passed" }], ticket.invocation_id));
    if (this.supersededAttempt(ticket)) return;
    const appended = await this.store.appendOperationEventAsync({
      session_id: ticket.session_id,
      task_id: ticket.task_id,
      member_id: ticket.member_id,
      type: "operation_finished",
      source_id: `${ticket.operation_id}${ticket.invocation_id ? `:${ticket.invocation_id}` : ""}-finish`,
      timestamp: new Date().toISOString(),
      payload: {
        operation_id: ticket.operation_id,
        invocation_id: ticket.invocation_id,
        status: result.status,
        actor: ticket.actor,
        effect: result.effect,
        exit_code: result.exit_code,
        error_code: result.error_code,
        error_message: result.error_message,
        result_ref: result.result_ref,
      },
    });
    if (!appended) return;

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

  /** The owning recorder calls this only after a locally joined handler settles.
   * Its physical boundary does not change the business outcome or first reply. */
  async recordLocalOperationCompletion(context: InvocationContext, ticket: OperationTicket, settledAt: string): Promise<void> {
    if (!ticket.invocation_id || !Number.isFinite(Date.parse(settledAt)) || !processOwner.start
      || context.operation_id !== ticket.operation_id || context.invocation_id !== ticket.invocation_id
      || context.session_id !== ticket.session_id || context.task_id !== ticket.task_id
      || context.member_id !== ticket.member_id || context.run_id !== ticket.run_id)
      throw new Error("LOCAL_COMPLETION_IDENTITY_MISMATCH");
    const db = this.requireLedger().db, store = new SessionStore(db);
    const subject = quiescenceSubject(db, "operation", ticket.operation_id, {allowTerminal:true});
    await runSqliteWrite(db, () => {
      const invocation = store.findInvocationSummaryByOperationId(ticket.operation_id);
      const member = store.findMember(ticket.session_id, ticket.member_id);
      const owned = db.prepare(`SELECT o.status,o.request_key,e.generation,e.owner_token,e.owner_pid,e.process_start
        FROM console_operations o JOIN execution_owners e ON e.domain='operation' AND e.id=o.id
        JOIN qm_run_links l ON l.run_id=o.run_id JOIN console_work_runs r ON r.id=o.run_id
        JOIN qm_tasks t ON t.id=l.task_id JOIN qm_sessions s ON s.id=l.session_id
        WHERE o.id=? AND o.run_id=? AND l.session_id=? AND l.task_id=? AND l.member_id=?
          AND t.session_id=l.session_id AND s.owner_id=? AND r.workspace_id=?`)
        .get(ticket.operation_id, ticket.run_id, ticket.session_id, ticket.task_id, ticket.member_id,
          context.owner_id, context.workspace_id) as {status:string;request_key:string;generation:string;
            owner_token:string;owner_pid:number;process_start:string|null} | undefined;
      if (!invocation || invocation.id !== ticket.invocation_id || invocation.owner_id !== context.owner_id
        || invocation.session_id !== ticket.session_id || invocation.task_id !== ticket.task_id
        || invocation.member_id !== ticket.member_id || invocation.tool_name !== context.tool_name
        || !member || member.node_id !== this.nodeId || member.workspace_id !== context.workspace_id
        || !owned || owned.request_key !== ticket.invocation_id || owned.generation !== ticket.invocation_id
        || owned.owner_token !== processOwner.token || owned.owner_pid !== processOwner.pid
        || owned.process_start !== processOwner.start)
        throw new Error("LOCAL_COMPLETION_IDENTITY_MISMATCH");
      const unresolved = invocation.state === OperationState.unknown && invocation.effect === "unknown"
        && ["unknown", "reconciliation_required"].includes(owned.status);
      const terminalStatus = invocation.state === OperationState.succeeded ? "completed"
        : invocation.state === OperationState.failed ? "failed"
          : invocation.state === OperationState.cancelled ? "cancelled" : null;
      const terminal = terminalStatus !== null && owned.status === terminalStatus
        && invocation.finished_at !== null && Number.isFinite(Date.parse(invocation.finished_at));
      if ((!unresolved && !terminal) || !invocation.result_ready
        || !store.hasOperationFinished(ticket.operation_id, ticket.invocation_id))
        throw new Error("LOCAL_COMPLETION_RECEIPT_NOT_READY");
      // This internal handshake is assigned only to handlers which join all
      // owned work. Revalidate the captured fingerprint after acquiring the
      // write lock; later evidence or another attempt must reject this callback.
      recordExecutionQuiescence(db, [subject], {
        id: `local-handler:${ticket.invocation_id}:${processOwner.token}`, verifiedAt: new Date().toISOString(),
        evidence: {version: 1, boundary: "local_handler_settled", operationId: ticket.operation_id,
          invocationId: ticket.invocation_id, sessionId: ticket.session_id, taskId: ticket.task_id,
          memberId: ticket.member_id, runId: ticket.run_id, nodeId: this.nodeId,
          workspaceId: context.workspace_id, ownerToken: processOwner.token, ownerPid: processOwner.pid,
          processStart: processOwner.start, settledAt},
      }, {allowTerminal:true});
      for (const claim of db.prepare("SELECT id FROM execution_claims WHERE operation_id=?").all(ticket.operation_id) as Array<{id:string}>)
        this.requireLedger().recoverClaim(claim.id);
    });
  }

  async operationProgress(ticket: OperationTicket, result: OperationProgressResult): Promise<void> {
    if (this.supersededAttempt(ticket) || this.store.hasOperationFinished(ticket.operation_id, ticket.invocation_id)) return;
    await this.store.writeAsync(() => {
      if (!this.supersededAttempt(ticket) && !this.store.hasOperationFinished(ticket.operation_id, ticket.invocation_id)) {
        this.store.setExecutionState(ticket.session_id, ExecutionState.active);
      }
    });
    if (this.supersededAttempt(ticket) || this.store.hasOperationFinished(ticket.operation_id, ticket.invocation_id)) return;
    const appended = await this.store.appendOperationEventAsync({
      session_id: ticket.session_id,
      task_id: ticket.task_id,
      member_id: ticket.member_id,
      type: "operation_started",
      source_id: `${ticket.operation_id}${ticket.invocation_id ? `:${ticket.invocation_id}` : ""}-progress`,
      timestamp: new Date().toISOString(),
      payload: {
        operation_id: ticket.operation_id,
        invocation_id: ticket.invocation_id,
        kind: ticket.kind,
        label: ticket.label,
        run_id: ticket.run_id,
        status: OperationState.running,
        effect: result.effect,
        result_ref: result.result_ref ?? null,
      },
    });
    if (!appended) return;
    if (this.projections?.schedule) {
      this.projections.schedule(ticket.session_id, ticket.member_id, ticket.task_id);
    }
  }

  operationTransportLost(ticket: OperationTicket): void {
    this.store.updateObservedHostState(ticket.session_id, HostState.disconnected);
  }

  private supersededAttempt(ticket: OperationTicket): boolean {
    const current = this.store.findInvocationSummaryByOperationId(ticket.operation_id);
    return Boolean(ticket.invocation_id && current && current.id !== ticket.invocation_id);
  }

  async agentEvent(sessionId: SessionId, memberId: string, event: Record<string, unknown>, taskId?: string): Promise<void> {
    const sourceId = (event.source_id as string) || `agent-${Date.now()}-${randomUUID().slice(0, 6)}`;
    await this.store.appendEventAsync({
      session_id: sessionId,
      task_id: taskId ?? null,
      member_id: memberId,
      type: "agent_changed",
      source_id: sourceId,
      timestamp: new Date().toISOString(),
      payload: event,
    });

    if (this.projections?.schedule) {
      this.projections.schedule(sessionId, memberId, taskId);
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
    // 获取写锁后再计算状态，等待期间新开始的工作不会被旧快照覆盖。
    return this.store.writeAsync(() => this.reconcileState(sessionId));
  }

  private reconcileState(sessionId: SessionId): ExecutionState {
    const ledger = this.requireLedger();
    const session = this.store.getSession(sessionId);
    let state = ExecutionState.idle;
    const after = new Date(Date.now() - EXECUTION_OBSERVATION_MS).toISOString();
    for (const member of session.members) {
      const activity = memberRunActivity(ledger.db, sessionId, member.id, after);
      if (!activity) continue;
      const currentRunId = activity.runId;
      // 旧阶段的后台工作继续参与活性汇总；旧失败记录不污染当前请求。
      if (activity.confirmed) state = ExecutionState.active;
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
    await Promise.allSettled([...this.finalizing.values(),...this.finalizingLocal.values()].map(flight=>flight.work));
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
