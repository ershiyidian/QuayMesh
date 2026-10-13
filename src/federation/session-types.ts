import type { Snapshot } from "../session/types.js";

export interface SessionFeedRequest {
  kind: "subscribe" | "revision" | "snapshot" | "unsubscribe" | "finalize" | "archive";
  session_id: string;
  member_id: string;
  known_revision?: number;
  task_id?: string;
  owner_id?: string;
  status?: "completed" | "failed" | "cancelled" | "handed_off";
  summary?: string;
}

export interface SessionFeedUpdate {
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
  invocation_id: string;
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
