export const taskMailboxSchema = `
CREATE TABLE qm_task_message_receivers (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES qm_tasks(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  entry_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE UNIQUE INDEX qm_task_message_receiver_entry
  ON qm_task_message_receivers(task_id,owner_id,client_id,entry_key) WHERE revoked_at IS NULL;
CREATE TABLE qm_task_message_deliveries (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES qm_tasks(id) ON DELETE CASCADE,
  receiver_id TEXT NOT NULL REFERENCES qm_task_message_receivers(id),
  request_key TEXT NOT NULL,
  message_ids_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  lease_expires_at INTEGER NOT NULL,
  UNIQUE(task_id, receiver_id, request_key)
);
CREATE TABLE qm_task_messages (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES qm_tasks(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK(sequence > 0),
  message_key TEXT NOT NULL,
  body TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','assistant')),
  reply_to_json TEXT NOT NULL DEFAULT '[]',
  sender_receiver_id TEXT REFERENCES qm_task_message_receivers(id),
  created_at TEXT NOT NULL,
  delivery_id TEXT REFERENCES qm_task_message_deliveries(id),
  acknowledged_at TEXT,
  acknowledged_by TEXT,
  UNIQUE(task_id, sequence),
  UNIQUE(task_id, message_key),
  CHECK((acknowledged_at IS NULL) = (acknowledged_by IS NULL)),
  CHECK((role = 'user' AND sender_receiver_id IS NULL) OR (role = 'assistant' AND sender_receiver_id IS NOT NULL))
);
CREATE INDEX qm_task_messages_pending
  ON qm_task_messages(task_id, sequence) WHERE role = 'user' AND acknowledged_at IS NULL;
CREATE INDEX qm_task_messages_delivery ON qm_task_messages(delivery_id);
`;
