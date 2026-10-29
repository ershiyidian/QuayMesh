import { messageDraftError } from "./message-state.js";

export interface PendingTaskMessage {
  taskId: string;
  key: string;
  body: string;
}

/** Optional UI recovery only; these methods never establish that a message was saved by the server. */
export interface PendingMessageState {
  load(taskId: string): PendingTaskMessage | null;
  save(pending: PendingTaskMessage): boolean;
  clear(pending: PendingTaskMessage): boolean;
}

export const PENDING_MESSAGE_NAMESPACE = "quaymesh.taskMessagePending";
// An application budget, not a claim about the host's storage limit. Keep all other widget fields intact.
const MAX_WIDGET_STATE_BYTES = 64 * 1024;
type RecordValue = Record<string, unknown>;

/** The caller injects the optional host capability; no browser storage or network is used here. */
export function createPendingMessageState(getHost: () => unknown): PendingMessageState {
  function access() {
    const host = getHost();
    if (!record(host) || typeof host.setWidgetState !== "function") return null;
    const state = host.widgetState ?? {};
    if (!record(state)) return null;
    const privateContent = state.privateContent ?? {};
    if (!record(privateContent)) return null;
    return { host, set: host.setWidgetState, state, privateContent };
  }

  function write(current: NonNullable<ReturnType<typeof access>>, privateContent: RecordValue): boolean {
    const next = { ...current.state, privateContent };
    const serialized = JSON.stringify(next);
    if (typeof serialized !== "string" || new TextEncoder().encode(serialized).byteLength > MAX_WIDGET_STATE_BYTES) return false;
    // The documented host API is synchronous. Preserve its receiver and do not infer business success from it.
    Reflect.apply(current.set, current.host, [next]);
    return true;
  }

  return {
    load(taskId) {
      try {
        const current = access();
        if (!current) return null;
        const pending = readPending(current.privateContent[PENDING_MESSAGE_NAMESPACE]);
        return pending?.taskId === taskId ? pending : null;
      } catch { return null; }
    },
    save(pending) {
      try {
        const value = readPending({ version: 1, ...pending }), current = access();
        if (!value || !current) return false;
        const saved = current.privateContent[PENDING_MESSAGE_NAMESPACE];
        if (saved !== undefined) {
          const previous = readPending(saved);
          if (!previous || previous.taskId !== value.taskId) return false;
        }
        return write(current, { ...current.privateContent, [PENDING_MESSAGE_NAMESPACE]: { version: 1, ...value } });
      } catch { return false; }
    },
    clear(pending) {
      try {
        if (!readPending({ version: 1, ...pending })) return false;
        const current = access();
        if (!current) return false;
        // A missing or stale snapshot is not permission to replace another iframe's newer state.
        // This is a best-effort match against the visible snapshot; the host API provides no CAS.
        const value = readPending(current.privateContent[PENDING_MESSAGE_NAMESPACE]);
        if (!value || value.taskId !== pending.taskId || value.key !== pending.key || value.body !== pending.body) return false;
        const privateContent = { ...current.privateContent };
        delete privateContent[PENDING_MESSAGE_NAMESPACE];
        return write(current, privateContent);
      } catch { return false; }
    },
  };
}

function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && Object.prototype.toString.call(value) === "[object Object]";
}

function readPending(value: unknown): PendingTaskMessage | null {
  if (!record(value) || value.version !== 1 || typeof value.taskId !== "string" || !value.taskId.trim()
    || value.taskId.length > 256 || typeof value.key !== "string" || !value.key.trim() || value.key.length > 128
    || typeof value.body !== "string" || value.body.length > 16_384 || messageDraftError(value.body)) return null;
  return { taskId: value.taskId, key: value.key, body: value.body };
}
