export const consoleAuditSchema = `
-- 后台终态可以继续更新 result_json；调用首响应另存，避免改写历史响应。
ALTER TABLE qm_invocations ADD COLUMN response_json TEXT;
CREATE TABLE console_audit (
  id TEXT PRIMARY KEY,
  time INTEGER NOT NULL,
  node_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  actor TEXT NOT NULL,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  request_key TEXT NOT NULL
);
CREATE INDEX console_audit_time ON console_audit(time DESC,id);
CREATE INDEX console_audit_request ON console_audit(action,target,request_key);
CREATE TABLE console_audit_imports (
  source TEXT PRIMARY KEY,
  imported_at TEXT NOT NULL
);
CREATE TABLE console_archive_steps (
  batch_id TEXT NOT NULL REFERENCES console_archive_batches(id),
  request_key TEXT NOT NULL,
  managed_thread_id TEXT REFERENCES console_threads(id),
  before_status TEXT NOT NULL,
  expected_revision INTEGER,
  created_at TEXT NOT NULL,
  PRIMARY KEY (batch_id,request_key)
);
`;
