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

export function errorFromEnvelope(envelope: InvocationEnvelope<unknown>, cause?: unknown): Error {
  return Object.assign(new Error(envelope.message ?? "Tool failed.", cause === undefined ? undefined : {cause}), {
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
    && (error.code === "EXECUTION_CONFLICT" || error.code === "NODE_ADMISSION_PAUSED");
}

const NOT_STARTED = new Set([
  "EXECUTION_CONFLICT", "NODE_ADMISSION_PAUSED", "ACCESS_DENIED", "WORKSPACE_NOT_FOUND", "WORKSPACE_MISMATCH",
  "TASK_SESSION_MISMATCH", "TASK_NOT_FOUND", "INVALID_TASK", "INVALID_ARGUMENT", "OPERATION_KEY_INVALID",
  "REQUEST_ID_REUSED", "ENOENT", "EACCES", "EPERM", "EINVAL", "ZOD_ERROR",
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
  const explicit=typeof value.effect==="string"&&["not_started","started","partial","completed","unknown"].includes(value.effect)
    ? value.effect as InvocationEffect:undefined;
  let effect:InvocationEffect;
  if(explicit)effect=explicit;
  else if(NOT_STARTED.has(code))effect="not_started";
  else if(UNKNOWN.has(code)||options.forwarded)effect="unknown";
  else if(!options.sideEffecting)effect="not_started";
  else if(options.effectStarted)effect="partial";
  else effect="not_started";
  const state=effect==="unknown"?OperationState.unknown:OperationState.failed;
  const retryHint:RetryHint=effect==="unknown"?"query_original"
    : effect==="not_started"&&(code==="EXECUTION_CONFLICT"||code==="NODE_ADMISSION_PAUSED")?"retry_later"
      : effect==="not_started"?"fix_input"
        : "do_not_retry";
  return {code,state,effect,retryHint,message,...(value.details!==undefined?{details:value.details}:{})};
}

export function toolErrorResult(error: unknown, extras: { operationId?: string | null; ownerNodeId?: string | null; sideEffecting?: boolean; forwarded?: boolean }={}) {
  const outcome=classifyError(error,{sideEffecting:extras.sideEffecting??false,forwarded:extras.forwarded,effectStarted:extras.sideEffecting??false});
  return {
    isError:true,
    content:[{type:"text" as const,text:errorRecoveryText(outcome,extras.operationId)}],
    structuredContent:{
      error_code:outcome.code,effect:outcome.effect,retry_hint:outcome.retryHint,
      ...(extras.operationId?{operation_id:extras.operationId}:{}),
      ...(extras.ownerNodeId?{owner_node_id:extras.ownerNodeId}:{}),
      ...(outcome.details!==undefined?{details:outcome.details}:{}),
    },
  };
}

const RECOVERY_SUFFIX=/\n\[QuayMesh recovery: (?:error_code=[A-Z][A-Z0-9_]{0,63}; )?effect=(?:not_started|started|partial|completed|unknown); retry_hint=(?:fix_input|retry_same_key|query_original|do_not_retry|retry_later)(?:; operation_id=[A-Za-z0-9][A-Za-z0-9_.:%~-]{0,255})?\]$/u;

function errorRecoveryText(outcome:ErrorOutcome,operationId?:string|null):string {
  let message=outcome.message;
  // 只替换本模块生成的尾注，不复制 details，也不从错误文本推导操作身份。
  while(RECOVERY_SUFFIX.test(message))message=message.replace(RECOVERY_SUFFIX,"");
  const fields=[
    ...(/^[A-Z][A-Z0-9_]{0,63}$/u.test(outcome.code)?[`error_code=${outcome.code}`]:[]),
    `effect=${outcome.effect}`,`retry_hint=${outcome.retryHint}`,
    ...(operationId&&/^[A-Za-z0-9][A-Za-z0-9_.:%~-]{0,255}$/u.test(operationId)?[`operation_id=${operationId}`]:[]),
  ];
  return `${message}\n[QuayMesh recovery: ${fields.join("; ")}]`;
}

export function classifyToolResultError(result: unknown, options:{sideEffecting:boolean;forwarded?:boolean}): ErrorOutcome {
  const value=result&&typeof result==="object"?result as Record<string,unknown>:{};
  const structured=value.structuredContent&&typeof value.structuredContent==="object"?value.structuredContent as Record<string,unknown>:{};
  const text=Array.isArray(value.content)?value.content.flatMap(item=>item&&typeof item==="object"&&typeof (item as Record<string,unknown>).text==="string"?[(item as Record<string,unknown>).text as string]:[]).join("\n"):"Tool returned an error.";
  const code=typeof structured.error_code==="string"?structured.error_code:errorCode(new Error(text));
  const explicit=typeof structured.effect==="string"&&["not_started","started","partial","completed","unknown"].includes(structured.effect)
    ? structured.effect as InvocationEffect:undefined;
  const source=Object.assign(new Error(text||code),{code,effect:explicit,details:structured.details});
  return classifyError(source,{sideEffecting:options.sideEffecting,forwarded:options.forwarded,effectStarted:options.sideEffecting});
}
