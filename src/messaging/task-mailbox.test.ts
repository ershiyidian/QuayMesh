import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import Database from "better-sqlite3";
import { taskMailboxSchema } from "../db/task-mailbox-schema.js";
import { runSqliteWrite } from "../db/async-write.js";
import { taskPrincipalFromAuthInfo } from "../tasks/task-access.js";
import { toolResultBytes } from "../mcp-tool-result.js";
import { MAX_TASK_MESSAGE_BATCH_BYTES, TaskMailboxStore, type TaskMailboxClaim, type TaskMailboxMessage, type TaskMailboxScope } from "./task-mailbox.js";

function fixture(t: TestContext) {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(`CREATE TABLE qm_sessions (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL);
    CREATE TABLE qm_tasks (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES qm_sessions(id), state TEXT NOT NULL);
    INSERT INTO qm_sessions VALUES ('session-a', 'owner-a'), ('session-b', 'owner-b');
    INSERT INTO qm_tasks VALUES ('task-a', 'session-a', 'active'), ('task-a2', 'session-a', 'active'),
      ('task-b', 'session-b', 'active');
    CREATE TABLE qm_task_finalizations(task_id TEXT PRIMARY KEY,completed_at TEXT,error TEXT);`);
  db.exec(taskMailboxSchema);
  for (const receiver of ["receiver", "old", "new"]) db.prepare(`INSERT INTO qm_task_message_receivers
    (id,task_id,owner_id,client_id,entry_key,created_at) VALUES(?,'task-a','owner-a','test',?,'2026-10-28T00:00:00Z')`).run(receiver,receiver);
  t.after(() => db.close());
  let now = 1_800_000_000_000;
  const scope: TaskMailboxScope = { principal: taskPrincipalFromAuthInfo({ extra: { owner_id: "owner-a" } }), taskId: "task-a" };
  const mailbox = new TaskMailboxStore(db, { ownerSource: "legacy-session", now: () => now });
  return { db, scope, mailbox, advance: (ms: number) => { now += ms; } };
}

function offered(claim: TaskMailboxClaim): Extract<TaskMailboxClaim, { status: "offered" }> {
  assert.equal(claim.status, "offered");
  return claim as Extract<TaskMailboxClaim, { status: "offered" }>;
}

test("消息重试复用身份，异文重用键冲突，关闭后仍能取回旧回执", async t => {
  const { db, scope, mailbox } = fixture(t);
  const first = await mailbox.enqueue(scope, { messageKey: "key", body: "先检查任务状态" });
  const retry = await mailbox.enqueue(scope, { messageKey: "key", body: "先检查任务状态" });
  assert.equal(retry.message.id, first.message.id);
  assert.equal(retry.replayed, true);
  assert.deepEqual(mailbox.inspect(scope), { sequence: 1, pending: 1 });
  await assert.rejects(mailbox.enqueue(scope, { messageKey: "key", body: "改成别的操作" }),
    { code: "TASK_MAILBOX_IDEMPOTENCY_CONFLICT" });
  db.prepare("UPDATE qm_tasks SET state = 'closed' WHERE id = ?").run(scope.taskId);
  assert.equal((await mailbox.enqueue(scope, { messageKey: "key", body: "先检查任务状态" })).message.id, first.message.id);
  await assert.rejects(mailbox.enqueue(scope, { messageKey: "new", body: "继续" }), { code: "TASK_MAILBOX_TASK_CLOSED" });
});

test("所有操作只核对认证owner和明确Task，不把外部会话作为父层", async t => {
  const { scope, mailbox } = fixture(t);
  await mailbox.enqueue(scope, { messageKey: "key", body: "私有消息" });
  for (const invalid of [
    { ...scope, principal: taskPrincipalFromAuthInfo({ extra: { owner_id: "owner-b" } }) },
    { ...scope, taskId: "missing" },
    { ...scope, taskId: "task-b" },
  ]) {
    assert.throws(() => mailbox.inspect(invalid), { code: "TASK_ACCESS_DENIED" });
    await assert.rejects(mailbox.enqueue(invalid, { messageKey: "new", body: "无权写入" }),
      { code: "TASK_ACCESS_DENIED" });
    await assert.rejects(mailbox.claim(invalid, { receiverId: "receiver", requestKey: "claim" }),
      { code: "TASK_ACCESS_DENIED" });
    await assert.rejects(mailbox.acknowledge(invalid, { receiverId: "receiver", deliveryId: "delivery", messageIds: ["message"] }),
      { code: "TASK_ACCESS_DENIED" });
  }
});

test("并发工具只能领取一个队首批次，相同领取键重试返回同一批", async t => {
  const { scope, mailbox } = fixture(t);
  for (const key of ["one", "two", "three"]) await mailbox.enqueue(scope, { messageKey: key, body: key });
  const results = await Promise.all([
    mailbox.claim(scope, { receiverId: "receiver", requestKey: "first", maxMessages: 2 }),
    mailbox.claim(scope, { receiverId: "receiver", requestKey: "second", maxMessages: 2 }),
  ]);
  const first = offered(results[0]);
  assert.deepEqual(first.messages.map(item => item.sequence), [1, 2]);
  assert.equal(results[1].status, "leased");
  const retry = offered(await mailbox.claim(scope, { receiverId: "receiver", requestKey: "first", maxMessages: 1 }));
  assert.equal(retry.deliveryId, first.deliveryId);
  assert.equal(retry.replayed, true);
  assert.deepEqual(retry.messages, first.messages);
});

test("确认必须属于实际投递批次，不能越过尚未读到的消息", async t => {
  const { scope, mailbox } = fixture(t);
  const ids: string[] = [];
  for (const key of ["one", "two", "three"]) ids.push((await mailbox.enqueue(scope, { messageKey: key, body: key })).message.id);
  const batch = offered(await mailbox.claim(scope, { receiverId: "receiver", requestKey: "claim", maxMessages: 2 }));
  const ack = (messageIds: string[]) => mailbox.acknowledge(scope, { receiverId: "receiver", deliveryId: batch.deliveryId, messageIds });
  await assert.rejects(ack([ids[1]]), { code: "TASK_MAILBOX_ACK_OUT_OF_ORDER" });
  await assert.rejects(ack([ids[0], ids[2]]), { code: "TASK_MAILBOX_MESSAGE_NOT_OFFERED" });
  assert.equal(mailbox.inspect(scope).pending, 3);
  assert.equal((await ack([ids[0]])).pending, 2);
  assert.equal((await ack([ids[0]])).pending, 2);
  assert.equal((await ack([ids[0], ids[1]])).pending, 1);
  assert.equal((await mailbox.claim(scope, { receiverId: "receiver", requestKey: "claim" })).status, "acknowledged");
  const next = offered(await mailbox.claim(scope, { receiverId: "receiver", requestKey: "next" }));
  assert.deepEqual(next.messages.map(item => item.id), [ids[2]]);
});

test("过期租约可重投，旧接收方或另一接收方的确认均被拒绝", async t => {
  const { scope, mailbox, advance } = fixture(t);
  const item = await mailbox.enqueue(scope, { messageKey: "one", body: "继续" });
  const old = offered(await mailbox.claim(scope, { receiverId: "old", requestKey: "claim", leaseMs: 1_000 }));
  assert.equal((await mailbox.claim(scope, { receiverId: "new", requestKey: "while-leased" })).status, "leased");
  assert.equal(mailbox.list(scope).messages[0].status, "offered");
  assert.equal(mailbox.list(scope, { filter: "awaiting_reply" }).messages.length, 0);
  advance(1_001);
  await assert.rejects(mailbox.claim(scope, { receiverId: "old", requestKey: "claim" }), { code: "TASK_MAILBOX_LEASE_EXPIRED" });
  await assert.rejects(mailbox.acknowledge(scope, { receiverId: "old", deliveryId: old.deliveryId, messageIds: [item.message.id] }),
    { code: "TASK_MAILBOX_LEASE_EXPIRED" });
  const fresh = offered(await mailbox.claim(scope, { receiverId: "new", requestKey: "claim" }));
  assert.notEqual(fresh.deliveryId, old.deliveryId);
  await assert.rejects(mailbox.acknowledge(scope, { receiverId: "old", deliveryId: old.deliveryId, messageIds: [item.message.id] }),
    { code: "TASK_MAILBOX_DELIVERY_SUPERSEDED" });
  await assert.rejects(mailbox.acknowledge(scope, { receiverId: "old", deliveryId: fresh.deliveryId, messageIds: [item.message.id] }),
    { code: "TASK_MAILBOX_RECEIVER_MISMATCH" });
  assert.equal((await mailbox.acknowledge(scope, { receiverId: "new", deliveryId: fresh.deliveryId, messageIds: [item.message.id] })).pending, 0);
});

test("相同用户的其他任务不能借用投递凭证确认本任务", async t => {
  const { scope, mailbox } = fixture(t);
  const second = { ...scope, taskId: "task-a2" };
  const a = await mailbox.enqueue(scope, { messageKey: "same-key", body: "任务一" });
  const b = await mailbox.enqueue(second, { messageKey: "same-key", body: "任务二" });
  const batch = offered(await mailbox.claim(scope, { receiverId: "receiver", requestKey: "claim" }));
  await assert.rejects(mailbox.acknowledge(second, { receiverId: "receiver", deliveryId: batch.deliveryId, messageIds: [a.message.id] }),
    { code: "TASK_MAILBOX_RECEIVER_MISMATCH" });
  await assert.rejects(mailbox.acknowledge(scope, { receiverId: "receiver", deliveryId: batch.deliveryId, messageIds: [b.message.id] }),
    { code: "TASK_MAILBOX_MESSAGE_NOT_OFFERED" });
});

test("确认后的重试跨过租约时限仍幂等", async t => {
  const { scope, mailbox, advance } = fixture(t);
  const item = await mailbox.enqueue(scope, { messageKey: "one", body: "继续" });
  const batch = offered(await mailbox.claim(scope, { receiverId: "receiver", requestKey: "claim", leaseMs: 1_000 }));
  const input = { receiverId: "receiver", deliveryId: batch.deliveryId, messageIds: [item.message.id] };
  await mailbox.acknowledge(scope, input);
  advance(2_000);
  assert.equal((await mailbox.acknowledge(scope, input)).pending, 0);
});

test("finish 检查必须和终态提交共享事务，新消息会阻止旧快照完成", async t => {
  const { db, scope, mailbox } = fixture(t);
  assert.throws(() => mailbox.assertReadyToFinishInTransaction(scope, 0), { code: "TASK_MAILBOX_TRANSACTION_REQUIRED" });
  const oldSnapshot = mailbox.inspect(scope);
  const item = await mailbox.enqueue(scope, { messageKey: "one", body: "先处理这条" });
  await assert.rejects(runSqliteWrite(db, () => {
    mailbox.assertReadyToFinishInTransaction(scope, oldSnapshot.sequence);
    db.prepare("UPDATE qm_tasks SET state = 'closed' WHERE id = ?").run(scope.taskId);
  }), { code: "TASK_MAILBOX_CHANGED" });
  await assert.rejects(runSqliteWrite(db, () => mailbox.assertReadyToFinishInTransaction(scope, 1)),
    { code: "TASK_MAILBOX_INPUT_PENDING" });
  const batch = offered(await mailbox.claim(scope, { receiverId: "receiver", requestKey: "claim" }));
  await mailbox.acknowledge(scope, { receiverId: "receiver", deliveryId: batch.deliveryId, messageIds: [item.message.id] });
  await runSqliteWrite(db, () => {
    mailbox.assertReadyToFinishInTransaction(scope, 1);
    db.prepare("UPDATE qm_tasks SET state = 'closed' WHERE id = ?").run(scope.taskId);
  });
  await assert.rejects(mailbox.enqueue(scope, { messageKey: "late", body: "稍后继续" }), { code: "TASK_MAILBOX_TASK_CLOSED" });
});

test("领取状态持久保存，新 Store 实例继续读取同一批次", async t => {
  const { db, scope, mailbox } = fixture(t);
  const item = await mailbox.enqueue(scope, { messageKey: "one", body: "可恢复消息" });
  const first = offered(await mailbox.claim(scope, { receiverId: "receiver", requestKey: "claim" }));
  const restored = new TaskMailboxStore(db, { ownerSource: "legacy-session", now: () => 1_800_000_000_001 });
  const replay = offered(await restored.claim(scope, { receiverId: "receiver", requestKey: "claim" }));
  assert.equal(replay.deliveryId, first.deliveryId);
  assert.equal(replay.messages[0].id, item.message.id);
});

test("消息按 UTF-8 字节限制，回包按实际 JSON 字节预算截取完整队首", async t => {
  const { scope, mailbox } = fixture(t);
  await assert.rejects(mailbox.enqueue(scope, { messageKey: "large", body: "😀".repeat(5_000) }),
    { code: "TASK_MAILBOX_INVALID_BODY" });
  await assert.rejects(mailbox.enqueue(scope, { messageKey: "escaped", body: "\u0000".repeat(4_000) }),
    { code: "TASK_MAILBOX_INVALID_BODY" });
  for (let index = 0; index < 8; index++) {
    await mailbox.enqueue(scope, { messageKey: String(index), body: "a".repeat(16 * 1024) });
  }
  const batch = offered(await mailbox.claim(scope, { receiverId: "receiver", requestKey: "claim", maxMessages: 8 }));
  assert.equal(batch.messages.length, 1);
  assert.deepEqual(batch.messages.map(item => item.sequence), [1]);
  assert.ok(toolResultBytes({ content: [], structuredContent: { messages: batch.messages } }) <= MAX_TASK_MESSAGE_BATCH_BYTES);
  assert.equal(mailbox.inspect(scope).pending, 8);
});

test("旧消息和答复的精确重试保留可交付正文，新写入仍使用当前编码预算", async t => {
  const { scope, mailbox, db } = fixture(t);
  const user = (await mailbox.enqueue(scope, { messageKey: "user", body: "old user body" })).message;
  const delivery = offered(await mailbox.claim(scope, { receiverId: "receiver", requestKey: "read" }));
  await mailbox.acknowledge(scope, { receiverId: "receiver", deliveryId: delivery.deliveryId, messageIds: [user.id] });
  const reply = (await mailbox.reply(scope, { receiverId: "receiver", messageKey: "reply", replyTo: [user.id], body: "old reply body" })).message;
  const oldBody = "\\".repeat(7600);
  db.prepare("UPDATE qm_task_messages SET body=? WHERE task_id=?").run(oldBody, scope.taskId);
  const rows = () => db.prepare("SELECT * FROM qm_task_messages WHERE task_id=? ORDER BY sequence").all(scope.taskId);
  const original = rows();
  const retriedUser = await mailbox.enqueue(scope, { messageKey: "user", body: oldBody });
  const retriedReply = await mailbox.reply(scope, { receiverId: "receiver", messageKey: "reply", replyTo: [user.id], body: oldBody });
  assert.equal(retriedUser.message.id, user.id); assert.equal(retriedUser.replayed, true);
  assert.equal(retriedReply.message.id, reply.id); assert.equal(retriedReply.replayed, true);
  assert.equal(retriedUser.message.body, oldBody); assert.equal(retriedReply.message.body, oldBody);
  assert.equal(mailbox.list(scope).messages[0].body, oldBody);
  await assert.rejects(mailbox.enqueue(scope, { messageKey: "new", body: oldBody }), { code: "TASK_MAILBOX_INVALID_BODY" });
  await assert.rejects(mailbox.reply(scope, { receiverId: "receiver", messageKey: "new-reply", replyTo: [user.id], body: oldBody }),
    { code: "TASK_MAILBOX_INVALID_BODY" });
  assert.deepEqual(rows(), original, "reads and failed new writes do not rewrite the original author, acknowledgement, or body");
});

test("接收者由持久Task/owner/client/宿主入口绑定产生，新外部入口可绑定同Task", async t => {
  const { scope, mailbox, db } = fixture(t);
  const first = await mailbox.bindReceiver(scope, { clientId: "client", correlationId: "entry-a" });
  assert.equal(await mailbox.bindReceiver(scope, { clientId: "client", correlationId: "entry-a" }), first);
  const second = await mailbox.bindReceiver(scope, { clientId: "client", correlationId: "entry-b" });
  assert.notEqual(second, first);
  const otherTask = await mailbox.bindReceiver({ ...scope, taskId: "task-a2" }, { clientId: "client", correlationId: "entry-a" });
  assert.notEqual(otherTask, first);
  await assert.rejects(mailbox.bindReceiver(scope, { clientId: "client", correlationId: "" }), { code: "TASK_MAILBOX_ENTRY_REQUIRED" });
  await assert.rejects(mailbox.claim(scope, { receiverId: "invented", requestKey: "x" }), { code: "TASK_MAILBOX_RECEIVER_MISMATCH" });
  db.prepare("UPDATE qm_task_message_receivers SET revoked_at=? WHERE id=?").run("2026-10-28T01:00:00Z", first);
  await assert.rejects(mailbox.claim(scope, { receiverId: first, requestKey: "x" }), { code: "TASK_MAILBOX_RECEIVER_MISMATCH" });
  assert.notEqual(await mailbox.bindReceiver(scope, { clientId: "client", correlationId: "entry-a" }), first);
});

test("历史确认不占有回复权，同Task其他入口可接续且原确认事实保持不变", async t => {
  const { scope, mailbox, db } = fixture(t);
  const item = await mailbox.enqueue(scope, { messageKey: "question", body: "请解释检查结果" });
  assert.equal(item.message.role, "user");
  assert.equal(mailbox.list(scope).messages[0].status, "queued");
  assert.equal(mailbox.list(scope).messages[0].offeredAt, null);
  const claim = offered(await mailbox.claim(scope, { receiverId: "receiver", requestKey: "read" }));
  assert.equal(mailbox.list(scope).messages[0].status, "offered");
  assert.ok(mailbox.list(scope).messages[0].offeredAt);
  const input = { receiverId: "receiver", messageKey: "answer", replyTo: [item.message.id], body: "已检查，目前还有两项待验证。" };
  await assert.rejects(mailbox.reply(scope, input), { code: "TASK_MAILBOX_REPLY_NOT_ACKNOWLEDGED" });
  await mailbox.acknowledge(scope, { receiverId: "receiver", deliveryId: claim.deliveryId, messageIds: [item.message.id] });
  assert.equal(mailbox.list(scope).messages[0].status, "acknowledged");
  const acknowledged = db.prepare("SELECT acknowledged_at,acknowledged_by,delivery_id FROM qm_task_messages WHERE id=?").get(item.message.id);
  assert.deepEqual(mailbox.list(scope, { filter: "awaiting_reply" }).messages.map(row => row.id), [item.message.id]);
  const answer = await mailbox.reply(scope, { ...input, receiverId: "new" });
  assert.equal(answer.message.role, "assistant");
  assert.equal(answer.message.status, "replied");
  assert.deepEqual(answer.message.replyTo, [item.message.id]);
  assert.deepEqual(mailbox.inspect(scope), { sequence: 2, pending: 0 });
  assert.deepEqual(db.prepare("SELECT acknowledged_at,acknowledged_by,delivery_id FROM qm_task_messages WHERE id=?").get(item.message.id), acknowledged);
  assert.equal((db.prepare("SELECT sender_receiver_id FROM qm_task_messages WHERE id=?").get(answer.message.id) as { sender_receiver_id: string }).sender_receiver_id, "new");
  const repeated = await mailbox.reply(scope, input);
  assert.equal(repeated.message.id, answer.message.id);
  assert.equal(repeated.replayed, true);
  assert.equal(mailbox.list(scope, { filter: "awaiting_reply" }).messages.length, 0);
  assert.equal((db.prepare("SELECT sender_receiver_id FROM qm_task_messages WHERE id=?").get(answer.message.id) as { sender_receiver_id: string }).sender_receiver_id, "new",
    "cross-entry replay must not rewrite the original reply author");
  await assert.rejects(mailbox.reply(scope, { ...input, body: "另一份答复" }), { code: "TASK_MAILBOX_IDEMPOTENCY_CONFLICT" });
  assert.deepEqual(mailbox.list(scope).messages.map(row => row.role), ["user", "assistant"]);
});

test("待回复历史有界分页且不重入pending，已确认未答消息不增加结束门槛", async t => {
  const { scope, mailbox, db } = fixture(t);
  const inputs: TaskMailboxMessage[] = [];
  for (const key of ["one", "two", "three"]) inputs.push((await mailbox.enqueue(scope, { messageKey: key, body: key })).message);
  const batch = offered(await mailbox.claim(scope, { receiverId: "old", requestKey: "read" }));
  await mailbox.acknowledge(scope, { receiverId: "old", deliveryId: batch.deliveryId, messageIds: batch.messages.map(row => row.id) });
  await runSqliteWrite(db, () => mailbox.assertReadyToFinishInTransaction(scope, 3));
  assert.equal((await mailbox.claim(scope, { receiverId: "new", requestKey: "after-ack" })).status, "empty");
  await mailbox.reply(scope, { receiverId: "new", messageKey: "answer-two", replyTo: [inputs[1].id], body: "Second response" });
  await mailbox.enqueue(scope, { messageKey: "queued", body: "Receive this separately" });
  const before = db.prepare("SELECT id,delivery_id,acknowledged_at,acknowledged_by FROM qm_task_messages ORDER BY sequence").all();
  const first = mailbox.list(scope, { filter: "awaiting_reply", limit: 1 });
  assert.deepEqual(first.messages.map(row => row.id), [inputs[2].id]);
  assert.equal(first.nextBeforeSequence, inputs[2].sequence);
  const next = mailbox.list(scope, { filter: "awaiting_reply", limit: 1, beforeSequence: first.nextBeforeSequence! });
  assert.deepEqual(next.messages.map(row => row.id), [inputs[0].id]);
  assert.equal(next.nextBeforeSequence, null);
  assert.deepEqual(first.snapshot, { sequence: 5, pending: 1 });
  assert.equal(mailbox.list(scope).messages.length, 5);
  assert.deepEqual(db.prepare("SELECT id,delivery_id,acknowledged_at,acknowledged_by FROM qm_task_messages ORDER BY sequence").all(), before);
  assert.throws(() => mailbox.list({ ...scope, taskId: "task-b" }, { filter: "awaiting_reply" }), { code: "TASK_ACCESS_DENIED" });
});

test("同key跨入口并发只保存一份回复，新key不能重用已答回合且关闭后不新增正文", async t => {
  const { scope, mailbox, db } = fixture(t);
  const item = (await mailbox.enqueue(scope, { messageKey: "question", body: "Please review" })).message;
  const delivery = offered(await mailbox.claim(scope, { receiverId: "old", requestKey: "read" }));
  await mailbox.acknowledge(scope, { receiverId: "old", deliveryId: delivery.deliveryId, messageIds: [item.id] });
  const input = { messageKey: "one-intent", replyTo: [item.id], body: "A shared saved response" };
  const same = await Promise.all([mailbox.reply(scope, { ...input, receiverId: "old" }), mailbox.reply(scope, { ...input, receiverId: "new" })]);
  assert.equal(same[0].message.id, same[1].message.id);
  assert.equal(same.filter(row => row.replayed).length, 1);
  const separate = await Promise.allSettled([mailbox.reply(scope, { ...input, receiverId: "old", messageKey: "parallel-a", body: "First perspective" }),
    mailbox.reply(scope, { ...input, receiverId: "new", messageKey: "parallel-b", body: "Second perspective" })]);
  assert.deepEqual(separate.map(result => result.status === "rejected" ? result.reason.code : "saved"),
    ["TASK_MAILBOX_REPLY_TURN_CLOSED", "TASK_MAILBOX_REPLY_TURN_CLOSED"]);
  assert.deepEqual(mailbox.inspect(scope), { sequence: 2, pending: 0 });
  await assert.rejects(mailbox.reply(scope, { ...input, receiverId: "new", body: "Different intent" }), { code: "TASK_MAILBOX_IDEMPOTENCY_CONFLICT" });
  await assert.rejects(mailbox.reply(scope, { ...input, receiverId: "invented" }), { code: "TASK_MAILBOX_RECEIVER_MISMATCH" });
  db.prepare("UPDATE qm_tasks SET state='closed' WHERE id=?").run(scope.taskId);
  assert.equal((await mailbox.reply(scope, { ...input, receiverId: "new" })).message.id, same[0].message.id);
  await assert.rejects(mailbox.reply(scope, { ...input, receiverId: "new", messageKey: "after-close" }), { code: "TASK_MAILBOX_TASK_CLOSED" });
  assert.equal(mailbox.list(scope).messages.length, 2);
});

test("两个入口以不同key竞争尚未答复的用户消息，事务只允许一个新回复", async t => {
  const { scope, mailbox, db } = fixture(t);
  const user = (await mailbox.enqueue(scope, { messageKey: "question", body: "Please inspect" })).message;
  const delivery = offered(await mailbox.claim(scope, { receiverId: "old", requestKey: "read" }));
  await mailbox.acknowledge(scope, { receiverId: "old", deliveryId: delivery.deliveryId, messageIds: [user.id] });
  const restored = new TaskMailboxStore(db, { ownerSource: "legacy-session" });
  const results = await Promise.allSettled([
    mailbox.reply(scope, { receiverId: "old", messageKey: "answer-a", replyTo: [user.id], body: "First response" }),
    restored.reply(scope, { receiverId: "new", messageKey: "answer-b", replyTo: [user.id], body: "Second response" }),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const rejected = results.find(result => result.status === "rejected") as PromiseRejectedResult;
  assert.equal(rejected.reason.code, "TASK_MAILBOX_REPLY_TURN_CLOSED");
  assert.equal(rejected.reason.effect, "not_started");
  assert.deepEqual(mailbox.inspect(scope), { sequence: 2, pending: 0 });
  assert.deepEqual(mailbox.list(scope).messages.map(row => row.role), ["user", "assistant"]);
  assert.equal(mailbox.list(scope, { filter: "awaiting_reply" }).messages.length, 0);
});

test("长任务首次回复不过期，古老已答消息不能主动开新回合，新用户输入可以", async t => {
  const { scope, mailbox, advance } = fixture(t);
  const user = (await mailbox.enqueue(scope, { messageKey: "long-request", body: "Report when the long job finishes" })).message;
  const delivery = offered(await mailbox.claim(scope, { receiverId: "old", requestKey: "read" }));
  await mailbox.acknowledge(scope, { receiverId: "old", deliveryId: delivery.deliveryId, messageIds: [user.id] });
  advance(90 * 24 * 60 * 60_000);
  const input = { receiverId: "new", messageKey: "answer", replyTo: [user.id], body: "The requested result" };
  const reply = await mailbox.reply(scope, input);
  assert.equal(reply.replayed, false, "unanswered user input remains replyable for long-running work");
  advance(90 * 24 * 60 * 60_000);
  await assert.rejects(mailbox.reply(scope, { ...input, messageKey: "unsolicited-followup" }),
    { code: "TASK_MAILBOX_REPLY_TURN_CLOSED", effect: "not_started" });
  assert.equal((await mailbox.reply(scope, input)).message.id, reply.message.id);
  const next = (await mailbox.enqueue(scope, { messageKey: "followup", body: "Please check one more thing" })).message;
  const nextDelivery = offered(await mailbox.claim(scope, { receiverId: "new", requestKey: "read-followup" }));
  await mailbox.acknowledge(scope, { receiverId: "new", deliveryId: nextDelivery.deliveryId, messageIds: [next.id] });
  const nextReply = await mailbox.reply(scope, { ...input, messageKey: "new-answer", replyTo: [next.id], body: "The new requested result" });
  assert.notEqual(nextReply.message.id, reply.message.id);
  assert.deepEqual(mailbox.inspect(scope), { sequence: 4, pending: 0 });
});

test("混合已答与未答目标整体拒绝，未答回合不被消耗且精确重试的目标保持不可变", async t => {
  const { scope, mailbox, db } = fixture(t);
  const users: TaskMailboxMessage[] = [];
  for (const key of ["one", "two", "three"]) users.push((await mailbox.enqueue(scope, { messageKey: key, body: key })).message);
  const delivery = offered(await mailbox.claim(scope, { receiverId: "receiver", requestKey: "read" }));
  await mailbox.acknowledge(scope, { receiverId: "receiver", deliveryId: delivery.deliveryId, messageIds: users.map(row => row.id) });
  await mailbox.reply(scope, { receiverId: "receiver", messageKey: "first", replyTo: [users[0].id], body: "First response" });
  const rows = () => db.prepare("SELECT * FROM qm_task_messages WHERE task_id=? ORDER BY sequence").all(scope.taskId);
  const before = rows();
  const input = { receiverId: "new", messageKey: "combined", replyTo: [users[0].id, users[1].id], body: "Combined response" };
  await assert.rejects(mailbox.reply(scope, input), { code: "TASK_MAILBOX_REPLY_TURN_CLOSED" });
  assert.deepEqual(rows(), before);
  assert.deepEqual(mailbox.list(scope, { filter: "awaiting_reply" }).messages.map(row => row.id), [users[1].id, users[2].id]);
  const valid = { ...input, replyTo: [users[1].id, users[2].id] };
  const saved = await mailbox.reply(scope, valid);
  assert.equal((await mailbox.reply(scope, { ...valid, replyTo: [...valid.replyTo].reverse() })).message.id, saved.message.id);
  await assert.rejects(mailbox.reply(scope, { ...valid, replyTo: [users[2].id] }), { code: "TASK_MAILBOX_IDEMPOTENCY_CONFLICT" });
  assert.equal(mailbox.list(scope, { filter: "awaiting_reply" }).messages.length, 0);
  assert.deepEqual(mailbox.inspect(scope), { sequence: 5, pending: 0 });
});

test("历史多回复原样保留且各自精确重放，不再允许新key扩展旧用户回合", async t => {
  const { scope, mailbox, db } = fixture(t);
  const user = (await mailbox.enqueue(scope, { messageKey: "question", body: "Historic request" })).message;
  const delivery = offered(await mailbox.claim(scope, { receiverId: "old", requestKey: "read" }));
  await mailbox.acknowledge(scope, { receiverId: "old", deliveryId: delivery.deliveryId, messageIds: [user.id] });
  const input = { receiverId: "old", messageKey: "original", replyTo: [user.id], body: "First saved response" };
  const original = (await mailbox.reply(scope, input)).message;
  db.prepare(`INSERT INTO qm_task_messages
    (id,task_id,sequence,message_key,body,role,reply_to_json,sender_receiver_id,created_at)
    SELECT 'legacy-answer',task_id,3,'legacy-key','Historic additional response',role,reply_to_json,'new',created_at
    FROM qm_task_messages WHERE id=?`).run(original.id);
  const before = db.prepare("SELECT * FROM qm_task_messages ORDER BY sequence").all();
  assert.equal((await mailbox.reply(scope, input)).message.id, original.id);
  assert.equal((await mailbox.reply(scope, { ...input, receiverId: "new", messageKey: "legacy-key", body: "Historic additional response" })).message.id, "legacy-answer");
  await assert.rejects(mailbox.reply(scope, { ...input, messageKey: "new-third" }), { code: "TASK_MAILBOX_REPLY_TURN_CLOSED" });
  assert.deepEqual(db.prepare("SELECT * FROM qm_task_messages ORDER BY sequence").all(), before);
});

test("回复仍检查收尾门禁和当前接收者权限，已撤销入口不能重放保存回复", async t => {
  const { scope, mailbox, db } = fixture(t);
  const user = (await mailbox.enqueue(scope, { messageKey: "question", body: "Please check" })).message;
  const delivery = offered(await mailbox.claim(scope, { receiverId: "old", requestKey: "read" }));
  await mailbox.acknowledge(scope, { receiverId: "old", deliveryId: delivery.deliveryId, messageIds: [user.id] });
  const input = { receiverId: "old", messageKey: "answer", replyTo: [user.id], body: "Requested response" };
  db.prepare("INSERT INTO qm_task_finalizations(task_id) VALUES(?)").run(scope.taskId);
  await assert.rejects(mailbox.reply(scope, input), { code: "TASK_MAILBOX_TASK_FINISHING" });
  assert.deepEqual(mailbox.inspect(scope), { sequence: 1, pending: 0 });
  db.prepare("UPDATE qm_task_finalizations SET error='archive failed' WHERE task_id=?").run(scope.taskId);
  const saved = await mailbox.reply(scope, input);
  db.prepare("UPDATE qm_task_message_receivers SET revoked_at='2026-10-31T00:00:00Z' WHERE id='old'").run();
  await assert.rejects(mailbox.reply(scope, input), { code: "TASK_MAILBOX_RECEIVER_MISMATCH" });
  await assert.rejects(mailbox.reply({ ...scope, principal: taskPrincipalFromAuthInfo({ extra: { owner_id: "owner-b" } }) }, input),
    { code: "TASK_ACCESS_DENIED" });
  assert.equal((await mailbox.reply(scope, { ...input, receiverId: "new" })).message.id, saved.message.id);
  assert.deepEqual(mailbox.inspect(scope), { sequence: 2, pending: 0 });
});

test("其他Task消息不能成为回复目标，列表按完整消息的两份输出预算分页", async t => {
  const { scope, mailbox } = fixture(t);
  const foreign = await mailbox.enqueue({ ...scope, taskId: "task-a2" }, { messageKey: "foreign", body: "别的Task" });
  await assert.rejects(mailbox.reply(scope, { receiverId: "receiver", messageKey: "bad", replyTo: [foreign.message.id], body: "错误回复" }),
    { code: "TASK_MAILBOX_MESSAGE_NOT_FOUND" });
  for (let index = 0; index < 3; index++) await mailbox.enqueue(scope, { messageKey: String(index), body: "a".repeat(16 * 1024) });
  const latest = mailbox.list(scope);
  assert.deepEqual(latest.messages.map(row => row.sequence), [3]);
  assert.equal(latest.nextBeforeSequence, 3);
  assert.ok(toolResultBytes({ content: [], structuredContent: { messages: latest.messages } }) <= MAX_TASK_MESSAGE_BATCH_BYTES);
  assert.deepEqual(mailbox.list(scope, { beforeSequence: 3 }).messages.map(row => row.sequence), [2]);
  assert.equal(mailbox.list(scope, { beforeSequence: 2 }).nextBeforeSequence, null);
});

test("消息和收尾准入竞争由同一写队列决定：已保存消息阻止旧截止序号关闭", async t => {
  const { db, scope, mailbox } = fixture(t);
  const results = await Promise.allSettled([
    mailbox.enqueue(scope, { messageKey: "race", body: "先别结束" }),
    runSqliteWrite(db, () => {
      mailbox.assertReadyToFinishInTransaction(scope, 0);
      db.prepare("INSERT INTO qm_task_finalizations(task_id) VALUES(?)").run(scope.taskId);
    }),
  ]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  assert.equal(db.prepare("SELECT 1 FROM qm_task_finalizations WHERE task_id=?").get(scope.taskId), undefined);
  assert.equal(mailbox.inspect(scope).pending, 1);
});

test("已落盘收尾intent拒绝新消息但保留旧发送回执；失败后可恢复收件", async t => {
  const { db, scope, mailbox } = fixture(t);
  const saved = await mailbox.enqueue(scope, { messageKey: "saved", body: "检查后结束" });
  const claim = offered(await mailbox.claim(scope, { receiverId: "receiver", requestKey: "claim" }));
  await mailbox.acknowledge(scope, { receiverId: "receiver", deliveryId: claim.deliveryId, messageIds: [saved.message.id] });
  const results = await Promise.allSettled([
    runSqliteWrite(db, () => {
      mailbox.assertReadyToFinishInTransaction(scope, 1);
      db.prepare("INSERT INTO qm_task_finalizations(task_id) VALUES(?)").run(scope.taskId);
    }),
    mailbox.enqueue(scope, { messageKey: "late", body: "另一条" }),
  ]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  assert.equal((results[1] as PromiseRejectedResult).reason.code, "TASK_MAILBOX_TASK_FINISHING");
  assert.equal(mailbox.list(scope).messages.length, 1);
  assert.equal((await mailbox.enqueue(scope, { messageKey: "saved", body: "检查后结束" })).message.id, saved.message.id);
  db.prepare("UPDATE qm_task_finalizations SET error='archive failed' WHERE task_id=?").run(scope.taskId);
  await mailbox.enqueue(scope, { messageKey: "late", body: "另一条" });
  await assert.rejects(runSqliteWrite(db, () => mailbox.assertReadyToFinishInTransaction(scope, 1)), { code: "TASK_MAILBOX_CHANGED" });
});
