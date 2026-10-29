import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { openDatabase } from "../../src/db/client.js";
import { SessionStore } from "../../src/session/store.js";
import { createRealTestServer, freePort, structured, waitForFixture, type RealTestServer } from "./server-fixture.js";

type Reply = Awaited<ReturnType<RealTestServer["client"]["callTool"]>>;
interface Task { task_id: string; session_id: string }
interface BindingReply extends Task { binding: { binding_revision: number; can_resume: boolean; can_continue: boolean } }
function value<T>(reply: Reply): T {
  assert.notEqual(reply.isError, true, JSON.stringify(reply));
  return structured(reply) as unknown as T;
}

async function fixture(t: TestContext) {
  const port = await freePort(), ingressPort = await freePort();
  const server = await createRealTestServer({ prefix: "qm-handoff-contract-", git: false, uiEnabled: true,
    federation: {
      nodeId: "handoff-coordinator", nickname: "Handoff contract test", priority: 100, port, ingressPort, peers: [],
      capabilities: { coordinator: true, worker: true, discovery: false, egress: false,
        meshRelay: false, desktopUi: false, consoleRelay: false },
    }, configure: async config => {
      const tokenFile = join(config.stateDir, "handoff-test-cluster-token");
      await writeFile(tokenFile, "test-handoff-cluster-token-that-is-long-enough\n");
      return { ...config, federation: { ...config.federation, coordinatorId: "handoff-coordinator",
        tokenEnv: "QUAYMESH_HANDOFF_TEST_UNUSED_TOKEN", tokenFile } };
    },
  });
  const database = openDatabase(server.config.stateDir), store = new SessionStore(database.sqlite);
  t.after(async () => { database.close(); await server.dispose(); });
  const call = (entry: string, name: string, args: Record<string, unknown>) => server.client.callTool({
    name, arguments: args, _meta: { "openai/session": entry },
  });
  const start = async (entry: string, key: string) => value<Task>(await call(entry, "start_session", { title: key, request_key: key }));
  const resume = async (entry: string, taskId: string, key: string) => {
    const inspected = value<BindingReply>(await call(entry, "task_resume", { action: "inspect", task_id: taskId }));
    return value<BindingReply>(await call(entry, "task_resume", { action: "resume", task_id: taskId,
      expected_binding_revision: inspected.binding.binding_revision, request_key: key }));
  };
  return { server, database, store, call, start, resume };
}

test("real MCP: rejecting handed_off preserves the original goal, checkpoint and messages across a new entry", { timeout: 60_000 }, async t => {
  const f = await fixture(t), task = await f.start("original", "goal");
  const opened = value<{ workspace_id: string }>(await f.call("original", "open_workspace", { path: f.server.project }));
  value(await f.call("original", "qm_task_message_enqueue", { task_id: task.task_id,
    message_key: "handoff-input", body: "请在新入口继续这个目标" }));
  const before = f.store.getTask(task.task_id);
  const rejected = await f.call("original", "finish_task", { task_id: task.task_id,
    status: "handed_off", summary: "continue in another entry" });
  assert.equal(rejected.isError, true);
  assert.match(JSON.stringify(rejected), /TASK_HANDOFF_NOT_TERMINAL/);
  assert.deepEqual(rejected.structuredContent, { error_code: "TASK_HANDOFF_NOT_TERMINAL", effect: "not_started", retry_hint: "fix_input" });
  assert.match(JSON.stringify(rejected.content), /effect=not_started; retry_hint=fix_input/);
  assert.match(JSON.stringify(rejected), /checkpoint_task/);
  assert.match(JSON.stringify(rejected), /task_resume/);
  assert.deepEqual(f.store.getTask(task.task_id), before);
  assert.equal(f.store.taskData.finalization(task.task_id), null);
  value(await f.call("original", "checkpoint_task", { workspace_id: opened.workspace_id,
    goal: "Keep the original goal", decisions: ["Continue in another entry"], next_action: "Read the pending user message", evidence_refs: [] }));
  const resumed = await f.resume("receiving", task.task_id, "resume-the-same-goal");
  assert.equal(resumed.task_id, task.task_id);
  assert.equal(resumed.session_id, task.session_id);
  assert.equal(resumed.binding.can_continue, true);
  const checkpoint = f.database.sqlite.prepare("SELECT task_id,next_action FROM qm_task_checkpoints WHERE task_id=?")
    .get(task.task_id) as { task_id: string; next_action: string };
  assert.deepEqual(checkpoint, { task_id: task.task_id, next_action: "Read the pending user message" });
  assert.equal((f.database.sqlite.prepare("SELECT COUNT(*) AS n FROM qm_tasks").get() as { n: number }).n, 1);
  const received = value<{ delivery_id: string; messages: Array<{ id: string; body: string }>; mailbox: { sequence: number } }>(
    await f.call("receiving", "task_messages", { action: "receive", task_id: task.task_id, request_key: "receive-handoff-input" }));
  assert.equal(received.messages[0].body, "请在新入口继续这个目标");
  value(await f.call("receiving", "task_messages", { action: "ack", task_id: task.task_id,
    delivery_id: received.delivery_id, message_ids: received.messages.map(message => message.id) }));
  value(await f.call("receiving", "read", { workspace_id: opened.workspace_id, path: "README.md" }));
  value(await f.call("receiving", "finish_task", { task_id: task.task_id, status: "completed",
    summary: "Goal completed after explicit continuation", message_sequence: received.mailbox.sequence }));
  await waitForFixture(f.server, { sessionId: task.session_id }, "explicit goal completion", async () => f.store.getTask(task.task_id), row => row.state === "closed");
  assert.equal(f.store.getTask(task.task_id).result_status, "completed");
});

test("real Core restart retires unconfirmed legacy handoffs before tools are served and preserves closed history", { timeout: 60_000 }, async t => {
  const f = await fixture(t), active = await f.start("original", "pending-goal");
  value(await f.call("original", "qm_task_message_enqueue", { task_id: active.task_id, message_key: "unread", body: "Do not discard this input" }));
  const selected = value<BindingReply>(await f.call("original", "task_resume", { action: "inspect", task_id: active.task_id }));
  const historical = value<Task>(await f.call("original", "start_session", { title: "historical-goal", request_key: "historical-goal",
    new_goal: true, expected_binding_revision: selected.binding.binding_revision }));
  const when = "2026-01-01T00:00:00.000Z";
  await f.server.restart(async () => {
    // These are previous-version receipts in a real on-disk database, not calls to the new finish API.
    f.database.sqlite.prepare(`INSERT INTO qm_task_finalizations(task_id,status,summary,requested_at,completed_at,error,mailbox_sequence)
      VALUES(?,'handed_off','pending legacy handoff',?,NULL,NULL,0)`).run(active.task_id, when);
    f.database.sqlite.prepare(`UPDATE qm_tasks SET state='closed',result_status='handed_off',summary='old confirmed handoff',
      finished_at=?,archived_at=?,delivery_ended_at=?,closure_reason='explicit' WHERE id=?`).run(when, when, when, historical.task_id);
    f.database.sqlite.prepare(`INSERT INTO qm_task_finalizations(task_id,status,summary,requested_at,completed_at,error,mailbox_sequence)
      VALUES(?,'handed_off','old confirmed handoff',?,?,NULL,0)`).run(historical.task_id, when, when);
  });
  const retired = f.store.taskData.finalization(active.task_id)!;
  assert.match(retired.error!, /TASK_HANDOFF_NOT_TERMINAL/);
  assert.equal(retired.completed_at, null);
  assert.equal(f.store.getTask(active.task_id).state, "active");
  assert.equal(f.store.getTask(historical.task_id).state, "closed");
  assert.equal(f.store.getTask(historical.task_id).result_status, "handed_off");
  assert.equal(f.store.getTask(historical.task_id).delivery_ended_at, when);
  assert.equal(f.store.taskData.finalization(historical.task_id)?.error, null);
  const resumed = await f.resume("receiving", active.task_id, "resume-after-upgrade");
  assert.equal(resumed.binding.can_continue, true);
  value(await f.call("receiving", "qm_task_message_enqueue", { task_id: active.task_id,
    message_key: "after-upgrade", body: "Inbox remains available" }));
  const received = value<{ messages: Array<{ body: string }> }>(await f.call("receiving", "task_messages", {
    action: "receive", task_id: active.task_id, request_key: "receive-preserved-input" }));
  assert.deepEqual(received.messages.map(message => message.body), ["Do not discard this input", "Inbox remains available"]);
  const old = value<{ snapshot: { taskState: string; taskResult: string } }>(await f.call("receiving", "qm_session", {
    session_id: historical.session_id, task_id: historical.task_id, since_rev: -1 }));
  assert.equal(old.snapshot.taskState, "closed");
  assert.equal(old.snapshot.taskResult, "handed_off");
  await f.server.restart();
  assert.equal(f.store.taskData.finalization(active.task_id)?.error, retired.error, "restarts do not repeatedly rewrite the rejection");
  assert.equal(f.store.getTask(active.task_id).state, "active");
  assert.equal(f.store.getTask(historical.task_id).state, "closed");
});
