import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { OperationState } from "./types.js";

export type InvocationEffect = "not_started" | "started" | "partial" | "completed" | "unknown";
export type RetryHint = "fix_input" | "retry_same_key" | "query_original" | "do_not_retry" | "retry_later";

export interface ErrorOutcome {
  code: string;
  state: OperationState.failed | OperationState.unknown;
  effect: InvocationEffect;
  retryHint: RetryHint;
  message: string;
  details?: unknown;
}

export interface InvocationEnvelope<T> {
  kind: "result" | "error";
  value?: T;
  message?: string;
  errorCode?: string;
  errorDetails?: unknown;
  effect?: InvocationEffect;
  retryHint?: string;
}

export function errorEnvelope(error: unknown, options: {sideEffecting: boolean; forwarded?: boolean; effectStarted?: boolean}): InvocationEnvelope<never> {
  const outcome = classifyError(error, options);
  return {kind: "error", message: outcome.message, errorCode: outcome.code,
    effect: outcome.effect, retryHint: outcome.retryHint,
    ...(outcome.details !== undefined ? {errorDetails: outcome.details} : {})};
}

// 只有持久记录和重放完成授权后，才允许把该操作身份带到错误回包。
export class RecordedInvocationError extends Error {
  constructor(message: string, readonly operationId: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export function errorFromEnvelope(envelope: InvocationEnvelope<unknown>, cause?: unknown, operationId?: string | null): Error {
  const message = envelope.message ?? "Tool failed.", options = cause === undefined ? undefined : {cause};
  return Object.assign(operationId ? new RecordedInvocationError(message, operationId, options) : new Error(message, options), {
    code: envelope.errorCode, details: envelope.errorDetails, effect: envelope.effect, retryHint: envelope.retryHint,
  });
}

/** 仅明确尚未执行的暂时性准入拒绝允许再次尝试。 */
export function retryableAdmission(row: {state: OperationState; effect: InvocationEffect; result_json: string | null}): boolean {
  if (row.state !== OperationState.failed || row.effect !== "not_started" || !row.result_json) return false;
  const saved = JSON.parse(row.result_json) as InvocationEnvelope<ReturnType<typeof toolErrorResult>>;
  const error = saved.kind === "error"
    ? {code: saved.errorCode, effect: saved.effect, hint: saved.retryHint}
    : saved.kind === "result" && saved.value?.isError === true
      ? {code: saved.value.structuredContent?.error_code, effect: saved.value.structuredContent?.effect,
          hint: saved.value.structuredContent?.retry_hint}
      : null;
  return error?.effect === "not_started" && error.hint === "retry_later"
    && (error.code === "EXECUTION_CONFLICT" || error.code === "NODE_ADMISSION_PAUSED" || error.code === "NODE_UNAVAILABLE" || error.code === "PEER_BUSY");
}

const NOT_STARTED = new Set([
  "NODE_ADMISSION_PAUSED", "ACCESS_DENIED", "WORKSPACE_NOT_FOUND", "WORKSPACE_MISMATCH",
  "TASK_SESSION_MISMATCH", "TASK_NOT_FOUND", "INVALID_TASK", "INVALID_ARGUMENT", "OPERATION_KEY_INVALID",
  "REQUEST_ID_REUSED", "ZOD_ERROR",
  "OPERATION_RETRY_SCOPE_MISMATCH", "OPERATION_RETRY_NOT_ALLOWED", "OPERATION_RETRY_SUPERSEDED", "OPERATION_ID_MISMATCH",
]);
const UNKNOWN = new Set([
  "REQUEST_TIMEOUT", "RPC_INTERRUPTED", "NODE_UNAVAILABLE", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT",
  "ECONNABORTED", "EPIPE", "ENOTFOUND", "PROCESS_RECONCILIATION_REQUIRED",
]);

export function errorCode(error: unknown): string {
  if (error && typeof error === "object") {
    const value=error as Record<string,unknown>;
    if(typeof value.code==="string"&&value.code)return value.code;
    if(value.name==="ZodError")return "ZOD_ERROR";
  }
  const message=error instanceof Error?error.message:String(error);
  const prefix=/^([A-Z][A-Z0-9_]{2,63})(?::|\b)/u.exec(message)?.[1];
  return prefix??"TOOL_EXECUTION_ERROR";
}

export function classifyError(error: unknown, options: { sideEffecting: boolean; forwarded?: boolean; effectStarted?: boolean }): ErrorOutcome {
  const value=error&&typeof error==="object"?error as Record<string,unknown>:{};
  const code=errorCode(error);
  const message=error instanceof Error?error.message:String(error);
  const explicit=invocationEffect(value.effect);
  let effect:InvocationEffect;
  if(explicit)effect=explicit;
  // Generic OS codes and EXECUTION_CONFLICT can occur after a write or provider
  // dispatch. Resource admission supplies an explicit effect at its boundary.
  else if(NOT_STARTED.has(code))effect="not_started";
  else if(UNKNOWN.has(code)||options.forwarded)effect="unknown";
  else if(!options.sideEffecting)effect="not_started";
  else if(options.effectStarted)effect="partial";
  else effect="not_started";
  const state=effect==="unknown"?OperationState.unknown:OperationState.failed;
  const retryHint:RetryHint=effect==="unknown"?"query_original"
    : effect==="not_started"&&(code==="EXECUTION_CONFLICT"||code==="NODE_ADMISSION_PAUSED"||code==="NODE_UNAVAILABLE"||code==="PEER_BUSY")?"retry_later"
      : effect==="not_started"&&["fix_input","retry_same_key","do_not_retry","retry_later"].includes(String(value.retryHint))?value.retryHint as RetryHint
      : effect==="not_started"?"fix_input"
        : "do_not_retry";
  return {code,state,effect,retryHint,message,...(value.details!==undefined?{details:value.details}:{})};
}

export function toolErrorResult(error: unknown, extras: { operationId?: string | null; ownerNodeId?: string | null; sideEffecting?: boolean; forwarded?: boolean }={}) {
  const outcome=classifyError(error,{sideEffecting:extras.sideEffecting??false,forwarded:extras.forwarded,effectStarted:extras.sideEffecting??false});
  const operationId=extras.operationId??(error instanceof RecordedInvocationError?error.operationId:undefined);
  return {
    isError:true,
    content:[{type:"text" as const,text:errorRecoveryText(outcome,operationId)}],
    structuredContent:{
      error_code:outcome.code,effect:outcome.effect,retry_hint:outcome.retryHint,
      ...(operationId?{operation_id:operationId}:{}),
      ...(extras.ownerNodeId?{owner_node_id:extras.ownerNodeId}:{}),
      ...(outcome.details!==undefined?{details:outcome.details}:{}),
    },
  };
}

export function recordedToolErrorResult(result: CallToolResult, operationId: string | undefined,
  options: {sideEffecting: boolean; forwarded?: boolean}): CallToolResult {
  if (!result.isError || !operationId) return result;
  const outcome = classifyToolResultError(result, options);
  const content = result.content.map(item => item.type === "text" ? {...item, text: stripRecoveryText(item.text)} : item);
  let lastText = content.length - 1;
  while (lastText >= 0 && content[lastText].type !== "text") lastText--;
  if (lastText < 0) content.push({type: "text", text: errorRecoveryText(outcome, operationId)});
  else {
    const item = content[lastText];
    if (item.type === "text") content[lastText] = {...item,
      text: errorRecoveryText({...outcome, message: item.text}, operationId)};
  }
  const metadata = record(result._meta), quaymesh = record(metadata.quaymesh), legacy = record(quaymesh.error);
  const legacyError = outcome.code === "EXECUTION_CONFLICT" ? {
    ...legacy, code: outcome.code, effect: outcome.effect,
    ...(outcome.details === undefined ? {} : {details: outcome.details}),
    ...(outcome.effect === "unknown" ? {started: undefined} : {started: outcome.effect !== "not_started"}),
  } : undefined;
  return {...result, content, structuredContent: {...result.structuredContent,
    error_code: outcome.code, effect: outcome.effect, retry_hint: outcome.retryHint, operation_id: operationId},
    ...(legacyError ? {_meta: {...metadata, quaymesh: {...quaymesh, error: legacyError}}} : {})};
}

const RECOVERY_SUFFIX=/\n\[QuayMesh recovery: (?:error_code=[A-Z][A-Z0-9_]{0,63}; )?effect=(?:not_started|started|partial|completed|unknown); retry_hint=(?:fix_input|retry_same_key|query_original|do_not_retry|retry_later)(?:; operation_id=[A-Za-z0-9][A-Za-z0-9_.:%~-]{0,255})?\]$/u;

function errorRecoveryText(outcome:ErrorOutcome,operationId?:string|null):string {
  const message=stripRecoveryText(outcome.message);
  const fields=[
    ...(/^[A-Z][A-Z0-9_]{0,63}$/u.test(outcome.code)?[`error_code=${outcome.code}`]:[]),
    `effect=${outcome.effect}`,`retry_hint=${outcome.retryHint}`,
    ...(operationId&&/^[A-Za-z0-9][A-Za-z0-9_.:%~-]{0,255}$/u.test(operationId)?[`operation_id=${operationId}`]:[]),
  ];
  return `${message}\n[QuayMesh recovery: ${fields.join("; ")}]`;
}

function stripRecoveryText(text: string): string {
  // 只替换本模块生成的尾注，不复制 details，也不从错误文本推导操作身份。
  while (RECOVERY_SUFFIX.test(text)) text = text.replace(RECOVERY_SUFFIX, "");
  return text;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function invocationEffect(value: unknown): InvocationEffect | undefined {
  return typeof value === "string" && ["not_started", "started", "partial", "completed", "unknown"].includes(value)
    ? value as InvocationEffect : undefined;
}

export function classifyToolResultError(result: unknown, options: {sideEffecting: boolean; forwarded?: boolean}): ErrorOutcome {
  const value = record(result), structured = record(value.structuredContent);
  const text = Array.isArray(value.content) ? value.content.flatMap(item =>
    typeof record(item).text === "string" ? [record(item).text as string] : []).join("\n") : "Tool returned an error.";
  // Current error fields take priority. Older workers retain the same error
  // evidence in a nested body or QuayMesh metadata instead of the success schema.
  const legacy = [record(structured.error), record(record(record(value._meta).quaymesh).error)];
  const hasCode = (source: Record<string, unknown>) => typeof source.code === "string" && source.code.length > 0;
  const legacyCode = legacy.find(hasCode)?.code as string | undefined;
  const code = typeof structured.error_code === "string" && structured.error_code.length > 0
    ? structured.error_code : legacyCode ?? errorCode(new Error(text));
  // Evidence from a different error identity must never turn a transport failure
  // into a no-effect admission denial. A canonical explicit phase still wins.
  const matching = legacy.filter(source => hasCode(source) && source.code === code);
  const explicit = invocationEffect(structured.effect) ?? matching.map(source =>
    invocationEffect(source.effect) ?? (source.started === false ? "not_started" : source.started === true ? "started" : undefined))
    .find(effect => effect !== undefined);
  const retryHint = structured.retry_hint ?? matching.map(source => source.retry_hint ?? source.retryHint)
    .find(value => value !== undefined);
  const details = structured.details !== undefined ? structured.details : matching.find(source => source.details !== undefined)?.details;
  const source = Object.assign(new Error(text || code), {code, effect: explicit, retryHint, details});
  return classifyError(source, {sideEffecting: options.sideEffecting, forwarded: options.forwarded, effectStarted: options.sideEffecting});
}
