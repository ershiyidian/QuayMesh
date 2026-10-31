/** Peer traffic is not user input and never participates in the user mailbox fence. */
export const taskPeerSchema = `
CREATE TABLE qm_task_peer_messages (
  id TEXT PRIMARY KEY,
  source_task_id TEXT NOT NULL REFERENCES qm_tasks(id) ON DELETE CASCADE,
  target_task_id TEXT NOT NULL REFERENCES qm_tasks(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK(sequence > 0),
  sender_client_id TEXT NOT NULL,
  sender_grant_id TEXT NOT NULL,
  message_key TEXT NOT NULL,
  body TEXT NOT NULL,
  reply_to_id TEXT REFERENCES qm_task_peer_messages(id),
  created_at TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  acknowledged_at TEXT,
  acknowledged_by_client TEXT,
  acknowledged_by_grant TEXT,
  CHECK(source_task_id <> target_task_id),
  CHECK((acknowledged_at IS NULL) = (acknowledged_by_client IS NULL)),
  CHECK((acknowledged_at IS NULL) = (acknowledged_by_grant IS NULL)),
  UNIQUE(target_task_id, sequence),
  UNIQUE(sender_client_id, source_task_id, target_task_id, message_key)
);
CREATE INDEX qm_task_peer_source_rate ON qm_task_peer_messages(source_task_id,created_at_ms);
CREATE INDEX qm_task_peer_target_rate ON qm_task_peer_messages(target_task_id,created_at_ms);
CREATE TABLE qm_task_peer_deliveries (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES qm_tasks(id) ON DELETE CASCADE,
  receiver_client_id TEXT NOT NULL,
  receiver_grant_id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  after_sequence INTEGER NOT NULL,
  page_limit INTEGER NOT NULL,
  message_ids_json TEXT NOT NULL,
  next_sequence INTEGER NOT NULL,
  has_more INTEGER NOT NULL CHECK(has_more IN (0,1)),
  created_at TEXT NOT NULL,
  UNIQUE(task_id, receiver_client_id, request_key)
);
`;
