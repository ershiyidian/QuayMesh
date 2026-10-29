import type { Snapshot } from "../session/types.js";

export interface SessionFeedRequest {
  kind: "subscribe" | "revision" | "snapshot" | "unsubscribe" | "finalize" | "archive";
  session_id: string;
  member_id: string;
  known_revision?: number;
  // Older peers validate command snapshots strictly; omit added identity fields unless requested.
  command_identity?: boolean;
  /** Independent of command identity: old peers have strict nested file readers. */
  file_recorded_at?: boolean;
  task_id?: string;
  owner_id?: string;
  status?: "completed" | "failed" | "cancelled" | "handed_off";
  summary?: string;
}

export interface SessionFeedUpdate {
  observation?: import("../execution-observation.js").ExecutionObservation;
  owner_id: string;
  node_id: string;
  session_id: string;
  member_id: string;
  task_id?: string;
  revision: number;
  observed_at: string;
  snapshot?: Snapshot;
}

export interface TrustedInvocationEnvelope {
  /** Explicit Task selection independent of the legacy conversation/currentTask adapter. */
  task_binding_version?: 1;
  canonical_conversation_id?: string | null;
  invocation_id: string;
  operation_id?: string;
  owner_id: string;
  conversation_id: string | null;
  transport_instance_id: string;
  request_id: string;
  session_id?: string;
  session_title?: string;
  task_id?: string;
  task_created_at?: string;
  task_source_id?: string;
  task_title?: string;
  member_id?: string;
  workspace_id?: string;
  actor: "model" | "agent" | "app" | "system";
}

/** Private peer protocol guard. Unknown versions never fall through to legacy selection. */
export function assertTaskBindingEnvelope(value: unknown): void {
  if (!value || typeof value !== "object") return;
  const envelope = value as Record<string, unknown>;
  if (envelope.task_binding_version === undefined) return;
  const failure = (code: string) => Object.assign(new Error(code), { code, effect: "not_started", retryHint: "fix_input" });
  if (envelope.task_binding_version !== 1) throw failure("TASK_BINDING_VERSION_UNSUPPORTED");
  if (typeof envelope.task_id !== "string" || !envelope.task_id
    || typeof envelope.session_id !== "string" || !envelope.session_id
    || !Object.hasOwn(envelope, "canonical_conversation_id")
    || envelope.canonical_conversation_id !== null && typeof envelope.canonical_conversation_id !== "string") {
    throw failure("TASK_BINDING_SCOPE_REQUIRED");
  }
}
