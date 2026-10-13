import assert from "node:assert/strict";
import Database from "better-sqlite3";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { freePort, createRealTestServer, structured } from "./server-fixture.js";

const CLUSTER_TOKEN = "session-card-federation-cluster-token-2026";
const withIdentity=(reply:any):Record<string,any>=>({
  ...structured(reply),...(reply._meta?.quaymesh??{}),
});

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 15000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(`TIMEOUT: ${label}`);
    await delay(50);
  }
}

test("F106 stale subscription is removed when its session was deleted before disconnect", { timeout: 45_000 }, async (t) => {
  process.env.QUAYMESH_CLUSTER_TOKEN = CLUSTER_TOKEN;
  const portA = await freePort();
  const portB = await freePort();
  const nodeB = await createRealTestServer({
    prefix: "quaymesh-stale-federation-b-",
    federation: {
      nodeId: "stale-node-b",
      nickname: "Stale Node B",
      capabilities: {coordinator:false,worker:true,discovery:false,egress:false,meshRelay:false,desktopUi:false,consoleRelay:false},
      priority: 0,
      port: portB,
      ingressPort: await freePort(),
      peers: [{ id: "stale-node-a", nickname: "Stale Node A", url: "" }],
    },
  });
  t.after(async () => { await nodeB.dispose(); delete process.env.QUAYMESH_CLUSTER_TOKEN; });
  const nodeA = await createRealTestServer({
    prefix: "quaymesh-stale-federation-a-",
    federation: {
      nodeId: "stale-node-a",
      nickname: "Stale Node A",
      capabilities: {coordinator:true,worker:true,discovery:false,egress:false,meshRelay:true,desktopUi:false,consoleRelay:false},
      priority: 100,
      port: portA,
      ingressPort: await freePort(),
      peers: [{ id: "stale-node-b", nickname: "Stale Node B", url: `http://127.0.0.1:${portB}` }],
    },
  });
  t.after(async () => { await nodeA.dispose(); });
  await until(() => nodeA.running.federation!.nodes().some((node) => node.id === "stale-node-b" && node.online), 15000, "stale-test node B online");
  const opened = withIdentity(await nodeA.client.callTool({
    name: "open_workspace",
    arguments: { path: nodeA.project },
    _meta: { "openai/session": "stale-federation-conversation" },
  }));
  const attached = withIdentity(await nodeA.client.callTool({
    name: "attach_workspace",
    arguments: { session_id: opened.session_id, root_id: "stale-node-b/main" },
    _meta: { "openai/session": "stale-federation-conversation" },
  }));
  assert.equal(typeof attached.member_id, "string");
  const sessionId = String(opened.session_id);
  const database = new Database(join(nodeA.config.stateDir, "quaymesh.sqlite"));
  try {
    database.pragma("foreign_keys = OFF");
    database.transaction(() => {
      for (const table of [
        "qm_agent_operations", "qm_agent_observations", "qm_context_reads",
        "qm_events", "qm_invocations", "qm_run_links",
      ]) {
        database.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(sessionId);
      }
      database.prepare("DELETE FROM qm_session_members WHERE session_id = ?").run(sessionId);
      database.prepare("DELETE FROM qm_sessions WHERE id = ?").run(sessionId);
    })();
  } finally {
    database.close();
  }
  nodeA.running.federation!.transport.updatePeers([{ id: "stale-node-b", nickname: "Stale Node B", url: "" }]);
  await until(() => !nodeA.running.federation!.nodes().find((node) => node.id === "stale-node-b")!.online, 10000, "stale-test node B offline");
  await delay(500);
  const verifyDatabase = new Database(join(nodeA.config.stateDir, "quaymesh.sqlite"), { readonly: true });
  try {
    assert.equal(verifyDatabase.prepare("SELECT 1 FROM qm_sessions WHERE id = ?").get(sessionId), undefined);
  } finally {
    verifyDatabase.close();
  }
  const health = await fetch(nodeA.baseUrl + "/healthz");
  assert.equal(health.status, 200);
});

test("F106 real two-node federation keeps ownership, streams revisions and reconnects", { timeout: 60_000 }, async (t) => {
  process.env.QUAYMESH_CLUSTER_TOKEN = CLUSTER_TOKEN;
  const portA = await freePort();
  const portB = await freePort();
  const ingressA = await freePort();
  const ingressB = await freePort();
  const nodeB = await createRealTestServer({
    prefix: "quaymesh-federation-b-",
    uiEnabled: true,
    federation: {
      nodeId: "node-b",
      nickname: "Node B",
      capabilities: {coordinator:false,worker:true,discovery:false,egress:false,meshRelay:false,desktopUi:false,consoleRelay:false},
      priority: 0,
      port: portB,
      ingressPort: ingressB,
      peers: [{ id: "node-a", nickname: "Node A", url: "" }],
    },
  });
  t.after(async () => { await nodeB.dispose(); delete process.env.QUAYMESH_CLUSTER_TOKEN; });
  const nodeA = await createRealTestServer({
    prefix: "quaymesh-federation-a-",
    uiEnabled: true,
    federation: {
      nodeId: "node-a",
      nickname: "Node A",
      capabilities: {coordinator:true,worker:true,discovery:false,egress:false,meshRelay:true,desktopUi:false,consoleRelay:false},
      priority: 100,
      port: portA,
      ingressPort: ingressA,
      peers: [{ id: "node-b", nickname: "Node B", url: `http://127.0.0.1:${portB}` }],
    },
  });
  t.after(async () => {
    await nodeA.dispose();
  });

  assert.ok(nodeA.running.federation);
  assert.ok(nodeB.running.federation);
  await until(() => nodeA.running.federation!.nodes().some((node) => node.id === "node-b" && node.online), 15000, "node B online");

  const opened = await nodeA.client.callTool({
    name: "open_workspace",
    arguments: { path: nodeA.project },
    _meta: { "openai/session": "federation-conversation" },
  });
  const openedData = withIdentity(opened);
  assert.equal(typeof openedData.session_id, "string");
  assert.equal(typeof openedData.member_id, "string");

  const attached = await nodeA.client.callTool({
    name: "attach_workspace",
    arguments: { session_id: openedData.session_id, root_id: "node-b/main" },
    _meta: { "openai/session": "federation-conversation" },
  });
  assert.equal(attached.isError, undefined, JSON.stringify(attached));
  const attachedData = withIdentity(attached);
  assert.equal(attachedData.session_id, openedData.session_id);
  assert.notEqual(attachedData.member_id, openedData.member_id);
  assert.equal(attachedData.root, nodeB.project);

  const remoteMember = nodeA.running.federation!.nodes().find((node) => node.id === "node-b");
  assert.ok(remoteMember);

  const remoteWorkspaceId = String(attachedData.workspace_id);
  const patch = [
    "*** Begin Patch",
    "*** Add File: federated.txt",
    "+created on node B",
    "*** End Patch",
  ].join("\n");
  const patched = await nodeA.client.callTool({
    name: "apply_patch",
    arguments: { workspace_id: remoteWorkspaceId, patch },
    _meta: { "openai/session": "federation-conversation" },
  });
  assert.equal(patched.isError, undefined, JSON.stringify(patched));
  assert.equal(await readFile(join(nodeB.project, "federated.txt"), "utf8"), "created on node B\n");
  await assert.rejects(readFile(join(nodeA.project, "federated.txt"), "utf8"), { code: "ENOENT" });

  const logicalSessionId = String(openedData.session_id);
  const remoteMemberId = String(attachedData.member_id);
  function invocationRow(server: typeof nodeA, toolName: string): Record<string, unknown> {
    const database = new Database(join(server.config.stateDir, "quaymesh.sqlite"), { readonly: true, fileMustExist: true });
    try {
      const row = database.prepare(
        `SELECT id, owner_id, transport_instance_id, request_id, tool_name FROM qm_invocations
         WHERE tool_name = ? ORDER BY created_at DESC LIMIT 1`,
      ).get(toolName) as Record<string, unknown> | undefined;
      assert.ok(row, `missing invocation for ${toolName}`);
      return row;
    } finally {
      database.close();
    }
  }
  function remoteInvocationCounts(): Record<string, number> {
    const database = new Database(join(nodeB.config.stateDir, "quaymesh.sqlite"), { readonly: true, fileMustExist: true });
    try {
      const rows = database.prepare(
        `SELECT tool_name, COUNT(*) AS count FROM qm_invocations GROUP BY tool_name ORDER BY tool_name`,
      ).all() as Array<{ tool_name: string; count: number }>;
      return Object.fromEntries(rows.map((row) => [row.tool_name, Number(row.count)]));
    } finally {
      database.close();
    }
  }
  async function readRemoteSnapshot(): Promise<Record<string, unknown>> {
    const result = await nodeA.client.callTool({
      name: "qm_session",
      arguments: { session_id: logicalSessionId, member_id: remoteMemberId, since_rev: -1 },
      _meta: { "openai/session": "federation-conversation" },
    });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.ok(result.structuredContent, JSON.stringify(result));
    return result.structuredContent as Record<string, unknown>;
  }
  let projected = await readRemoteSnapshot();
  await until(async () => {
    projected = await readRemoteSnapshot();
    return Boolean((projected.snapshot as any)?.files?.some((file: any) => file.path === "federated.txt"));
  }, 15000, "node A receives node B file revision");
  const projectedAfterPatch = projected.snapshot as any;
  assert.equal(projectedAfterPatch.files.filter((file: any) => file.path === "federated.txt").length, 1);
  const originalPatchInvocation = invocationRow(nodeA, "apply_patch");
  const remotePatchInvocation = invocationRow(nodeB, "apply_patch");
  assert.equal(remotePatchInvocation.id, originalPatchInvocation.id);
  assert.equal(remotePatchInvocation.request_id, originalPatchInvocation.request_id);
  const remoteCountsBeforeReads = remoteInvocationCounts();
  for (let index = 0; index < 8; index += 1) await readRemoteSnapshot();
  assert.deepEqual(remoteInvocationCounts(), remoteCountsBeforeReads);

  const disconnectedAt = projected.rev as number;
  await writeFile(join(nodeB.project, "long-task.mjs"), [
    "import { writeFileSync } from 'node:fs';",
    "setTimeout(() => writeFileSync(process.argv[2], 'DONE\\n'), 2000);",
  ].join("\n"), "utf8");
  const command = await nodeA.client.callTool({
    name: "exec_command",
    arguments: {
      workspace_id: remoteWorkspaceId,
      cmd: "node long-task.mjs command-done.txt",
      yield_time_ms: 100,
    },
    _meta: { "openai/session": "federation-conversation" },
  });
  assert.equal(command.isError, undefined, JSON.stringify(command));
  const commandData = structured(command);
  assert.equal(commandData.running, true, JSON.stringify(commandData));

  const nodeBUrl = `http://127.0.0.1:${portB}`;
  nodeA.running.federation!.transport.updatePeers([{ id: "node-b", nickname: "Node B", url: "" }]);
  await until(() => !nodeA.running.federation!.nodes().find((node) => node.id === "node-b")!.online, 10000, "node B offline on A");
  await until(() => existsSync(join(nodeB.project, "command-done.txt")), 15000, "remote command continues while A is disconnected");

  const offlineRead = await readRemoteSnapshot();
  const offlineSnapshot = offlineRead.snapshot as any;
  const offlineMember = offlineSnapshot.workspaces.find((member: any) => member.id === remoteMemberId);
  assert.ok(offlineMember);
  assert.equal(offlineMember.online, false);
  assert.equal(typeof offlineMember.last_observed_at, "string");
  assert.equal(offlineSnapshot.host_status, "disconnected");
  const offlineCommands = offlineSnapshot.commands.filter((row: any) => row.cmd === "node long-task.mjs command-done.txt");
  assert.equal(offlineCommands.length, 1, JSON.stringify(offlineSnapshot.commands));
  const commandOperationId = String(offlineCommands[0].operation_id);
  assert.equal(offlineCommands[0].status, "run", JSON.stringify(offlineCommands));
  assert.equal(offlineCommands[0].endedAt, null, JSON.stringify(offlineCommands));
  assert.equal(existsSync(join(nodeA.project, "command-done.txt")), false);
  assert.equal(await readFile(join(nodeB.project, "command-done.txt"), "utf8"), "DONE\n");

  nodeA.running.federation!.transport.updatePeers([{ id: "node-b", nickname: "Node B", url: nodeBUrl }]);
  await until(() => nodeA.running.federation!.nodes().some((node) => node.id === "node-b" && node.online), 15000, "node B reconnected on A");
  let reconnected = await readRemoteSnapshot();
  await until(async () => {
    reconnected = await readRemoteSnapshot();
    return (reconnected.rev as number) > disconnectedAt
      && (reconnected.snapshot as any).commands.some((row: any) => row.cmd === "node long-task.mjs command-done.txt" && row.status === "ok");
  }, 15000, "node A catches up node B revision and command completion");
  const reconnectedSnapshot = reconnected.snapshot as any;
  assert.equal(reconnectedSnapshot.files.filter((file: any) => file.path === "federated.txt").length, 1);
  const commandRows = reconnectedSnapshot.commands.filter((row: any) => row.cmd === "node long-task.mjs command-done.txt");
  assert.equal(commandRows.length, 1, JSON.stringify(reconnectedSnapshot.commands));
  assert.equal(commandRows[0].operation_id, commandOperationId, JSON.stringify(commandRows));
  assert.equal(commandRows[0].status, "ok", JSON.stringify(commandRows));
  assert.equal(await readFile(join(nodeB.project, "command-done.txt"), "utf8"), "DONE\n");
  assert.equal(existsSync(join(nodeA.project, "command-done.txt")), false);

  const repeated = structured(await nodeA.client.callTool({
    name: "qm_session",
    arguments: { session_id: logicalSessionId, member_id: remoteMemberId, since_rev: reconnected.rev },
    _meta: { "openai/session": "federation-conversation" },
  }));
  assert.equal(repeated.unchanged, true);
  assert.equal(repeated.rev, reconnected.rev);
});
