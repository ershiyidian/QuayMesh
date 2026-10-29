import { finalizationBlocksNewWork } from "./task-finalization.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { OperationState, type InvocationContext } from "./types.js";
import type { SessionStore, InvocationSummary } from "./store.js";
import { classifyError, errorEnvelope, errorFromEnvelope, RecordedInvocationError, type InvocationEffect } from "./outcome.js";

export const requestContextStorage = new AsyncLocalStorage<InvocationContext>();

export interface InvocationRequestIdentity {
  owner_id: string;
  transport_instance_id: string;
  request_id: string | number;
}

export interface InvocationSessionIdentity {
  session_id: string;
  task_id?: string;
  member_id: string;
  workspace_id: string;
}

export interface InvocationAuth {
  owner_id: string;
}

export interface InvocationTransport {
  instance_id: string;
}

export interface InvocationRequest {
  id: string | number;
  invocation_id?: string;
  operation_id?: string;
  conversation_id?: string | null;
  actor?: "model" | "agent" | "app" | "system";
  tool_name?: string;
}

export interface InvocationOperation<T> {
  invoke(): Promise<T>;
  onReserved?(): void;
  beforeEffect?(): Promise<void> | void;
  resultRef?(result: T): string | null;
  isError?(result: T): boolean;
  runningResult?(result: T): boolean;
  unknownResult?(result: T): boolean;
  outcome?(result:T): {state:OperationState;effect:InvocationEffect}|null;
  sideEffecting?: boolean;
  forwarded?: boolean;
}

export interface RecordedInvocation<T> {
  replay: boolean;
  result?: T;
  invocation_id: string;
  operation_id: string | null;
  state: OperationState;
  effect: "not_started" | "started" | "partial" | "completed" | "unknown";
  result_ref: string | null;
}

// 原操作已返回，保存回执失败时保留原身份，禁止把数据库错误当成新的执行失败。
export class InvocationPersistenceError extends RecordedInvocationError {
  readonly code = "INVOCATION_PERSISTENCE_FAILED";
  readonly effect = "unknown";
  readonly details: { operation_id: string; stage: "result" };

  constructor(operationId: string, cause: unknown) {
    super("INVOCATION_PERSISTENCE_FAILED: The operation returned, but its receipt could not be saved. Query the original operation before taking further action.", operationId, { cause });
    this.details = { operation_id: operationId, stage: "result" };
  }
}

export function stableJson(value: unknown): string {
  return JSON.stringify(normalizeJson(value));
}

export function createInvocationContext(input: {
  auth: InvocationAuth;
  transport: InvocationTransport;
  request: InvocationRequest;
  session: InvocationSessionIdentity;
}): InvocationContext {
  if (!input.auth.owner_id) throw new Error("MISSING_AUTHENTICATED_OWNER");
  if (!input.transport.instance_id) throw new Error("MISSING_TRANSPORT_INSTANCE");
  if (input.request.id === undefined || input.request.id === null || input.request.id === "") {
    throw new Error("MISSING_REQUEST_ID");
  }
  return {
    owner_id: input.auth.owner_id,
    conversation_id: input.request.conversation_id ?? null,
    transport_instance_id: input.transport.instance_id,
    request_id: input.request.id,
    invocation_id: input.request.invocation_id ?? randomUUID(),
    ...(input.request.operation_id ? {operation_id: input.request.operation_id} : {}),
    session_id: input.session.session_id,
    ...(input.session.task_id ? { task_id: input.session.task_id } : {}),
    member_id: input.session.member_id,
    actor: input.request.actor ?? "model",
    tool_name: input.request.tool_name ?? "unknown",
    workspace_id: input.session.workspace_id,
  };
}

export function currentInvocation(): InvocationContext | undefined {
  return requestContextStorage.getStore();
}

export async function executeRecorded<T>(
  store: SessionStore,
  context: InvocationContext,
  input: unknown,
  operation: InvocationOperation<T>,
): Promise<RecordedInvocation<T>> {
  const requestId = String(context.request_id);
  const data = input !== null && typeof input === "object" ? input as Record<string, unknown> : null;
  const operationKey = typeof data?.operation_key === "string" ? data.operation_key : undefined;
  if (operationKey !== undefined && (operationKey.length === 0 || operationKey.length > 128)) {
    throw new Error("OPERATION_KEY_INVALID");
  }
  // 已登记的操作允许以不同读取预算重取回执，实际执行参数仍须相同。
  const argumentsJson = stableJson(operationKey && data
    ? Object.fromEntries(Object.entries(data).filter(([key]) =>
      !["workspace_id", "yield_time_ms", "max_output_tokens"].includes(key)))
    : input);
  const sameRequest = store.findInvocationSummary(context.owner_id, context.transport_instance_id, requestId);
  const existing = sameRequest ?? (operationKey
    ? store.findKeyedInvocationSummary(context.owner_id, context.session_id, context.member_id, operationKey) : null);
  let retryOf: string | undefined;
  if (existing) {
    assertReplayScope(store, existing, context);
    if (context.operation_id && existing.operation_id && context.operation_id !== existing.operation_id) {
      throw new Error("OPERATION_ID_MISMATCH");
    }
    context.operation_id = existing.operation_id ?? undefined;
    if (!store.invocationMatchesInput(existing.id,context.tool_name,argumentsJson)) {
      throw new Error("REQUEST_ID_REUSED");
    }
    if (!sameRequest && operationKey && store.isRetryableInvocationAdmission(existing)) {
      const task = existing.task_id ? store.getTask(existing.task_id) : null;
      if (!task || task.state !== "active" || task.id !== context.task_id
        || existing.session_id !== context.session_id || existing.member_id !== context.member_id
        || finalizationBlocksNewWork(store.taskData.finalization(task.id))) throw Object.assign(
          new Error("OPERATION_RETRY_SCOPE_MISMATCH: Retry requires the original active task and workspace member."),
          {code: "OPERATION_RETRY_SCOPE_MISMATCH", details: {operation_id: existing.operation_id, task_id: existing.task_id}});
      retryOf = existing.id;
    } else { operation.onReserved?.(); return replayInvocation<T>(store, existing); }
  }

  const reservation = await store.writeAsync(() => {
    const prior = store.findInvocationSummary(context.owner_id, context.transport_instance_id, requestId);
    const row = store.reserveInvocation({
      id: context.invocation_id,
      ownerId: context.owner_id,
      transportInstanceId: context.transport_instance_id,
      requestId,
      sessionId: context.session_id,
      memberId: context.member_id,
      toolName: context.tool_name,
      argumentsJson,
      taskId: context.task_id,
      operationId: context.operation_id ?? operationIdFrom(context, requestId),
      retryOfInvocationId: retryOf,
      operationKey,
    });
    return { row, alreadyReserved: prior !== null };
  });
  const reserved = reservation.row;
  if (reservation.alreadyReserved || reserved.id !== context.invocation_id) return executeRecorded(store, context, input, operation);
  const operationId = reserved.operation_id ?? operationIdFrom(context, requestId);
  context.operation_id = operationId;
  operation.onReserved?.();
  await store.writeAsync(() => store.updateInvocation({
    ownerId: context.owner_id,
    transportInstanceId: context.transport_instance_id,
    requestId,
    operationId,
  }));

  try {
    await operation.beforeEffect?.();
  } catch (error) {
    const cancelled = store.findInvocationSummary(context.owner_id, context.transport_instance_id, requestId);
    if (cancelled?.state === OperationState.cancelled && cancelled.result_ready) return replayInvocation<T>(store, cancelled);
    const outcome = classifyError(error, {sideEffecting: operation.sideEffecting ?? false, effectStarted: false});
    const envelope = errorEnvelope(error, {sideEffecting: operation.sideEffecting ?? false, effectStarted: false});
    await store.writeAsync(() => store.updateInvocation({
      ownerId: context.owner_id,
      transportInstanceId: context.transport_instance_id,
      requestId,
      state: outcome.state,
      effect: outcome.effect,
      result: envelope,
      finished: true,
      responded: true,
    }));
    throw errorFromEnvelope(envelope, error, operationId);
  }
  const cancelled = store.findInvocationSummary(context.owner_id, context.transport_instance_id, requestId);
  if (cancelled?.state === OperationState.cancelled && cancelled.result_ready) return replayInvocation<T>(store, cancelled);
  const started = await store.writeAsync(() => store.updateInvocation({
    ownerId: context.owner_id,
    transportInstanceId: context.transport_instance_id,
    requestId,
    state: OperationState.running,
    effect: "started",
  }));
  if (started.state === OperationState.cancelled) return replayInvocation<T>(store, started);

  return requestContextStorage.run(context, async () => {
    const latest = store.findInvocationSummary(context.owner_id, context.transport_instance_id, requestId);
    if (latest?.state === OperationState.cancelled) return replayInvocation<T>(store, latest);
    let result: T;
    try {
      result = await operation.invoke();
    } catch (error) {
      const outcome = classifyError(error, {sideEffecting: operation.sideEffecting ?? false, forwarded: operation.forwarded, effectStarted: true});
      const envelope = errorEnvelope(error, {sideEffecting: operation.sideEffecting ?? false, forwarded: operation.forwarded, effectStarted: true});
      try {
        await store.writeAsync(() => store.updateInvocation({
          ownerId: context.owner_id,
          transportInstanceId: context.transport_instance_id,
          requestId,
          state: outcome.state,
          effect: outcome.effect,
          result: envelope,
          finished: true,
          responded: true,
        }));
      } catch (persistenceError) {
        throw new InvocationPersistenceError(operationId, persistenceError);
      }
      throw errorFromEnvelope(envelope, error, operationId);
    }

    // 只保存已经算出的结果；锁等待和保存失败都不会再次调用 invoke。
    try {
      const resultRef = operation.resultRef?.(result) ?? null;
      const isError = operation.isError?.(result) ?? false;
      const running = operation.runningResult?.(result) ?? false;
      const unknown = operation.unknownResult?.(result) ?? false;
      const explicit=operation.outcome?.(result)??null;
      const state = explicit?.state ?? (running
        ? OperationState.running
        : unknown
          ? OperationState.unknown
          : isError
            ? OperationState.failed
            : OperationState.succeeded);
      const effect = explicit?.effect ?? (running ? "started" : unknown ? "unknown" : isError ? "completed" : "completed");
      const saved = await store.writeAsync(() => {
        const current = store.findInvocationSummary(context.owner_id, context.transport_instance_id, requestId);
        if (running && current?.finished_at) {
          return store.updateInvocation({
            ownerId: context.owner_id,
            transportInstanceId: context.transport_instance_id,
            requestId,
            resultRef: resultRef ?? current.result_ref,
            result,
            responded: true,
          });
        }
        return store.updateInvocation({
          ownerId: context.owner_id,
          transportInstanceId: context.transport_instance_id,
          requestId,
          state,
          effect,
          resultRef,
          result,
          finished: !running,
          responded: true,
        });
      });
      return {
        replay: false,
        result,
        invocation_id: saved.id,
        operation_id: saved.operation_id,
        state: saved.state,
        effect: saved.effect,
        result_ref: saved.result_ref,
      };
    } catch (error) {
      throw new InvocationPersistenceError(operationId, error);
    }
  });
}

/** A retry may use another external conversation, but never another Task or workspace member. */
function assertReplayScope(store: SessionStore, existing: InvocationSummary, context: InvocationContext): void {
  const member = existing.owner_id === context.owner_id
    && existing.session_id === context.session_id && existing.member_id === context.member_id
    && (existing.task_id ?? null) === (context.task_id ?? null)
    ? store.findMember(context.session_id, context.member_id) : null;
  if (!member || member.workspace_id !== context.workspace_id
    || existing.node_id !== member.node_id || existing.workspace_root !== member.root) {
    throw Object.assign(new Error("OPERATION_RETRY_SCOPE_MISMATCH: Use the original Task and workspace member to retrieve this operation."), {
      code: "OPERATION_RETRY_SCOPE_MISMATCH", effect: "not_started", retryHint: "fix_input",
      details: { operation_id: existing.operation_id, task_id: existing.task_id },
    });
  }
}

async function replayInvocation<T>(store: SessionStore, existing: InvocationSummary): Promise<RecordedInvocation<T>> {
  const ready = existing.result_ready ? existing
    : await waitForInvocationResult(store, existing.owner_id, existing.transport_instance_id, existing.request_id) ?? existing;
  const receipt = ready.result_ready
    ? store.findInvocationResult(ready.owner_id,ready.transport_instance_id,ready.request_id) : null;
  const saved = receipt ?? ready;
  return {replay: true, ...(receipt?.result_json !== null && receipt?.result_json !== undefined ? {result: JSON.parse(receipt.result_json) as T} : {}),
    invocation_id: saved.id, operation_id: saved.operation_id, state: saved.state,
    effect: saved.effect, result_ref: saved.result_ref};
}

async function waitForInvocationResult(
  store: SessionStore,
  ownerId: string,
  transportInstanceId: string,
  requestId: string,
): Promise<InvocationSummary | null> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const current = store.findInvocationSummary(ownerId, transportInstanceId, requestId);
    // 进程终态可能先于请求回执保存；重复请求等待实际回执，不能只看执行状态。
    if (!current || current.result_ready) return current;
    if (Date.now() >= deadline) return current;
    await delay(50);
  }
}

export function inheritedEnvelope(context: InvocationContext): InvocationContext {
  return { ...context };
}

export function lookupStatus(store: SessionStore, ownerId: string, operationId: string): InvocationStatus {
  const invocation = store.findInvocationSummaryByOperation(ownerId, operationId);
  if (!invocation) throw new Error("OPERATION_NOT_FOUND");
  return {
    operation_id: operationId,
    state: invocation.state,
    effect: invocation.effect,
    result_ref: invocation.result_ref,
  };
}

export interface InvocationStatus {
  operation_id: string;
  state: OperationState;
  effect: "not_started" | "started" | "partial" | "completed" | "unknown";
  result_ref: string | null;
}

function operationIdFrom(context: InvocationContext, requestId: string): string {
  return `op_${createHash("sha256")
    .update(stableJson([
      context.owner_id,
      context.transport_instance_id,
      requestId,
      context.tool_name,
    ]))
    .digest("hex")
    .slice(0, 32)}`;
}

function normalizeJson(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => normalizeJson(item));
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      result[key] = normalizeJson((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  if (value === undefined) return null;
  throw new Error(`UNSERIALIZABLE_INVOCATION_INPUT: ${typeof value}`);
}
