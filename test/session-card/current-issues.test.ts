import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { callOpen, createRealTestServer, structured } from "./server-fixture.js";
import { validateSnapshot } from "../../src/session/schema.js";
import { prepareCodexVersion } from "../../scripts/prepare-codex-version.js";
import { loadQuayMeshFiles, writeQuayMeshConfig } from "../../src/user-config.js";
import { defaultQuayMeshConfig } from "../../src/config-schema.js";
import { resolveCodexCommand } from "../../src/local-agent-codex.js";
import { canonicalExecutionRoot } from "../../src/execution-coordinator.js";
import { openDatabase } from "../../src/db/client.js";

// Minimal model-facing results no longer repeat the Task/Member binding.
// The MCP App receives those identities from the non-model _meta envelope.
const withIdentity = (result: any): Record<string, any> => ({
  ...structured(result), ...(result._meta?.quaymesh ?? {}),
});

test("real commands feed the card, and attaching a root refreshes metadata and instructions", { timeout: 30_000 }, async (t) => {
  const server = await createRealTestServer({ uiEnabled: true });
  t.after(() => server.dispose());
  await writeFile(join(server.project, "README.md"), "user's initial change\n");
  await writeFile(join(server.secondRoot, "AGENTS.md"), "所有修改保留现有文件内容。\n");
  const conversation = "current-issues-real-session";
  const opened = withIdentity(await callOpen(server.client, server.project, conversation));
  const sessionId = String(opened.session_id);
  const memberId = String(opened.member_id);
  const workspaceId = String(opened.workspace_id);
  const meta = { "openai/session": conversation };
  const first = structured(await server.client.callTool({ name: "qm_session", arguments: { session_id: sessionId, member_id: memberId, since_rev: -1 } }));
  const initial = validateSnapshot(first.snapshot);
  assert.equal(initial.workspace.dirtySource, true);
  assert.ok(initial.workspace.baseSha);
  await server.client.callTool({ name: "read", arguments: { workspace_id: workspaceId, path: "README.md" }, _meta: meta });
  const script = join(server.project, "command.mjs");
  const expectedLines = ["first", "last", "中文输出"];
  await writeFile(script, "process.stdout.write('first\\n'); process.stderr.write('中文输出\\n'); setTimeout(() => process.stdout.write('last\\n'), 50);\n");
  const command = `"${process.execPath}" "${script}"`;
  const executed = await server.client.callTool({ name: "exec_command", arguments: { workspace_id: workspaceId, cmd: command, yield_time_ms: 1000 }, _meta: meta });
  assert.notEqual(executed.isError, true, JSON.stringify(executed.content));
  const receipt = structured(executed);
  if (receipt.running) {
    const finished = await server.client.callTool({ name: "write_stdin", arguments: {
      workspace_id: workspaceId, session_id: receipt.session_id, chars: "", yield_time_ms: 10_000,
    }, _meta: meta });
    assert.notEqual(finished.isError, true, JSON.stringify(finished.content));
  }
  let snapshot = initial;
  for (let attempt = 0; attempt < 50; attempt++) {
    const reply = structured(await server.client.callTool({ name: "qm_session", arguments: { session_id: sessionId, member_id: memberId, since_rev: -1 } }));
    snapshot = validateSnapshot(reply.snapshot);
    if (snapshot.commands.some((item) => item.status === "ok")) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(snapshot.commands.length, 1);
  assert.equal(snapshot.commands[0]!.cmd, command);
  assert.equal(snapshot.commands[0]!.output_available, true);
  const output = structured(await server.client.callTool({ name: "qm_command_output", arguments: {
    session_id: sessionId, member_id: memberId, command_id: snapshot.commands[0]!.id, cursor: 0, max_bytes: 65_536,
  } }));
  assert.deepEqual(output.chunk.trimEnd().split("\n").sort(), [...expectedLines].sort());
  assert.equal(output.done, true);
  const attached = withIdentity(await server.client.callTool({ name: "attach_workspace", arguments: {
    path: server.secondRoot, session_id: sessionId,
  }, _meta: meta }));
  assert.ok((attached.available_agents_files as Array<{ path: string }>).some((file) => file.path === "AGENTS.md"),
    "attaching a root exposes instruction paths without default instruction bodies");
  assert.ok(!(attached.available_agents_files as Array<Record<string, unknown>>).some(file => "content" in file));
  let refreshed = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    const reply = structured(await server.client.callTool({ name: "qm_session", arguments: { session_id: sessionId, member_id: memberId, since_rev: snapshot.rev } }));
    if (reply.snapshot && validateSnapshot(reply.snapshot).workspaces.length === 2) { refreshed = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(refreshed, true);
  const second = structured(await server.client.callTool({ name: "qm_session", arguments: { session_id: sessionId, member_id: attached.member_id, since_rev: -1 } }));
  assert.equal(validateSnapshot(second.snapshot).workspace.root, canonicalExecutionRoot(server.secondRoot));
});

test("explicit independent goals retain separate task cards within the compatible storage session", { timeout: 30_000 }, async (t) => {
  const server = await createRealTestServer({ uiEnabled: true });
  t.after(() => server.dispose());
  await writeFile(join(server.project, "AGENTS.md"), "task one rules\n");
  const conversation = "task-card-per-user-request";
  const meta = { "openai/session": conversation };

  const firstStart = structured(await server.client.callTool({
    name: "start_session", arguments: { request_key: "request-1-5353", title: "第一轮任务" }, _meta: meta,
  }));
  const opened = withIdentity(await callOpen(server.client, server.project, conversation));
  assert.equal(opened.session_id, firstStart.session_id);
  const firstTaskId = String(firstStart.task_id);
  const memberId = String(opened.member_id);
  const workspaceId = String(opened.workspace_id);

  const instructions = await server.client.callTool({name:"read",arguments:{workspace_id:workspaceId,path:"AGENTS.md"},_meta:meta});
  assert.notEqual(instructions.isError,true,"historical context must be explicitly read to become available");

  const firstPatch = await server.client.callTool({ name: "apply_patch", arguments: {
    workspace_id: workspaceId,
    patch: "*** Begin Patch\n*** Add File: first-task.txt\n+first task\n*** End Patch",
  }, _meta: meta });
  assert.notEqual(firstPatch.isError, true, JSON.stringify(firstPatch.content));

  let firstSnapshot: ReturnType<typeof validateSnapshot> | undefined;
  for (let attempt = 0; attempt < 80; attempt++) {
    const reply = structured(await server.client.callTool({ name: "qm_session", arguments: {
      session_id: opened.session_id, task_id: firstTaskId, member_id: memberId, since_rev: -1,
    } }));
    firstSnapshot = validateSnapshot(reply.snapshot);
    if (firstSnapshot.files.some((file) => file.path === "first-task.txt")) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(firstSnapshot?.files.some((file) => file.path === "first-task.txt"));
  const projectInstructionPath = join(server.project, "AGENTS.md");
  const instructionPath = firstSnapshot.instructions.find((item) => item.path === projectInstructionPath)?.path;
  assert.ok(instructionPath);

  // 第一轮任务按第 28 章要求调用 finish_task 保存交付摘要，历史卡片才会显示清晰结束状态。
  const firstFinish = structured(await server.client.callTool({
    name: "finish_task", arguments: { task_id: firstTaskId, status: "completed", summary: "第一轮任务完成" }, _meta: meta,
  }));
  assert.equal(firstFinish.result_status, "completed");

  const firstSelection = structured(await server.client.callTool({
    name: "task_resume", arguments: { action: "inspect", task_id: firstTaskId }, _meta: meta,
  }));
  const secondStart = structured(await server.client.callTool({
    name: "start_session", arguments: { request_key: "request-2-6914", title: "第二个独立目标", new_goal: true,
      expected_binding_revision: (firstSelection.binding as { binding_revision: number }).binding_revision }, _meta: meta,
  }));
  assert.equal(secondStart.session_id, firstStart.session_id);
  assert.notEqual(secondStart.task_id, firstStart.task_id);

  const secondPatch = await server.client.callTool({ name: "apply_patch", arguments: {
    workspace_id: workspaceId,
    patch: "*** Begin Patch\n*** Update File: AGENTS.md\n@@\n-task one rules\n+task two rules\n*** Add File: second-task.txt\n+second task\n*** End Patch",
  }, _meta: meta });
  assert.notEqual(secondPatch.isError, true, JSON.stringify(secondPatch.content));

  const historical = structured(await server.client.callTool({ name: "qm_session", arguments: {
    session_id: opened.session_id, task_id: firstTaskId, member_id: memberId, since_rev: -1,
  } }));
  const historicalSnapshot = validateSnapshot(historical.snapshot);
  assert.equal(historicalSnapshot.title, "第一轮任务");
  assert.equal(historicalSnapshot.status, "done");
  assert.ok(historicalSnapshot.files.some((file) => file.path === "first-task.txt"));
  assert.equal(historicalSnapshot.files.some((file) => file.path === "second-task.txt"), false);
  const historicalInstruction = structured(await server.client.callTool({ name: "qm_instruction", arguments: {
    session_id: opened.session_id, task_id: firstTaskId, member_id: memberId, path: instructionPath,
  } }));
  assert.match(String(historicalInstruction.content), /task one rules/);
  assert.doesNotMatch(String(historicalInstruction.content), /task two rules/);
});

test("workspace_context capture pages retain automatic operation receipts and rebuild exact Unicode source", { timeout: 60_000 }, async (t) => {
  const source = ["自动文本😀\"".repeat(15000) + "\r\n", "第二行\n".repeat(270) + "末尾😀"];
  const server = await createRealTestServer({ uiEnabled: true, files: {
    "source0.txt": source[0]!,
    "source1.txt": source[1]!,
  } });
  t.after(() => server.dispose());
  const conversation = "workspace-context-receipt-recovery";
  const opened = withIdentity(await callOpen(server.client, server.project, conversation));
  const workspaceId = String(opened.workspace_id);
  // A selection deliberately has a 250-line maximum. Represent the 271-line
  // second file as two explicit ranges, preserving one snapshot and one call.
  const files = [
    { path: "source0.txt", max_lines: 1 },
    { path: "source1.txt", max_lines: 250 },
    { path: "source1.txt", start_line: 251, max_lines: 21 },
  ];
  const rebuilt = ["", ""];
  const operations: string[] = [];
  let pages = 0;
  let page = structured(await server.client.callTool({
      name: "workspace_context",
      arguments: {
        workspace_id: workspaceId,
        action: "capture",
        files,
      },
      _meta: { "openai/session": conversation },
    }));
  const ref = String(page.result_ref);
  while (true) {
    const operationId = String(page.operation_id);
    assert.match(operationId, /^op_/);
    operations.push(operationId);
    for (const entry of page.entries as Array<{selection_index:number;lines:Array<{text:string;eol:string}>;sha256:string}>) {
      const fileIndex=entry.selection_index===0?0:1;
      for (const line of entry.lines) {
        assert(!line.text.includes("�"));
        rebuilt[fileIndex] += line.text + line.eol;
      }
      assert.equal(entry.sha256, createHash("sha256").update(source[fileIndex]!).digest("hex"));
    }
    if (page.complete === true) break;
    assert(page.next_cursor, "incomplete result must carry an absolute continuation cursor");
    assert(++pages < 100);
    page = structured(await server.client.callTool({name:"workspace_context",arguments:{
      workspace_id:workspaceId,action:"capture",result_ref:ref,cursor:page.next_cursor,
    },_meta:{"openai/session":conversation}}));
  }
  assert.deepEqual(rebuilt, source);
  assert(pages > 3);

  const database = openDatabase(server.config.stateDir);
  try {
    const runIds = new Set<string>();
    for (const operationId of operations) {
      const row = database.sqlite.prepare(
        "SELECT run_id FROM console_operations WHERE id = ?",
      ).get(operationId) as { run_id: string } | undefined;
      assert.match(String(row?.run_id),/^run_/,"internal run ownership remains durable without repeating it in every model result");
      runIds.add(row!.run_id);
    }
    assert.equal(runIds.size,1,"all pages belong to the same owning work run");
  } finally {
    database.close();
  }
});


test("the first file-diff page is bounded and all pages reproduce the saved patch", { timeout: 30_000 }, async (t) => {
  const server = await createRealTestServer({ uiEnabled: true });
  t.after(() => server.dispose());
  const conversation = "current-issues-diff-pages";
  const opened = structured(await callOpen(server.client, server.project, conversation));
  const added = Array.from({ length: 1500 }, (_, index) => `+line ${index}: 中文正文 contents`).join("\n");
  const response = await server.client.callTool({ name: "apply_patch", arguments: { workspace_id: opened.workspace_id,
    patch: `*** Begin Patch\n*** Add File: large.txt\n${added}\n*** End Patch`,
  }, _meta: { "openai/session": conversation } });
  assert.notEqual(response.isError, true, JSON.stringify(response.content));
  let file: ReturnType<typeof validateSnapshot>["files"][number] | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    const reply = structured(await server.client.callTool({ name: "qm_session", arguments: { session_id: opened.session_id, member_id: opened.member_id, since_rev: -1 } }));
    file = validateSnapshot(reply.snapshot).files.find((entry) => entry.path === "large.txt");
    if (file) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(file);
  let cursor: string | undefined;
  let patch = "";
  let pages = 0;
  do {
    const page = structured(await server.client.callTool({ name: "qm_file_diff", arguments: {
      session_id: opened.session_id, member_id: opened.member_id, file_id: file.id, hash: file.hash,
      ...(cursor ? { cursor } : {}),
    } }));
    assert.ok(Buffer.byteLength(String(page.patch)) <= 12 * 1024);
    patch += String(page.patch);
    cursor = page.cursor as string | undefined;
    pages++;
  } while (cursor);
  assert.ok(pages > 1);
  assert.match(patch, /line 0: 中文正文/);
  assert.match(patch, /line 1499: 中文正文/);
});

test("Codex preparation updates only the selected temporary provider configuration", { timeout: 30_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "quaymesh-codex-prepare-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const candidate = resolveCodexCommand();
  assert.ok(candidate?.version, "a real installed Codex executable is required");
  const env = { ...process.env, QUAYMESH_CONFIG_DIR: directory };
  const defaults = defaultQuayMeshConfig();
  writeQuayMeshConfig({ ...defaults, subagents: { ...defaults.subagents, providers: [{ id: "codex", enabled: true }] } }, env);
  const configBefore = loadQuayMeshFiles(env);
  const otherBefore = configBefore.config.subagents.providers.filter((provider) => provider.id !== "codex");
  const referenceBefore = await readFile("tools/codex-reference.json");
  const report = await prepareCodexVersion({ configDir: directory, executable: candidate.executable, version: candidate.version, activateForNewRuns: true });
  assert.equal(report.activated, true);
  const after = loadQuayMeshFiles(env);
  const codex = after.config.subagents.providers.find((provider) => provider.id === "codex");
  assert.ok(codex && "command" in codex);
  assert.equal(codex.command, candidate.executable);
  assert.deepEqual(after.config.subagents.providers.filter((provider) => provider.id !== "codex"), otherBefore);
  assert.equal("activeAgents" in report.inspect, false);
  assert.deepEqual(await readFile("tools/codex-reference.json"), referenceBefore);
});
