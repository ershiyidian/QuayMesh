/** Internal execution-entry bindings. A Task remains the independent owned entity. */
export const taskBindingSchema = `
CREATE TABLE qm_task_bindings (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  entry_key TEXT NOT NULL,
  task_id TEXT REFERENCES qm_tasks(id) ON DELETE SET NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_id,client_id,entry_key)
);
CREATE INDEX qm_task_bindings_task_idx ON qm_task_bindings(task_id);
CREATE TABLE qm_task_binding_requests (
  binding_id TEXT NOT NULL REFERENCES qm_task_bindings(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK(action IN ('start','resume')),
  request_key TEXT NOT NULL,
  input_json TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES qm_tasks(id),
  result_revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(binding_id,action,request_key)
);
`;
