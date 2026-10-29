import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { openDatabase } from "../../src/db/client.js";
import { createRealTestServer } from "../session-card/server-fixture.js";
import { twoNodes } from "./fixture.js";

interface TextEnvelope { content?: unknown; isError?: boolean }
type Body = Record<string, unknown>;

// 模拟只保留 content[].text 的宿主；后续操作从不读取 structuredContent。
function textBody(reply: TextEnvelope): Body {
  assert.ok(Array.isArray(reply.content), JSON.stringify(reply));
  for (const item of reply.content) {
    if (!item || typeof item !== "object") continue;
    const block = item as Record<string, unknown>;
    if (block.type !== "text" || typeof block.text !== "string") continue;
    let value: unknown;
    try { value = JSON.parse(block.text); } catch { continue; }
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Body;
  }
  assert.fail(`Missing JSON text result: ${JSON.stringify(reply.content)}`);
}

for (const federated of [false, true]) {
  test(`${federated ? "联邦" : "单机"}纯文本客户端完成发现、打开、挂载、执行、查询、读取与删除`, { timeout: 90000 }, async t => {
    const pair = federated ? await twoNodes(t) : undefined;
    const server = pair?.cloud ?? await createRealTestServer({ git: false });
    if (!pair) t.after(() => server.dispose());
    const project = pair?.worker.project ?? server.project;
    const raw = async (name: string, args: Body) => {
      const result = await server.client.callTool({ name, arguments: args });
      return { content: result.content, isError: result.isError === true };
    };
    const call = async (name: string, args: Body) => {
      const result = await raw(name, args);
      assert.notEqual(result.isError, true, JSON.stringify(result));
      return textBody(result);
    };

    const start = { title: "Text-only client", request_key: randomUUID() };
    const task = await call("start_session", start);
    assert.equal(typeof task.task_id, "string");
    assert.equal((await call("start_session", start)).task_id, task.task_id);
    let rootId: string | undefined;
    if (pair) {
      const catalog = await call("workspace_catalog", {});
      const roots = catalog.workspaces as Array<{ root_id: string; node_id: string }>;
      rootId = roots.find(root => root.node_id === "worker")?.root_id;
      assert.equal(rootId, "worker/main");
    }
    const workspace = await call("open_workspace", { task_id: task.task_id,
      ...(rootId ? { root_id: rootId } : { path: project }) });
    assert.equal(typeof workspace.workspace_id, "string");
    assert.equal(workspace.task_id, task.task_id);
    if (pair) assert.match(String(workspace.workspace_id), /^qm:worker:/u);
    const attached = await call("attach_workspace", {
      ...(rootId ? { root_id: rootId } : { path: server.secondRoot }), session_id: workspace.session_id,
      task_id: task.task_id,
    });
    assert.equal(typeof attached.workspace_id, "string");
    assert.equal(attached.task_id, task.task_id);
    if (pair) assert.match(String(attached.workspace_id), /^qm:worker:/u);

    const scope = { workspace_id: workspace.workspace_id, task_id: task.task_id };
    const create = { ...scope, yield_time_ms: 2000, operation_key: randomUUID(),
      cmd: `"${process.execPath}" -e "require('node:fs').writeFileSync('gemini-one-byte.txt','x');process.stdout.write('created:1')"` };
    const command = await call("exec_command", create);
    assert.equal(typeof command.operation_id, "string");
    const replay = await call("exec_command", create);
    assert.equal(replay.operation_id, command.operation_id);

    let output: Body = {};
    for (let attempt = 0; attempt < 100; attempt++) {
      output = await call("read_output", { ...scope, operation_id: command.operation_id, cursor: 0, wait_ms: 100 });
      if (output.process_done === true) break;
      await delay(25);
    }
    assert.equal(output.process_done, true, JSON.stringify(output));
    assert.equal(output.task_id, task.task_id);
    assert.equal(output.result, "created:1");
    assert.equal(output.next_cursor, Buffer.byteLength(String(output.result)));
    const status = await call("workspace_context", { ...scope, action: "status", operation_id: command.operation_id });
    assert.equal(status.task_id, task.task_id);
    assert.equal((await call("start_session", start)).task_id, task.task_id);
    assert.ok(JSON.stringify(status).includes(String(command.operation_id)));
    assert.equal((await stat(join(project, "gemini-one-byte.txt"))).size, 1);
    assert.equal((await call("read", { ...scope, path: "gemini-one-byte.txt" })).result, "x");
    const capture = await call("workspace_context", { ...scope, action: "capture", files: [{ path: "gemini-one-byte.txt" }] });
    assert.equal(typeof capture.result_ref, "string");
    assert.ok(Array.isArray(capture.entries));

    const removed = await call("exec_command", { ...scope, yield_time_ms: 2000, operation_key: randomUUID(),
      cmd: `"${process.execPath}" -e "require('node:fs').unlinkSync('gemini-one-byte.txt');process.stdout.write('deleted')"` });
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = await call("read_output", { ...scope, operation_id: removed.operation_id, cursor: 0, wait_ms: 100 });
      if (result.process_done === true) { assert.equal(result.result, "deleted"); break; }
      await delay(25);
    }
    await assert.rejects(readFile(join(project, "gemini-one-byte.txt")), { code: "ENOENT" });
    const missing = await raw("read", { ...scope, path: "gemini-one-byte.txt" });
    assert.equal(missing.isError, true);
    const error = textBody(missing);
    assert.equal(typeof error.error_code, "string");
    assert.equal(typeof error.retry_hint, "string");
    for (const node of pair ? [pair.cloud, pair.worker] : [server]) {
      const database = openDatabase(node.config.stateDir);
      try {
        assert.equal(database.sqlite.prepare("SELECT COUNT(*) FROM qm_tasks").pluck().get(), 1,
          "explicit Task scope must survive observations and captures without creating another Task");
        assert.equal(database.sqlite.prepare("SELECT COUNT(*) FROM qm_task_bindings").pluck().get(), 0,
          "a client without a host entry must not acquire a synthetic binding");
      } finally {database.close();}
    }
  });
}
