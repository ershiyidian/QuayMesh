export const reliabilitySchema = `
ALTER TABLE qm_invocations ADD COLUMN response_at TEXT;
CREATE TABLE qm_operation_keys (
  owner_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  root TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  invocation_id TEXT NOT NULL REFERENCES qm_invocations(id),
  PRIMARY KEY(owner_id,node_id,root,operation_key)
);
CREATE TABLE qm_process_handles (
  handle INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL UNIQUE REFERENCES console_operations(id)
);
CREATE TABLE qm_task_checkpoints (
  task_id TEXT NOT NULL REFERENCES qm_tasks(id),
  member_id TEXT NOT NULL REFERENCES qm_session_members(id),
  goal TEXT NOT NULL,
  decisions_json TEXT NOT NULL,
  next_action TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(task_id,member_id)
);
ALTER TABLE qm_tasks ADD COLUMN source_task_id TEXT;
CREATE TABLE qm_context_results (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  root TEXT NOT NULL,
  task_id TEXT REFERENCES qm_tasks(id),
  input_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX qm_context_results_task ON qm_context_results(task_id);
CREATE INDEX qm_invocations_operation ON qm_invocations(operation_id);
`;
