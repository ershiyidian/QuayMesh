export const executionOwnerSchema = `
CREATE TABLE execution_owners (
  domain TEXT NOT NULL CHECK(domain IN ('execution','operation')),
  id TEXT NOT NULL,
  generation TEXT NOT NULL,
  owner_token TEXT NOT NULL,
  owner_pid INTEGER NOT NULL,
  process_start TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY(domain,id)
);
CREATE INDEX execution_owners_process ON execution_owners(owner_pid,process_start);
CREATE INDEX qm_events_source_type ON qm_events(source_id,event_type,sequence DESC);
CREATE INDEX qm_events_operation_type ON qm_events(json_extract(data_json,'$.operation_id'),event_type,sequence DESC);
`;
