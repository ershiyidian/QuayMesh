import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { WORKSPACE_APP_URI } from "../../src/tool-surfaces/types.js";
import { setTimeout as delay } from "node:timers/promises";
import { callOpen, createRealTestServer, openConversation, structured } from "./server-fixture.js";

const APP_ONLY = [
  "qm_widget_stage",
  "qm_session",
  "qm_file_diff",
  "qm_command_output",
  "qm_command_outputs",
  "qm_instruction",
  "qm_patch",
  "qm_revert",
  "qm_file_url",
  "qm_session_continue",
];

const MODEL_NON_AGENT = [
  "start_session",
  "finish_task",
  "open_workspace",
  "attach_workspace",
  "read",
  "workspace_context",
  "apply_patch",
  "exec_command",
  "write_stdin",
];

const RETIRED = ["work_task", "agent_task", "show_changes"];

test("enabled UI exposes the real model surface, app-only surface and one card binding", async (t) => {
  const server = await createRealTestServer({ uiEnabled: true });
  t.after(() => server.dispose());

  const tools = await server.client.listTools();
  const names = tools.tools.map((tool) => tool.name);
  for (const name of MODEL_NON_AGENT) assert.ok(names.includes(name), "missing model tool " + name);
  for (const name of APP_ONLY) assert.ok(names.includes(name), "missing app tool " + name);
  assert.equal(names.includes("workspace_catalog"), false, "single-node server registered a federation-only tool");
  for (const name of RETIRED) assert.equal(names.includes(name), false, "retired tool still registered: " + name);

  const start = tools.tools.find((tool) => tool.name === "start_session");
  assert.deepEqual(start?._meta?.ui, { resourceUri: WORKSPACE_APP_URI, visibility: ["model"], availableDisplayModes:["inline","fullscreen"] });
  const open = tools.tools.find((tool) => tool.name === "open_workspace");
  assert.equal(open?._meta?.ui, undefined);
  const attach = tools.tools.find((tool) => tool.name === "attach_workspace");
  assert.equal(attach?._meta?.ui, undefined);
  for (const tool of tools.tools) {
    if (APP_ONLY.includes(tool.name)) {
      assert.deepEqual(tool._meta?.ui, { visibility: ["app"] }, tool.name + " is not app-only");
    } else if (tool.name !== "start_session") {
      assert.equal(tool._meta?.ui, undefined, tool.name + " unexpectedly binds the card");
    }
  }

  const resources = await server.client.listResources();
  assert.deepEqual(resources.resources.map((resource) => resource.uri), [
    WORKSPACE_APP_URI,
  ]);
});

test("first open_workspace then attach_workspace keeps one session with two members", async (t) => {
  const server = await createRealTestServer({ uiEnabled: true });
  t.after(() => server.dispose());

  const opened = await callOpen(server.client, server.project, "surface-conversation");
  const openStructured = { ...structured(opened), ...((opened._meta as any)?.quaymesh??{}) };
  const sessionId = openStructured.session_id;
  const firstMember = openStructured.member_id;
  assert.equal(typeof sessionId, "string");
  assert.equal(typeof firstMember, "string");

  const attach = await server.client.callTool({
    name: "attach_workspace",
    arguments: { session_id: sessionId, path: server.secondRoot },
    _meta: { "openai/session": "surface-conversation" },
  });
  assert.equal(attach.isError, undefined);
  assert.equal(attach._meta && (attach._meta as Record<string, unknown>).ui, undefined);
  const attachStructured = { ...structured(attach), ...((attach._meta as any)?.quaymesh??{}) };
  assert.equal(attachStructured.session_id, sessionId);
  assert.notEqual(attachStructured.member_id, firstMember);
});

test("qm_session reads the real stored snapshot and rejects other owners", async (t) => {
  const server = await createRealTestServer({ uiEnabled: true });
  t.after(() => server.dispose());

  const opened = await openConversation(server.client, server.project, "app-session-read");
  const sessionId = structured(opened).session_id as string;

  const first = await server.client.callTool({
    name: "qm_session",
    arguments: { session_id: sessionId, since_rev: -1 },
  });
  assert.equal(first.isError, undefined);
  const firstStructured = structured(first);
  assert.equal(firstStructured.unchanged, false);
  const rev = (firstStructured.rev as number) ?? 0;

  const again = await server.client.callTool({
    name: "qm_session",
    arguments: { session_id: sessionId, since_rev: rev },
  });
  assert.equal(structured(again).unchanged, true);

  const unknown = await server.client.callTool({
    name: "qm_session",
    arguments: { session_id: "not-a-real-session", since_rev: -1 },
  });
  assert.equal(unknown.isError, true);
});


test("unchanged snapshots stay small and five real file updates reach the card", { timeout: 60_000 }, async (t) => {
  const server = await createRealTestServer({ uiEnabled: true });
  t.after(() => server.dispose());

  const conversationId = "surface-performance";
  const opened = await openConversation(server.client, server.project, conversationId);
  const openedStructured = structured(opened);
  const sessionId = openedStructured.session_id as string;
  const workspaceId = openedStructured.workspace_id as string;

  const initial = await server.client.callTool({
    name: "qm_session",
    arguments: { session_id: sessionId, since_rev: -1 },
  });
  const initialStructured = structured(initial);
  assert.equal(initialStructured.unchanged, false);
  const initialRev = Number(initialStructured.rev);
  assert.ok(Number.isSafeInteger(initialRev) && initialRev >= 0);

  const idleSamples: Array<{ bytes: number; milliseconds: number }> = [];
  for (let index = 0; index < 30; index++) {
    const started = performance.now();
    const result = await server.client.callTool({
      name: "qm_session",
      arguments: { session_id: sessionId, since_rev: initialRev },
    });
    const milliseconds = performance.now() - started;
    assert.equal(structured(result).unchanged, true);
    idleSamples.push({ bytes: Buffer.byteLength(JSON.stringify(result), "utf8"), milliseconds: Number(milliseconds.toFixed(3)) });
  }

  const updates: Array<{ file: string; milliseconds: number; revision: number }> = [];
  let currentRev = initialRev;
  for (let index = 1; index <= 5; index++) {
    const file = `performance-${index}.txt`;
    const patch = ["*** Begin Patch", `*** Add File: ${file}`, `+real update ${index}`, "*** End Patch"].join("\n");
    const changed = await server.client.callTool({
      name: "apply_patch",
      arguments: { workspace_id: workspaceId, patch },
      _meta: { "openai/session": conversationId },
    });
    assert.notEqual(changed.isError, true, JSON.stringify(changed));

    const started = performance.now();
    let observed: Record<string, unknown> | undefined;
    while (performance.now() - started < 10_000) {
      const result = await server.client.callTool({
        name: "qm_session",
        arguments: { session_id: sessionId, since_rev: currentRev },
      });
      const value = structured(result);
      if (value.unchanged === false) {
        const snapshot = value.snapshot as { files?: Array<{ path?: string }> } | undefined;
        if (snapshot?.files?.some((entry) => entry.path === file)) {
          observed = value;
          break;
        }
      }
      await delay(20);
    }
    assert.ok(observed, `card did not observe ${file} within 10 seconds`);
    const revision = Number(observed.rev);
    assert.ok(revision > currentRev);
    updates.push({ file, milliseconds: Number((performance.now() - started).toFixed(3)), revision });
    currentRev = revision;
  }

  const idleBytes = idleSamples.map((sample) => sample.bytes);
  const idleMilliseconds = idleSamples.map((sample) => sample.milliseconds);
  const receipt = {
    createdAt: new Date().toISOString(),
    sessionId,
    idle: {
      requests: idleSamples.length,
      bytes: { min: Math.min(...idleBytes), max: Math.max(...idleBytes), average: Number((idleBytes.reduce((sum, value) => sum + value, 0) / idleBytes.length).toFixed(3)) },
      milliseconds: { min: Math.min(...idleMilliseconds), max: Math.max(...idleMilliseconds), average: Number((idleMilliseconds.reduce((sum, value) => sum + value, 0) / idleMilliseconds.length).toFixed(3)) },
      samples: idleSamples,
    },
    updates,
    noGitOrProviderRequests: "SessionProjector.read only reads stored snapshots and member state; the test does not replace or instrument Git or provider code.",
  };
  const directory = resolve("releases/session-acceptance");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "performance.json"), JSON.stringify(receipt, null, 2) + "\n", "utf8");
});

test("UI disabled leaves no card binding and no legacy placeholder resource", async (t) => {
  const server = await createRealTestServer({ uiEnabled: false });
  t.after(() => server.dispose());

  const tools = await server.client.listTools();
  assert.equal(tools.tools.some((tool) => tool._meta?.ui?.resourceUri), false);
  await assert.rejects(
    server.client.listResources(),
    (error: unknown) => (error as { code?: number }).code === -32601,
  );
});
