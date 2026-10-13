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

const NOT_STARTED = new Set([
  "EXECUTION_CONFLICT", "NODE_ADMISSION_PAUSED", "ACCESS_DENIED", "WORKSPACE_NOT_FOUND", "WORKSPACE_MISMATCH",
  "TASK_SESSION_MISMATCH", "TASK_NOT_FOUND", "INVALID_TASK", "INVALID_ARGUMENT", "OPERATION_KEY_INVALID",
  "REQUEST_ID_REUSED", "ENOENT", "EACCES", "EPERM", "EINVAL", "ZOD_ERROR",
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
    : code==="EXECUTION_CONFLICT"||code==="NODE_ADMISSION_PAUSED"?"retry_later"
      : effect==="not_started"?"fix_input"
        : "do_not_retry";
  return {code,state,effect,retryHint,message,...(value.details!==undefined?{details:value.details}:{})};
}

export function toolErrorResult(error: unknown, extras: { operationId?: string | null; ownerNodeId?: string | null; sideEffecting?: boolean; forwarded?: boolean }={}) {
  const outcome=classifyError(error,{sideEffecting:extras.sideEffecting??false,forwarded:extras.forwarded,effectStarted:extras.sideEffecting??false});
  return {
    isError:true,
    content:[{type:"text" as const,text:outcome.message}],
    structuredContent:{
      error_code:outcome.code,effect:outcome.effect,retry_hint:outcome.retryHint,
      ...(extras.operationId?{operation_id:extras.operationId}:{}),
      ...(extras.ownerNodeId?{owner_node_id:extras.ownerNodeId}:{}),
      ...(outcome.details!==undefined?{details:outcome.details}:{}),
    },
  };
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
