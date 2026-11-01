import type { WorkbenchFeed } from "../../console-workbench/feed.js";
import type { LocalActions } from "../../console-workbench/actions.js";
import type { readRunDetail, readFileDiff, readRunPatch, readCommandOutput } from "../../console-workbench/detail.js";
import type { Run, Project, Root, SourceState, TaskMessageConfirmation } from "../../console-workbench/types.js";
import type { ConsoleSession } from "./client.js";

export type { Run, Project, Root, SourceState, ConsoleSession };
export type Fleet = Awaited<ReturnType<WorkbenchFeed["fleet"]>>;
export type Machine = Fleet["nodes"][number];
export type NodeSettingsSnapshot = Awaited<ReturnType<WorkbenchFeed["nodeSettings"]>>;
export type Overview = Awaited<ReturnType<WorkbenchFeed["overview"]>>;
export type RunPage = Awaited<ReturnType<WorkbenchFeed["runs"]>>;
export type UsageReport = Awaited<ReturnType<WorkbenchFeed["usage"]>>;
type BaseRunDetail = Awaited<ReturnType<typeof readRunDetail>>;
export interface ChangeCapture {
  runId: string; nodeId: string; projectName: string; root: string;
  state: 'idle' | 'pending' | 'failed'; error: string | null;
}
export type RunDetail = Omit<BaseRunDetail, 'files' | 'changeCaptures'> & {
  taskMessages?: TaskMessageConfirmation;
  changeCaptures?: ChangeCapture[];
  phases?: Array<{ id: string; run: Run; summary: string }>;
  files: Array<BaseRunDetail['files'][number] & { source?: { runId: string; nodeId: string; projectName: string; root: string } }>;
};
export type ChangeFile = RunDetail["files"][number];
export type Command = RunDetail["commands"][number];
export type FileDiff = Awaited<ReturnType<typeof readFileDiff>>;
export type PatchPage = Awaited<ReturnType<typeof readRunPatch>>;
export type CommandPage = Awaited<ReturnType<typeof readCommandOutput>>;
export type Sessions = ReturnType<LocalActions["sessions"]>;
export type Thread = Sessions["items"][number];
export type RevertPreview = Awaited<ReturnType<LocalActions["revertPreview"]>>;
export type RevertReceipt = Awaited<ReturnType<LocalActions["revertCommit"]>>;
export type ArchivePreview = Awaited<ReturnType<LocalActions["archive"]>>;
export interface ReviewReceipt { results: Array<{ id: string; ok: boolean; revision?: number; error?: string }> }
export interface ActionReceipt {
  scope: string; requestKey: string; path: string; state: 'started' | 'completed' | 'rejected' | 'partial' | 'unknown';
  effect: 'none' | 'applied' | 'partial' | 'unknown'; createdAt: number | string; finishedAt: number | string | null;
  response?: unknown; error?: { message?: string; code?: string } | string | null;
}
export interface ControlReceipt {
  status: string; outcome?: string; missingNodes?: string[];
  results?: Array<{ phaseId?: string; nodeId?: string; status?: string; error?: string; targets?: ControlTarget[] }>;
  targets?: ControlTarget[];
}
export interface ControlTarget { id: string; kind: string; status: string; error?: string; effect?: string; nodeId?: string }
export interface ListResponse<T> { items: T[]; sources: SourceState[]; complete: boolean }
export interface EventRow {
  id: string; nodeId: string; time: number; level: string; message: string; details: Record<string, unknown>;
  tool?: string; summary?: string; rootId?: string | null; state?: string; duration?: number | null;
  ok?: boolean | null; error?: string | null; responseRecorded?: boolean;
  requestId?: string | null; operationId?: string | null; taskId?: string | null; runId?: string | null; executionState?: string | null;
}
export interface TransferRow {
  id: string; nodeId: string; source: string; destination: string; bytes: number; total: number | null;
  status: string; speed: number | null; startedAt: number; revision: string; error: string | null;
}
export interface AuditRow {
  id: string; nodeId: string; time: number; action: string; target: string; actor: string;
  before: unknown; after: unknown; requestKey: string;
}
export interface ActivityPage<T = EventRow> extends ListResponse<T> {
  total: number; offset: number; limit: number; nextCursor: string | null;
  observedAt?: number | null; nextAfter?: { after: number; afterId: string } | null;
  bins: Array<{ start: number; count: number; errors: number; warnings: number }>;
}
export interface Route { view: string; p: Record<string, string | undefined> }
export interface Preferences {
  theme: string; density: string; sidebar: string; poll: number; listWidth: number;
  base: string; wrap: boolean; notifications: boolean; timeZone: string;
  taskLayout: string; machineLayout: string; diffMode: string;
}
export interface CacheEntry<T = unknown> {
  data: T | null; time: number; error: Error & { code?: string } | null; loading: boolean;
  retained?: {data:T;time:number}; receivedAt?:number;
  retryAt?: number; ctl?: AbortController; promise?: Promise<unknown> | null;
  startedAt?: number; duration?: number; failures?: number;
}
