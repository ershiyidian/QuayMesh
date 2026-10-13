import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig, type ServerConfig, type ToolMode } from "./config.js";
import type { LocalAgentProviderAvailability } from "./local-agent-availability.js";
import { buildLocalAgentProviderStatuses } from "./local-agent-catalog.js";
import type { SubagentsConfig } from "./local-agent-config.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { createMcpServer, createServer } from "./server.js";
import { WORKSPACE_APP_URI } from "./tool-surfaces/types.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";
import { createSessionRuntime, type SessionRuntime } from "./session/runtime.js";
import { WorkLedger as ProjectWorkLedger } from "./work-ledger.js";
import { LocalAgentStore } from "./local-agent-store.js";
import { openDatabase } from "./db/client.js";
import { SessionStore } from "./session/store.js";
import { writeTestQuayMeshConfig } from "./test-support/config.test.js";
import type { ensureDesktopProject } from "./codex-projects.js";

const registerProject: typeof ensureDesktopProject = async (roots) => ({
  protocol: "fixture", status: "persisted_registration", roots, createdDirectories: [], projectId: "fixture-project", uiStatus: "unverified",
});

const execFileAsync = promisify(execFile);

test("console redirect preserves queries and does not redirect its own destination", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "quaymesh-console-redirect-"));
  const config = loadConfig(writeTestQuayMeshConfig(join(root, "config"), {
    storage: { stateDir: join(root, "state") },
    workspaces: { allowedRoots: [root], worktreeRoot: join(root, "worktrees") },
    subagents: { enabled: false, instructions: "on-demand", providers: [] },
  }));
  const server = createServer({ ...config, console: { enabled: false, allowRemote: false, sessionTtlSeconds: 300 } }, { registerProject });
  const http = server.app.listen(0, "127.0.0.1");
  t.after(async () => {
    await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
    await server.close();
    await rm(root, { recursive: true, force: true });
  });
  await once(http, "listening");
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  for (const query of ["", "?project=fixture&next=%2Fconsole%2F"]) {
    const redirect = await fetch(`${base}/console${query}`, { redirect: "manual" });
    assert.equal(redirect.status, 303);
    assert.equal(redirect.headers.get("location"), `/console/${query}`);
    await redirect.text();
    const entry = await fetch(`${base}/console/${query}`, { redirect: "manual" });
    assert.equal(entry.status, 404);
    assert.equal(entry.headers.get("location"), null);
    await entry.text();
  }
});

test("tool modes expose the expected host-facing tool surface", async (t) => {
  const cases: Array<{
    mode: ToolMode;
    expected: string[];
  }> = [
    {
      mode: "claude",
      expected: ["start_session", "finish_task", "open_workspace", "attach_workspace", "read", "workspace_context", "write", "edit", "bash"],
    },
    {
      mode: "codex",
      expected: ["start_session", "finish_task", "open_workspace", "attach_workspace", "read", "workspace_context", "apply_patch", "exec_command", "write_stdin"],
    },
  ];

  for (const { mode, expected } of cases) {
    await t.test(mode, async (nested) => {
      const context = await fixture(nested, { toolMode: mode, uiEnabled: false });
      const tools = await context.client.listTools();

      assert.deepEqual(
        tools.tools.map((tool) => tool.name).sort(),
        expected.sort(),
      );
    });
  }
});

test("command review opt-in changes only shell destructive annotations", async (t) => {
  for (const mode of ["codex", "claude"] as const) {
    await t.test(mode, async (nested) => {
      const reviewed = await fixture(nested, {
        toolMode: mode,
        dangerouslySkipCommandReview: false,
      });
      const preauthorized = await fixture(nested, {
        toolMode: mode,
        dangerouslySkipCommandReview: true,
      });
      const commandNames = mode === "codex" ? ["exec_command", "write_stdin"] : ["bash"];
      const reviewedTools = (await reviewed.client.listTools()).tools;
      const preauthorizedTools = (await preauthorized.client.listTools()).tools;

      for (const name of commandNames) {
        const reviewedAnnotations = reviewedTools.find((tool) => tool.name === name)?.annotations;
        const preauthorizedAnnotations = preauthorizedTools.find((tool) => tool.name === name)?.annotations;
        assert.equal(reviewedAnnotations?.destructiveHint, true);
        assert.equal(preauthorizedAnnotations?.destructiveHint, false);
        assert.equal(preauthorizedAnnotations?.readOnlyHint, false);
        assert.equal(preauthorizedAnnotations?.idempotentHint, false);
        assert.equal(preauthorizedAnnotations?.openWorldHint, true);
      }
    });
  }
});

test("model-facing tool schemas use snake_case recursively", async (t) => {
  for (const toolMode of ["claude", "codex"] as const) {
    await t.test(toolMode, async (nested) => {
      const context = await fixture(nested, { toolMode, uiEnabled: false });
      const tools = await context.client.listTools();
      const invalidPaths = tools.tools.flatMap((tool) => [
        ...schemaPropertyPaths(tool.inputSchema)
          .filter(({ key }) => !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(key))
          .map(({ path }) => `${tool.name}.input.${path}`),
        ...schemaPropertyPaths(tool.outputSchema)
          .filter(({ key }) => !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(key))
          .map(({ path }) => `${tool.name}.output.${path}`),
      ]);

      assert.deepEqual(invalidPaths, []);
    });
  }
});

test("Codex process tools bound model-facing yield windows to 12 seconds", async (t) => {
  const context = await fixture(t, { toolMode: "codex", uiEnabled: false });
  const tools = await context.client.listTools();

  for (const toolName of ["exec_command", "write_stdin"] as const) {
    const tool = tools.tools.find(({ name }) => name === toolName);
    const yieldSchema = tool?.inputSchema?.properties?.yield_time_ms as {
      maximum?: number;
      description?: string;
    } | undefined;

    assert.equal(yieldSchema?.maximum, 12_000);
    // 公开 JSON Schema 必须约束上限；描述文案可能由当前 MCP SDK 精简。
    assert.ok(yieldSchema?.description === undefined || typeof yieldSchema.description === "string");
  }
});

test("Claude edit and bash tools accept snake_case runtime inputs", async (t) => {
  const context = await fixture(t, { toolMode: "claude", uiEnabled: false });
  const workspaceId = structuredContent(
    await callOpen(context.client, context.project, "snake-case-claude"),
  ).workspace_id;
  assert.equal(typeof workspaceId, "string");

  await writeFile(join(context.project, "note.txt"), "before\n");
  await mkdir(join(context.project, "nested"));

  const edited = await context.client.callTool({
    name: "edit",
    arguments: {
      workspace_id: workspaceId,
      path: "note.txt",
      edits: [{ old_text: "before", new_text: "after" }],
    },
  });
  assert.equal(edited.isError, undefined);
  assert.equal(await readFile(join(context.project, "note.txt"), "utf8"), "after\n");

  const shell = structuredContent(await context.client.callTool({
    name: "bash",
    arguments: {
      workspace_id: workspaceId,
      command: "pwd",
      working_directory: "nested",
    },
  }));
  assert.match(shell.result as string, /nested/i);
});

test("read rejects a symlink that leaves the workspace", async (t) => {
  const context = await fixture(t, { toolMode: "claude", uiEnabled: false });
  const outside = await mkdtemp(join(tmpdir(), "quaymesh-server-outside-test-"));
  t.after(async () => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "secret.txt"), "outside secret\n");

  const outsideLink = join(context.project, "outside-link");
  await symlink(outside, outsideLink, platform() === "win32" ? "junction" : "dir");
  const workspaceId = structuredContent(
    await callOpen(context.client, context.project, "symlink-read"),
  ).workspace_id;
  assert.equal(typeof workspaceId, "string");

  const result = await context.client.callTool({
    name: "read",
    arguments: { workspace_id: workspaceId, path: "outside-link/secret.txt" },
  });
  assert.equal(result.isError, true);
});

test("write rejects a new file through a symlink that leaves the workspace", async (t) => {
  const context = await fixture(t, { toolMode: "claude", uiEnabled: false });
  const outside = await mkdtemp(join(tmpdir(), "quaymesh-server-outside-test-"));
  t.after(async () => rm(outside, { recursive: true, force: true }));

  const outsideLink = join(context.project, "outside-link");
  await symlink(outside, outsideLink, platform() === "win32" ? "junction" : "dir");
  const workspaceId = structuredContent(
    await callOpen(context.client, context.project, "symlink-write"),
  ).workspace_id;
  assert.equal(typeof workspaceId, "string");

  const result = await context.client.callTool({
    name: "write",
    arguments: {
      workspace_id: workspaceId,
      path: "outside-link/new.txt",
      content: "escaped\n",
    },
  });
  assert.equal(result.isError, true);
  await assert.rejects(access(join(outside, "new.txt")));
});

test("UI metadata is limited to workspace and aggregate review", async (t) => {
  for (const uiEnabled of [true, false]) {
    await t.test(uiEnabled ? "enabled" : "disabled", async (nested) => {
      const context = await fixture(nested, { toolMode: "claude", uiEnabled });
      const tools = await context.client.listTools();
      const toolsWithUi = tools.tools
        .filter((tool) => Boolean((tool._meta as { ui?: unknown } | undefined)?.ui))
        .map((tool) => tool.name)
        .sort();

      assert.deepEqual(toolsWithUi, uiEnabled ? ["start_session"] : []);
    });
  }
});

test("enabled UI exposes the production card, app-only tools and only start_session as a bound card", async (t) => {
  const context = await fixture(t, { uiEnabled: true, session: true });
  const appOnly = [
    "qm_session",
    "qm_file_diff",
    "qm_command_output",
    "qm_instruction",
    "qm_patch",
    "qm_revert",
    "qm_file_url",
    "qm_session_continue",
  ];
  const tools = (await context.client.listTools()).tools;
  for (const name of appOnly) {
    const tool = tools.find((entry) => entry.name === name);
    assert.ok(tool, );
    const visibility = (tool._meta as { ui?: { visibility?: string[] } } | undefined)?.ui?.visibility;
    assert.deepEqual(visibility, ["app"]);
  }

  const start = tools.find((tool) => tool.name === "start_session");
  const open = tools.find((tool) => tool.name === "open_workspace");
  const attach = tools.find((tool) => tool.name === "attach_workspace");
  assert.equal((start?._meta as { ui?: { resourceUri?: string } } | undefined)?.ui?.resourceUri, WORKSPACE_APP_URI);
  assert.ok((start?.outputSchema as { required?: string[] } | undefined)?.required?.includes("task_id"));
  assert.equal((open?._meta as { ui?: unknown } | undefined)?.ui, undefined);
  assert.equal((attach?._meta as { ui?: unknown } | undefined)?.ui, undefined);

  const resources = await context.client.listResources();
  assert.deepEqual(resources.resources.map((resource) => resource.uri), [
    WORKSPACE_APP_URI,
  ]);
  const read = await context.client.readResource({ uri: WORKSPACE_APP_URI });
  const content = read.contents[0];
  assert.ok(content && "text" in content);
  assert.match(content.text, /id="card"/);
  assert.match(content.text, /id="t-changes"/);
  assert.match(content.text, /id="t-commands"/);
  assert.match(content.text, /id="t-agents"/);
  assert.match(content.text, /id="t-context"/);
  assert.match(content.text, /id="p-changes"/);
  assert.match(content.text, /id="clock"/);
  assert.doesNotMatch(content.text, /class="demo"/);
  assert.doesNotMatch(content.text, /Legacy Client Support Only/);
});

test("each user request gets a distinct task while the conversation keeps one session", async (t) => {
  const context = await fixture(t, { uiEnabled: true, session: true });
  assert.ok(context.runtime);
  const first = await context.runtime.service.startTask({ owner_id: "owner-a", conversation_id: "conversation-task-contract" }, "第一轮");
  const second = await context.runtime.service.startTask({ owner_id: "owner-a", conversation_id: "conversation-task-contract" }, "第二轮");
  assert.equal(second.session.id, first.session.id);
  assert.notEqual(second.task.id, first.task.id);
  assert.equal(first.task.title, "第一轮");
  assert.equal(second.task.title, "第二轮");
  assert.equal(context.runtime.store.getTask(first.task.id).state, "closed");
  assert.equal(context.runtime.store.currentTask(first.session.id)?.id, second.task.id);
});

test("when uiEnabled is false, tools omit UI metadata and the production resource is not registered", async (t) => {
  const context = await fixture(t, { toolMode: "claude", uiEnabled: false });
  const toolList = await context.client.listTools();
  for (const tool of toolList.tools) {
    const meta = tool._meta as { ui?: unknown; "ui/resourceUri"?: unknown } | undefined;
    assert.equal(meta?.ui, undefined);
    assert.equal(meta?.["ui/resourceUri"], undefined);
  }
  const capabilities = context.client.getServerCapabilities();
  assert.equal(capabilities?.resources, undefined);
});

test("MCP advertises explicit directory creation and preserves it through the real tool handler", async (t) => {
  const context = await fixture(t, { toolMode: "codex", uiEnabled: false });
  const tool = (await context.client.listTools()).tools.find((entry) => entry.name === "open_workspace");
  assert(tool);
  const property = tool.inputSchema.properties?.create_directory as { type?: string } | undefined;
  assert.equal(property?.type, "boolean");
  assert(!tool.inputSchema.required?.includes("create_directory"));
  const target = join(context.project, "new-explicit-project");
  const missing = await context.client.callTool({ name: "open_workspace", arguments: { path: target },
    _meta: { "openai/session": "new-project-contract" } });
  assert.equal(missing.isError, true);
  assert.match(JSON.stringify(missing.content), /only if|Only if/);
  assert.match(JSON.stringify(missing.content), /host exposes create_directory/);
  await assert.rejects(access(target));
  const request = { name: "open_workspace", arguments: { path: target, create_directory: true },
    _meta: { "openai/session": "new-project-contract" } };
  const created = await context.client.callTool(request);
  assert(!created.isError);
  await access(target);
  const first = structuredContent(created);
  assert.equal((first.execution as { platform: string }).platform, process.platform);
  assert.equal("transport" in (first.execution as Record<string,unknown>),false,"process transport is internal metadata, not a model contract");
  const registration = responseCard(created).project_registration as { status: string; quaymeshProjectId: string };
  assert.equal(registration.status, "not_configured");
  assert.match(registration.quaymeshProjectId, /^prj_/);
  const repeated = structuredContent(await context.client.callTool(request));
  assert.equal(repeated.workspace_id, first.workspace_id);
});

test("open_workspace reports aggregate review availability", async (t) => {
  const plain = await fixture(t);
  const gitWorkspace = await fixture(t, { git: true });

  const plainReview = responseCard(await callOpen(plain.client, plain.project, "plain")).review;
  const gitReview = responseCard(await callOpen(gitWorkspace.client, gitWorkspace.project, "git")).review;

  assert.equal((plainReview as { available: boolean }).available, false);
  assert.deepEqual(gitReview, { available: true });
});

test("open_workspace keeps lifecycle flags out of model output and preserves complete card metadata", async (t) => {
  const providerNote = "available";
  const context = await fixture(t, {
    localAgentProviders: [{ name: "codex", available: true, note: providerNote }],
  });
  const first = await callOpen(context.client, context.project, "chat-1");
  const repeated = await callOpen(context.client, context.project, "chat-1");
  assert.equal((first._meta as Record<string, unknown> | undefined)?.tool, undefined);
  assert.equal((repeated._meta as Record<string, unknown> | undefined)?.tool, undefined);

  const tools = await context.client.listTools();
  const openTool = tools.tools.find((tool) => tool.name === "open_workspace");
  const outputProperties = (openTool?.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  assert.equal(outputProperties && "project_registration" in outputProperties, false,
    "项目注册详情属于卡片 metadata，不应重复暴露在模型 schema");
  assert.ok("create_directory" in (openTool!.inputSchema.properties ?? {}));
  assert.equal(openTool?.annotations?.readOnlyHint, false);
  assert.equal((responseCard(first).project_registration as { status: string }).status, "persisted_registration");
  assert.ok(outputProperties && "workspace_id" in outputProperties);
  assert.equal(outputProperties && "workspaceId" in outputProperties, false);
  assert.equal(outputProperties && "workspaceReused" in outputProperties, false);
  assert.equal(outputProperties && "includeBootstrapContext" in outputProperties, false);
  assert.equal(outputProperties && "agent_providers" in outputProperties, false);

  const firstStructured = structuredContent(first);
  assert.equal(typeof firstStructured.workspace_id, "string");
  assert.equal("workspaceId" in firstStructured, false);
  assert.equal(firstStructured.workspace_id, structuredContent(repeated).workspace_id);
  assert.equal(firstStructured.agents_files, undefined);
  assert.ok(firstStructured.available_agents_files === undefined || Array.isArray(firstStructured.available_agents_files));
  assert.equal(firstStructured.skills, undefined);
  assert.equal(firstStructured.agent_providers, undefined);
  const firstCard=responseCard(first);
  assert.ok(Array.isArray(firstCard.agentProviders));
  assert.equal(
    (firstCard.agentProviders as Array<Record<string, unknown>>)[0]?.id,
    "codex",
  );
  assert.equal(
    (firstCard.agentProviders as Array<Record<string, unknown>>)[0]?.note,
    providerNote,
  );
  assert.equal(firstStructured.agents, undefined);
  assert.equal(firstStructured.skill_diagnostics, undefined);
  assert.equal("workspaceReused" in firstStructured, false);
  assert.equal("includeBootstrapContext" in firstStructured, false);

  const repeatedStructured = structuredContent(repeated);
  assert.equal(firstStructured.instruction, undefined);
  assert.equal(repeatedStructured.instruction, undefined);
  assert.match(String(firstCard.instruction), /workspace_id/);
  assert.match(String(responseCard(repeated).instruction), /workspace_id/);
  assert.equal(repeatedStructured.agents_files, undefined);
  assert.equal(repeatedStructured.available_agents_files, undefined);
  assert.equal(repeatedStructured.skills, undefined);
  assert.equal(repeatedStructured.agent_providers, undefined);
  assert.equal(repeatedStructured.agents, undefined);
  assert.equal(repeatedStructured.skill_diagnostics, undefined);
  assert.equal("workspaceReused" in repeatedStructured, false);
  assert.equal("includeBootstrapContext" in repeatedStructured, false);

  const card = responseCard(repeated);
  assert.equal(card.workspaceReused, true);
  assert.equal(card.includeBootstrapContext, false);
  assert.ok(Array.isArray(card.agentsFiles));
  assert.ok(Array.isArray(card.availableAgentsFiles));
  assert.ok(Array.isArray(card.skills));
  assert.ok(Array.isArray(card.agentProviders));
  assert.equal(
    (card.agentProviders as Array<Record<string, unknown>>)[0]?.note,
    providerNote,
  );
  assert.ok(Array.isArray(card.agents));
});

test("open_workspace refreshes provider availability for each catalog", async (t) => {
  let available = false;
  const context = await fixture(t, {
    localAgentProviders: () => [{ name: "codex", available }],
  });

  const unavailable = responseCard(await callOpen(context.client, context.project, "chat-1"));
  assert.deepEqual(unavailable.agentProviders, []);
  assert.deepEqual(unavailable.agents, []);

  available = true;
  const usable = responseCard(await callOpen(context.client, context.project, "chat-2"));
  assert.equal(
    (usable.agentProviders as Array<Record<string, unknown>>)[0]?.id,
    "codex",
  );
  assert.equal(
    (usable.agents as Array<Record<string, unknown>>)[0]?.name,
    "reviewer",
  );
});

test("open_workspace omits providers disabled by configuration", async (t) => {
  const context = await fixture(t, {
    localAgentProviders: [
      { name: "codex", available: true },
      { name: "claude", available: true },
    ],
    subagents: {
      enabled: true,
      instructions: "on-demand",
      providers: [
        { id: "codex", enabled: true },
        { id: "claude", enabled: false },
      ],
    },
  });

  const opened = responseCard(await callOpen(context.client, context.project, "chat-1"));
  assert.deepEqual(
    (opened.agentProviders as Array<Record<string, unknown>>).map((provider) => provider.id),
    ["codex"],
  );
});

test("open_workspace advertises subagent instructions on demand by default", async (t) => {
  const context = await fixture(t, {
    localAgentProviders: [{ name: "codex", available: true }],
  });

  const response=await callOpen(context.client, context.project, "chat-1");
  const opened = responseCard(response);
  assert.ok(Array.isArray(opened.skills));
  assert.equal(structuredContent(response).skills, undefined);
  const skills = opened.skills as Array<Record<string, unknown>>;
  assert.equal(skills.some((skill) => skill.name === "subagents"), true);
  assert.doesNotMatch(String(opened.instruction), /# Subagents/);
});

test("open_workspace preloads subagent instructions when configured", async (t) => {
  const context = await fixture(t, {
    localAgentProviders: [{ name: "codex", available: true }],
    subagents: {
      enabled: true,
      instructions: "preload",
      providers: [{ id: "codex", enabled: true }],
    },
  });

  const response=await callOpen(context.client, context.project, "chat-1");
  const opened = responseCard(response);
  const skills = opened.skills as Array<Record<string, unknown>>;
  assert.equal(skills.some((skill) => skill.name === "subagents"), true);
  const instruction = String(opened.instruction);
  assert.match(instruction, /Read project instruction files only when requested/);
  assert.equal(structuredContent(response).instruction,undefined);
  const listed=(await context.client.listTools()).tools.map(tool=>tool.name);
  assert.ok(listed.includes("spawn_agent"));
  assert.ok(listed.includes("wait_agent"));
  assert.doesNotMatch(instruction, /work_task|agent_task|show_changes/);
});

test("real MCP read records one operation without counting a card read", async (t) => {
  const { root, localBaseUrl, accessToken } = await httpServerFixture(t, "quaymesh-recorded-read-");
  await writeFile(join(root, "AGENTS.md"), "project instructions\n");
  const meta = { "openai/session": "recorded-read" };
  const openedResponse = await postModernMcp(localBaseUrl, accessToken, "tools/call", {
    name: "open_workspace", arguments: { path: root }, _meta: meta,
  });
  assert.equal(openedResponse.status, 200, await openedResponse.clone().text());
  const openedBody = await openedResponse.json() as { result?: { structuredContent?: { workspace_id?: string } } };
  const workspaceId = openedBody.result?.structuredContent?.workspace_id;
  assert.equal(typeof workspaceId, "string");
  const readResponse = await postModernMcp(localBaseUrl, accessToken, "tools/call", {
    name: "read", arguments: { workspace_id: workspaceId, path: "AGENTS.md" }, _meta: meta,
  });
  assert.equal(readResponse.status, 200, await readResponse.clone().text());
  const readBody = await readResponse.json() as { result?: { structuredContent?:{result?:string} } };
  assert.match(readBody.result?.structuredContent?.result ?? "", /project instructions/);
  const database = openDatabase(join(root, ".state"));
  try {
  const store = new SessionStore(database.sqlite);
  const session = store.findByConversation("local-owner", "recorded-read");
  assert.ok(session);
  const events = store.eventsForSession(session!.id);
  const started = events.filter((event) => event.type === "operation_started");
  const finished = events.filter((event) => event.type === "operation_finished");
  assert.equal(started.length, 1);
  assert.equal(finished.length, 1);
  assert.equal(finished[0]!.payload.status, "succeeded");
  const task = store.currentTask(session!.id);
  assert.ok(task);
  const reads = store.contextReads(session!.id, undefined, task.id).filter((row) => row.actor_id === "model");
  assert.equal(reads.length, 1);
  assert.equal(reads[0]!.read_count, 1);
  const before = reads[0]!.read_count;
  const card = await postModernMcp(localBaseUrl, accessToken, "tools/call", {
    name: "qm_instruction", arguments: { session_id: session!.id, path: reads[0]!.path }, _meta: meta,
  });
  assert.equal(card.status, 200, await card.clone().text());
  assert.equal(
    store.contextReads(session!.id, undefined, task.id).find((row) => row.actor_id === "model" && row.path === reads[0]!.path)!.read_count,
    before,
  );
  } finally { database.close(); }
});

test("real MCP keeps conversation sessions isolated and explicit attach session-scoped", async (t) => {
  const { root, localBaseUrl, accessToken } = await httpServerFixture(t, "quaymesh-session-identity-");
  const conversationA = { "openai/session": "conversation-a" };
  const conversationB = { "openai/session": "conversation-b" };

  const firstA = await postModernMcp(localBaseUrl, accessToken, "tools/call", {
    name: "open_workspace",
    arguments: { path: root },
    _meta: conversationA,
  });
  assert.equal(firstA.status, 200, await firstA.clone().text());
  const firstABody = await firstA.json() as {
    result?: { structuredContent?: { session_id?: string; workspace_id?: string } };
  };
  const sessionA = firstABody.result?.structuredContent?.session_id;
  assert.equal(typeof sessionA, "string");

  const remountedA = await postModernMcp(localBaseUrl, accessToken, "tools/call", {
    name: "open_workspace",
    arguments: { path: root },
    _meta: {
      "openai/session": "conversation-a",
      "openai/widgetSessionId": "widget-remount-1",
    },
  });
  const remountedABody = await remountedA.json() as {
    result?: { structuredContent?: { session_id?: string; workspace_id?: string } };
  };
  assert.equal(remountedABody.result?.structuredContent?.session_id, sessionA);
  assert.equal(
    remountedABody.result?.structuredContent?.workspace_id,
    firstABody.result?.structuredContent?.workspace_id,
  );

  const firstB = await postModernMcp(localBaseUrl, accessToken, "tools/call", {
    name: "open_workspace",
    arguments: { path: root },
    _meta: conversationB,
  });
  const firstBBody = await firstB.json() as {
    result?: { structuredContent?: { session_id?: string; workspace_id?: string } };
  };
  assert.equal(typeof firstBBody.result?.structuredContent?.session_id, "string");
  assert.notEqual(firstBBody.result?.structuredContent?.session_id, sessionA);
  assert.notEqual(firstBBody.result?.structuredContent?.workspace_id, firstABody.result?.structuredContent?.workspace_id);

  const explicitAttach = await postModernMcp(localBaseUrl, accessToken, "tools/call", {
    name: "attach_workspace",
    arguments: { path: root, session_id: sessionA },
    _meta: { "openai/session": "conversation-b" },
  });
  assert.equal(explicitAttach.status, 200, await explicitAttach.clone().text());
  const explicitAttachBody = await explicitAttach.json() as {
    result?: {
      isError?: boolean;
      content?: Array<{ type?: string; text?: string }>;
      structuredContent?: { session_id?: string };
    };
  };
  assert.equal(explicitAttachBody.result?.isError, true);
  assert.match(JSON.stringify(explicitAttachBody.result?.content), /SESSION_SCOPE_MISMATCH/);

  const missingConversation = await postModernMcp(localBaseUrl, accessToken, "tools/call", {
    name: "attach_workspace",
    arguments: { path: root },
    _meta: {},
  });
  const missingConversationBody = await missingConversation.json() as {
    result?: { isError?: boolean; content?: Array<{ type?: string; text?: string }> };
  };
  assert.equal(missingConversationBody.result?.isError, true);
  assert.match(JSON.stringify(missingConversationBody.result?.content), /SESSION_REQUIRED/);
});
test("open_workspace scopes checkout reuse to OpenAI session metadata", async (t) => {
  const context = await fixture(t);
  const first = await callOpen(context.client, context.project, "chat-1");
  const repeated = await callOpen(context.client, context.project, "chat-1");
  const otherSession = await callOpen(context.client, context.project, "chat-2");
  const unscoped = await callOpen(context.client, context.project);

  assert.equal(structuredContent(repeated).workspace_id, structuredContent(first).workspace_id);
  assert.equal(structuredContent(repeated).agents_files, undefined);
  assert.notEqual(structuredContent(otherSession).workspace_id, structuredContent(first).workspace_id);
  assert.notEqual(structuredContent(unscoped).workspace_id, structuredContent(first).workspace_id);
  assert.ok(Array.isArray(responseCard(otherSession).agentsFiles));
  assert.ok(Array.isArray(responseCard(unscoped).agentsFiles));
  assert.equal(structuredContent(otherSession).agents_files,undefined);
  assert.equal(structuredContent(unscoped).agents_files,undefined);
});

test("authenticated HTTP normalizes cached tool arguments without relaxing canonical checks", async (t) => {
  const { root, localBaseUrl, accessToken } = await httpServerFixture(t, "quaymesh-cached-arguments-");
  await writeFile(join(root, "cached.txt"), "first\nsecond\nthird\n");
  const meta = { "openai/session": "cached-contract-regression" };
  const opened = await postModernMcp(localBaseUrl, accessToken, "tools/call", {
    name: "open_workspace", arguments: { path: root }, _meta: meta,
  });
  assert.equal(opened.status, 200);
  const body = await opened.json() as { result?: { structuredContent?: { workspace_id?: string } } };
  const workspaceId = body.result?.structuredContent?.workspace_id;
  assert.equal(typeof workspaceId, "string");
  const cached = { name: "workspace_context", arguments: { workspaceId, action: "capture",
    files: [{ path: "cached.txt", startLine: 2, maxLines: 1 }] }, _meta: meta };
  const unauthorized = await postModernMcp(localBaseUrl, undefined, "tools/call", cached);
  assert.equal(unauthorized.status, 401);
  await unauthorized.text();
  const read = await postModernMcp(localBaseUrl, accessToken, "tools/call", cached);
  assert.equal(read.status, 200);
  const readBody = await read.json() as { result?: { isError?: boolean;
    structuredContent?:{entries?:Array<{lines?:Array<{line:number;text:string}>}>} } };
  assert.equal(readBody.result?.isError, undefined);
  const captured = readBody.result?.structuredContent;
  assert.ok(captured);
  assert.deepEqual(captured.entries?.[0]?.lines?.map(({ line, text }) => ({ line, text })), [{ line: 2, text: "second" }]);
  const conflict = await postModernMcp(localBaseUrl, accessToken, "tools/call", {
    name: "read", arguments: { workspaceId, workspace_id: "different-private-scope", path: "cached.txt" }, _meta: meta,
  });
  assert.equal(conflict.status, 400);
  const error = await conflict.text();
  assert(!error.includes("different-private-scope"));
  for (const file of [{ path: "cached.txt", startLine: 1, maxLines: 251 },
    { path: "cached.txt", maxLines: 1, unexpected: true }]) {
    const rejected = await postModernMcp(localBaseUrl, accessToken, "tools/call", {
      name: "workspace_context", arguments: { workspaceId, action: "capture", files: [file] }, _meta: meta,
    });
    const invalid = await rejected.json() as { error?: unknown; result?: { isError?: boolean } };
    assert(invalid.error || invalid.result?.isError, "Canonical range and strict-key checks must still reject invalid requests");
  }
});

test("HTTP endpoint serves modern MCP and stateless legacy clients", async (t) => {
  const { root, localBaseUrl, accessToken } = await httpServerFixture(
    t,
    "quaymesh-modern-http-test-",
  );

  const unauthenticated = await postModernMcp(
    localBaseUrl,
    undefined,
    "tools/list",
    {},
  );
  assert.equal(unauthenticated.status, 401, await unauthenticated.clone().text());

  const discovery = await postModernMcp(
    localBaseUrl,
    accessToken,
    "server/discover",
    {},
  );
  assert.equal(discovery.status, 200, await discovery.clone().text());
  const discoveryBody = await discovery.json() as {
    result?: { supportedVersions?: string[] };
  };
  assert.ok(discoveryBody.result?.supportedVersions?.includes("2026-07-28"));

  const listed = await postModernMcp(
    localBaseUrl,
    accessToken,
    "tools/list",
    {},
  );
  assert.equal(listed.status, 200, await listed.clone().text());
  const listBody = await listed.json() as {
    result?: { tools?: Array<{ name?: string }> };
  };
  assert.ok(listBody.result?.tools?.some((tool) => tool.name === "open_workspace"));

  const called = await postModernMcp(
    localBaseUrl,
    accessToken,
    "tools/call",
    {
      name: "open_workspace",
      arguments: { path: root },
      _meta: { "openai/session": "modern-http-test" },
    },
  );
  assert.equal(called.status, 200, await called.clone().text());
  const callBody = await called.json() as {
    result?: { structuredContent?: { workspace_id?: string; agents_files?: unknown[] } };
  };
  const workspaceId = callBody.result?.structuredContent?.workspace_id;
  assert.equal(typeof workspaceId, "string");

  const repeated = await postModernMcp(
    localBaseUrl,
    accessToken,
    "tools/call",
    {
      name: "open_workspace",
      arguments: { path: root },
      _meta: { "openai/session": "modern-http-test" },
    },
  );
  assert.equal(repeated.status, 200, await repeated.clone().text());
  const repeatedBody = await repeated.json() as {
    result?: { structuredContent?: { workspace_id?: string; agents_files?: unknown[] } };
  };
  assert.equal(repeatedBody.result?.structuredContent?.workspace_id, workspaceId);
  assert.equal(repeatedBody.result?.structuredContent?.agents_files, undefined);

  const modernTools = await postModernMcp(localBaseUrl, accessToken, "tools/list", {});
  assert.equal(modernTools.status, 200, await modernTools.clone().text());
  const modernToolsBody = await modernTools.json() as { result?: { tools?: Array<{ name?: string }> } };
  const names = modernToolsBody.result?.tools?.map((tool) => tool.name) ?? [];
  assert.ok(names.includes("apply_patch"));
  assert.equal(names.includes("work_task"), false);
  assert.equal(names.includes("agent_task"), false);
  assert.equal(names.includes("show_changes"), false);

  const legacy = await fetch(`${localBaseUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "legacy-initialize",
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "quaymesh-legacy-test", version: "1.0.0" },
      },
    }),
  });
  assert.equal(legacy.status, 200, await legacy.clone().text());
  assert.equal(legacy.headers.get("mcp-session-id"), null);
  assert.match(await legacy.text(), /"protocolVersion"/);

  const legacyTools = await fetch(`${localBaseUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "legacy-tools-list",
      method: "tools/list",
      params: {},
    }),
  });
  assert.equal(legacyTools.status, 200, await legacyTools.clone().text());
  assert.equal(legacyTools.headers.get("mcp-session-id"), null);
  assert.match(await legacyTools.text(), /"open_workspace"/);
});

test("stateless MCP gives distinct calls distinct identities when JSON-RPC ids repeat", async (t) => {
  const { root, localBaseUrl, accessToken } = await httpServerFixture(t, "quaymesh-stateless-identity-");
  const meta = { "openai/session": "stateless-identity-conversation" };
  const opened = await postModernMcp(localBaseUrl, accessToken, "tools/call", {
    name: "open_workspace", arguments: { path: root }, _meta: meta,
  }, "0");
  assert.equal(opened.status, 200, await opened.clone().text());
  const openedBody = await opened.json() as { result?: { structuredContent?: { workspace_id?: string } } };
  const workspaceId = openedBody.result?.structuredContent?.workspace_id;
  assert.equal(typeof workspaceId, "string");

  const command = await postModernMcp(localBaseUrl, accessToken, "tools/call", {
    name: "exec_command",
    arguments: { workspace_id: workspaceId, cmd: "node -e \"require('fs').appendFileSync('distinct-count.txt','x')\"" },
    _meta: meta,
  }, "0");
  assert.equal(command.status, 200, await command.clone().text());
  assert.equal(await readFile(join(root, "distinct-count.txt"), "utf8"), "x");

  const read = await postModernMcp(localBaseUrl, accessToken, "tools/call", {
    name: "read", arguments: { workspace_id: workspaceId, path: "distinct-count.txt" }, _meta: meta,
  }, "0");
  assert.equal(read.status, 200, await read.clone().text());
  const readBody = await read.json() as { result?: { content?: Array<{ type: string; text?: string }> } };
  assert.match(readBody.result?.content?.map((item) => item.text ?? "").join("\n") ?? "", /x/);
  const secondCommand = await postModernMcp(localBaseUrl, accessToken, "tools/call", {
    name: "exec_command",
    arguments: { workspace_id: workspaceId, cmd: "node -e \"require('fs').appendFileSync('distinct-count.txt','y')\"" },
    _meta: meta,
  }, "0");
  assert.equal(secondCommand.status, 200, await secondCommand.clone().text());
  assert.equal(await readFile(join(root, "distinct-count.txt"), "utf8"), "xy");
});

test("stateless MCP replays a real retry inside one MCP session", async (t) => {
  const { root, localBaseUrl, accessToken } = await httpServerFixture(t, "quaymesh-stateless-replay-");
  const meta = { "openai/session": "stateless-replay-conversation" };
  const opened = await postModernMcp(localBaseUrl, accessToken, "tools/call", {
    name: "open_workspace", arguments: { path: root }, _meta: meta,
  }, "open-workspace");
  assert.equal(opened.status, 200, await opened.clone().text());
  const openedBody = await opened.json() as { result?: { structuredContent?: { workspace_id?: string } } };
  const workspaceId = openedBody.result?.structuredContent?.workspace_id;
  assert.equal(typeof workspaceId, "string");

  const retryMcpSessionId = "retry-session-1";
  const command = {
    name: "exec_command",
    arguments: { workspace_id: workspaceId, cmd: "node -e \"require('fs').appendFileSync('retry-once.txt','x')\"" },
    _meta: meta,
  };
  const first = await postModernMcp(localBaseUrl, accessToken, "tools/call", command, "retry-request", retryMcpSessionId);
  assert.equal(first.status, 200, await first.clone().text());
  const retry = await postModernMcp(localBaseUrl, accessToken, "tools/call", command, "retry-request", retryMcpSessionId);
  assert.equal(retry.status, 200, await retry.clone().text());
  assert.equal(await readFile(join(root, "retry-once.txt"), "utf8"), "x");
});

test("server shutdown waits for an active MCP tool call", async (t) => {
  const { root, localBaseUrl, accessToken, running } = await httpServerFixture(
    t,
    "quaymesh-shutdown-test-",
  );
  const opened = await postModernMcp(
    localBaseUrl,
    accessToken,
    "tools/call",
    {
      name: "open_workspace",
      arguments: { path: root },
      _meta: { "openai/session": "shutdown-test" },
    },
  );
  const openBody = await opened.json() as {
    result?: { structuredContent?: { workspace_id?: string } };
  };
  const workspaceId = openBody.result?.structuredContent?.workspace_id;
  assert.equal(typeof workspaceId, "string");

  const command = [
    "const fs=require('node:fs')",
    "fs.writeFileSync('started','')",
    "const timer=setInterval(()=>{if(fs.existsSync('release')) clearInterval(timer)},10)",
  ].join(";");
  const toolCall = postModernMcp(
    localBaseUrl,
    accessToken,
    "tools/call",
    {
      name: "exec_command",
      arguments: {
        workspace_id: workspaceId,
        cmd: `node -e \"${command}\"`,
        yield_time_ms: 12_000,
      },
    },
  );
  await waitForFile(join(root, "started"));

  let shutdownFinished = false;
  const shutdown = running.close().then(() => {
    shutdownFinished = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(shutdownFinished, false);

  await writeFile(join(root, "release"), "");
  await toolCall;
  await shutdown;
  assert.equal(shutdownFinished, true);
});

test("process completion writes one terminal event and invocation state", async (t) => {
  const { root, localBaseUrl, accessToken } = await httpServerFixture(t, "quaymesh-process-lifecycle-");
  const meta = { "openai/session": "process-lifecycle" };
  const opened = await postModernMcp(localBaseUrl, accessToken, "tools/call", {
    name: "open_workspace", arguments: { path: root }, _meta: meta,
  });
  const openedBody = await opened.json() as { result?: { structuredContent?: { workspace_id?: string } } };
  const workspaceId = openedBody.result?.structuredContent?.workspace_id;
  assert.equal(typeof workspaceId, "string");

  const started = await postModernMcp(localBaseUrl, accessToken, "tools/call", {
    name: "exec_command",
    arguments: {
      workspace_id: workspaceId,
      cmd: `node -e "setTimeout(() => {}, 150)"`,
      yield_time_ms: 5,
    },
    _meta: meta,
  });
  assert.equal(started.status, 200, await started.clone().text());
  const startedBody = await started.json() as {
    result?: { structuredContent?: { running?: boolean; session_id?: number; operation_id?:string } };
  };
  assert.equal(startedBody.result?.structuredContent?.running, true);
  const processSessionId = startedBody.result?.structuredContent?.session_id;
  assert.equal(typeof processSessionId, "number");
  assert.ok(processSessionId! > 0);
  assert.equal(typeof startedBody.result?.structuredContent?.operation_id,"string");

  const finished = await postModernMcp(localBaseUrl, accessToken, "tools/call", {
    name: "write_stdin",
    arguments: { workspace_id: workspaceId, session_id: processSessionId },
    _meta: meta,
  });
  assert.equal(finished.status, 200, await finished.clone().text());
  const finishedBody = await finished.json() as {
    result?: { structuredContent?: { running?: boolean; exit_code?: number } };
  };
  assert.equal(finishedBody.result?.structuredContent?.running, false);
  assert.equal(finishedBody.result?.structuredContent?.exit_code, 0);

  const database = openDatabase(join(root, ".state"));
  try {
    const store = new SessionStore(database.sqlite);
    const session = store.findByConversation("local-owner", "process-lifecycle");
    assert.ok(session);
    const events = store.eventsForSession(session!.id);
    const commandOperationIds = new Set(events
      .filter((event) => event.type === "operation_started" && event.payload.kind === "command")
      .map((event) => String(event.payload.operation_id)));
    const finishedEvents = events.filter((event) =>
      event.type === "operation_finished" && commandOperationIds.has(String(event.payload.operation_id)));
    assert.equal(finishedEvents.length, 1);
    assert.equal(finishedEvents[0]!.payload.status, "succeeded");

    const invocation = store.findInvocationByOperationId(String(finishedEvents[0]!.payload.operation_id));
    assert.ok(invocation);
    assert.equal(invocation!.state, "succeeded");
    assert.equal(invocation!.effect, "completed");
    assert.equal(typeof invocation!.finished_at, "string");
  } finally {
    database.close();
  }
});

interface ServerFixture {
  client: Client;
  project: string;
  runtime?: SessionRuntime;
}

function schemaPropertyPaths(
  schema: unknown,
  prefix = "",
): Array<{ key: string; path: string }> {
  if (!schema || typeof schema !== "object") return [];
  const record = schema as {
    properties?: Record<string, unknown>;
    items?: unknown;
    anyOf?: unknown[];
    oneOf?: unknown[];
    allOf?: unknown[];
  };
  const paths = Object.entries(record.properties ?? {}).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return [{ key, path }, ...schemaPropertyPaths(child, path)];
  });
  if (record.items) paths.push(...schemaPropertyPaths(record.items, `${prefix}[]`));
  for (const variant of [record.anyOf, record.oneOf, record.allOf]) {
    for (const child of variant ?? []) {
      paths.push(...schemaPropertyPaths(child, prefix));
    }
  }
  return paths;
}

interface HttpServerFixture {
  root: string;
  localBaseUrl: string;
  accessToken: string;
  running: ReturnType<typeof createServer>;
}

async function httpServerFixture(
  t: TestContext,
  prefix: string,
): Promise<HttpServerFixture> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const ownerToken = "test-owner-token-that-is-long-enough";
  const config = loadConfig(writeTestQuayMeshConfig(join(root, ".config"), {
    server: {
      port: 1,
      publicBaseUrl: "https://example.test",
    },
    workspaces: {
      allowedRoots: [root],
      worktreeRoot: join(root, ".worktrees"),
    },
    storage: { stateDir: join(root, ".state") },
  }));
  const running = createServer(config, { incomingArtifactAdapters: [], registerProject });
  const httpServer = running.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => httpServer.once("listening", resolve));

  t.after(async () => {
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => error ? reject(error) : resolve());
    });
    await running.close();
    await rm(root, { recursive: true, force: true });
  });

  const address = httpServer.address();
  assert.ok(address && typeof address === "object");
  const localBaseUrl = `http://127.0.0.1:${address.port}`;
  const accessToken = await issueTestAccessToken(
    localBaseUrl,
    config.publicBaseUrl,
    ownerToken,
  );
  return { root, localBaseUrl, accessToken, running };
}

async function fixture(
  t: TestContext,
  options: {
    git?: boolean;
    localAgentProviders?: LocalAgentProviderAvailability[] | (() => LocalAgentProviderAvailability[]);
    subagents?: SubagentsConfig;
    toolMode?: ToolMode;
    dangerouslySkipCommandReview?: boolean;
    uiEnabled?: boolean;
    session?: boolean;
  } = {},
): Promise<ServerFixture> {
  const root = await mkdtemp(join(tmpdir(), "quaymesh-server-test-"));
  const project = join(root, "project");
  const agentDir = join(root, "agent");
  const stateDir = join(root, ".state");

  await mkdir(join(project, ".quaymesh", "agents"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "AGENTS.md"), "global instructions\n");
  await writeFile(join(project, "AGENTS.md"), "project instructions\n");
  await writeFile(join(project, ".quaymesh", "agents", "reviewer.md"), [
    "---",
    "name: reviewer",
    "description: Reviews project changes.",
    "provider: codex",
    "---",
    "Review changes.",
  ].join("\n"));

  if (options.git) {
    await writeFile(join(project, "README.md"), "hello\n");
    await git(project, ["init"]);
    await git(project, ["config", "user.email", "quaymesh@example.com"]);
    await git(project, ["config", "user.name", "QuayMesh Test"]);
    await git(project, ["add", "."]);
    await git(project, ["commit", "-m", "Initial commit"]);
  }

  const initialProviderAvailability = typeof options.localAgentProviders === "function"
    ? options.localAgentProviders()
    : options.localAgentProviders ?? [];
  const loadedConfig = loadConfig(writeTestQuayMeshConfig(join(root, ".config"), {
    storage: { stateDir },
    server: { port: 1 },
    workspaces: { allowedRoots: [root], worktreeRoot: join(root, ".worktrees") },
    skills: { agentDir },
    subagents: {
      enabled: options.localAgentProviders !== undefined,
      instructions: "on-demand",
      providers: [],
    },
  }));
  const modeConfig: ServerConfig = {
    ...loadedConfig,
    toolMode: options.toolMode ?? loadedConfig.toolMode,
    dangerouslySkipCommandReview:
      options.dangerouslySkipCommandReview ?? loadedConfig.dangerouslySkipCommandReview,
    uiEnabled: options.uiEnabled ?? loadedConfig.uiEnabled,
  };
  const config: ServerConfig = options.localAgentProviders
    ? {
        ...modeConfig,
        subagents: options.subagents ?? {
          enabled: true,
          instructions: "on-demand",
          providers: initialProviderAvailability.map((provider) => ({
            id: provider.name,
            enabled: true,
          })),
        },
      }
    : modeConfig;
  const resolveProviderAvailability: () => LocalAgentProviderAvailability[] =
    typeof options.localAgentProviders === "function"
      ? options.localAgentProviders
      : () => initialProviderAvailability;
  const resolveLocalAgentProviders = () => buildLocalAgentProviderStatuses(
    config.subagents,
    resolveProviderAvailability(),
  );
  const store = new SqliteWorkspaceStore(stateDir);
  const workspaces = new WorkspaceRegistry(config, store);
  const processSessions = new ProcessSessionManager({ stateDir });
  const ledger = new ProjectWorkLedger(stateDir);
  const agents = new LocalAgentStore(stateDir);
  const runtime = options.session
    ? createSessionRuntime({ config, workspaces, ledger, agents, execution: processSessions.executionCoordinator, processSessions })
    : undefined;
  const server = createMcpServer(
    config,
    workspaces,
    createReviewCheckpointManager(),
    processSessions,
    resolveLocalAgentProviders,
    [],
    undefined,
    registerProject,
    runtime,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "quaymesh-test-client", version: "1.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await client.close();
    await server.close();
    await runtime?.close();
    agents.close();
    ledger.close();
    processSessions.shutdown();
    store.close();
  };

  t.after(async () => {
    await close();
    await rm(root, { recursive: true, force: true });
  });

  return { client, project, runtime };
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  assert.fail(`Timed out waiting for ${path}`);
}

async function issueTestAccessToken(
  localBaseUrl: string,
  publicBaseUrl: string,
  ownerToken: string,
): Promise<string> {
  const redirectUri = "http://127.0.0.1/callback";
  const resource = new URL("/mcp", publicBaseUrl).href;
  const verifier = "quaymesh-modern-protocol-test-verifier-0123456789";
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const registration = await fetch(`${localBaseUrl}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "QuayMesh modern protocol test",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  assert.equal(registration.status, 201, await registration.clone().text());
  const client = await registration.json() as { client_id?: string };
  assert.ok(client.client_id);

  const approval = await fetch(`${localBaseUrl}/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: redirectUri,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "quaymesh",
      resource,
      state: "modern-test",
      owner_token: ownerToken,
    }),
    redirect: "manual",
  });
  assert.equal(approval.status, 302, await approval.clone().text());
  const location = approval.headers.get("location");
  assert.ok(location);
  const code = new URL(location).searchParams.get("code");
  assert.ok(code);

  const exchange = await fetch(`${localBaseUrl}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client.client_id,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      resource,
    }),
  });
  assert.equal(exchange.status, 200, await exchange.clone().text());
  const tokens = await exchange.json() as { access_token?: string };
  assert.ok(tokens.access_token);
  return tokens.access_token;
}

function postModernMcp(
  localBaseUrl: string,
  accessToken: string | undefined,
  method: string,
  params: Record<string, unknown>,
  requestId: string = randomUUID(),
  mcpSessionId?: string,
): Promise<Response> {
  const mcpName = typeof params.name === "string"
    ? params.name
    : typeof params.uri === "string"
      ? params.uri
      : undefined;
  return fetch(`${localBaseUrl}/mcp`, {
    method: "POST",
    headers: {
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      "content-type": "application/json",
      "mcp-method": method,
      "mcp-protocol-version": "2026-07-28",
      ...(mcpSessionId ? { "mcp-session-id": mcpSessionId } : {}),
      ...(mcpName ? { "mcp-name": mcpName } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: requestId,
      method,
      params: {
        ...params,
        _meta: {
          ...recordValue(params._meta),
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": {
            name: "quaymesh-modern-http-test",
            version: "1.0.0",
          },
        },
      },
    }),
  });
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function callOpen(
  client: Client,
  path: string,
  conversationScopeId?: string,
): Promise<Awaited<ReturnType<Client["callTool"]>>> {
  const params = {
    name: "open_workspace",
    arguments: { path },
    ...(conversationScopeId
      ? { _meta: { "openai/session": conversationScopeId } }
      : {}),
  } as Parameters<Client["callTool"]>[0];
  return client.callTool(params);
}

function structuredContent(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  assert.ok(result.structuredContent);
  return result.structuredContent as Record<string, unknown>;
}

function responseCard(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const metadata = result._meta;
  assert.ok(metadata && typeof metadata === "object");
  const card = (metadata as Record<string, unknown>).card;
  assert.ok(card && typeof card === "object");
  return card as Record<string, unknown>;
}

test("real MCP initialization returns the short prompt with the configured sections", async (t) => {
  const withoutSubagents = await fixture(t, { uiEnabled: false });
  const baseInstructions = withoutSubagents.client.getInstructions();
  assert.ok(baseInstructions);
  assert.ok((baseInstructions.match(/[A-Za-z0-9][A-Za-z0-9_./:-]*/g) ?? []).length <= 180);
  assert.match(baseInstructions, /Call start_session once/);
  assert.match(baseInstructions, /use workspace_catalog/);
  assert.doesNotMatch(baseInstructions, /Give each agent/);
  assert.doesNotMatch(baseInstructions, /[\u4e00-\u9fff]/);
  assert.doesNotMatch(baseInstructions, /show_changes|work_task|agent_task/);

  const withSubagents = await fixture(t, {
    uiEnabled: false,
    localAgentProviders: [{ name: "codex", available: true }],
    subagents: {
      enabled: true,
      instructions: "on-demand",
      providers: [{ id: "codex", enabled: true }],
    },
  });
  const instructions = withSubagents.client.getInstructions();
  assert.ok(instructions);
  assert.match(instructions, /Give each agent a clear task/);
  assert.doesNotMatch(instructions, /为每个代理说明任务/);
  const subagentSection = "Give each agent a clear task";
  assert.ok((instructions.slice(instructions.indexOf(subagentSection)).match(/[A-Za-z0-9][A-Za-z0-9_./:-]*/g) ?? []).length <= 90);
});
