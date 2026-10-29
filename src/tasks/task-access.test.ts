import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import Database from "better-sqlite3";
import { runSqliteWrite } from "../db/async-write.js";
import { TaskAccessResolver, taskPrincipalFromAuthInfo, type TaskPrincipal } from "./task-access.js";

function principal(ownerId: string) {
  return taskPrincipalFromAuthInfo({ extra: { owner_id: ownerId } });
}

function legacyFixture(t: TestContext) {
  const db = new Database(":memory:");
  db.pragma("busy_timeout = 5000");
  db.exec(`CREATE TABLE qm_sessions (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, conversation_id TEXT);
    CREATE TABLE qm_tasks (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, state TEXT NOT NULL);
    CREATE TABLE writes (task_id TEXT NOT NULL);
    INSERT INTO qm_sessions VALUES
      ('storage-a', 'owner-a', 'chat-old'),
      ('storage-a2', 'owner-a', 'chat-new'),
      ('storage-b', 'owner-b', 'chat-other');
    INSERT INTO qm_tasks VALUES
      ('task-a', 'storage-a', 'active'),
      ('task-a2', 'storage-a2', 'active'),
      ('task-closed', 'storage-a', 'closed'),
      ('task-b', 'storage-b', 'active'),
      ('orphan', 'missing-storage', 'active');`);
  t.after(() => db.close());
  const access = new TaskAccessResolver(db, { ownerSource: "legacy-session" });
  return { db, access };
}

test("同 owner 在不同外部对话访问同一 Task，归属不变且没有外部 Session 输入", t => {
  const { access } = legacyFixture(t);
  const oldEntry = { authInfo: { extra: { owner_id: "owner-a" } }, conversationId: "chat-old" };
  const newEntry = { authInfo: { extra: { owner_id: "owner-a" } }, conversationId: "unseen-chat" };
  const a = access.resolve(taskPrincipalFromAuthInfo(oldEntry.authInfo), "task-a");
  const b = access.resolve(taskPrincipalFromAuthInfo(newEntry.authInfo), "task-a");
  assert.deepEqual(a, b);
  assert.deepEqual(a, { ownerId: "owner-a", taskId: "task-a", state: "active" });
  assert.equal(access.resolve(principal("owner-a"), "task-a2").taskId, "task-a2");
});

test("Task 身份必须明确，其他 owner、未知和孤立 Task 均拒绝且不泄漏归属", t => {
  const { access } = legacyFixture(t);
  for (const taskId of ["task-b", "missing", "orphan"]) {
    assert.throws(() => access.resolve(principal("owner-a"), taskId), { code: "TASK_ACCESS_DENIED" });
  }
  assert.throws(() => access.resolve(principal("owner-b"), "task-a"), { code: "TASK_ACCESS_DENIED" });
  for (const taskId of ["", " ", "x".repeat(257)]) {
    assert.throws(() => access.resolve(principal("owner-a"), taskId), { code: "TASK_ACCESS_INVALID_ID" });
  }
});

test("缺失认证与 JSON 伪造的 principal 不能作为 Task 权限", t => {
  const { access } = legacyFixture(t);
  for (const value of [undefined, null, {}, { extra: {} }, { extra: { owner_id: 42 } }]) {
    assert.throws(() => taskPrincipalFromAuthInfo(value), { code: "MISSING_AUTHENTICATED_OWNER" });
  }
  const spoofed = JSON.parse('{"ownerId":"owner-a"}') as TaskPrincipal;
  assert.throws(() => access.resolve(spoofed, "task-a"), { code: "MISSING_AUTHENTICATED_OWNER" });
  // A transport must rebuild middleware identity, not deserialize an old principal.
  const serialized = JSON.parse(JSON.stringify(principal("owner-a"))) as TaskPrincipal;
  assert.throws(() => access.resolve(serialized, "task-a"), { code: "MISSING_AUTHENTICATED_OWNER" });
});

test("已结束 Task 仍可授权读取，读取归属不授予接收者或执行控制权", t => {
  const { access } = legacyFixture(t);
  const result = access.resolve(principal("owner-a"), "task-closed");
  assert.deepEqual(result, { ownerId: "owner-a", taskId: "task-closed", state: "closed" });
  assert.ok(Object.isFrozen(result));
  assert.deepEqual(Object.keys(result).sort(), ["ownerId", "state", "taskId"]);
});

test("直接 Task owner 模式无需 Session 表，访问不依赖业务会话结构", t => {
  const db = new Database(":memory:");
  t.after(() => db.close());
  db.exec(`CREATE TABLE qm_tasks (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, state TEXT NOT NULL);
    INSERT INTO qm_tasks VALUES ('task-a', 'owner-a', 'active');`);
  const access = new TaskAccessResolver(db, { ownerSource: "task" });
  assert.equal(access.resolve(principal("owner-a"), "task-a").taskId, "task-a");
  assert.throws(() => access.resolve(principal("owner-b"), "task-a"), { code: "TASK_ACCESS_DENIED" });
});

test("迁移后直接 owner 为权威，不向旧 Session owner 或未回填字段降级", t => {
  const { db } = legacyFixture(t);
  db.exec("ALTER TABLE qm_tasks ADD COLUMN owner_id TEXT");
  db.prepare("UPDATE qm_tasks SET owner_id = ? WHERE id = ?").run("owner-b", "task-a");
  const access = new TaskAccessResolver(db, { ownerSource: "task" });
  assert.equal(access.resolve(principal("owner-b"), "task-a").ownerId, "owner-b");
  assert.throws(() => access.resolve(principal("owner-a"), "task-a"), { code: "TASK_ACCESS_DENIED" });
  assert.throws(() => access.resolve(principal("owner-a"), "task-a2"), { code: "TASK_ACCESS_DENIED" });
});

test("在真正获得写锁后重新解析 owner，旧的授权快照不能跨越权限变化", async t => {
  const { db, access } = legacyFixture(t);
  const actor = principal("owner-a");
  const previous = access.resolve(actor, "task-a");
  db.prepare("UPDATE qm_sessions SET owner_id = ? WHERE id = ?").run("owner-b", "storage-a");
  assert.equal(previous.ownerId, "owner-a");
  await assert.rejects(runSqliteWrite(db, () => {
    access.resolveInTransaction(actor, "task-a");
    db.prepare("INSERT INTO writes VALUES (?)").run("task-a");
  }), { code: "TASK_ACCESS_DENIED" });
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM writes").get() as { n: number }).n, 0);
  await runSqliteWrite(db, () => {
    access.resolveInTransaction(principal("owner-b"), "task-a");
    db.prepare("INSERT INTO writes VALUES (?)").run("task-a");
  });
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM writes").get() as { n: number }).n, 1);
});

test("解析器复用调用方事务，不自行开始或提交，失败由既有写队列回滚", async t => {
  const { db, access } = legacyFixture(t);
  assert.throws(() => access.resolveInTransaction(principal("owner-a"), "task-a"),
    { code: "TASK_ACCESS_TRANSACTION_REQUIRED" });
  await assert.rejects(runSqliteWrite(db, () => {
    db.prepare("INSERT INTO writes VALUES (?)").run("task-a");
    access.resolveInTransaction(principal("owner-b"), "task-a");
  }), { code: "TASK_ACCESS_DENIED" });
  assert.equal(db.inTransaction, false);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM writes").get() as { n: number }).n, 0);
});

test("无法识别的 Task 元数据不作为授权成功返回", t => {
  const { db, access } = legacyFixture(t);
  db.prepare("UPDATE qm_tasks SET state = ? WHERE id = ?").run("corrupt", "task-a");
  assert.throws(() => access.resolve(principal("owner-a"), "task-a"),
    { code: "TASK_ACCESS_METADATA_INVALID" });
});
