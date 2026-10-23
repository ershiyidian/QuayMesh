// Shared SQL expression for a console_work_runs row aliased as r. Reads and
// control calls must not erase the last substantive execution result.
export const LAST_RUN_OUTCOME_SQL = `COALESCE((SELECT child.status FROM (
  SELECT o.status,o.created_at,o.finished_at FROM console_operations o WHERE o.run_id=r.id
    AND o.rowid=(SELECT MAX(latest.rowid) FROM console_operations latest WHERE latest.run_id=r.id AND latest.kind NOT IN ('read','search','agent_control'))
  UNION ALL SELECT e.status,e.created_at,e.finished_at FROM console_executions e WHERE e.run_id=r.id
    AND e.rowid=(SELECT MAX(latest.rowid) FROM console_executions latest WHERE latest.run_id=r.id)
) child ORDER BY child.created_at DESC,child.finished_at DESC,
  CASE WHEN child.status='failed' THEN 2 WHEN child.status IN ('cancelled','stopped') THEN 1 ELSE 0 END DESC LIMIT 1),
  (SELECT o.status FROM console_operations o WHERE o.run_id=r.id ORDER BY o.rowid DESC LIMIT 1))`;
