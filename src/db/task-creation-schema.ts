// 创建回执属于认证客户端的请求键，不建立默认 Task 或聊天绑定。
export const taskCreationSchema = `
CREATE TABLE qm_task_creation_receipts (
  owner_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  input_json TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES qm_tasks(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY(owner_id,client_id,request_key)
);
`;
