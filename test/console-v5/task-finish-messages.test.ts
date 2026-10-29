import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createRealTestServer, freePort, structured, type RealTestServer } from "../session-card/server-fixture.js";
import { openDatabase } from "../../src/db/client.js";
import { SessionStore } from "../../src/session/store.js";
import type { TaskMessageConfirmation } from "../../src/console-workbench/types.js";
import type { RunDetail } from "../../src/ui/console-v5/contracts.js";

const correlation = "console-task-finish-messages";
type ToolResult = Awaited<ReturnType<RealTestServer["client"]["callTool"]>>;

function toolValue<T>(reply: ToolResult): T {
  assert.notEqual(reply.isError, true, JSON.stringify(reply));
  return structured(reply) as unknown as T;
}

async function fixture(t: TestContext, mode: "coordinator" | "worker" | "standalone" = "coordinator") {
  const nodeId = mode === "worker" ? "message-worker" : "message-coordinator";
  const port = await freePort(), ingressPort = await freePort();
  const server = await createRealTestServer({ prefix: "qm-console-message-finish-", git: false,
    ...(mode === "standalone" ? {} : { federation: { nodeId, nickname: "Console message test", priority: 100,
      port, ingressPort, peers: [], capabilities: { coordinator: mode === "coordinator", worker: true,
        discovery: false, egress: false, meshRelay: false, desktopUi: false, consoleRelay: false } },
      configure: async (config: RealTestServer["config"]) => {
        const tokenFile = join(config.stateDir, "console-message-test-cluster-token");
        await writeFile(tokenFile, "console-message-test-cluster-token-that-is-long-enough\n");
        return { ...config, federation: { ...config.federation, coordinatorId: "message-coordinator",
          tokenEnv: "QUAYMESH_CONSOLE_MESSAGE_TEST_UNUSED_TOKEN", tokenFile } };
      } }),
  });
  const database = openDatabase(server.config.stateDir), store = new SessionStore(database.sqlite);
  t.after(async () => { database.close(); await server.dispose(); });
  const call = (name: string, args: Record<string, unknown>) => server.client.callTool({ name,
    arguments: args, _meta: { "openai/session": correlation } });
  const login = await fetch(server.baseUrl + "/console/api/login", { method: "POST",
    headers: { Origin: server.baseUrl, "Content-Type": "application/json" },
    body: JSON.stringify({ password: server.config.oauth.ownerToken }) });
  assert.equal(login.status, 200, await login.clone().text());
  const cookie = login.headers.getSetCookie()[0].split(";")[0];
  const { csrf } = await login.json() as { csrf: string };
  const api = async <T>(path: string, body?: unknown, options: { auth?: boolean; csrf?: boolean } = {}) => {
    const response = await fetch(server.baseUrl + "/console/api/" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { Origin: server.baseUrl, "Content-Type": "application/json",
        ...(options.auth === false ? {} : { Cookie: cookie }),
        ...(options.csrf === false ? {} : { "X-QuayMesh-CSRF": csrf }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, value: await response.json() as T };
  };
  const success = async <T>(path: string, body?: unknown): Promise<T> => {
    const response = await api<T>(path, body);
    assert.equal(response.status, 200, JSON.stringify(response.value));
    return response.value;
  };
  return { server, database, store, call, api, success };
}

function observed(detail: RunDetail): Extract<TaskMessageConfirmation, { available: true }> {
  const messages = detail.taskMessages;
  assert.ok(messages?.available, JSON.stringify(detail));
  assert.equal(messages.taskId, detail.run.taskId);
  return messages;
}

test("Owner Console confirms the observed Task message cutoff; new input cannot be silently closed", { timeout: 90_000 }, async t => {
  const f = await fixture(t);
  const started = toolValue<{ task_id: string }>(await f.call("start_session", { title: "Console message goal", request_key: "goal" }));
  const taskId = started.task_id, reference = encodeURIComponent("qmtask:" + taskId);
  const opened = toolValue<{ workspace_id: string }>(await f.call("open_workspace", { path: f.server.project }));
  toolValue(await f.call("read", { workspace_id: opened.workspace_id, path: "README.md" }));
  const detail = () => f.success<RunDetail>(`v4/runs/${reference}?fresh=1`);
  const statePath = `workbench/tasks/${encodeURIComponent(taskId)}/messages-state`;
  const state = await f.api(statePath, undefined, { auth: false });
  assert.equal(state.status, 401, "mailbox metadata requires the authenticated Owner console");

  const saved = toolValue<{ message: { id: string } }>(await f.call("qm_task_message_enqueue", {
    task_id: taskId, message_key: "user-before-confirm", body: "先确认这条补充信息。" }));
  const pendingDetail = await detail(), pending = observed(pendingDetail);
  assert.equal(pending.ownerNodeId, "message-coordinator");
  assert.deepEqual([pending.sequence, pending.pending, pending.taskState], [1, 1, "active"]);
  const pendingFinish = await f.api<{ code: string; effect: string }>(`v4/runs/${reference}/finish`, {
    expectedRevision: pendingDetail.run.revision, expectedTaskRevision: pending.taskRevision,
    messageSequence: pending.sequence, result: "completed", summary: "must not close", requestKey: "pending-finish" });
  assert.equal(pendingFinish.status, 409, JSON.stringify(pendingFinish));
  assert.equal(pendingFinish.value.code, "TASK_MAILBOX_INPUT_PENDING");
  assert.equal(pendingFinish.value.effect, "none");
  assert.equal(f.store.getTask(taskId).state, "active");

  async function receiveAndAck(key: string) {
    const delivery = toolValue<{ delivery_id: string; messages: Array<{ id: string }> }>(await f.call("task_messages", {
      action: "receive", task_id: taskId, request_key: key }));
    assert.ok(delivery.messages.length > 0);
    toolValue(await f.call("task_messages", { action: "ack", task_id: taskId, delivery_id: delivery.delivery_id,
      message_ids: delivery.messages.map(message => message.id) }));
  }
  await receiveAndAck("first-receive");
  toolValue(await f.call("task_messages", { action: "reply", task_id: taskId, message_key: "first-reply",
    reply_to: [saved.message.id], body: "已经确认收到，目标仍开放。" }));
  const readyDetail = await detail(), ready = observed(readyDetail);
  assert.deepEqual([ready.sequence, ready.pending], [2, 0]);
  const finishInput = { taskId, expectedTaskRevision: ready.taskRevision, messageSequence: ready.sequence,
    result: "completed", summary: "ready after review", requestKey: "missing-csrf" };
  assert.equal((await f.api("workbench/tasks/finish", finishInput, { csrf: false })).status, 403);

  const legacyInput = { ...finishInput, requestKey: "legacy-zero-cutoff", messageSequence: undefined };
  const legacyFinish = await f.api<{ code: string }>("workbench/tasks/finish", legacyInput);
  assert.equal(legacyFinish.status, 409, JSON.stringify(legacyFinish));
  assert.equal(legacyFinish.value.code, "TASK_MAILBOX_CHANGED", "missing cutoff never means accept the latest sequence");

  toolValue(await f.call("qm_task_message_enqueue", { task_id: taskId, message_key: "during-confirmation",
    body: "确认框打开后新到的消息不能被跳过。" }));
  const raced = await f.api<{ code: string; effect: string }>("workbench/tasks/finish", {
    ...finishInput, requestKey: "stale-confirmation" });
  assert.equal(raced.status, 409, JSON.stringify(raced));
  assert.equal(raced.value.code, "TASK_MAILBOX_CHANGED");
  assert.equal(raced.value.effect, "none");
  assert.equal(f.store.getTask(taskId).state, "active");
  assert.equal(f.store.taskData.finalization(taskId), null, "rejected confirmation must not leave a finalization intent");

  await receiveAndAck("receive-after-refresh");
  const finalDetail = await detail(), final = observed(finalDetail);
  assert.deepEqual([final.sequence, final.pending], [3, 0]);
  const input = { expectedRevision: finalDetail.run.revision, expectedTaskRevision: final.taskRevision,
    messageSequence: final.sequence, result: "completed", summary: "目标已完成，消息均已确认。", requestKey: "confirmed-finish" };
  const finished = await f.success<{ taskId: string; state: string }>(`v4/runs/${reference}/finish`, input);
  assert.equal(finished.taskId, taskId);
  assert.equal(finished.state, "closed");
  assert.equal(f.store.taskData.finalization(taskId)?.mailbox_sequence, 3);
  assert.deepEqual(await f.success(`v4/runs/${reference}/finish`, input), finished, "an identical confirmed write replays its receipt");
  assert.equal(observed(await detail()).taskState, "closed");
});

test("a configured Worker cannot bypass the Coordinator by posting directly to its local finish route", { timeout: 60_000 }, async t => {
  const f = await fixture(t, "worker");
  const entry = f.store.createSession("record-owner", "worker-local-entry", "Worker local record");
  const task = f.store.createTask(entry.id, "Worker mirror or legacy record");
  const status = await f.api<{ code: string }>(`workbench/tasks/${encodeURIComponent(task.id)}/messages-state`);
  assert.equal(status.status, 503);
  assert.equal(status.value.code, "task_authority_required");
  const finish = await f.api<{ code: string; effect: string }>("workbench/tasks/finish", {
    taskId: task.id, expectedTaskRevision: task.revision, messageSequence: 0,
    result: "completed", summary: "forbidden Worker close", requestKey: "direct-worker-finish" });
  assert.equal(finish.status, 503, JSON.stringify(finish));
  assert.equal(finish.value.code, "task_authority_required");
  assert.equal(finish.value.effect, "none");
  assert.equal(f.store.getTask(task.id).state, "active");
  assert.equal(f.store.taskData.finalization(task.id), null);
});

test("standalone Owner lifecycle remains compatible when no federated mailbox exists", async t => {
  const f = await fixture(t, "standalone");
  const started = toolValue<{ task_id: string }>(await f.call("start_session", { title: "Standalone goal", request_key: "standalone" }));
  const state = await f.success<Extract<TaskMessageConfirmation, { available: true }>>(
    `workbench/tasks/${encodeURIComponent(started.task_id)}/messages-state`);
  assert.deepEqual([state.sequence, state.pending], [0, 0]);
  const finished = await f.success<{ state: string }>("workbench/tasks/finish", {
    taskId: started.task_id, expectedTaskRevision: state.taskRevision,
    result: "completed", summary: "standalone completed", requestKey: "standalone-finish" });
  assert.equal(finished.state, "closed");
});
