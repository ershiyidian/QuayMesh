import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "../../src/db/client.js";
import { SessionStore } from "../../src/session/store.js";
import { createRealTestServer, structured } from "../session-card/server-fixture.js";
import { twoNodes, until } from "./fixture.js";

test("无会话元数据的真实 HTTP 创建在并发与重启后重放同一 Task，不选择其他目标", {timeout: 60000}, async t => {
  const server = await createRealTestServer({git: false, uiEnabled: false});
  t.after(() => server.dispose());
  const raw = (name: string, args: Record<string, unknown>) => server.client.callTool({name, arguments: args});
  const start = {title: "Unbound creation", request_key: randomUUID()};
  const replies = await Promise.all(Array.from({length: 4}, () => raw("start_session", start)));
  for (const reply of replies) assert.notEqual(reply.isError, true, JSON.stringify(reply));
  const taskId = structured(replies[0]).task_id;
  assert.ok(replies.every(reply => structured(reply).task_id === taskId));
  const next = structured(await raw("start_session", {title: "Independent second goal", request_key: randomUUID()}));
  assert.notEqual(next.task_id, taskId);
  const conflict = await raw("start_session", {...start, title: "Changed input"});
  assert.equal(conflict.isError, true);
  assert.match(JSON.stringify(conflict), /TASK_BINDING_KEY_CONFLICT/);
  const noEntry = await raw("start_session", {title: "Invalid binding revision", request_key: randomUUID(), expected_binding_revision: 0});
  assert.equal(noEntry.isError, true);
  assert.match(JSON.stringify(noEntry), /TASK_ENTRY_REQUIRED/);
  const db = openDatabase(server.config.stateDir);
  try {
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) FROM qm_tasks").pluck().get(), 2);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) FROM qm_task_creation_receipts").pluck().get(), 2);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) FROM qm_task_bindings").pluck().get(), 0);
  } finally { db.close(); }
  const inspected = await raw("task_resume", {action: "inspect", task_id: taskId});
  assert.notEqual(inspected.isError, true, JSON.stringify(inspected));
  const inspection = structured(inspected);
  assert.equal(inspection.binding.entry_available, false);
  assert.equal(inspection.binding.selected_task_id, null);
  assert.equal(typeof inspection.task_revision, "number");
  const finished = await raw("finish_task", {task_id: taskId, status: "completed", summary: "Explicitly finished goal",
    expected_task_revision: inspection.task_revision, message_sequence: 0});
  assert.notEqual(finished.isError, true, JSON.stringify(finished));
  assert.equal(structured(finished).state, "closed");
  await server.restart();
  const replay = await raw("start_session", start);
  assert.notEqual(replay.isError, true, JSON.stringify(replay));
  assert.equal(structured(replay).task_id, taskId);
  assert.match(JSON.stringify(replay.content), /This Task is closed/);
});

test("真实 HTTP 的历史入口创建回执在元数据丢失时明确拒绝，原入口和无入口回执均不受影响", {timeout: 60000}, async t => {
  const server = await createRealTestServer({git: false, uiEnabled: false});
  t.after(() => server.dispose());
  const raw = (args: Record<string, unknown>, meta?: Record<string, string>) =>
    server.client.callTool({name: "start_session", arguments: args, ...(meta ? {_meta: meta} : {})});
  const meta = {"openai/session": randomUUID()}, start = {title: "Historical entry receipt", request_key: randomUUID()};
  const first = await raw(start, meta);
  assert.notEqual(first.isError, true, JSON.stringify(first));
  const lost = await raw(start);
  assert.equal(lost.isError, true, JSON.stringify(lost));
  assert.equal(structured(lost).error_code, "TASK_ENTRY_REQUIRED");
  assert.equal(structured(lost).effect, "not_started");
  const db = openDatabase(server.config.stateDir);
  try {
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) FROM qm_tasks").pluck().get(), 1);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) FROM qm_task_creation_receipts").pluck().get(), 0);
    const repeated = await raw(start, meta);
    assert.notEqual(repeated.isError, true, JSON.stringify(repeated));
    assert.equal(structured(repeated).task_id, structured(first).task_id);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) FROM qm_tasks").pluck().get(), 1);

    // 先前真正的无入口回执优先重放，不受随后同 key 的其他入口影响。
    const unbound = {title: "Unbound receipt first", request_key: randomUUID()};
    const original = await raw(unbound);
    assert.notEqual(original.isError, true, JSON.stringify(original));
    const bound = await raw(unbound, {"openai/session": randomUUID()});
    assert.notEqual(bound.isError, true, JSON.stringify(bound));
    assert.notEqual(structured(bound).task_id, structured(original).task_id);
    const replay = await raw(unbound);
    assert.notEqual(replay.isError, true, JSON.stringify(replay));
    assert.equal(structured(replay).task_id, structured(original).task_id);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) FROM qm_tasks").pluck().get(), 3);
  } finally {db.close();}
});

test("显式 task_id 贯穿真实工作区读取，其他 owner 的 Task 在目录创建前被拒绝", {timeout: 30000}, async t => {
  const server = await createRealTestServer({git: false, uiEnabled: false});
  t.after(() => server.dispose());
  const raw = (name: string, args: Record<string, unknown>) => server.client.callTool({name, arguments: args});
  const task = structured(await raw("start_session", {title: "Explicit Task", request_key: randomUUID()}));
  const opened = await raw("open_workspace", {path: server.project, task_id: task.task_id});
  assert.notEqual(opened.isError, true, JSON.stringify(opened));
  const workspace = structured(opened);
  assert.equal(workspace.task_id, task.task_id);
  const reply = await raw("read", {workspace_id: workspace.workspace_id, task_id: task.task_id, path: "README.md"});
  assert.notEqual(reply.isError, true, JSON.stringify(reply));
  const db = openDatabase(server.config.stateDir);
  try {
    const read = db.sqlite.prepare("SELECT task_id FROM qm_invocations WHERE tool_name='read' ORDER BY rowid DESC LIMIT 1").get() as {task_id: string};
    assert.equal(read.task_id, task.task_id);
    const store = new SessionStore(db.sqlite);
    const foreignSession = store.createSession("foreign-owner", null, "Foreign goal");
    const foreign = store.createTask(foreignSession.id, "Foreign goal", "foreign-goal");
    const path = join(server.project, "must-not-create");
    const refused = await raw("open_workspace", {path, create_directory: true, task_id: foreign.id});
    assert.equal(refused.isError, true, JSON.stringify(refused));
    assert.equal(existsSync(path), false);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) FROM qm_task_bindings").pluck().get(), 0);
  } finally { db.close(); }
});

test("真实 Peer 的字符串 clientId 不能重放本机创建回执，显式 Task 的复制仍通过原始参数约束", {timeout: 60000}, async t => {
  const {worker, cloud} = await twoNodes(t);
  const raw = (name: string, args: Record<string, unknown>) => cloud.client.callTool({name, arguments: args});
  const start = {title: "Local authenticated creation", request_key: randomUUID()};
  const first = await raw("start_session", start);
  assert.notEqual(first.isError, true, JSON.stringify(first));
  const task = structured(first);
  const db = openDatabase(cloud.config.stateDir);
  try {
    const creator = db.sqlite.prepare("SELECT owner_id,client_id FROM qm_task_creation_receipts WHERE request_key=?")
      .get(start.request_key) as {owner_id: string; client_id: string};
    assert.ok(creator);
    const forged = await worker.running.federation!.request("cloud", "tool", {name: "start_session", input: start,
      extra: {requestId: "forged-local-auth", sessionId: "peer-session", authInfo: {clientId: creator.client_id,
        extra: {owner_id: creator.owner_id, locallyAuthenticated: true, task_creation: creator}}}}) as Record<string, unknown>;
    assert.equal(forged.isError, true, JSON.stringify(forged));
    assert.match(JSON.stringify(forged), /TASK_CREATION_IDENTITY_REQUIRED/);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) FROM qm_task_creation_receipts").pluck().get(), 1);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) FROM qm_tasks").pluck().get(), 1);

    const workspace = structured(await raw("open_workspace", {root_id: "worker/main", task_id: task.task_id}));
    const copied = await raw("copy_artifact", {action: "start", task_id: task.task_id, request_key: randomUUID(),
      source_workspace_id: workspace.workspace_id, destination_workspace_id: workspace.workspace_id,
      source_path: "README.md", destination_path: "copied.txt"});
    assert.notEqual(copied.isError, true, JSON.stringify(copied));
    const copyId = structured(copied).id;
    await until(async () => {
      const observed = await raw("copy_artifact", {action: "observe", task_id: task.task_id, copy_id: copyId});
      assert.notEqual(observed.isError, true, JSON.stringify(observed));
      return structured(observed).status === "completed";
    });
    assert.equal(await readFile(join(worker.project, "copied.txt"), "utf8"), await readFile(join(worker.project, "README.md"), "utf8"));
    const invalid = await raw("copy_artifact", {action: "observe", task_id: task.task_id, copy_id: copyId, destination_path: "unexpected.txt"});
    assert.equal(invalid.isError, true, "adding Task scope must preserve the original action-specific validation");
  } finally { db.close(); }
});
