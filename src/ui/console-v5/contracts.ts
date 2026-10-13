import type { WorkbenchFeed } from "../../console-workbench/feed.js";
import type { LocalActions } from "../../console-workbench/actions.js";
import type { readRunDetail, readFileDiff, readRunPatch, readCommandOutput } from "../../console-workbench/detail.js";
import type { Run, Project, Root, SourceState } from "../../console-workbench/types.js";
import type { ConsoleSession } from "./client.js";

export type { Run, Project, Root, SourceState, ConsoleSession };
export type Fleet = Awaited<ReturnType<WorkbenchFeed["fleet"]>>;
export type Machine = Fleet["nodes"][number];
export type Overview = Awaited<ReturnType<WorkbenchFeed["overview"]>>;
export type RunPage = Awaited<ReturnType<WorkbenchFeed["runs"]>>;
export type UsageReport = Awaited<ReturnType<WorkbenchFeed["usage"]>>;
export type RunDetail = Awaited<ReturnType<typeof readRunDetail>>;
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
export interface ListResponse<T> { items: T[]; sources: SourceState[]; complete: boolean }
export interface EventRow {
  id: string; nodeId: string; time: number; level: string; message: string; details: Record<string, unknown>;
  tool?: string; summary?: string; rootId?: string | null; state?: string; duration?: number | null;
  ok?: boolean | null; error?: string | null;
}
export interface TransferRow {
  id: string; nodeId: string; source: string; destination: string; bytes: number; total: number;
  status: string; speed: number | null; startedAt: number; revision: string; error: string | null;
}
export interface AuditRow {
  id: string; nodeId: string; time: number; action: string; target: string; actor: string;
  before: unknown; after: unknown; requestKey: string;
}
export interface ActivityPage<T = EventRow> extends ListResponse<T> {
  total: number; offset: number; limit: number; nextCursor: string | null;
  bins: Array<{ start: number; count: number; errors: number; warnings: number }>;
}
export interface Route { view: string; p: Record<string, string | undefined> }
export interface Preferences {
  theme: string; density: string; sidebar: string; poll: number; listWidth: number;
  base: string; wrap: boolean; notifications: boolean; timeZone: string;
}
export interface CacheEntry<T = unknown> {
  data: T | null; time: number; error: Error & { code?: string } | null; loading: boolean;
  retryAt?: number; ctl?: AbortController; promise?: Promise<unknown> | null;
}
