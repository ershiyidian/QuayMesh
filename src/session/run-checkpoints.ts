import type Database from "better-sqlite3";
import type { FileSummary, Snapshot } from "./types.js";

export interface RunCheckpoint {
  revision: number;
  snapshot: Snapshot;
  files: Array<FileSummary & { patchRef: string; versionRef: string }>;
}

export function saveRunCheckpoint(db: Database.Database, runId: string, checkpoint: RunCheckpoint): void {
  const memberId = checkpoint.snapshot.workspace?.id ?? checkpoint.files[0]?.member_id ?? "session";
  db.prepare(`INSERT INTO qm_run_checkpoints
    (run_id, session_id, member_id, revision, snapshot_json, files_json, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO NOTHING`)
    .run(runId, checkpoint.snapshot.sessionId, memberId,
      checkpoint.revision, JSON.stringify(checkpoint.snapshot), JSON.stringify(checkpoint.files), new Date().toISOString());
}

export function readRunCheckpoint(db: Database.Database, runId: string): RunCheckpoint | null {
  const row = db.prepare("SELECT revision,snapshot_json,files_json FROM qm_run_checkpoints WHERE run_id=?")
    .get(runId) as { revision: number; snapshot_json: string; files_json: string } | undefined;
  return row ? { revision: row.revision, snapshot: JSON.parse(row.snapshot_json), files: JSON.parse(row.files_json) } : null;
}
