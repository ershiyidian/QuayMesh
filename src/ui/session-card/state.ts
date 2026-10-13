import type {
  AgentSummary,
  CommandSummary,
  FileSummary,
  InstructionSummary,
  Snapshot,
} from "../../session/types.js";
import type { DiffRow } from "./diff.js";

export type CardTab = "changes" | "commands" | "agents" | "context";
export type ConnectionState = "connecting" | "live" | "static" | "error";

export interface DiffCacheEntry {
  rows?: DiffRow[];
  note?: string;
  error?: string;
}

export interface OutputCacheEntry {
  text: string;
  cursor: number;
  done: boolean;
  error?: string;
  truncated?: boolean;
  retainedFrom?: number;
}

export interface InstructionCacheEntry {
  content?: string;
  error?: string;
}

export interface SnapshotChange {
  snapshot: boolean;
  files: boolean;
  commands: boolean;
  agents: boolean;
  instructions: boolean;
  status: boolean;
}

export interface CardState {
  snapshot: Snapshot | null;
  tab: CardTab;
  collapsed: boolean;
  inViewport: boolean;
  hostDisplayMode: "inline" | "fullscreen";
  clockOffsetMs: number;
  lastNowMs: number;
  tall: boolean;
  filter: string;
  failOnly: boolean;
  connection: ConnectionState;
  revertArmed: boolean;
  busy: boolean;
  message: string | null;
  selectedMemberId: string | null;
  panelScroll: Record<CardTab, number>;
  openFiles: Set<string>;
  openCommands: Set<string>;
  openInstructions: Set<string>;
  forceLarge: Set<string>;
  diffCache: Map<string, DiffCacheEntry>;
  outputCache: Map<string, OutputCacheEntry>;
  instructionCache: Map<string, InstructionCacheEntry>;
  seenStatus: Map<string, string>;
  seenSuperseded: Set<string>;
  loading: Set<string>;
  disposed: boolean;
  lastConfirmedAt: number | null;
  pageCursors: { files: string | null; commands: string | null; agents: string | null };
  extraFiles: FileSummary[];
  extraCommands: CommandSummary[];
  extraAgents: AgentSummary[];
  loadingMore: boolean;
}

export function createCardState(): CardState {
  return {
    snapshot: null,
    tab: "changes",
    collapsed: true,
    inViewport: true,
    hostDisplayMode: "inline",
    clockOffsetMs: 0,
    lastNowMs: 0,
    tall: false,
    filter: "",
    failOnly: false,
    connection: "connecting",
    revertArmed: false,
    busy: false,
    message: null,
    selectedMemberId: null,
    panelScroll: { changes: 0, commands: 0, agents: 0, context: 0 },
    openFiles: new Set(),
    openCommands: new Set(),
    openInstructions: new Set(),
    forceLarge: new Set(),
    diffCache: new Map(),
    outputCache: new Map(),
    instructionCache: new Map(),
    seenStatus: new Map(),
    seenSuperseded: new Set(),
    loading: new Set(),
    disposed: false,
    lastConfirmedAt: null,
    pageCursors: { files: null, commands: null, agents: null },
    extraFiles: [],
    extraCommands: [],
    extraAgents: [],
    loadingMore: false,
  };
}

export function applySnapshot(
  state: CardState,
  next: Snapshot,
): SnapshotChange {
  if (state.disposed) throw new Error("SESSION_CARD_STATE_DISPOSED");
  const previous = state.snapshot;
  if (previous && previous.sessionId !== next.sessionId) {
    throw new Error(`SESSION_CARD_IDENTITY_CHANGED: ${previous.sessionId} -> ${next.sessionId}`);
  }
  if (previous && previous.workspace?.id === next.workspace?.id && next.rev < previous.rev) {
    return {
      snapshot: false,
      files: false,
      commands: false,
      agents: false,
      instructions: false,
      status: false,
    };
  }

  const first = previous === null;
  const fileChanged = !first && !sameFiles(previous.files, next.files);
  const commandChanged = !first && !sameCommands(previous.commands, next.commands);
  const agentChanged = !first && !sameAgents(previous.agents, next.agents);
  const instructionChanged = !first && !sameInstructions(previous.instructions, next.instructions);
  const statusChanged = !first && (
    previous.status !== next.status
    || previous.rev !== next.rev
    || previous.host_status !== next.host_status
  );

  state.snapshot = next;
  state.lastConfirmedAt = Date.now();
  if(typeof next.serverNow==="number"&&Number.isFinite(next.serverNow))state.clockOffsetMs=next.serverNow-Date.now();
  state.extraFiles = state.extraFiles.filter((file) => !next.files.some((item) => item.id === file.id));
  state.extraCommands = state.extraCommands.filter((command) => !next.commands.some((item) => item.id === command.id));
  state.extraAgents = state.extraAgents.filter((agent) => !next.agents.some((item) => item.id === agent.id));
  const hasExtraPages = state.extraFiles.length > 0 || state.extraCommands.length > 0 || state.extraAgents.length > 0;
  if (first || !hasExtraPages) {
    state.pageCursors = {
      files: next.cursors?.files ?? null,
      commands: next.cursors?.commands ?? null,
      agents: next.cursors?.agents ?? null,
    };
  }
  if (state.selectedMemberId && !next.workspaces.some((member) => member.id === state.selectedMemberId)) {
    state.selectedMemberId = null;
  }

  const liveDiffKeys = new Set(next.files.map((file) => diffCacheKey(file)));
  for (const key of state.diffCache.keys()) {
    if (!liveDiffKeys.has(key)) state.diffCache.delete(key);
  }

  if (first && next.files[0]) state.openFiles.add(next.files[0].id);
  for (const command of next.commands) {
    const previousStatus = state.seenStatus.get(command.id);
    if (previousStatus !== command.status && (
      command.status === "run"
      || (command.status === "fail" && !command.supersededBy)
    )) {
      state.openCommands.add(command.id);
    }
    if (command.supersededBy && !state.seenSuperseded.has(command.id)) {
      state.seenSuperseded.add(command.id);
      if (!first) state.openCommands.delete(command.id);
    }
    state.seenStatus.set(command.id, command.status);
  }

  return {
    snapshot: true,
    files: first || fileChanged,
    commands: first || commandChanged,
    agents: first || agentChanged,
    instructions: first || instructionChanged,
    status: first || statusChanged,
  };
}

export function applyCommandOutput(
  state: CardState,
  commandId: string,
  result: {
    chunk: string;
    cursor: number;
    done: boolean;
    truncated?: boolean;
    retained_from?: number;
  },
): boolean {
  const previous = state.outputCache.get(commandId);
  const next: OutputCacheEntry = {
    text: `${previous?.text ?? ""}${result.chunk}`,
    cursor: result.cursor,
    done: result.done,
    ...(result.truncated ? { truncated: true } : {}),
    ...(result.retained_from !== undefined ? { retainedFrom: result.retained_from } : {}),
  };
  state.outputCache.set(commandId, next);
  return previous?.text !== next.text
    || previous.cursor !== next.cursor
    || previous.done !== next.done
    || previous.error !== undefined;
}

export function resetAfterRevert(state: CardState): void {
  state.diffCache.clear();
  state.openFiles.clear();
  state.forceLarge.clear();
  state.revertArmed = false;
  state.busy = false;
}

export function disposeState(state: CardState): void {
  state.disposed = true;
  state.diffCache.clear();
  state.outputCache.clear();
  state.instructionCache.clear();
  state.loading.clear();
  state.extraFiles = [];
  state.extraCommands = [];
  state.extraAgents = [];
}

export function unresolvedFailure(state: CardState): CommandSummary | null {
  const commands = state.snapshot?.commands ?? [];
  return [...commands].reverse().find(
    (command) => command.status === "fail" && !command.supersededBy,
  ) ?? null;
}

export function selectedFiles(state: CardState): FileSummary[] {
  const snapshot = state.snapshot;
  if (!snapshot) return [];
  const memberId = state.selectedMemberId;
  return mergeRows(snapshot.files, state.extraFiles).filter((file) => !memberId || file.member_id === memberId);
}

export function selectedCommands(state: CardState): CommandSummary[] {
  const snapshot = state.snapshot;
  if (!snapshot) return [];
  const memberId = state.selectedMemberId;
  return mergeRows(snapshot.commands, state.extraCommands).filter((command) => !memberId || command.member_id === memberId);
}

export function selectedAgents(state: CardState): AgentSummary[] {
  const snapshot = state.snapshot;
  if (!snapshot) return [];
  const memberId = state.selectedMemberId;
  return mergeRows(snapshot.agents, state.extraAgents).filter((agent) => !memberId || agent.member_id === memberId);
}

export function appendPage(
  state: CardState,
  next: Snapshot,
  kind: "files" | "commands" | "agents",
): void {
  if (kind === "files") {
    state.extraFiles = mergeRows(state.extraFiles, next.files);
    state.pageCursors.files = next.cursors?.files ?? null;
    return;
  }
  if (kind === "commands") {
    state.extraCommands = mergeRows(state.extraCommands, next.commands);
    state.pageCursors.commands = next.cursors?.commands ?? null;
    return;
  }
  state.extraAgents = mergeRows(state.extraAgents, next.agents);
  state.pageCursors.agents = next.cursors?.agents ?? null;
}

function mergeRows<T extends { id: string }>(base: T[], extra: T[]): T[] {
  const byId = new Map<string, T>();
  for (const row of base) byId.set(row.id, row);
  for (const row of extra) if (!byId.has(row.id)) byId.set(row.id, row);
  return [...byId.values()];
}

export function selectedInstructions(state: CardState): InstructionSummary[] {
  return state.snapshot?.instructions ?? [];
}

export function diffCacheKey(file: Pick<FileSummary, "id" | "hash">): string {
  return `${file.id}:${file.hash}`;
}

function sameFiles(left: FileSummary[], right: FileSummary[]): boolean {
  return left.length === right.length && left.every((file, index) => {
    const other = right[index];
    return file.id === other.id
      && file.hash === other.hash
      && file.status === other.status
      && file.additions === other.additions
      && file.removals === other.removals;
  });
}

function sameCommands(left: CommandSummary[], right: CommandSummary[]): boolean {
  return left.length === right.length && left.every((command, index) => {
    const other = right[index];
    return command.id === other.id
      && command.status === other.status
      && command.supersededBy === other.supersededBy
      && command.startedAt === other.startedAt
      && command.endedAt === other.endedAt
      && command.summary === other.summary;
  });
}

function sameAgents(
  left: Snapshot["agents"],
  right: Snapshot["agents"],
): boolean {
  return left.length === right.length && left.every((agent, index) => {
    const other = right[index];
    return agent.id === other.id
      && agent.state === other.state
      && agent.task === other.task
      && agent.tokens === other.tokens
      && agent.startedAt === other.startedAt
      && agent.endedAt === other.endedAt
      && JSON.stringify(agent.steps) === JSON.stringify(other.steps);
  });
}

function sameInstructions(
  left: InstructionSummary[],
  right: InstructionSummary[],
): boolean {
  return left.length === right.length && left.every((instruction, index) => {
    const other = right[index];
    return instruction.path === other.path
      && instruction.status === other.status
      && instruction.actor_id === other.actor_id
      && instruction.content_ref === other.content_ref;
  });
}
