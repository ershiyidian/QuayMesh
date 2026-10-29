import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createRealTestServer, freePort, structured, waitForFixture, type RealTestServer } from "./server-fixture.js";
import { openDatabase } from "../../src/db/client.js";
import { SessionStore } from "../../src/session/store.js";
import { createInvocationContext } from "../../src/session/invocations.js";
import { REPLY_BYTES } from "../../src/bounded-reply.js";
import { taskPrincipalFromAuthInfo } from "../../src/tasks/task-access.js";
import type { TaskMessagePage, TaskMessageReceipt, TaskMessageView } from "../../src/messaging/task-message-types.js";
import { MAX_TASK_MESSAGE_BODY_WIRE_BYTES } from "../../src/messaging/task-message-types.js";
import { isTaskMessageAuthority, withTaskMessageNotice } from "../../src/messaging/task-messages.js";

const entry = "task-message-test-entry";
type ToolResult = Awaited<ReturnType<RealTestServer["client"]["callTool"]>>;

async function fixture(t: TestContext, authority = true) {
  const port = await freePort(), ingressPort = await freePort();
  const server = await createRealTestServer({
    prefix: "qm-task-message-tools-", git: false,
    ...(authority ? { federation: {
      nodeId: "message-coordinator", nickname: "Message test", priority: 100, port, ingressPort, peers: [],
      capabilities: { coordinator: true, worker: true, discovery: false, egress: false,
        meshRelay: false, desktopUi: false, consoleRelay: false },
    }, configure: async (config: RealTestServer["config"]) => {
      const tokenFile = join(config.stateDir, "message-test-cluster-token");
      await writeFile(tokenFile, "test-task-message-cluster-token-that-is-long-enough\n");
      return { ...config, federation: { ...config.federation, coordinatorId: "message-coordinator",
        tokenEnv: "QUAYMESH_TASK_MESSAGE_TEST_UNUSED_TOKEN", tokenFile } };
    } } : {}),
  });
  const database = openDatabase(server.config.stateDir), store = new SessionStore(database.sqlite);
  t.after(async () => { database.close(); await server.dispose(); });
  const call = (name: string, args: Record<string, unknown>, correlation: string | null = entry) => server.client.callTool({
    name, arguments: args, ...(correlation === null ? {} : { _meta: { "openai/session": correlation } }),
  });
  const started = await call("start_session", { title: "Task messages", request_key: "messages" });
  assert.notEqual(started.isError, true, JSON.stringify(started));
  const taskId = String(structured(started).task_id), sessionId = String(structured(started).session_id);
  const scope = { principal: taskPrincipalFromAuthInfo({ extra: { owner_id: store.getSession(sessionId).owner_id } }), taskId };
  return { server, database, store, call, taskId, sessionId, scope };
}

function value<T>(result: ToolResult): T {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return structured(result) as unknown as T;
}

async function rejected(result: Promise<ToolResult>, code: RegExp): Promise<void> {
  let reply: ToolResult;
  try { reply = await result; }
  catch (error) { assert.match(String(error), code); return; }
  assert.equal(reply.isError, true, JSON.stringify(reply));
  assert.match(JSON.stringify(reply), code);
}

test("real MCP card input, tool notice, receive, acknowledgement and reply retain one Task conversation", async t => {
  const f = await fixture(t);
  const opened = value<Record<string, unknown>>(await f.call("open_workspace", { path: f.server.project }));
  const workspaceId = String(opened.workspace_id);
  const input = { task_id: f.taskId, message_key: "user-1", body: "请在卡片中解释检查结果。" };
  const saved = value<TaskMessageReceipt>(await f.call("qm_task_message_enqueue", input));
  assert.equal(saved.message.status, "queued");
  assert.equal(saved.message.offered_at, null);
  const replay = value<TaskMessageReceipt>(await f.call("qm_task_message_enqueue", input));
  assert.equal(replay.message.id, saved.message.id);
  assert.equal(replay.replayed, true);

  const boundary = await f.call("workspace_context", { workspace_id: workspaceId, action: "status" });
  assert.notEqual(boundary.isError, true, JSON.stringify(boundary));
  assert.match(JSON.stringify(boundary.content), /pending user message/);
  assert.ok(!JSON.stringify(boundary).includes(input.body), "the notice must not copy the message body into another receipt");
  const queued = value<TaskMessagePage>(await f.call("qm_task_messages", { task_id: f.taskId }));
  assert.equal(queued.messages[0].status, "queued", "a notification is not a body delivery");

  const recordedRead = await f.call("read", { workspace_id: workspaceId, path: "README.md" });
  assert.notEqual(recordedRead.isError, true, JSON.stringify(recordedRead));
  assert.match(JSON.stringify(recordedRead.content), /pending user message/);
  const receipts = f.database.sqlite.prepare("SELECT result_json,response_json FROM qm_invocations WHERE task_id=? AND tool_name='read'")
    .all(f.taskId) as Array<{ result_json: string | null; response_json: string | null }>;
  assert.ok(receipts.length > 0, "the production recorder must actually persist this read");
  for (const receipt of receipts) {
    assert.ok(receipt.result_json);
    assert.ok(!JSON.stringify(receipt).includes("pending user message"));
    assert.ok(!JSON.stringify(receipt).includes(input.body));
  }
  const goalSelection = value<{ binding: { binding_revision: number } }>(await f.call("task_resume", { action: "inspect", task_id: f.taskId }));
  const another = value<{ task_id: string }>(await f.call("start_session", { title: "Another independent goal", request_key: "other-goal",
    new_goal: true, expected_binding_revision: goalSelection.binding.binding_revision }));
  const otherRead = await f.call("read", { workspace_id: workspaceId, path: "README.md" });
  assert.notEqual(otherRead.isError, true, JSON.stringify(otherRead));
  assert.ok(!JSON.stringify(otherRead.content).includes("pending user message"), "another Task's reply must not receive this Task's notice");
  assert.notEqual(another.task_id, f.taskId);

  const received = value<{ status: string; delivery_id: string; messages: TaskMessageView[] }>(
    await f.call("task_messages", { action: "receive", task_id: f.taskId, request_key: "receive-1" }));
  assert.equal(received.status, "offered");
  assert.equal(received.messages[0].body, input.body);
  assert.equal(received.messages[0].status, "offered");
  const ack = { action: "ack", task_id: f.taskId, delivery_id: received.delivery_id, message_ids: [saved.message.id] };
  value(await f.call("task_messages", ack));
  const reply = { action: "reply", task_id: f.taskId, message_key: "reply-1", reply_to: [saved.message.id], body: "已经读到补充信息；以下是当前检查结果。" };
  const answer = value<TaskMessageReceipt>(await f.call("task_messages", reply));
  assert.equal(answer.message.role, "assistant");
  assert.equal(answer.message.status, "replied");
  assert.deepEqual(answer.message.reply_to, [saved.message.id]);
  assert.deepEqual(answer.mailbox, { sequence: 2, pending: 0 });
  assert.equal(value<TaskMessageReceipt>(await f.call("task_messages", reply)).message.id, answer.message.id);
  assert.equal(f.store.getTask(f.taskId).state, "active", "saving a reply does not complete the goal");

  await f.server.restart();
  const restored = value<TaskMessagePage>(await f.call("qm_task_messages", { task_id: f.taskId }));
  assert.deepEqual(restored.messages.map(message => [message.id, message.status]),
    [[saved.message.id, "acknowledged"], [answer.message.id, "replied"]]);
  await rejected(f.call("finish_task", { task_id: f.taskId, status: "completed", summary: "done" }), /TASK_MAILBOX_CHANGED/);
  value(await f.call("finish_task", { task_id: f.taskId, status: "completed", summary: "done", message_sequence: 2 }));
  assert.equal(f.store.getTask(f.taskId).state, "closed");
  assert.equal(value<TaskMessageReceipt>(await f.call("qm_task_message_enqueue", input)).message.id, saved.message.id);
  await rejected(f.call("qm_task_message_enqueue", { ...input, message_key: "late" }), /TASK_MAILBOX_TASK_CLOSED/);
});

test("owner authorization and server receiver binding survive a changed external conversation without trusting supplied IDs", async t => {
  const f = await fixture(t);
  const saved = value<TaskMessageReceipt>(await f.call("qm_task_message_enqueue", {
    task_id: f.taskId, message_key: "private", body: "同一目标的新入口继续读取。",
  }));
  await rejected(f.call("task_messages", { action: "receive", task_id: f.taskId, request_key: "missing-entry" }, null), /TASK_MAILBOX_ENTRY_REQUIRED/);
  assert.equal((f.database.sqlite.prepare("SELECT COUNT(*) AS count FROM qm_task_message_receivers").get() as { count: number }).count, 0);
  assert.equal(f.store.mailbox.list(f.scope).messages[0].status, "queued");
  const received = value<{ delivery_id: string }>(await f.call("task_messages", {
    action: "receive", task_id: f.taskId, request_key: "new-entry",
  }, "another-external-conversation"));
  await rejected(f.call("task_messages", { action: "ack", task_id: f.taskId, delivery_id: received.delivery_id,
    message_ids: [saved.message.id] }), /TASK_MAILBOX_RECEIVER_MISMATCH/);
  value(await f.call("task_messages", { action: "ack", task_id: f.taskId, delivery_id: received.delivery_id,
    message_ids: [saved.message.id] }, "another-external-conversation"));
  await rejected(f.call("task_messages", { action: "receive", task_id: f.taskId, request_key: "spoof",
    receiver_id: "caller-chosen" }), /unrecognized|invalid|receiver_id|unexpected/i);
  const otherSession = f.store.createSession("different-owner", "entry", "Private Task");
  const otherTask = f.store.createTask(otherSession.id, "Private Task");
  await rejected(f.call("qm_task_messages", { task_id: otherTask.id }), /TASK_ACCESS_DENIED/);
  await rejected(f.call("qm_task_message_enqueue", { task_id: otherTask.id, message_key: "no", body: "wrong owner" }), /TASK_ACCESS_DENIED/);
});

test("unconfigured authority refuses message writes and Worker capability never creates a second mailbox", async t => {
  const f = await fixture(t, false);
  await rejected(f.call("qm_task_message_enqueue", { task_id: f.taskId, message_key: "no-authority", body: "keep the draft" }),
    /TASK_MAILBOX_AUTHORITY_REQUIRED/);
  assert.equal(f.store.mailbox.inspect(f.scope).sequence, 0);
  assert.equal(isTaskMessageAuthority({ federation: { ...f.server.config.federation, enabled: true,
    nodeId: "worker", coordinatorId: "home", capabilities: { ...f.server.config.federation.capabilities, coordinator: false } } }), false);
});

test("optional boundary notices leave durable receipts immutable and respect the complete JSON budget", async t => {
  const f = await fixture(t);
  await f.store.mailbox.enqueue(f.scope, { messageKey: "one", body: "must not enter the cached receipt" });
  const context = createInvocationContext({ auth: { owner_id: f.scope.principal.ownerId }, transport: { instance_id: "transport" },
    request: { id: "request", actor: "model", tool_name: "read" },
    session: { session_id: f.sessionId, task_id: f.taskId, member_id: "member", workspace_id: "workspace" } });
  const original = { content: [{ type: "text" as const, text: "durable command result" }], structuredContent: { completed: true } };
  const before = JSON.stringify(original), decorated = withTaskMessageNotice(f.server.config, f.store.mailbox, context, original);
  assert.notEqual(decorated, original);
  assert.equal(JSON.stringify(original), before);
  assert.equal(decorated.content.length, 2);
  assert.equal(f.store.mailbox.list(f.scope).messages[0].status, "queued");
  const nearlyFull = { content: [{ type: "text" as const, text: "x".repeat(REPLY_BYTES - 50) }] };
  assert.equal(withTaskMessageNotice(f.server.config, f.store.mailbox, context, nearlyFull), nearlyFull);
  assert.equal(withTaskMessageNotice(f.server.config, f.store.mailbox, { ...context, actor: "app" }, original), original);
});


test("complete MCP replies stay within 48 KiB while pagination and acknowledgement cover twenty maximum-size messages", async t => {
  const f = await fixture(t), expected = new Set<string>();
  for (let index = 0; index < 20; index++) {
    const reply = await f.call("qm_task_message_enqueue", { task_id: f.taskId, message_key: `bulk-${index}`, body: "x".repeat(16 * 1024) });
    assert.ok(Buffer.byteLength(JSON.stringify(reply), "utf8") <= REPLY_BYTES);
    expected.add(value<TaskMessageReceipt>(reply).message.id);
  }
  const listed = new Set<string>();
  let before: number | null = null;
  do {
    const reply = await f.call("qm_task_messages", { task_id: f.taskId, limit: 50, ...(before === null ? {} : { before_sequence: before }) });
    assert.ok(Buffer.byteLength(JSON.stringify(reply), "utf8") <= REPLY_BYTES);
    const page = value<TaskMessagePage>(reply);
    for (const message of page.messages) listed.add(message.id);
    before = page.next_before_sequence;
  } while (before !== null);
  assert.deepEqual(listed, expected);
  const acknowledged = new Set<string>();
  for (let batch = 0; acknowledged.size < expected.size; batch++) {
    assert.ok(batch < 20, "every claimed batch must advance the queue");
    const reply = await f.call("task_messages", { action: "receive", task_id: f.taskId, request_key: `bulk-read-${batch}` });
    assert.ok(Buffer.byteLength(JSON.stringify(reply), "utf8") <= REPLY_BYTES);
    const delivery = value<{ status: string; delivery_id: string; messages: TaskMessageView[] }>(reply);
    assert.equal(delivery.status, "offered");
    assert.ok(delivery.messages.length > 0);
    value(await f.call("task_messages", { action: "ack", task_id: f.taskId, delivery_id: delivery.delivery_id,
      message_ids: delivery.messages.map(message => message.id) }));
    for (const message of delivery.messages) acknowledged.add(message.id);
  }
  assert.deepEqual(acknowledged, expected);
  assert.deepEqual(f.store.mailbox.inspect(f.scope), { sequence: 20, pending: 0 });
});

test("maximum escaped message bodies round-trip through complete MCP replies without poisoning the queue head", { timeout: 90_000 }, async t => {
  const f = await fixture(t);
  const maximumBodies = ["\\".repeat(7508), '"'.repeat(7508), '"\\\u0000'.repeat(1638) + "a".repeat(4), "x".repeat(16 * 1024)];
  for (const body of maximumBodies) {
    assert.ok(Buffer.byteLength(JSON.stringify(body), "utf8") <= 16 * 1024 + 2);
    assert.ok(Buffer.byteLength(body, "utf8") <= 16 * 1024);
  }
  assert.equal(Buffer.byteLength(JSON.stringify(maximumBodies[0]))
    + Buffer.byteLength(JSON.stringify(JSON.stringify(maximumBodies[0]))), MAX_TASK_MESSAGE_BODY_WIRE_BYTES);
  const expected: TaskMessageView[] = [];
  function bounded<T>(reply: ToolResult): T {
    assert.ok(Buffer.byteLength(JSON.stringify(reply), "utf8") <= REPLY_BYTES,
      "the complete MCP result, including content and structuredContent, must fit the public budget");
    return value<T>(reply);
  }
  for (const [index, body] of maximumBodies.entries()) {
    for (const [suffix, text] of [["escaped", body], ["neighbor", `ordinary message after escaped body ${index}`]] as const) {
      const receipt = bounded<TaskMessageReceipt>(await f.call("qm_task_message_enqueue", {
        task_id: f.taskId, message_key: `escaped-${index}-${suffix}`, body: text }));
      assert.equal(receipt.message.body, text, "successful enqueue preserves the entire body");
      expected.push(receipt.message);
    }
  }
  for (const [index, body] of ["\\".repeat(7509), '"'.repeat(7509), "\\".repeat(16 * 1024)].entries()) {
    await rejected(f.call("qm_task_message_enqueue", { task_id: f.taskId, message_key: `over-escaped-budget-${index}`, body }),
      /TASK_MAILBOX_INVALID_BODY/);
  }
  assert.equal(f.store.mailbox.inspect(f.scope).sequence, expected.length, "rejected input never creates an unreadable queue entry");

  const received: TaskMessageView[] = [];
  for (let batch = 0; received.length < expected.length; batch++) {
    assert.ok(batch < expected.length, "a legal maximum-size message must not permanently block its neighbors");
    const delivery = bounded<{ status: string; delivery_id: string; messages: TaskMessageView[] }>(await f.call("task_messages", {
      action: "receive", task_id: f.taskId, request_key: `escaped-read-${batch}` }));
    assert.equal(delivery.status, "offered");
    assert.ok(delivery.messages.length > 0);
    assert.deepEqual(delivery.messages.map(message => [message.id, message.body]),
      expected.slice(received.length, received.length + delivery.messages.length).map(message => [message.id, message.body]),
      "delivery must preserve the complete ordered queue prefix");
    bounded(await f.call("task_messages", { action: "ack", task_id: f.taskId,
      delivery_id: delivery.delivery_id, message_ids: delivery.messages.map(message => message.id) }));
    received.push(...delivery.messages);
  }
  assert.deepEqual(received.map(message => message.id), expected.map(message => message.id));

  const replyTo = expected.map(message => message.id);
  for (const [index, body] of maximumBodies.entries()) {
    const input = { action: "reply", task_id: f.taskId, message_key: `escaped-reply-${index}`,
      reply_to: replyTo, body };
    const receipt = bounded<TaskMessageReceipt>(await f.call("task_messages", input));
    assert.equal(receipt.message.body, body);
    assert.equal(receipt.message.status, "replied");
    assert.equal(bounded<TaskMessageReceipt>(await f.call("task_messages", input)).message.id, receipt.message.id);
    expected.push(receipt.message);
  }

  const listed = new Map<string, TaskMessageView>();
  let before: number | null = null;
  for (let pageNumber = 0; ; pageNumber++) {
    assert.ok(pageNumber < expected.length, "each page must include at least one complete legal message");
    const page = bounded<TaskMessagePage>(await f.call("qm_task_messages", { task_id: f.taskId, limit: 50,
      ...(before === null ? {} : { before_sequence: before }) }));
    assert.ok(page.messages.length > 0);
    for (const message of page.messages) {
      assert.equal(listed.has(message.id), false, "pagination cannot repeat or skip messages at an escaped-body boundary");
      listed.set(message.id, message);
    }
    before = page.next_before_sequence;
    if (before === null) break;
  }
  assert.deepEqual([...listed.values()].sort((a, b) => a.sequence - b.sequence).map(message => [message.id, message.body]),
    expected.map(message => [message.id, message.body]));
  assert.deepEqual(f.store.mailbox.inspect(f.scope), { sequence: expected.length, pending: 0 });
});

test("legacy oversized messages and offered batches fail explicitly without losing or re-claiming saved input", { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  const saved = value<TaskMessageReceipt>(await f.call("qm_task_message_enqueue", {
    task_id: f.taskId, message_key: "legacy-message", body: "placeholder for the old format",
  }));
  // An older message can exceed the new-write reserve yet still fit a real reply.
  const readableOldBody = "\\".repeat(7600);
  f.database.sqlite.prepare("UPDATE qm_task_messages SET body=? WHERE id=?").run(readableOldBody, saved.message.id);
  const oldReplay = await f.call("qm_task_message_enqueue", { task_id: f.taskId,
    message_key: "legacy-message", body: readableOldBody });
  assert.ok(Buffer.byteLength(JSON.stringify(oldReplay), "utf8") <= REPLY_BYTES);
  assert.equal(value<TaskMessageReceipt>(oldReplay).replayed, true);
  assert.equal(value<TaskMessageReceipt>(oldReplay).message.body, readableOldBody);
  const history = await f.call("qm_task_messages", { task_id: f.taskId });
  assert.ok(Buffer.byteLength(JSON.stringify(history), "utf8") <= REPLY_BYTES);
  assert.equal(value<TaskMessagePage>(history).messages[0].body, readableOldBody);
  const received = value<{ delivery_id: string; messages: TaskMessageView[] }>(await f.call("task_messages", {
    action: "receive", task_id: f.taskId, request_key: "legacy-delivery",
  }));
  assert.equal(received.messages[0].body, readableOldBody);
  // This body fitted the v10 single-JSON budget, before the mirrored text block.
  const oldBody = "\\".repeat(8192);
  f.database.sqlite.prepare("UPDATE qm_task_messages SET body=? WHERE id=?").run(oldBody, saved.message.id);
  const neighbor = value<TaskMessageReceipt>(await f.call("qm_task_message_enqueue", {
    task_id: f.taskId, message_key: "after-legacy-message", body: "Keep this later input in order.",
  }));
  const rows = () => f.database.sqlite.prepare(
    "SELECT id,body,delivery_id,acknowledged_at,acknowledged_by FROM qm_task_messages WHERE task_id=? ORDER BY sequence").all(f.taskId);
  const deliveries = () => f.database.sqlite.prepare("SELECT * FROM qm_task_message_deliveries WHERE task_id=? ORDER BY id").all(f.taskId);
  const beforeRows = rows(), beforeDeliveries = deliveries();
  await rejected(f.call("task_messages", { action: "receive", task_id: f.taskId, request_key: "legacy-delivery" }), /TASK_MAILBOX_BATCH_LIMIT/);
  const recent = value<TaskMessagePage>(await f.call("qm_task_messages", { task_id: f.taskId }));
  assert.deepEqual(recent.messages.map(message => message.id), [neighbor.message.id]);
  assert.equal(recent.next_before_sequence, neighbor.message.sequence);
  await rejected(f.call("qm_task_messages", { task_id: f.taskId, before_sequence: recent.next_before_sequence }), /TASK_MAILBOX_BATCH_LIMIT/);
  await rejected(f.call("task_messages", { action: "history", task_id: f.taskId,
    before_sequence: recent.next_before_sequence }), /TASK_MAILBOX_BATCH_LIMIT/);
  assert.deepEqual(rows(), beforeRows);
  assert.deepEqual(deliveries(), beforeDeliveries, "a failed replay preserves the original delivery and lease");
  f.database.sqlite.prepare("UPDATE qm_task_message_deliveries SET lease_expires_at=? WHERE id=?")
    .run(Date.now() - 1, received.delivery_id);
  const expired = deliveries();
  await rejected(f.call("task_messages", { action: "receive", task_id: f.taskId, request_key: "after-legacy-expiry" }), /TASK_MAILBOX_BATCH_LIMIT/);
  assert.deepEqual(rows(), beforeRows, "an oversized queue head is not offered or acknowledged by a failed new claim");
  assert.deepEqual(deliveries(), expired, "no new delivery is created before the whole batch fits");
  assert.deepEqual(f.store.mailbox.inspect(f.scope), { sequence: 2, pending: 2 });
});

test("a Task without background agents exposes continuation only when the action can preserve that Task", async t => {
  const f = await fixture(t);
  const snapshot = (taskId: string) => f.call("qm_session", { task_id: taskId, session_id: f.sessionId, since_rev: -1, resource_version: "task-card-v9" });
  const active = value<{ snapshot: { taskId: string; capabilities: { continue: boolean }; agents: unknown[] } }>(await snapshot(f.taskId));
  assert.equal(active.snapshot.taskId, f.taskId);
  assert.equal(active.snapshot.agents.length, 0);
  assert.equal(active.snapshot.capabilities.continue, true);
  value(await f.call("qm_session_continue", { task_id: f.taskId, session_id: f.sessionId }));
  const goalSelection = value<{ binding: { binding_revision: number } }>(await f.call("task_resume", { action: "inspect", task_id: f.taskId }));
  const another = value<{ task_id: string }>(await f.call("start_session", { title: "Another independent goal", request_key: "capability-other",
    new_goal: true, expected_binding_revision: goalSelection.binding.binding_revision }));
  const previous = value<{ snapshot: { capabilities: { continue: boolean } } }>(await snapshot(f.taskId));
  assert.equal(previous.snapshot.capabilities.continue, false);
  await rejected(f.call("qm_session_continue", { task_id: f.taskId, session_id: f.sessionId }), /TASK_CONTINUATION_BINDING_REQUIRED/);
  value(await f.call("finish_task", { task_id: another.task_id, status: "completed", summary: "finished", message_sequence: 0 }));
  const closed = value<{ snapshot: { capabilities: { continue: boolean } } }>(await snapshot(another.task_id));
  assert.equal(closed.snapshot.capabilities.continue, false);
  await rejected(f.call("qm_session_continue", { task_id: another.task_id, session_id: f.sessionId }), /TASK_NOT_ACTIVE/);
});

test("Task continuation is prepared by the entry even when its selected workspace owner is offline", async t => {
  const f = await fixture(t);
  const member = f.store.upsertRemoteMember({ id: "offline-task-member", sessionId: f.sessionId,
    nodeId: "unavailable-worker", workspaceId: "offline-workspace", root: join(f.server.project, "remote"),
    sourceRoot: null, mode: "checkout", online: false, revision: 0 });
  f.store.touchTaskMember(f.taskId, member.id);
  const reply = value<{ message: string; session_id: string; task_id: string }>(await f.call("qm_session_continue", {
    task_id: f.taskId, session_id: f.sessionId, member_id: member.id }));
  assert.equal(reply.task_id, f.taskId);
  assert.equal(reply.session_id, f.sessionId);
  assert.match(reply.message, /qm:unavailable-worker:offline-workspace/);
  assert.ok(!("unavailable" in reply), "workspace availability must not replace the continuation output contract");
  assert.equal(f.store.getTask(f.taskId).state, "active");
});


test("real MCP: a resumed entry reads acknowledged history and replies without taking over the original receipt", { timeout: 60_000 }, async t => {
  const f = await fixture(t), nextEntry = "continued-in-another-chat";
  const saved = value<TaskMessageReceipt>(await f.call("qm_task_message_enqueue", {
    task_id: f.taskId, message_key: "old-chat-question", body: "换聊天后请接续回答这个问题。",
  }));
  const delivery = value<{ delivery_id: string; messages: TaskMessageView[] }>(await f.call("task_messages", {
    action: "receive", task_id: f.taskId, request_key: "old-chat-received",
  }));
  value(await f.call("task_messages", { action: "ack", task_id: f.taskId,
    delivery_id: delivery.delivery_id, message_ids: [saved.message.id] }));
  const originalReceipt = () => f.database.sqlite.prepare(
    "SELECT acknowledged_by,acknowledged_at,delivery_id FROM qm_task_messages WHERE id=?").get(saved.message.id);
  const acknowledged = originalReceipt();
  const receiverCount = () => (f.database.sqlite.prepare("SELECT COUNT(*) AS n FROM qm_task_message_receivers WHERE task_id=?")
    .get(f.taskId) as { n: number }).n;
  const beforeHistoryReceivers = receiverCount();
  const initialHistory = value<TaskMessagePage>(await f.call("task_messages", {
    action: "history", task_id: f.taskId, filter: "awaiting_reply",
  }, null));
  assert.deepEqual(initialHistory.messages.map(message => [message.id, message.status, message.body]),
    [[saved.message.id, "acknowledged", saved.message.body]]);
  assert.deepEqual(initialHistory.mailbox, { sequence: 1, pending: 0 });
  assert.equal(receiverCount(), beforeHistoryReceivers, "owner-authorized history needs no receiver or host correlation");

  const other = value<{ task_id: string }>(await f.call("start_session", {
    title: "Independent next-chat goal", request_key: "next-chat-other-goal",
  }, nextEntry));
  const inspected = value<{ binding: { binding_revision: number } }>(await f.call("task_resume", {
    action: "inspect", task_id: f.taskId,
  }, nextEntry));
  const resumed = value<{ task_id: string; binding: { can_continue: boolean } }>(await f.call("task_resume", {
    action: "resume", task_id: f.taskId, expected_binding_revision: inspected.binding.binding_revision,
    request_key: "continue-the-same-message-task",
  }, nextEntry));
  assert.equal(resumed.task_id, f.taskId);
  assert.equal(resumed.binding.can_continue, true);
  const pending = value<{ status: string; mailbox: { sequence: number; pending: number } }>(await f.call("task_messages", {
    action: "receive", task_id: f.taskId, request_key: "new-chat-pending",
  }, nextEntry));
  assert.equal(pending.status, "empty", "historical acknowledgement never re-enters the unread queue");
  assert.deepEqual(pending.mailbox, { sequence: 1, pending: 0 });
  const continuedHistory = value<TaskMessagePage>(await f.call("task_messages", {
    action: "history", task_id: f.taskId, filter: "awaiting_reply", limit: 1,
  }, nextEntry));
  assert.deepEqual(continuedHistory.messages.map(message => message.id), [saved.message.id]);
  assert.deepEqual(originalReceipt(), acknowledged);

  const replyInput = { action: "reply", task_id: f.taskId, message_key: "continued-answer",
    reply_to: [saved.message.id], body: "我已从同一个任务的历史读到问题，继续提供答复。" };
  const answer = value<TaskMessageReceipt>(await f.call("task_messages", replyInput, nextEntry));
  assert.deepEqual(answer.message.reply_to, [saved.message.id]);
  const author = () => f.database.sqlite.prepare("SELECT sender_receiver_id FROM qm_task_messages WHERE id=?").get(answer.message.id);
  const originalAuthor = author();
  const replay = value<TaskMessageReceipt>(await f.call("task_messages", replyInput));
  assert.equal(replay.message.id, answer.message.id);
  assert.equal(replay.replayed, true, "the same reply intent stays idempotent across entries");
  assert.deepEqual(author(), originalAuthor, "replay does not rewrite the original saved reply author");
  assert.deepEqual(originalReceipt(), acknowledged, "a new reply does not reassign old acknowledgement facts");
  const parallel = await Promise.all([
    f.call("task_messages", { ...replyInput, message_key: "parallel-a", body: "原入口补充说明。" }),
    f.call("task_messages", { ...replyInput, message_key: "parallel-b", body: "新入口补充说明。" }, nextEntry),
  ]);
  assert.notEqual(value<TaskMessageReceipt>(parallel[0]).message.id, value<TaskMessageReceipt>(parallel[1]).message.id,
    "different explicit intents may save concurrent replies to the same input");
  assert.equal(value<TaskMessagePage>(await f.call("task_messages", {
    action: "history", task_id: f.taskId, filter: "awaiting_reply",
  }, nextEntry)).messages.length, 0);
  await rejected(f.call("task_messages", { ...replyInput, body: "同key却换了内容" }, nextEntry), /TASK_MAILBOX_IDEMPOTENCY_CONFLICT/);
  await rejected(f.call("task_messages", { ...replyInput, task_id: other.task_id, message_key: "wrong-task" }, nextEntry),
    /TASK_MAILBOX_MESSAGE_NOT_FOUND/);
  const foreignSession = f.store.createSession("another-owner", "not-a-parent", "Private"), foreignTask = f.store.createTask(foreignSession.id, "Private");
  await rejected(f.call("task_messages", { action: "history", task_id: foreignTask.id }, null), /TASK_ACCESS_DENIED/);
  await rejected(f.call("task_messages", { action: "history", task_id: f.taskId, receiver_id: "invented" }, nextEntry),
    /invalid|unrecognized|receiver_id|unexpected/i);

  const history = value<TaskMessagePage>(await f.call("task_messages", { action: "history", task_id: f.taskId }, null));
  assert.deepEqual(history.mailbox, { sequence: 4, pending: 0 });
  value(await f.call("finish_task", { task_id: f.taskId, status: "completed", summary: "Explicit goal completion",
    message_sequence: history.mailbox.sequence }, nextEntry));
  await waitForFixture(f.server, { sessionId: f.sessionId }, "Task closes after its explicit message cutoff", async () => f.store.getTask(f.taskId).state,
    state => state === "closed");
  const receiversBeforeClosedRead = receiverCount();
  const closedHistory = value<TaskMessagePage>(await f.call("task_messages", { action: "history", task_id: f.taskId }, null));
  assert.deepEqual(closedHistory.messages.map(message => message.id), history.messages.map(message => message.id));
  assert.equal(receiverCount(), receiversBeforeClosedRead, "closed Task history creates no receiver and does not reopen it");
  assert.equal(value<TaskMessageReceipt>(await f.call("task_messages", replyInput)).message.id, answer.message.id);
  await rejected(f.call("task_messages", { ...replyInput, message_key: "new-after-close" }, nextEntry), /TASK_MAILBOX_TASK_CLOSED/);
  assert.equal(f.store.getTask(f.taskId).state, "closed");
  assert.deepEqual(originalReceipt(), acknowledged);
});

test("real MCP: awaiting-reply history keeps maximum escaped messages complete within the transport budget", { timeout: 60_000 }, async t => {
  const f = await fixture(t), expected = new Map<string, string>();
  const bodies = ["\\".repeat(7508), '"'.repeat(7508), '"\\\u0000'.repeat(1638) + "a".repeat(4)];
  function bounded<T>(result: ToolResult): T {
    assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= REPLY_BYTES,
      "history must fit the full CallToolResult budget without truncating an individual message");
    return value<T>(result);
  }
  for (const [index, body] of bodies.entries()) {
    assert.ok(Buffer.byteLength(JSON.stringify(body), "utf8") <= 16 * 1024 + 2);
    const saved = bounded<TaskMessageReceipt>(await f.call("qm_task_message_enqueue", {
      task_id: f.taskId, message_key: `history-budget-${index}`, body,
    }));
    expected.set(saved.message.id, body);
  }
  for (let batch = 0; f.store.mailbox.inspect(f.scope).pending; batch++) {
    assert.ok(batch < bodies.length);
    const offered = bounded<{ delivery_id: string; messages: TaskMessageView[] }>(await f.call("task_messages", {
      action: "receive", task_id: f.taskId, request_key: `history-budget-receive-${batch}`,
    }));
    bounded(await f.call("task_messages", { action: "ack", task_id: f.taskId,
      delivery_id: offered.delivery_id, message_ids: offered.messages.map(message => message.id) }));
  }
  const queued = bounded<TaskMessageReceipt>(await f.call("qm_task_message_enqueue", {
    task_id: f.taskId, message_key: "not-yet-acknowledged", body: "This belongs in pending receive, not awaiting-reply history.",
  }));
  const receiptFacts = () => f.database.sqlite.prepare("SELECT id,acknowledged_by,acknowledged_at,delivery_id FROM qm_task_messages WHERE task_id=? ORDER BY sequence")
    .all(f.taskId);
  const original = receiptFacts(), listed = new Map<string, string>();
  let cursor: number | null = null;
  for (let pageNumber = 0; ; pageNumber++) {
    assert.ok(pageNumber < bodies.length, "each history page must advance past a complete message");
    const page = bounded<TaskMessagePage>(await f.call("task_messages", { action: "history", task_id: f.taskId,
      filter: "awaiting_reply", limit: 50, ...(cursor === null ? {} : { before_sequence: cursor }) }, null));
    assert.ok(page.messages.length > 0);
    for (const message of page.messages) {
      assert.equal(message.status, "acknowledged");
      assert.equal(listed.has(message.id), false);
      listed.set(message.id, message.body);
    }
    assert.deepEqual(page.mailbox, { sequence: 4, pending: 1 });
    cursor = page.next_before_sequence;
    if (cursor === null) break;
  }
  assert.deepEqual(listed, expected);
  assert.equal(listed.has(queued.message.id), false);
  assert.deepEqual(receiptFacts(), original, "history never changes the acknowledged delivery or claims pending messages");
});
