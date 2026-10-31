export const localUserApiSchema = `
CREATE TABLE qm_local_api_grants (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  credential_hash TEXT NOT NULL UNIQUE,
  capabilities_json TEXT NOT NULL,
  task_ids_json TEXT,
  peer_task_ids_json TEXT,
  source_task_id TEXT REFERENCES qm_tasks(id),
  kind TEXT NOT NULL CHECK(kind IN ('user','model')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX qm_local_api_grants_owner ON qm_local_api_grants(owner_id,created_at,id);
CREATE INDEX qm_local_api_grants_expiry ON qm_local_api_grants(kind,expires_at);
CREATE TABLE qm_local_api_dispatches (
  invocation_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES qm_tasks(id),
  node_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  grant_id TEXT REFERENCES qm_local_api_grants(id)
);
CREATE INDEX qm_local_api_dispatches_expiry ON qm_local_api_dispatches(expires_at);
CREATE INDEX qm_tasks_local_api_created ON qm_tasks(created_at,id);
CREATE TABLE qm_local_api_verifiers (
  grant_id TEXT PRIMARY KEY,
  credential_hash TEXT NOT NULL UNIQUE,
  node_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
`;
