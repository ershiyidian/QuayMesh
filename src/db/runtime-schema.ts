export const runtimeSchema = `
CREATE TABLE IF NOT EXISTS qm_runtime_admission (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  accepting INTEGER NOT NULL CHECK(accepting IN (0,1)),
  reason TEXT,
  changed_at TEXT NOT NULL
);
INSERT OR IGNORE INTO qm_runtime_admission(id,accepting,changed_at) VALUES(1,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
CREATE TABLE IF NOT EXISTS qm_runtime_work (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  owner_pid INTEGER NOT NULL,
  kind TEXT NOT NULL,
  operation_id TEXT,
  task_id TEXT,
  blocking INTEGER NOT NULL CHECK(blocking IN (0,1)),
  started_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS qm_runtime_work_task ON qm_runtime_work(task_id,kind);
CREATE TABLE IF NOT EXISTS qm_transfers (
  id TEXT PRIMARY KEY,
  request_key TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  session_id TEXT,
  task_id TEXT,
  member_id TEXT,
  source_node TEXT NOT NULL,
  source_workspace TEXT NOT NULL,
  source_path TEXT NOT NULL,
  destination_workspace TEXT NOT NULL,
  destination_path TEXT NOT NULL,
  overwrite INTEGER NOT NULL,
  status TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER,
  temporary_path TEXT,
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE(owner_id,request_key)
);
CREATE INDEX IF NOT EXISTS qm_transfers_task ON qm_transfers(task_id,status);
`;
