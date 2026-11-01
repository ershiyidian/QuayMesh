import { requestContextStorage as observationContext } from "./invocations.js";
import { isReadOnlyObservation } from "../tool-admission.js";
import { createInvocationContext, executeRecorded, InvocationPersistenceError, type InvocationOperation } from "./invocations.js";
import type { InvocationContext, OperationRecord, SessionId } from "./types.js";
import type { SessionStore } from "./store.js";
import type { SessionService, TaskExecutionIdentity } from "./service.js";
import type { SessionChangeCollector } from "./changes.js";
import type { SessionProjector } from "./projection.js";
import type { WorkspaceRegistry } from "../workspaces.js";
import { parseWorkspaceHandle } from "../federation/routing.js";
import { OperationState } from "./types.js";
import { observesAcceptedWork } from "../tool-admission.js";
import { classifyError, errorEnvelope, errorFromEnvelope, type InvocationEnvelope } from "./outcome.js";
import type { ExecutionCoordinator, RuntimeWorkLease } from "../execution-coordinator.js";

export interface ModelToolIdentity extends TaskExecutionIdentity {
  owner_id: string;
  conversation_id: string | null;
  transport_instance_id: string;
  request_id: string | number;
  invocation_id?: string;
  operation_id?: string;
  task_id?: string;
}

export interface RecordModelToolInput<T> {
  identity: ModelToolIdentity;
  workspace_id: string;
  tool_name: string;
  kind: OperationRecord["kind"];
  label: string;
  input: unknown;
  operation: (context: InvocationContext) => Promise<T>;
  /** Internal contract: the local handler awaits every owned operation and cleanup.
   * Never infer this from a read-only hint, operation kind or remote receipt. */
  localCompletion?: "handler_settled";
  isError?: (result: T) => boolean;
  runningResult?: (result: T) => boolean;
  unknownResult?: (result: T) => boolean;
  knownPaths?: (result: T) => string[];
  beforeWrite?: (context: InvocationContext) => Promise<void>;
  affectsFiles?: boolean;
  replyWaitMs?: number;
  pendingResult?: (context: InvocationContext) => T;
  resultRef?: (result: T, context: InvocationContext) => string | null;
  afterResult?: (result: T, context: InvocationContext) => Promise<void> | void;
  afterReply?: (result: T, context: InvocationContext, recordedOperationId?: string) => T;
  contextRead?: (result: T, context: InvocationContext) => Promise<void> | void;
  operationStatus?: (result: T, context: InvocationContext) => {
    state: OperationState;
    effect: "not_started" | "started" | "partial" | "completed" | "unknown";
    error_code?: string | null;
    error_message?: string | null;
    exit_code?: number | null;
  } | null;
}

export class SessionToolRecorder {
  private readonly pendingRecords = new Set<Promise<unknown>>();
  private readonly ownedContexts = new Set<InvocationContext>();

  activeOperationIds(): string[] {
    return [...new Set([...this.ownedContexts].flatMap(context => context.operation_id ? [context.operation_id] : []))];
  }
  constructor(
    private readonly store: SessionStore,
    private readonly workspaces: WorkspaceRegistry,
    private readonly service: SessionService,
    private readonly changes: SessionChangeCollector,
    private readonly projector: SessionProjector,
    private readonly execution?: ExecutionCoordinator,
    private readonly nodeId = "local",
  ) {}

  async contextForWorkspace(
    identity: ModelToolIdentity,
    workspaceId: string,
  ): Promise<InvocationContext> {
    const { session, task, member } = await this.service.resolveForWorkspace(
      identity,
      workspaceId,
    );
    if(task.session_id !== session.id)throw new Error(`TASK_SESSION_MISMATCH: ${task.id}`);
    return createInvocationContext({
      auth: { owner_id: identity.owner_id },
      transport: { instance_id: identity.transport_instance_id },
      request: {
        id: identity.request_id,
        invocation_id: identity.invocation_id,
        operation_id: identity.operation_id,
        conversation_id: identity.conversation_id,
        actor: "model",
      },
      session: {
        session_id: session.id,
        task_id: task.id,
        member_id: member.id,
        workspace_id: member.workspace_id,
      },
    });
  }

  contextForSession(
    identity: ModelToolIdentity,
    sessionId: SessionId,
    memberId: string,
    workspaceId: string,
    toolName: string,
    recordActivity = true,
  ): InvocationContext {
    this.store.requireSession(identity.owner_id, sessionId);
    const session = this.store.getSession(sessionId);
    const selected = this.service.selectedExecution(identity);
    const task = selected?.task ?? this.service.ensureCurrentTask(session);
    if(task.session_id !== session.id)throw new Error(`TASK_SESSION_MISMATCH: ${task.id}`);
    const member = this.store.getMember(sessionId, memberId);
    if(recordActivity)this.store.touchTaskMember(task.id, member.id);
    return createInvocationContext({
      auth: { owner_id: identity.owner_id },
      transport: { instance_id: identity.transport_instance_id },
      request: {
        id: identity.request_id,
        invocation_id: identity.invocation_id,
        operation_id: identity.operation_id,
        conversation_id: identity.conversation_id,
        actor: "model",
        tool_name: toolName,
      },
      session: {
        session_id: sessionId,
        task_id: task.id,
        member_id: member.id,
        workspace_id: member.workspace_id || workspaceId,
      },
    });
  }

  private async returnOrAccept<T>(
    context: InvocationContext,
    input: Pick<RecordModelToolInput<T>, "pendingResult" | "replyWaitMs">,
    execution: Promise<T>,
    reserved: Promise<void>,
  ): Promise<T> {
    this.ownedContexts.add(context);
    const work = execution.finally(() => {this.pendingRecords.delete(work);this.ownedContexts.delete(context);});
    this.pendingRecords.add(work);
    // 如果先返回受理回执，后台执行依然可能失败。显式观察失败以避免
    // unhandledRejection 终止 Core；执行结果和错误由 executeRecorded 持久保存。
    void work.catch(() => {});
    if (!input.pendingResult) return work;
    // 操作身份已落盘，执行由 recorder 持有；HTTP 回执不承担执行所有权。
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        work.then(value => ({ kind: "result" as const, value })),
        new Promise<{ kind: "timeout" }>(resolve => {
          timer = setTimeout(() => resolve({ kind: "timeout" }), input.replyWaitMs ?? 2000);
        }),
      ]);
      if (outcome.kind === "result") return outcome.value;
      // 写锁可能让初始受理计时器先到；一旦身份持久化立即返回回执，不再等待整个动作。
      await Promise.race([reserved, work]);
      const saved = context.operation_id && this.store.findInvocationSummaryByOperation(context.owner_id,context.operation_id);
      if (!saved) return work;
      return input.pendingResult(context);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async record<T>(input: RecordModelToolInput<T>): Promise<T> {
    const observation = isReadOnlyObservation(input.tool_name,input.input as Record<string,unknown>);
    const known = this.service.selectedExecution(input.identity);
    const selected = !observation && !input.identity.task_id && input.identity.task_entry && known
      ? await this.service.resolveExecution(input.identity) : known;
    const identity = selected ? { ...input.identity, task_id: selected.task.id } : input.identity;
    const context = this.contextForKnownWorkspace(identity, input.workspace_id, false)
      ?? await this.contextForWorkspace(identity, input.workspace_id);
    if (observation) {
      context.tool_name=input.tool_name;
      if (input.tool_name === "read") {
        // Keep the saved read result and context evidence, without a business
        // execution or a durable work lease that can outlive the observation.
        return this.recordReceipt(context,{...input,localCompletion:undefined,operation:async captured=>{
          const result=await input.operation(captured);
          await input.contextRead?.(result,captured);
          await input.afterResult?.(result,captured);
          return result;
        }},undefined,true).then(result=>input.afterReply?.(result,context,context.operation_id)??result);
      }
      return observationContext.run(context, () => input.operation(context)).then(result => input.afterReply?.(result, context) ?? result);
    }
    let notifyReserved!: () => void;
    const reserved = new Promise<void>(resolve => {notifyReserved=resolve;});
    let recordedOperationId: string | undefined;
    const execution = this.recordWithContext(context, input, () => {
      recordedOperationId = context.operation_id;
      notifyReserved();
    });
    return this.returnOrAccept(context, input, execution, reserved)
      .then(result => input.afterReply?.(result, context, recordedOperationId) ?? result);
  }

  async close(): Promise<void> {
    while (this.pendingRecords.size) await Promise.allSettled([...this.pendingRecords]);
  }

  async recordForwarded<T>(input: RecordModelToolInput<T>): Promise<T> {
    const observation=isReadOnlyObservation(input.tool_name,input.input as Record<string,unknown>);
    const known = this.service.selectedExecution(input.identity);
    const selected = !observation && !input.identity.task_id && input.identity.task_entry && known
      ? await this.service.resolveExecution(input.identity) : known;
    const identity = selected ? { ...input.identity, task_id: selected.task.id } : input.identity;
    const context = this.contextForKnownWorkspace(identity, input.workspace_id,false);
    if (!context) throw new Error(`REMOTE_SESSION_MEMBER_REQUIRED: ${input.workspace_id}`);
    if (input.tool_name === "read") return this.recordReceipt(context,input)
      .then(result=>input.afterReply?.(result,context,context.operation_id)??result);
    if(observation){context.tool_name=input.tool_name;return observationContext.run(context,()=>input.operation(context)).then(result => input.afterReply?.(result, context) ?? result);}
    // 入口回执由协调端持久保存，远程操作仍使用相同的确定性 operation_id。
    // 等待时间达到上限即返回可查询的受理回执，后台 RPC 继续执行并归档结果。
    let notifyReserved!: () => void;
    const reserved=new Promise<void>(resolve=>{notifyReserved=resolve;});
    let recordedOperationId: string | undefined;
    return this.returnOrAccept(context, input, this.recordReceipt(context, input, () => {
      recordedOperationId = context.operation_id;
      notifyReserved();
    }), reserved).then(result => input.afterReply?.(result, context, recordedOperationId) ?? result);
  }

  private async recordReceipt<T>(context: InvocationContext, input: Omit<RecordModelToolInput<T>, "identity" | "workspace_id">, onReserved?: () => void, local = false): Promise<T> {
    context.tool_name = input.tool_name;
    let lease: RuntimeWorkLease | undefined;
    let failed=false;
    try {
    // 入口保存同一次请求的回执，文件、进程和工作记录由所属节点维护。
    const recorded = await executeRecorded<InvocationEnvelope<T>>(this.store, context, input.input, {
      onReserved,
      beforeEffect: async () => {
        // A local read of a closed Task still owns physical work, without
        // creating a new business operation or certifying a forwarded call.
        if (local && input.localCompletion && this.execution) lease = await this.execution.beginWorkAsync({
          kind: "tool", taskId: context.task_id, operationId: context.operation_id,
          allowWhilePaused: observesAcceptedWork(input.tool_name, input.input as Record<string, unknown>), blocking: true,
        });
        // 已有回执先由 executeRecorded 重放；只有新工作必须在转发和首次镜像前验证任务。
        if (observesAcceptedWork(input.tool_name, input.input as Record<string, unknown>)) {
          const taskId = context.task_id;
          if (taskId) await this.store.writeAsync(() => {
            // A new foreground read participates in its active Task even when
            // the workspace was already known. Historical reads stay frozen.
            if (this.store.getTask(taskId).state === "active") this.store.touchTaskMember(taskId, context.member_id);
          });
          return;
        }
        const task = context.task_id ? this.store.getTask(context.task_id) : null;
        if (!task || task.state !== "active") throw Object.assign(new Error(`TASK_NOT_ACTIVE: ${context.task_id ?? "missing"}`),
          { code: "TASK_NOT_ACTIVE", effect: "not_started" });
        // Acquire the Task lease before admission so a finish cannot pass its
        // idle check between this transaction and the actual remote dispatch.
        if (this.execution && !lease) lease=await this.execution.beginWorkAsync({kind:"tool",taskId:task.id,operationId:context.operation_id});
        await this.store.writeAsync(() => {
          this.store.taskData.admitWorkInTransaction(task.id);
          this.store.touchTaskMember(task.id,context.member_id);
        });
      },
      invoke: async () => {
        try { return { kind: "result", value: await (lease ? lease.run(()=>input.operation(context)) : input.operation(context)) }; }
        catch (error) {
          const envelope = errorEnvelope(error,{sideEffecting:input.affectsFiles??false,forwarded:!local,effectStarted:true});
          if (envelope.effect === "unknown" && context.operation_id) {
            const member = this.store.getMember(context.session_id, context.member_id);
            const workspaceId = parseWorkspaceHandle(member.workspace_id) ? member.workspace_id : `qm:${member.node_id}:${member.workspace_id}`;
            envelope.errorDetails = { ...(envelope.errorDetails && typeof envelope.errorDetails === "object" ? envelope.errorDetails : {}),
              operation_id: context.operation_id, owner_node_id: member.node_id, receipt_node_id: this.nodeId,
              next_action: { tool: "workspace_context", arguments: { workspace_id: workspaceId, action: "status", operation_id: context.operation_id } } };
          }
          return envelope;
        }
      },
      isError: (envelope) => envelope.kind === "error" || (envelope.value !== undefined && input.isError?.(envelope.value) === true),
      runningResult: (envelope) => envelope.kind === "result" && envelope.value !== undefined && input.runningResult?.(envelope.value) === true,
      outcome:(envelope)=>envelope.kind==="error"?{state:envelope.effect==="unknown"?OperationState.unknown:OperationState.failed,effect:envelope.effect??"unknown"}
        : envelope.value!==undefined?input.operationStatus?.(envelope.value,context)??null:null,
      sideEffecting:input.affectsFiles??false,
      forwarded:!local,
      resultRef: (envelope) => envelope.kind === "result" && envelope.value !== undefined ? input.resultRef?.(envelope.value, context) ?? null : null,
    });
    if (!recorded.result) throw new Error(`INVOCATION_REPLAY_RESULT_PENDING: ${recorded.operation_id ?? "unknown"}`);
    return unwrapEnvelope(recorded.result, recorded.operation_id);
    } catch(error) {failed=true;throw error;}
    finally {try {await lease?.releaseAsync();} catch(error) {if (!failed) throw error;}}
  }

  private contextForKnownWorkspace(
    identity: ModelToolIdentity,
    workspaceId: string,
    recordActivity = true,
  ): InvocationContext | undefined {
    const handle = parseWorkspaceHandle(workspaceId);
    const selected = this.service.selectedExecution(identity);
    const workspaceIds = handle ? [handle.local, workspaceId] : [workspaceId];
    const member = selected?.session.members.find(item => workspaceIds.includes(item.workspace_id)
      && (!handle || item.node_id === handle.node));
    const candidate = selected ? member ? { sessionId: selected.session.id, member } : null : this.store.resolveMemberForWorkspace({
      ownerId: identity.owner_id,
      conversationId: identity.conversation_id,
      workspaceIds,
      ...(handle ? { nodeId: handle.node } : {}),
    });
    if (!candidate) return undefined;
    return this.contextForSession(
      identity,
      candidate.sessionId,
      candidate.member.id,
      candidate.member.workspace_id,
      "unknown",
      recordActivity,
    );
  }

  async recordWithContext<T>(
    context: InvocationContext,
    input: Omit<RecordModelToolInput<T>, "identity" | "workspace_id">,
    onReserved?: () => void,
  ): Promise<T> {
    context.tool_name = input.tool_name;
    context.actor = "model";
    const finalization=context.task_id?this.store.taskData.finalization(context.task_id):null;
    if (context.task_id && (this.store.getTask(context.task_id).state === "closed"
      || finalization && finalization.recovery_state!=="superseded") &&
      observesAcceptedWork(input.tool_name, input.input as Record<string, unknown>)) {
      return this.recordReceipt(context, input, onReserved, true);
    }
    const isWrite = input.affectsFiles ?? (input.kind === "patch" || input.kind === "command" || input.kind === "copy");
    let ticket: Awaited<ReturnType<SessionService["beforeOperation"]>> | undefined;
    let lease: RuntimeWorkLease | undefined;
    let completion: {context: InvocationContext; settledAt: string} | undefined;
    let failed=false;
    try {
    const operation: InvocationOperation<InvocationEnvelope<T>> = {
      onReserved,
      beforeEffect: async () => {
        if ((input.pendingResult || input.localCompletion) && this.execution) lease=await this.execution.beginWorkAsync({
          kind:"tool",taskId:context.task_id,operationId:context.operation_id,
          ...(input.localCompletion ? {allowWhilePaused: observesAcceptedWork(input.tool_name, input.input as Record<string, unknown>), blocking: true} : {}),
        });
        const prepare=async()=>{
        ticket = await this.service.beforeOperation(context, input.kind, input.label);
        context.operation_id = ticket.operation_id;
        if (isWrite) {
          if (input.beforeWrite) {
            await input.beforeWrite(context);
          } else {
            const member = this.store.getMember(context.session_id, context.member_id);
            await this.changes.ensureBaseline(member, [], member.root, context.task_id);
          }
        }
        };
        await (lease ? lease.run(prepare) : prepare());
      },
      invoke: async () => {
        const captured = input.localCompletion ? {...context} : undefined;
        try {
          return { kind: "result", value: await (lease ? lease.run(()=>input.operation(context)) : input.operation(context)) };
        } catch (error) {
          return errorEnvelope(error,{sideEffecting:isWrite,effectStarted:true});
        } finally { if (captured) completion = {context: captured, settledAt: new Date().toISOString()}; }
      },
      isError: (envelope) => envelope.kind === "error" || (envelope.value !== undefined && input.isError?.(envelope.value) === true),
      runningResult: (envelope) => envelope.kind === "result" && envelope.value !== undefined && input.runningResult?.(envelope.value) === true,
      unknownResult: (envelope) => envelope.kind === "result" && envelope.value !== undefined && input.unknownResult?.(envelope.value) === true,
      outcome:(envelope)=>envelope.kind==="error"?{state:envelope.effect==="unknown"?OperationState.unknown:OperationState.failed,effect:envelope.effect??(isWrite?"partial":"not_started")}
        : envelope.value!==undefined?input.operationStatus?.(envelope.value,context)??null:null,
      sideEffecting:isWrite,
      resultRef: (envelope) => envelope.kind === "result" && envelope.value !== undefined
        ? input.resultRef?.(envelope.value, context) ?? null
        : null,
    };
    const recorded = await executeRecorded(this.store, context, input.input, operation).catch(async error => {
      if (error instanceof InvocationPersistenceError) throw error;
      if (ticket) {
        const outcome = classifyError(error, { sideEffecting: isWrite, effectStarted: false });
        await this.service.operationFinished(ticket, {
          status: outcome.state, effect: outcome.effect,
          error_code: outcome.code, error_message: outcome.message,
        });
      }
      throw error;
    });
    if (recorded.replay) {
      if (!recorded.result) throw new Error(`INVOCATION_REPLAY_RESULT_PENDING: ${recorded.operation_id ?? "unknown"}`);
      return unwrapEnvelope(recorded.result, recorded.operation_id);
    }
    const envelope = recorded.result;
    if (!envelope) throw new Error("INVOCATION_RESULT_MISSING");
    if (envelope.kind === "result" && envelope.value !== undefined) {
      await input.contextRead?.(envelope.value, context);
      await input.afterResult?.(envelope.value, context);
    }
    if (!ticket) throw new Error("INVOCATION_OPERATION_TICKET_MISSING");
    const finalStatus = envelope.kind === "result" && envelope.value !== undefined
      ? input.operationStatus?.(envelope.value, context) ?? null
      : null;
    await this.service.operationFinished(ticket, {
      status: finalStatus?.state ?? recorded.state,
      effect: finalStatus?.effect ?? recorded.effect,
      exit_code: finalStatus?.exit_code,
      error_code: finalStatus?.error_code ?? (envelope.kind==="error"?envelope.errorCode:undefined),
      error_message: envelope.kind === "error"
        ? envelope.message ?? "Tool failed."
        : finalStatus?.error_message
          ?? (finalStatus?.state === OperationState.failed || recorded.state === OperationState.failed
            ? "Tool returned an error."
            : null),
      result_ref: recorded.result_ref,
      known_paths: recorded.state === OperationState.succeeded && envelope.kind === "result"
        ? input.knownPaths?.(envelope.value as T) ?? []
        : [],
    });
    if (completion && [OperationState.unknown, OperationState.succeeded, OperationState.failed, OperationState.cancelled].includes(recorded.state)) {
      // Save only after operationFinished: its business-row update revokes any
      // earlier proof. A failed proof write must not replace the first receipt.
      try { await this.service.recordLocalOperationCompletion(completion.context, ticket, completion.settledAt); }
      catch (error) { console.error("QuayMesh physical completion receipt pending", ticket.operation_id,
        error instanceof Error ? error.message : String(error)); }
    }
    this.projector.schedule(context.session_id, context.member_id, context.task_id);
    return unwrapEnvelope(envelope, recorded.operation_id);
    } catch(error) {failed=true;throw error;}
    finally {try {await lease?.releaseAsync();} catch(error) {if (!failed) throw error;}}
  }
}

function unwrapEnvelope<T>(envelope: InvocationEnvelope<T>, operationId: string | null): T {
  if (envelope.kind === "error") throw errorFromEnvelope(envelope, undefined, operationId);
  if (envelope.kind !== "result") throw new Error("INVOCATION_RESULT_INVALID: Stored receipt has no result or error envelope.");
  return envelope.value as T;
}
