export const LOCAL_USER_API_PROTOCOL = "quaymesh.local-user.v1" as const;
export const LOCAL_USER_API_MAX_FRAME_BYTES = 65_536;
export const LOCAL_USER_API_METHODS = ["status.get", "tasks.list", "tasks.get", "events.read", "events.watch",
  "peer.send", "peer.receive", "peer.ack"] as const;
export type LocalUserApiMethod = typeof LOCAL_USER_API_METHODS[number];
export interface LocalUserApiRequest {
  protocol: typeof LOCAL_USER_API_PROTOCOL; id: string; credential: string;
  method: LocalUserApiMethod; params: Record<string, unknown>;
}
export type LocalUserApiResponse = {protocol: typeof LOCAL_USER_API_PROTOCOL; id: string; ok: true; result: unknown; done: boolean}
  | {protocol: typeof LOCAL_USER_API_PROTOCOL; id: string; ok: false; error: {code: string; message: string}; done: true};
export const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
export const identifier = (value: unknown): value is string => typeof value === "string" && value.length > 0
  && value.length <= 256 && !/[\x00-\x20\x7f]/.test(value);
export const localApiError = (code: string) => Object.assign(new Error(code), {code, effect: "not_started" as const});
const fields: Record<LocalUserApiMethod, readonly string[]> = {
  "status.get": [], "tasks.list": ["cursor", "limit"], "tasks.get": ["task_id"],
  "events.read": ["task_id", "cursor", "limit"], "events.watch": ["task_id", "cursor", "limit"],
  "peer.send": ["target_task_id", "message_key", "body", "reply_to"],
  "peer.receive": ["request_key", "after_sequence", "limit"], "peer.ack": ["delivery_id", "message_ids"],
};

/** Reject identity fields and unknown methods rather than forwarding arbitrary paths. */
export function localApiParams(method: unknown, value: unknown): {method: LocalUserApiMethod; params: Record<string, unknown>} {
  if (typeof method !== "string" || !Object.hasOwn(fields, method) || !object(value)) throw localApiError("LOCAL_API_INVALID_REQUEST");
  const name = method as LocalUserApiMethod;
  if (Object.keys(value).some(key => !fields[name].includes(key))) throw localApiError("LOCAL_API_INVALID_REQUEST");
  const required = name === "tasks.get" || name.startsWith("events.") ? ["task_id"]
    : name === "peer.send" ? ["target_task_id", "message_key"] : name === "peer.receive" ? ["request_key"]
    : name === "peer.ack" ? ["delivery_id"] : [];
  if (required.some(key => !identifier(value[key]))) throw localApiError("LOCAL_API_INVALID_REQUEST");
  if (value.cursor !== undefined && (typeof value.cursor !== "string" || value.cursor.length > 2048)) throw localApiError("LOCAL_API_INVALID_REQUEST");
  if (value.limit !== undefined && (!Number.isSafeInteger(value.limit) || Number(value.limit) < 1
    || Number(value.limit) > (name === "tasks.list" ? 50 : name === "peer.receive" ? 8 : 100))) throw localApiError("LOCAL_API_INVALID_REQUEST");
  if (value.after_sequence !== undefined && (!Number.isSafeInteger(value.after_sequence) || Number(value.after_sequence) < 0)) throw localApiError("LOCAL_API_INVALID_REQUEST");
  if (name === "peer.send" && (typeof value.body !== "string" || !value.body.trim() || Buffer.byteLength(value.body) > 16_384
    || value.reply_to !== undefined && !identifier(value.reply_to))) throw localApiError("LOCAL_API_INVALID_REQUEST");
  if (name === "peer.ack" && (!Array.isArray(value.message_ids) || value.message_ids.length < 1 || value.message_ids.length > 8
    || value.message_ids.some(id => !identifier(id)))) throw localApiError("LOCAL_API_INVALID_REQUEST");
  return {method: name, params: value};
}

export function parseLocalApiRequest(value: unknown): LocalUserApiRequest {
  if (!object(value) || Object.keys(value).some(key => !["protocol", "id", "credential", "method", "params"].includes(key))
    || value.protocol !== LOCAL_USER_API_PROTOCOL || !identifier(value.id)
    || typeof value.credential !== "string" || !/^qml1_[A-Za-z0-9_-]{43}$/.test(value.credential)) throw localApiError("LOCAL_API_INVALID_REQUEST");
  return {protocol: LOCAL_USER_API_PROTOCOL, id: value.id, credential: value.credential, ...localApiParams(value.method, value.params)};
}

/** Never expose database errors, internal URLs or credentials in a client error. */
export function localApiFailure(id: string, error: unknown): LocalUserApiResponse {
  const raw = error && typeof error === "object" ? (error as {code?: unknown}).code : undefined;
  const code = typeof raw === "string" && /^(?:LOCAL_API_|TASK_ACCESS_|TASK_PEER_)[A-Z0-9_]{1,80}$/.test(raw) ? raw : "LOCAL_API_UNAVAILABLE";
  return {protocol: LOCAL_USER_API_PROTOCOL, id, ok: false, error: {code, message: code}, done: true};
}
