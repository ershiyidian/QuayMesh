import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { OperationState, type InvocationContext } from "./types.js";
import type { SessionStore } from "./store.js";
import { classifyError, type InvocationEffect } from "./outcome.js";

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
  conversation_id?: string | null;
  actor?: "model" | "agent" | "app" | "system";
  tool_name?: string;
}

export interface InvocationOperation<T> {
  invoke(): Promise<T>;
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
  const existing = operationKey
    ? store.findKeyedInvocation(context.owner_id, context.session_id, context.member_id, operationKey)
    : store.findInvocation(context.owner_id, context.transport_instance_id, requestId);
  if (existing) {
    context.operation_id = existing.operation_id ?? undefined;
    if (existing.tool_name !== context.tool_name || existing.arguments_json !== argumentsJson) {
      throw new Error("REQUEST_ID_REUSED");
    }
    if (existing.result_json !== null) {
      return {
        replay: true,
        result: JSON.parse(existing.result_json) as T,
        invocation_id: existing.id,
        operation_id: existing.operation_id,
        state: existing.state,
        effect: existing.effect,
        result_ref: existing.result_ref,
      };
    }
    const completed = await waitForInvocationResult(store, existing.owner_id, existing.transport_instance_id, existing.request_id);
    if (completed?.result_json !== null && completed?.result_json !== undefined) {
      return {
        replay: true,
        result: JSON.parse(completed.result_json) as T,
        invocation_id: completed.id,
        operation_id: completed.operation_id,
        state: completed.state,
        effect: completed.effect,
        result_ref: completed.result_ref,
      };
    }
    return {
      replay: true,
      invocation_id: existing.id,
      operation_id: existing.operation_id,
      state: existing.state,
      effect: existing.effect,
      result_ref: existing.result_ref,
    };
  }

  const reserved = store.reserveInvocation({
    id: context.invocation_id,
    ownerId: context.owner_id,
    transportInstanceId: context.transport_instance_id,
    requestId,
    sessionId: context.session_id,
    memberId: context.member_id,
    toolName: context.tool_name,
    argumentsJson,
    operationKey,
  });
  if (reserved.id !== context.invocation_id) return executeRecorded(store, context, input, operation);
  const operationId = reserved.operation_id ?? operationIdFrom(context, requestId);
  context.operation_id = operationId;
  store.updateInvocation({
    ownerId: context.owner_id,
    transportInstanceId: context.transport_instance_id,
    requestId,
    operationId,
  });

  try {
    await operation.beforeEffect?.();
  } catch (error) {
    const cancelled = store.findInvocation(context.owner_id, context.transport_instance_id, requestId);
    if (cancelled?.state === OperationState.cancelled && cancelled.result_json !== null) {
      return { replay: true, result: JSON.parse(cancelled.result_json) as T,
        invocation_id: cancelled.id, operation_id: cancelled.operation_id,
        state: cancelled.state, effect: cancelled.effect, result_ref: cancelled.result_ref };
    }
    const message = error instanceof Error ? error.message : String(error);
    store.updateInvocation({
      ownerId: context.owner_id,
      transportInstanceId: context.transport_instance_id,
      requestId,
      state: OperationState.failed,
      effect: "not_started",
      result: { error: message },
      finished: true,
      responded: true,
    });
    throw error;
  }
  const cancelled = store.findInvocation(context.owner_id, context.transport_instance_id, requestId);
  if (cancelled?.state === OperationState.cancelled && cancelled.result_json !== null) {
    return { replay: true, result: JSON.parse(cancelled.result_json) as T,
      invocation_id: cancelled.id, operation_id: cancelled.operation_id,
      state: cancelled.state, effect: cancelled.effect, result_ref: cancelled.result_ref };
  }
  store.updateInvocation({
    ownerId: context.owner_id,
    transportInstanceId: context.transport_instance_id,
    requestId,
    state: OperationState.running,
    effect: "started",
  });

  return requestContextStorage.run(context, async () => {
    try {
      const result = await operation.invoke();
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
      const current = store.findInvocation(context.owner_id, context.transport_instance_id, requestId);
      if (running && current?.finished_at) {
        store.updateInvocation({
          ownerId: context.owner_id,
          transportInstanceId: context.transport_instance_id,
          requestId,
          resultRef: resultRef ?? current.result_ref,
          result,
        });
      } else store.updateInvocation({
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
      const saved = store.findInvocation(context.owner_id, context.transport_instance_id, requestId)!;
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
      const message = error instanceof Error ? error.message : String(error);
      const outcome=classifyError(error,{sideEffecting:operation.sideEffecting??false,forwarded:operation.forwarded,effectStarted:true});
      store.updateInvocation({
        ownerId: context.owner_id,
        transportInstanceId: context.transport_instance_id,
        requestId,
        state: outcome.state,
        effect: outcome.effect,
        result: { error: message,error_code:outcome.code,retry_hint:outcome.retryHint },
        finished: true,
        responded: true,
      });
      throw error;
    }
  });
}

async function waitForInvocationResult(
  store: SessionStore,
  ownerId: string,
  transportInstanceId: string,
  requestId: string,
): Promise<ReturnType<SessionStore["findInvocation"]>> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const current = store.findInvocation(ownerId, transportInstanceId, requestId);
    // 进程终态可能先于请求回执保存；重复请求等待实际回执，不能只看执行状态。
    if (!current || current.result_json !== null) return current;
    if (Date.now() >= deadline) return current;
    await delay(50);
  }
}

export function inheritedEnvelope(context: InvocationContext): InvocationContext {
  return { ...context };
}

export function lookupStatus(store: SessionStore, ownerId: string, operationId: string): InvocationStatus {
  const invocation = store.findInvocationByOperation(ownerId, operationId);
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
