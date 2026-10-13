import type { ReviewFile } from "../card-types.js";

export type Quality = "complete" | "partial" | "unavailable" | "not_used";

export interface Counts {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  reasoningOutputTokens?: number;
  cacheWriteInputTokens?: number;
}

export interface Origin {
  entryPoint: string;
  modelLabel?: string;
  clientLabel?: string;
  evidence?: string;
}

export interface Usage {
  usageStatus: Quality;
  codexUsage: Counts | null;
  missingExecutions: number;
  executions: number;
  pendingExecutions: number;
  /** 可选：用量为 partial / unavailable 的原因 */
  usageQualityReason?: string | null;
}

export interface DiffStat {
  files: number;
  additions: number;
  deletions: number;
}

export interface Receipt extends Usage {
  workRunId: string;
  projectId: string;
  title: string;
  executionStatus: string;
  acceptanceStatus: string;
  origin: Origin;
  codexThreads: number;
  receiptRevision: number;
  createdAt?: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  /** 以下为可选字段，后端提供后自动显示 */
  diffStat?: DiffStat | null;
  lastEventSummary?: string | null;
  attentionReason?: string | null;
}

export interface Project extends Usage {
  id: string;
  name: string;
  root: string;
  taskCount: number;
  activeTasks: number;
  pendingAcceptance: number;
  needsAttention: number;
}

export interface ControlEvent {
  sequence: number;
  eventType: string;
  state: string;
  createdAt: string;
}

export interface Thread {
  id: string;
  title: string;
  agentId: string;
  providerThreadId: string;
  desktopThreadUrl: string;
  origin: Origin;
  createdHere: boolean;
  identityVerified: boolean;
  externalActivity: boolean;
  protected: boolean;
  archiveState: string;
  nameStatus: string;
  updatedAt: string;
  runs: { id: string; status: string; acceptance: string }[];
  control?: { state: string; providerTurnId?: string; revision: number; events: ControlEvent[] };
}

export interface BatchEntry {
  managedThreadId: string;
  title: string;
  status: string;
  reason: string | null;
}

export interface Batch {
  batchId: string;
  projectId: string;
  mode: "archive" | "restore";
  status: string;
  confirmationHash: string;
  expiresAt: string;
  acceptPartial: boolean;
  readyCount: number;
  succeededCount: number;
  entries: BatchEntry[];
}

export interface BatchSummary {
  id: string;
  mode: string;
  status: string;
  created_at: string;
}

export interface Turn {
  createdAt?: string;
  executionId: string;
  agentId: string;
  status: string;
  codexUsage: Counts | null;
  usageStatus: Quality;
  boundary: string;
  requestedModel: string | null;
  requestedEffort: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
}

export type ChangeFile = ReviewFile;

export interface ChangeSet {
  baseCommit?: string | null;
  baseDirty?: boolean;
  baseline?: { kind?: string; reference?: string } | null;
  patch?: string | null;
  truncated?: boolean;
  capturedBy?: string;
  coverage?: "complete" | "partial" | "unavailable";
  revision?: number;
  updatedAt?: string;
  files?: ChangeFile[];
}

export interface TimelineEvent {
  seq?: number;
  time: string;
  type: string;
  title?: string;
  detail?: string;
  durationMs?: number | null;
  exitCode?: number | null;
  agentId?: string;
}

export interface Detail extends Receipt {
  summary: string;
  evidence: { label: string; reference: string; outcome: string }[];
  operations: { id: string; kind: string; label: string; status: string; created_at: string }[];
  turns: Turn[];
  changes?: ChangeSet | null;
  changeSets?: (ChangeSet & { operationId: string; time: string })[];
  events?: TimelineEvent[] | null;
}

export interface Claim {
  id: string;
  kind?: string;
  agent_id?: string;
  access_mode?: string;
  owner_pid?: number | null;
  created_at?: string;
}

export interface AttentionData {
  claims: Claim[];
  waiters: Claim[];
}

export interface Gpu {
  name: string;
  utilization: number;
  memoryUsedMiB: number;
  memoryTotalMiB: number;
  temperature?: number | null;
  processes?: { pid: number; name?: string; executionId?: string }[];
}

export interface Disk {
  mount: string;
  freeBytes: number;
  totalBytes: number;
}

export interface NodeHealth {
  activeCalls: number;
  memoryTotal?: number;
  memoryFree?: number;
  memoryAvailable?: number;
  cpu?: number | null;
  load?: number[];
  uptimeSec?: number;
  disks?: Disk[];
  gpus: Gpu[];
}

export interface RootEntry {
  id: string;
  nickname: string;
  path: string;
  description?: string;
  tags: string[];
  enabled: boolean;
}

export interface Egress {
  enabled: boolean;
  healthy?: boolean;
  listenPort?: number;
  proxyUrl?: string;
  mihomoConfig?: string | null;
  controllerUrl?: string | null;
  probeUrl?: string;
  recoveryDelayMs?: number;
  inheritProxy?: boolean;
  exitIp?: string;
  region?: string;
  latencyMs?: number | null;
  probedAt?: string;
}

export interface FleetNode {
  id: string;
  nickname: string;
  role: string;
  priority: number;
  online: boolean;
  lastSeen?: string | number | null;
  latencyMs?: number | null;
  health: NodeHealth;
  roots: RootEntry[];
  providers: unknown[];
  egress: Egress;
  versions?: { quaymesh?: string; codex?: string; node?: string };
  clockOffsetMs?: number | null;
}

export interface FleetEvent {
  time: string | number;
  nodeId: string;
  message: string;
  level?: string;
}

export interface Transfer {
  id: string;
  nodeId?: string;
  source: string;
  destination: string;
  bytes?: number;
  totalBytes?: number;
  status: string;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  executionId?: string;
}

export interface McpCall {
  id: string;
  time: string;
  tool: string;
  argsSummary?: string;
  routedNode?: string;
  routedRoot?: string;
  durationMs?: number;
  ok: boolean;
  error?: string;
  executionId?: string;
}

export interface AuditEntry {
  id: string;
  time: string;
  actor?: string;
  action: string;
  target?: string;
  before?: unknown;
  after?: unknown;
}

export interface FleetStatus {
  enabled: boolean;
  proxyUrl?: string | null;
  localNodeId?: string;
  gatewayId?: string | null;
  gatewayReason?: string | null;
  publicMcpUrl?: string;
  nodes: FleetNode[];
  events: FleetEvent[];
  transfers?: Transfer[];
  mcpCalls?: McpCall[];
  audit?: AuditEntry[];
}

export interface Peer {
  id: string;
  nickname?: string;
  url?: string;
}

export interface NodeSettings {
  nickname: string;
  role: string;
  priority: number;
  peers: Peer[];
  egress: Egress;
  roots: RootEntry[];
}

export interface OverviewNode {
  nodeId: string;
  error?: string;
  projects?: { id: string; name: string; root: string }[];
  transfers?: Transfer[];
}

export interface NodeProjects {
  nodeId: string;
  projects: Project[];
  error?: string;
  fetchedAt?: number;
}

export interface ScopedProject extends Project {
  nodeId: string;
  nodeName: string;
}

export interface RunRow extends Receipt {
  nodeId: string;
  projectName: string;
  key: string;
  startMs: number | null;
  endMs: number | null;
}

export interface RunBucket {
  nodeId: string;
  projectId: string;
  entries: Receipt[];
  nextOffset: number | null;
  stats: Project | null;
  pages: number;
  fetchedAt?: number;
  error?: string;
}
