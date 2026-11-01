import type Database from 'better-sqlite3';

/** The latest phase and freshness across every older phase of this member.
 * One scalar query replaces loading every run id and issuing a query per run;
 * old live training remains visible and historical failures remain excluded. */
export function memberRunActivity(db:Database.Database,sessionId:string,memberId:string,after:string):{
  runId:string; confirmed:boolean;
} | null {
  const row = db.prepare(`SELECT l.run_id,
    EXISTS(SELECT 1 FROM qm_run_links h JOIN console_operations o ON o.run_id=h.run_id
      WHERE h.session_id=? AND h.member_id=? AND o.status IN ('starting','queued','running') AND o.observed_at>=?
      UNION ALL SELECT 1 FROM qm_run_links h JOIN console_executions e ON e.run_id=h.run_id
      WHERE h.session_id=? AND h.member_id=? AND e.status IN ('starting','queued','running') AND e.observed_at>=?) AS confirmed
    FROM qm_run_links l WHERE l.session_id=? AND l.member_id=? ORDER BY l.rowid DESC LIMIT 1`)
    .get(sessionId,memberId,after,sessionId,memberId,after,sessionId,memberId) as {run_id:string;confirmed:number}|undefined;
  return row ? {runId:row.run_id,confirmed:row.confirmed===1} : null;
}
