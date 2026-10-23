import type Database from "better-sqlite3";
import { pidAlive } from "../process-liveness.js";
import { canonicalWorkspaceRoot } from "../roots.js";
import { samePhysicalPath } from "../physical-paths.js";
import { LAST_RUN_OUTCOME_SQL } from "../work-outcome.js";
import type { FileSummary, Snapshot } from "./types.js";

export interface TaskBaseline {
  session_id: string; member_id: string; repo_root: string;
  baseline_ref: string; latest_ref: string; coverage: "session_owned" | "workspace_observed" | "partial";
}
export interface ContextReadInput {
  sessionId: string; memberId: string; actorId: string; path: string;
  kind: "instruction" | "skill"; state: "loaded" | "available" | "read";
  contentRef?: string | null; incrementRead?: boolean; taskId?: string;
}
export interface TaskContextRead {
  session_id: string; member_id: string; actor_id: string; path: string;
  kind: "instruction" | "skill"; state: "loaded" | "available" | "read";
  content_ref: string | null; read_count: number; observed_at: string | null;
}
export type StoredTaskFile = FileSummary & { patchRef: string; versionRef: string };
export type TaskFinalStatus = "completed" | "failed" | "cancelled" | "handed_off";
export interface TaskFinalization {
  task_id: string; status: TaskFinalStatus; summary: string;
  requested_at: string; completed_at: string | null; error: string | null;
}

export class TaskDataStore {
  constructor(private readonly db: Database.Database) {}

  latestRunResult(taskId: string, memberId: string): {run_id:string;status:string;last_outcome:string|null} | null {
    return this.db.prepare(`select r.id run_id,r.status,${LAST_RUN_OUTCOME_SQL} last_outcome
      from qm_run_links l join console_work_runs r on r.id=l.run_id
      where l.task_id=? and l.member_id=? order by l.rowid desc limit 1`)
      .get(taskId,memberId) as {run_id:string;status:string;last_outcome:string|null} | undefined ?? null;
  }

  operationObservations(taskId: string, memberId: string): Array<{id:string;status:string;effect:string|null;observed_at:string|null}> {
    return this.db.prepare(`select o.id,o.status,i.effect,o.observed_at from console_operations o
      join qm_run_links l on l.run_id=o.run_id left join qm_invocations i on i.operation_id=o.id
        and not exists(select 1 from qm_invocations n where n.retry_of_invocation_id=i.id)
      where l.task_id=? and l.member_id=? and o.status in ('starting','queued','running','unknown','reconciliation_required')
      and (o.status in ('unknown','reconciliation_required') or i.finished_at is null or i.state not in ('succeeded','failed','cancelled'))
      union all select 'execution:'||e.id id,e.status,null effect,e.observed_at from console_executions e
      join qm_run_links l on l.run_id=e.run_id
      where l.task_id=? and l.member_id=? and e.status in ('starting','queued','running','unknown','reconciliation_required')`)
      .all(taskId,memberId,taskId,memberId) as Array<{id:string;status:string;effect:string|null;observed_at:string|null}>;
  }

  observeProjection(taskId: string, memberId: string, observation: import("../execution-observation.js").ExecutionObservation): void {
    const current=this.projection(taskId,memberId);
    if(!current || (current.snapshot.executionObservation?.observedAt??-1)>observation.observedAt)return;
    const snapshot={...current.snapshot,executionObservation:observation};
    this.db.prepare("update qm_task_projections set snapshot_json=? where task_id=? and member_id=? and source_revision=?")
      .run(JSON.stringify(snapshot),taskId,memberId,current.revision);
  }

  pendingFinalizations(limit = 4, after?: Pick<TaskFinalization, "requested_at" | "task_id">): TaskFinalization[] {
    const read = (cursor?: typeof after) => this.db.prepare(`select f.* from qm_task_finalizations f join qm_tasks t on t.id=f.task_id
      where (t.state='active' OR f.completed_at IS NULL)
      ${cursor ? "and (f.requested_at,f.task_id)>(?,?)" : ""}
      order by f.requested_at,f.task_id limit ?`)
      .all(...(cursor ? [cursor.requested_at,cursor.task_id,limit] : [limit])) as TaskFinalization[];
    const batch = read(after);
    return batch.length || !after ? batch : read();
  }

  requireScope(taskId: string, sessionId: string, memberId?: string): void {
    const task = this.db.prepare("SELECT session_id FROM qm_tasks WHERE id=?").get(taskId) as { session_id: string } | undefined;
    if (!task || task.session_id !== sessionId) throw new Error(`TASK_SESSION_MISMATCH: ${taskId}`);
    if (memberId && !this.db.prepare("SELECT 1 FROM qm_session_members WHERE id=? AND session_id=?").get(memberId, sessionId)) {
      throw new Error(`TASK_MEMBER_MISMATCH: ${memberId}`);
    }
  }

  baseline(taskId: string, sessionId: string, memberId: string, root: string): TaskBaseline | null {
    this.requireScope(taskId, sessionId, memberId);
    const query = this.db.prepare(`SELECT session_id,member_id,repo_root,baseline_ref,latest_ref,coverage
      FROM qm_task_change_baselines WHERE task_id=? AND member_id=? AND repo_root=?`);
    const row = (query.get(taskId, memberId, root)
      ?? query.get(taskId, memberId, canonicalWorkspaceRoot(root))) as TaskBaseline | undefined;
    if (row) return row;
    const aliases = this.baselines(taskId, sessionId, memberId).filter(value => samePhysicalPath(value.repo_root, root));
    if (aliases.length > 1) throw new Error("CHANGE_BASELINE_ALIAS_AMBIGUOUS");
    return aliases[0] ?? null;
  }

  baselines(taskId: string, sessionId: string, memberId: string): TaskBaseline[] {
    this.requireScope(taskId, sessionId, memberId);
    return this.db.prepare(`SELECT session_id,member_id,repo_root,baseline_ref,latest_ref,coverage
      FROM qm_task_change_baselines WHERE task_id=? AND member_id=? ORDER BY repo_root`).all(taskId, memberId) as TaskBaseline[];
  }

  putBaseline(taskId: string, value: TaskBaseline): void {
    this.requireScope(taskId, value.session_id, value.member_id);
    this.db.transaction(() => {
      const root = this.baseline(taskId, value.session_id, value.member_id, value.repo_root)?.repo_root
        ?? canonicalWorkspaceRoot(value.repo_root);
      this.db.prepare(`INSERT INTO qm_task_change_baselines(task_id,session_id,member_id,repo_root,baseline_ref,latest_ref,coverage)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(task_id,member_id,repo_root) DO UPDATE SET
          latest_ref=excluded.latest_ref,coverage=excluded.coverage`)
        .run(taskId, value.session_id, value.member_id, root, value.baseline_ref, value.latest_ref, value.coverage);
    }).immediate();
  }

  replaceFiles(taskId: string, sessionId: string, memberId: string, version: string, files: Array<FileSummary & { patchRef: string }>): void {
    this.requireScope(taskId, sessionId, memberId);
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM qm_task_file_changes WHERE task_id=? AND member_id=? AND version_ref=?").run(taskId, memberId, version);
      const insert = this.db.prepare(`INSERT INTO qm_task_file_changes
        (task_id,session_id,member_id,version_ref,file_id,status,path,from_path,additions,removals,hash,large,binary,coverage,revertible,patch_ref,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      const now = new Date().toISOString();
      for (const file of files) insert.run(taskId, sessionId, memberId, version, file.id, file.status, file.path,
        file.from, file.additions, file.removals, file.hash, file.large ? 1 : 0, file.binary ? 1 : 0,
        file.coverage, file.revertible ? 1 : 0, file.patchRef, now);
    }).immediate();
  }

  files(taskId: string, sessionId: string, memberId?: string): StoredTaskFile[] {
    this.requireScope(taskId, sessionId, memberId);
    const rows = this.db.prepare(`SELECT f.* FROM qm_task_file_changes f
      WHERE f.task_id=? ${memberId ? "AND f.member_id=?" : ""}
      AND EXISTS(SELECT 1 FROM qm_task_change_baselines b WHERE b.task_id=f.task_id AND b.member_id=f.member_id AND b.latest_ref=f.version_ref)
      ORDER BY f.member_id,f.path`).all(...(memberId ? [taskId, memberId] : [taskId])) as Array<Record<string, unknown>>;
    return rows.map(row => ({ id: String(row.file_id), member_id: String(row.member_id), status: row.status as FileSummary["status"],
      path: String(row.path), from: row.from_path === null ? null : String(row.from_path),
      additions: row.additions === null ? null : Number(row.additions), removals: row.removals === null ? null : Number(row.removals),
      hash: String(row.hash), large: Boolean(row.large), binary: Boolean(row.binary), coverage: row.coverage as FileSummary["coverage"],
      revertible: Boolean(row.revertible), patchRef: String(row.patch_ref), versionRef: String(row.version_ref) }));
  }

  upsertContext(taskId: string, input: ContextReadInput): void {
    this.requireScope(taskId, input.sessionId, input.memberId);
    this.db.prepare(`INSERT INTO qm_task_context_reads(task_id,session_id,member_id,actor_id,path,kind,state,content_ref,read_count,observed_at)
      VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(task_id,member_id,actor_id,path,kind) DO UPDATE SET
      state=CASE WHEN excluded.state='read' THEN 'read' WHEN qm_task_context_reads.state='read' THEN 'read'
        WHEN excluded.state='loaded' THEN 'loaded' ELSE qm_task_context_reads.state END,
      content_ref=COALESCE(excluded.content_ref,qm_task_context_reads.content_ref),
      read_count=qm_task_context_reads.read_count+?,observed_at=excluded.observed_at`)
      .run(taskId, input.sessionId, input.memberId, input.actorId, input.path, input.kind, input.state,
        input.contentRef ?? null, input.incrementRead ? 1 : 0, new Date().toISOString(), input.incrementRead ? 1 : 0);
  }

  context(taskId: string, sessionId: string, memberId?: string): TaskContextRead[] {
    this.requireScope(taskId, sessionId, memberId);
    return this.db.prepare(`SELECT session_id,member_id,actor_id,path,kind,state,content_ref,read_count,observed_at
      FROM qm_task_context_reads WHERE task_id=? ${memberId ? "AND member_id=?" : ""} ORDER BY member_id,path,actor_id`)
      .all(...(memberId ? [taskId, memberId] : [taskId])) as TaskContextRead[];
  }

  inheritDiscoveredContext(taskId: string, sessionId: string, memberId: string): void {
    this.requireScope(taskId, sessionId, memberId);
    this.db.prepare(`INSERT OR IGNORE INTO qm_task_context_reads
      (task_id,session_id,member_id,actor_id,path,kind,state,content_ref,read_count,observed_at)
      SELECT ?,session_id,member_id,actor_id,path,kind,state,content_ref,0,observed_at
      FROM qm_context_reads WHERE session_id=? AND member_id=? AND actor_id='host'`).run(taskId, sessionId, memberId);
  }

  projection(taskId: string, memberId: string): { revision: number; snapshot: Snapshot } | null {
    const row = this.db.prepare("SELECT source_revision,snapshot_json FROM qm_task_projections WHERE task_id=? AND member_id=?")
      .get(taskId, memberId) as { source_revision: number; snapshot_json: string } | undefined;
    return row ? { revision: row.source_revision, snapshot: JSON.parse(row.snapshot_json) as Snapshot } : null;
  }

  putProjection(taskId: string, memberId: string, revision: number, snapshot: Snapshot, remote = false): boolean {
    this.requireScope(taskId, snapshot.sessionId, memberId);
    if (snapshot.taskId !== taskId) throw new Error("TASK_SNAPSHOT_ID_MISMATCH");
    return this.db.transaction(() => {
      const result = this.db.prepare(`INSERT INTO qm_task_projections(task_id,member_id,source_revision,snapshot_json,observed_at)
        VALUES(?,?,?,?,?) ON CONFLICT(task_id,member_id) DO UPDATE SET source_revision=excluded.source_revision,
          snapshot_json=excluded.snapshot_json,observed_at=excluded.observed_at
        WHERE qm_task_projections.source_revision ${remote ? "<" : "<="} excluded.source_revision`)
        .run(taskId, memberId, revision, JSON.stringify(snapshot), new Date().toISOString());
      if (remote && result.changes) this.bumpDisplay(taskId);
      return result.changes > 0;
    }).immediate();
  }

  bumpDisplay(taskId: string): void {
    this.db.prepare("UPDATE qm_tasks SET revision=revision+1 WHERE id=?")
      .run(taskId);
  }

  finalization(taskId: string): TaskFinalization | null {
    return this.db.prepare("SELECT * FROM qm_task_finalizations WHERE task_id=?").get(taskId) as TaskFinalization | undefined ?? null;
  }

  activeWork(taskId: string): number {
    const rows=this.db.prepare("SELECT id,owner_pid FROM qm_runtime_work WHERE task_id=? AND blocking=1")
      .all(taskId) as {id:string;owner_pid:number}[];
    let active=0;
    for(const row of rows){
      if(pidAlive(row.owner_pid)){active++;continue;}
      this.db.prepare("DELETE FROM qm_runtime_work WHERE id=? AND owner_pid=?").run(row.id,row.owner_pid);
    }
    return active;
  }

  requestFinalization(taskId: string, status: TaskFinalStatus, summary: string, expectedRevision?: number): TaskFinalization {
    return this.db.transaction(() => {
      if(expectedRevision!==undefined) {
        const task=this.db.prepare('SELECT revision FROM qm_tasks WHERE id=?').get(taskId) as {revision:number}|undefined;
        if(!task || task.revision!==expectedRevision)throw Object.assign(new Error('TASK_REVISION_CONFLICT'),{code:'TASK_REVISION_CONFLICT'});
      }
      const existing = this.finalization(taskId);
      if (existing) {
        if (existing.completed_at && (existing.status !== status || existing.summary !== summary)) throw new Error("TASK_FINALIZATION_ALREADY_CONFIRMED");
        if (!existing.completed_at && !existing.error && (existing.status!==status || existing.summary!==summary))throw new Error('TASK_FINALIZATION_CONFLICT');
        if (!existing.completed_at) {
          const updated=this.db.prepare("UPDATE qm_task_finalizations SET status=?,summary=?,error=NULL WHERE task_id=? AND (status!=? OR summary!=? OR error IS NOT NULL)")
            .run(status, summary, taskId,status,summary);
          if(updated.changes)this.bumpDisplay(taskId);
        }
        return this.finalization(taskId)!;
      }
      this.db.prepare("INSERT INTO qm_task_finalizations(task_id,status,summary,requested_at) VALUES(?,?,?,?)")
        .run(taskId, status, summary, new Date().toISOString());
      this.bumpDisplay(taskId);
      return this.finalization(taskId)!;
    }).immediate();
  }

  finishFinalization(taskId: string, error?: string): void {
    this.db.prepare("UPDATE qm_task_finalizations SET completed_at=?,error=? WHERE task_id=?")
      .run(error ? null : new Date().toISOString(), error ?? null, taskId);
    this.bumpDisplay(taskId);
  }
}
