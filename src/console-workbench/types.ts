export interface Usage {
  total: number | null;
  input: number | null;
  cached: number | null;
  output: number | null;
  reasoning: number | null;
  quality: "complete" | "partial" | "unavailable" | "not_used";
}

export interface Run {
  id: string;
  localId: string;
  title: string;
  nodeId: string;
  projectId: string;
  projectLocalId: string;
  projectName: string;
  root: string;
  executionStatus: string;
  acceptanceStatus: string;
  startedAt: number;
  finishedAt: number | null;
  lastActivityAt: number;
  revision: number;
  workspaceRevision: number;
  sessionId: string | null;
  taskId: string | null;
  sourceTaskId?: string | null;
  memberId: string | null;
  usage: Usage;
  diff: { files: number; add: number | null; del: number | null } | null;
  origin: string;
  branch: string | null;
  baseSha: string | null;
  command: string | null;
  agent: string | null;
  reason: string | null;
  reviewNote?: string | null;
  actions: { interrupt: boolean; resume: boolean; review: boolean; revert: boolean; complete?: boolean; patch?: boolean };
  warnings: string[];
  /** All execution-phase references that belong to this user task. */
  phaseRefs?: string[];
  /** Nodes touched by this task. A single phase still reports one node. */
  nodeIds?: string[];
  nodeStates?: Record<string, string>;
  workspaceCount?: number;
  currentPhase?: boolean;
  currentPhaseRefs?: string[];
  workspaces?: Array<{nodeId: string; projectId: string; memberId: string | null; name: string; root: string}>;
}

export interface Project {
  id: string;
  localId: string;
  nodeId: string;
  name: string;
  path: string;
  rootId: string | null;
  active: number;
  review: number;
  total: number;
  updatedAt: number;
  sessionCount?: number;
  threadCount?: number;
}

export interface Root {
  id: string;
  reference: string;
  localId: string;
  nodeId: string;
  name: string;
  path: string;
  description: string;
  tags: string[];
  enabled: boolean;
  readOnly: boolean;
  revision: number;
}

export interface LocalIndex {
  nodeId: string;
  runs: Run[];
  projects: Project[];
  roots: Root[];
  observedAt: number;
  settings?: { revision: number; nickname: string; priority: number; egress: {
    enabled: boolean; config: string | null; port: number; probe: string; recovery: number; inherit: boolean;
  } };
}

export type SourceReadState = "loading" | "ready" | "refreshing" | "error" | "offline";

export interface SourceState {
  nodeId: string;
  name: string;
  online: boolean;
  observedAt: number | null;
  state: SourceReadState;
  stale: boolean;
  error: string | null;
}

export interface FleetIndex extends LocalIndex {
  sources: SourceState[];
  complete: boolean;
}

export interface WorkbenchEvent {
  id: string;
  time: number;
  level: string;
  nodeId: string;
  message: string;
  details: Record<string, unknown>;
  [key: string]: unknown;
}

export class WorkbenchError extends Error {
  constructor(message: string, readonly status = 409, readonly code = "operation_rejected") {
    super(message);
  }
}
