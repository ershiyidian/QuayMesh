import assert from "node:assert/strict";
import { createServer } from "node:net";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import test from "node:test";
import Database from "better-sqlite3";
import { federationConfigSchema } from "../../src/federation/schema.js";
import { PeerApplicationError } from "../../src/federation/transport.js";
import { validateSnapshot } from "../../src/session/schema.js";
import { createRealTestServer, structured } from "./server-fixture.js";

async function port(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const address = socket.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

test("real federation preserves identity, remote card data and online status after operation errors", { timeout: 60_000 }, async (t) => {
  const ports = await Promise.all([port(), port(), port(), port()]);
  const nodes = ["entry", "worker"];
  const servers: Awaited<ReturnType<typeof createRealTestServer>>[] = [];
  t.after(async () => { for (const server of servers.reverse()) await server.dispose(); });
  for (let index = 0; index < 2; index++) {
    const server = await createRealTestServer({ uiEnabled: true, configure: async (config) => {
      const tokenFile = join(config.configDir, "cluster.token");
      await writeFile(tokenFile, "current-issues-real-cluster-test-token");
      return { ...config, federation: federationConfigSchema.parse({
        enabled: true, nodeId: nodes[index], nickname: nodes[index],
        capabilities: { coordinator: index === 0, worker: true, discovery: true, egress: false, meshRelay: index === 0, desktopUi: false, consoleRelay: false },
        coordinatorId: "entry",
        priority: 0, host: "127.0.0.1", port: ports[index], ingressPort: ports[index + 2], tokenFile,
        heartbeatMs: 1000, rpcTimeoutMs: 30_000,
        peers: [{ id: nodes[1 - index], url: `http://127.0.0.1:${ports[1 - index]}` }],
        roots: [{ id: `${nodes[index]}-root`, nickname: nodes[index], path: config.allowedRoots[0] }],
        egress: { enabled: false },
      }) };
    } });
    servers.push(server);
    await server.running.ready;
  }
  const [entry, worker] = servers;
  assert.ok(entry && worker);
  await entry.running.federation!.transport.waitForLink("worker", 5000);
  const meta = { "openai/session": "current-issues-federated-conversation" };
  const started = structured(await entry.client.callTool({ name: "start_session", arguments: { request_key: "request-1-2501", title: "联邦任务一" }, _meta: meta }));
  const taskId = String(started.task_id);
  const response = await entry.client.callTool({ name: "open_workspace", arguments: { root_id: "worker/worker-root" }, _meta: meta });
  assert.notEqual(response.isError, true, JSON.stringify(response.content));
  const opened = {...structured(response),...((response._meta as any)?.quaymesh??{})};
  assert.equal(opened.session_id, started.session_id);
  const read = await entry.client.callTool({ name: "read", arguments: { workspace_id: opened.workspace_id, path: "README.md" }, _meta: meta });
  assert.notEqual(read.isError, true, JSON.stringify(read.content));
  assert.match(String((read.structuredContent as any)?.result), /session card test fixture/,
    "remote read preserves model-visible text in structuredContent without duplicating the body");
  const attached = await entry.client.callTool({ name: "attach_workspace", arguments: { root_id: "entry/entry-root", session_id: opened.session_id }, _meta: meta });
  assert.notEqual(attached.isError, true, JSON.stringify(attached.content));
  const patch = await entry.client.callTool({ name: "apply_patch", arguments: {
    workspace_id: opened.workspace_id, patch: "*** Begin Patch\n*** Add File: remote.txt\n+remote result\n*** End Patch",
  }, _meta: meta });
  assert.notEqual(patch.isError, true, JSON.stringify(patch.content));
  let workerSnapshot: ReturnType<typeof validateSnapshot> | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    const reply = await worker.client.callTool({ name: "qm_session", arguments: {
      session_id: opened.session_id, task_id: taskId, member_id: opened.member_id, since_rev: -1,
    } });
    assert.notEqual(reply.isError, true, JSON.stringify(reply.content));
    workerSnapshot = validateSnapshot(structured(reply).snapshot);
    if (workerSnapshot.files.some((file) => file.path === "remote.txt")) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(workerSnapshot?.files.some((file) => file.path === "remote.txt"));
  let cachedSnapshot: ReturnType<typeof validateSnapshot> | undefined;
  let cachedState: { revision: number; snapshot_revision: number } | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    const database = new Database(join(entry.config.stateDir, "quaymesh.sqlite"), { readonly: true });
    try {
      const row = database.prepare(`SELECT revision,snapshot_revision,snapshot_json FROM qm_session_members WHERE id=?`)
        .get(opened.member_id) as { revision: number; snapshot_revision: number; snapshot_json: string | null } | undefined;
      cachedState = row ? { revision: row.revision, snapshot_revision: row.snapshot_revision } : undefined;
      cachedSnapshot = row?.snapshot_json ? validateSnapshot(JSON.parse(row.snapshot_json)) : undefined;
    } finally {
      database.close();
    }
    if (cachedSnapshot?.files.some((file) => file.path === "remote.txt")) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(cachedSnapshot?.files.some((file) => file.path === "remote.txt"), JSON.stringify(cachedState));
  const taskDatabase = new Database(join(entry.config.stateDir, "quaymesh.sqlite"), { readonly: true });
  const taskMemberRows = taskDatabase.prepare(`SELECT member_id FROM qm_task_members WHERE task_id=? ORDER BY member_id`)
    .all(taskId) as Array<{ member_id: string }>;
  taskDatabase.close();
  assert.equal(new Set(taskMemberRows.map((row) => row.member_id)).size, 2, JSON.stringify(taskMemberRows));
  let snapshot: ReturnType<typeof validateSnapshot> | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    const reply = await entry.client.callTool({ name: "qm_session", arguments: { session_id: opened.session_id, task_id: taskId, member_id: opened.member_id, since_rev: -1 } });
    assert.notEqual(reply.isError, true, JSON.stringify(reply.content));
    snapshot = validateSnapshot(structured(reply).snapshot);
    if (snapshot.files.some((file) => file.path === "remote.txt")) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(snapshot?.files.some((file) => file.path === "remote.txt"));
  assert.equal(snapshot.workspaces.length, 2);
  assert.deepEqual(new Set(snapshot.workspaces.map((member) => member.node_id)), new Set(["entry", "worker"]));
  const file = snapshot.files.find((item) => item.path === "remote.txt")!;
  const diff = await entry.client.callTool({ name: "qm_file_diff", arguments: { session_id: opened.session_id, task_id: taskId, member_id: opened.member_id, file_id: file.id, hash: file.hash } });
  assert.notEqual(diff.isError, true, JSON.stringify(diff.content));
  assert.match(String(structured(diff).patch), /remote result/);
  // 第一轮任务先显式结束，历史卡片才会显示清晰结束状态。
  const firstFinish = structured(await entry.client.callTool({ name: "finish_task", arguments: { task_id: taskId, status: "completed", summary: "联邦任务一完成" }, _meta: meta }));
  assert.equal(firstFinish.result_status, "completed");
  const taskSelection = structured(await entry.client.callTool({ name: "task_resume", arguments: { action: "inspect", task_id: taskId }, _meta: meta }));
  const second = structured(await entry.client.callTool({ name: "start_session", arguments: { request_key: "request-2-7171", title: "联邦任务二",
    new_goal: true, expected_binding_revision: (taskSelection.binding as { binding_revision: number }).binding_revision }, _meta: meta }));
  assert.equal(second.session_id, opened.session_id);
  assert.notEqual(second.task_id, taskId);
  const taskTwoRead = await entry.client.callTool({ name: "read", arguments: { workspace_id: opened.workspace_id, path: "README.md" }, _meta: meta });
  assert.notEqual(taskTwoRead.isError, true, JSON.stringify(taskTwoRead.content));
  const historical = await entry.client.callTool({ name: "qm_session", arguments: {
    session_id: opened.session_id, task_id: taskId, member_id: opened.member_id, since_rev: -1,
  } });
  assert.notEqual(historical.isError, true, JSON.stringify(historical.content));
  const historicalSnapshot = validateSnapshot(structured(historical).snapshot);
  assert.equal(historicalSnapshot.title, "联邦任务一");
  assert.equal(historicalSnapshot.status, "done");
  const historicalFile = historicalSnapshot.files.find((item) => item.path === "remote.txt");
  assert.ok(historicalFile);
  const historicalDiff = await entry.client.callTool({ name: "qm_file_diff", arguments: {
    session_id: opened.session_id, task_id: taskId, member_id: opened.member_id, file_id: historicalFile.id, hash: historicalFile.hash,
  } });
  assert.notEqual(historicalDiff.isError, true, JSON.stringify(historicalDiff.content));
  assert.match(String(structured(historicalDiff).patch), /remote result/);
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(entry.running.federation!.request("worker", "tool", { name: "missing_tool", input: {}, extra: {} }), PeerApplicationError);
  }
  assert.equal(entry.running.federation!.nodes().find((node) => node.id === "worker")?.online, true);
});
