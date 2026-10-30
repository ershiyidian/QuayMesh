export const diagnosticQuerySchema = `
CREATE INDEX qm_events_task_diagnostic_time ON qm_events(task_id,created_at,sequence);
CREATE INDEX qm_invocations_task_diagnostic_time ON qm_invocations(task_id,coalesce(finished_at,created_at),id);
CREATE INDEX qm_invocations_pending_state ON qm_invocations(state)
  WHERE state IN ('accepted','queued','running');
`;
