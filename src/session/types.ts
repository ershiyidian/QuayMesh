export type SessionId = string;
export type OperationId = string;
export type WorkspaceId = string;
export type NodeId = string;
export type AgentId = string;
export type TaskId = string;

export enum OperationState {
  accepted = "accepted",
  queued = "queued",
  running = "running",
  succeeded = "succeeded",
  failed = "failed",
  cancelled = "cancelled",
  unknown = "unknown",
}

export enum ExecutionState {
  active = "active",
  idle = "idle",
  interrupted = "interrupted",
  failed = "failed",
}

export enum ReviewState {
  unknown = "unknown",
  needs_review = "needs_review",
  passed = "passed",
  failed = "failed",
  not_applicable = "not_applicable",
}

export enum HostState {
  connected = "connected",
  disconnected = "disconnected",
  unknown = "unknown",
}

export interface SessionMember {
  id: string;
  node_id: NodeId;
  workspace_id: WorkspaceId;
  root: string;
  source_root: string | null;
  mode: "checkout" | "worktree";
  first_seen_at: string;
  last_observed_at: string;
  online: boolean;
  revision: number;
  recovery_root: string;
}

export interface SessionRecord {
  id: SessionId;
  owner_id: string;
  conversation_id: string | null;
  title: string;
  created_at: string;
  last_activity_at: string;
  revision: number;
  execution_state: ExecutionState;
  review_state: ReviewState;
  host_state: HostState;
  current_task_id: TaskId | null;
  selected_member_id: string;
  members: SessionMember[];
}

export interface TaskRecord {
  id: TaskId;
  session_id: SessionId;
  title: string;
  revision: number;
  state: "active" | "closed";
  start_sequence: number;
  created_at: string;
  last_activity_at: string;
  finished_at: string | null;
  request_key?: string | null;
  result_status?: "completed" | "failed" | "cancelled" | "handed_off" | null;
  summary?: string | null;
  source_task_id?: TaskId | null;
  closure_reason?: "explicit" | "superseded" | "legacy_archive" | "recovered" | null;
  archived_at?: string | null;
  delivery_ended_at?: string | null;
  source_kind?: "user_request" | "deployment_check" | "federation_mirror" | "legacy_unknown";
  change_summary_state?: "not_started" | "complete" | "incomplete";
  change_summary_error?: string | null;
}

export interface InvocationContext {
  owner_id: string;
  conversation_id: string | null;
  transport_instance_id: string;
  request_id: string | number;
  invocation_id: string;
  session_id: SessionId;
  task_id?: TaskId;
  member_id: string;
  actor: "model" | "agent" | "app" | "system";
  tool_name: string;
  workspace_id: WorkspaceId;
  operation_id?: string;
  run_id?: string;
}

export interface OperationRecord {
  id: OperationId;
  invocation_id: string;
  session_id: SessionId;
  member_id: string;
  run_id: string | null;
  agent_id: AgentId | null;
  kind: "read" | "search" | "patch" | "command" | "agent_control" | "copy" | "verification";
  label: string;
  state: OperationState;
  started_at: number | null;
  ended_at: number | null;
  result_ref: string | null;
  command_id: string | null;
  error_code: string | null;
  error_message: string | null;
  effect: "not_started" | "started" | "partial" | "completed" | "unknown";
}

export interface FileSummary {
  id: string;
  member_id: string;
  status: "A" | "M" | "D" | "R";
  path: string;
  from: string | null;
  additions: number | null;
  removals: number | null;
  hash: string;
  large: boolean;
  binary: boolean;
  coverage: "session_owned" | "workspace_observed" | "partial";
  revertible: boolean;
}

export interface CommandSummary {
  id: string;
  operation_id: OperationId;
  member_id: string;
  cmd: string;
  agent: string;
  status: "queued" | "run" | "ok" | "fail" | "cancelled" | "unknown";
  startedAt: number | null;
  endedAt: number | null;
  exitCode: number | null;
  signal: string | null;
  attempt: number | null;
  supersededBy: string | null;
  summary: string | null;
  output_ref: string;
  output_available: boolean;
}

export interface AgentSummary {
  id: AgentId;
  member_id: string;
  role: "main" | "subagent";
  name: string;
  provider: string;
  model: string | null;
  effort: string | null;
  state: "queued" | "working" | "done" | "failed" | "cancelled" | "unknown";
  task: string;
  tokens: number | null;
  usage_quality: "complete" | "partial" | "unavailable" | "not_used";
  startedAt: number | null;
  endedAt: number | null;
  steps: Array<{ label: string; state: "done" | "cur" | "todo" }> | null;
  result_available: boolean;
  result_ref: string | null;
}

export interface InstructionSummary {
  path: string;
  status: "loaded" | "available";
  actor_id: string;
  source: "global" | "ancestor" | "workspace" | "nested";
  observed_at: string | null;
  content_ref: string | null;
}

export interface SkillSummary {
  name: string;
  description: string | null;
  path: string;
  actor_id: string;
  state: "available" | "read";
  uses: number | null;
}

export interface SnapshotWorkspace {
  id: string;
  node_id: string;
  workspace_id: string;
  online: boolean;
  observedAt: number;
  root: string;
  sourceRoot: string | null;
  branch: string | null;
  baseRef: string | null;
  baseSha: string | null;
  dirtySource: boolean | null;
  mode: "local" | "worktree";
}

export interface SnapshotCursors {
  files?: string | null;
  commands?: string | null;
  agents?: string | null;
}

export interface SnapshotCapabilities {
  refresh: boolean;
  revert: boolean;
  continue: boolean;
  open_file: boolean;
}

export interface Snapshot {
  taskState?: "active" | "closed";
  taskResult?: TaskRecord["result_status"];
  lastActivityAt?: number | null;
  lastModelToolAt?: number | null;
  lastExecutionActivityAt?: number | null;
  lastOutputAt?: number | null;
  serverNow?: number;
  lastOperation?: import("./activity.js").TaskActivity | null;
  currentCommand?: CommandSummary | null;
  runningCommand?: CommandSummary | null;
  lastCommand?: CommandSummary | null;
  closureReason?: TaskRecord["closure_reason"];
  archivedAt?: number | null;
  deliveryEndedAt?: number | null;
  sourceKind?: TaskRecord["source_kind"];
  changeSummary?: {state:"not_started"|"complete"|"incomplete";error:string|null};
  sessionId: SessionId;
  taskId?: TaskId | null;
  rev: number;
  changeRev?: number | null;
  title: string;
  status: "running" | "done" | "failed" | "idle";
  execution_status: ExecutionState;
  review_status: ReviewState;
  host_status: HostState;
  startedAt: number;
  endedAt: number | null;
  observedAt: number;
  consoleUrl: string | null;
  workspace: SnapshotWorkspace | null;
  workspaces: SessionMember[];
  files: FileSummary[];
  commands: CommandSummary[];
  agents: AgentSummary[];
  instructions: InstructionSummary[];
  skills: SkillSummary[];
  totals: {
    files: number;
    commands: number;
    agents: number;
  };
  cursors: SnapshotCursors | null;
  capabilities: SnapshotCapabilities;
  notices: string[];
}

export interface RecoveryRowCommands {
  succeeded: number;
  failed: number;
  running: number;
  last_summary: string;
}

export interface RecoveryRowAgents {
  completed: number;
  running: number;
  failed: number;
}

export interface RecoveryRow {
  session_id: SessionId;
  title: string;
  updated_at: string;
  execution_state: string;
  latest_completed: string;
  files: string[];
  remaining_files: number;
  commands: RecoveryRowCommands;
  agents: RecoveryRowAgents;
  verification: string;
  next_step: string;
  detail_ref: string;
  node_id: NodeId;
  root: string;
}

export interface SessionEvent {
  sequence: number;
  session_id: SessionId;
  task_id?: TaskId | null;
  member_id: string;
  type:
    | "session_opened"
    | "operation_started"
    | "operation_finished"
    | "operation_output"
    | "file_changed"
    | "agent_changed"
    | "context_read"
    | "usage_changed"
    | "verification_recorded"
    | "host_changed";
  source_id: string;
  timestamp: string;
  payload: Record<string, unknown>;
}
