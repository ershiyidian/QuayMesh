import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "parse5";
import { compileMcpRegistrationSurface } from "../src/mcp-modern-server.js";
import { createServer } from "../src/server.js";
import { WORKSPACE_APP_URI } from "../src/tool-surfaces/types.js";
import { createRealTestServer, structured, type RealTestServer } from "../test/session-card/server-fixture.js";

type JsonRecord = Record<string, unknown>;
type Check = { name: string; passed: boolean; detail: unknown };
type BuiltAsset = { path: string; bytes: number; kind: "js" | "css" | "other" };

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const reportPath = join(repositoryRoot, "releases", "session-acceptance", "surface.json");
const expectedAppTools = [
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
const expectedModelTools = [
  "start_session",
  // finish_task 是 QuayMesh 任务收尾的必需模型工具，必须出现在模型可见工具列表中。
  "finish_task",
  "open_workspace",
  "attach_workspace",
  "read",
  "workspace_context",
  "apply_patch",
  "exec_command",
  "write_stdin",
  "read_output",
  "cancel_command",
  "checkpoint_task",
  "spawn_agent",
  "followup_agent",
  "send_message",
  "wait_agent",
  "interrupt_agent",
  "list_agents",
];
const retiredTools = ["show_changes", "work_task", "agent_task"];
const forbiddenBuiltMarkers = [
  "Legacy Client Support Only",
  "createMockSource",
  "decodeToolResult",
  "toolResultFromChatGptGlobals",
  "mcp_tool_result",
  "demoStage",
  "demoSteps",
  "show_changes",
  "work_task",
  "agent_task",
];

const checks: Check[] = [];
let server: RealTestServer | undefined;
let setupError: string | null = null;
const startedAt = new Date().toISOString();

try {
  assert.equal(typeof createServer, "function", "production createServer must be callable");
  assert.equal(typeof compileMcpRegistrationSurface, "function", "production registration compiler must be callable");
  server = await createRealTestServer({
    prefix: "quaymesh-surface-check-",
    uiEnabled: true,
    subagents: { enabled: true, instructions: "on-demand", providers: [] },
  });

  const listed = await server.client.listTools();
  const tools = listed.tools.map((tool) => ({
    name: tool.name,
    annotations: tool.annotations ?? null,
    ui: (tool._meta as JsonRecord | undefined)?.ui ?? null,
  }));
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const appOnly = tools.filter((tool) => visibilityIncludes(tool.ui, "app"));
  const model = tools.filter((tool) => !visibilityIncludes(tool.ui, "app"));
  const cardBindings = tools.filter((tool) => typeof resourceUri(tool.ui) === "string");

  check("model tool surface is exact", () => {
    assert.deepEqual(model.map((tool) => tool.name).sort(), [...expectedModelTools].sort());
    return model.map((tool) => tool.name);
  });
  check("app-only tool surface is exact", () => {
    assert.deepEqual(appOnly.map((tool) => tool.name).sort(), [...expectedAppTools].sort());
    return appOnly.map((tool) => tool.name);
  });
  check("retired model tools are absent", () => {
    const present = retiredTools.filter((name) => byName.has(name));
    assert.deepEqual(present, []);
    return { absent: retiredTools };
  });
  check("workspace_catalog remains federation-only", () => {
    assert.equal(byName.has("workspace_catalog"), false);
    return { absent: "workspace_catalog" };
  });
  check("only start_session binds the card template", () => {
    assert.deepEqual(cardBindings.map((tool) => tool.name), ["start_session"]);
    assert.equal(resourceUri(byName.get("start_session")?.ui), WORKSPACE_APP_URI);
    for (const tool of tools) {
      if (tool.name !== "start_session") assert.equal(resourceUri(tool.ui), undefined, tool.name + " unexpectedly binds a card");
    }
    return { binding: "start_session", resourceUri: WORKSPACE_APP_URI };
  });
  check("app-only tools declare app visibility", () => {
    for (const tool of appOnly) {
      assert.equal(visibilityIncludes(tool.ui, "app"), true, tool.name + " lacks app visibility");
      assert.equal(resourceUri(tool.ui), undefined, tool.name + " must not bind a model template");
    }
    return appOnly.map((tool) => tool.name);
  });
  check("tool annotations use compact MCP defaults", () => {
    for (const tool of tools) {
      if (tool.annotations === null) continue;
      assert.equal(typeof tool.annotations, "object", `${tool.name} annotations must be an object`);
    }
    for (const name of ["read", "workspace_context", "read_output", "wait_agent", "list_agents"]) {
      const value = byName.get(name)?.annotations as JsonRecord | null | undefined;
      assert.equal(value?.readOnlyHint, true, `${name} must retain readOnlyHint=true`);
    }
    return { omittedDefaults: tools.filter((tool) => tool.annotations === null).map((tool) => tool.name) };
  });

  if (!server) throw new Error("SURFACE_SERVER_MISSING");
  const started = await server.client.callTool({
    name: "start_session",
    arguments: { title: "surface check", request_key: "surface-check" },
    _meta: { "openai/session": "surface-check" },
  });
  assert.equal(started.isError, undefined, JSON.stringify(started));
  const opened = await server.client.callTool({
    name: "open_workspace",
    arguments: { path: server.project },
    _meta: { "openai/session": "surface-check" },
  });
  check("start_session plus open_workspace returns real card identity", () => {
    assert.equal(opened.isError, undefined, JSON.stringify(opened));
    const result = structured(opened);
    assert.equal(typeof result.workspace_id, "string");
    const meta = (opened._meta as JsonRecord | undefined)?.quaymesh as JsonRecord | undefined;
    assert.equal(typeof meta?.session_id, "string");
    assert.equal(typeof meta?.task_id, "string");
    assert.equal(typeof meta?.member_id, "string");
    assert.equal(meta?.workspace_id, result.workspace_id);
    return { session_id: meta?.session_id, task_id: meta?.task_id, member_id: meta?.member_id, workspace_id: result.workspace_id };
  });

  const resource = await server.client.readResource({ uri: WORKSPACE_APP_URI });
  const html = resource.contents.find((entry) => typeof (entry as { text?: unknown }).text === "string") as { text: string } | undefined;
  if (!html?.text) throw new Error("WORKSPACE_APP_RESOURCE_MISSING");
  const document = parse(html.text);
  const elements = allElements(document);
  const card = elements.find((element) => attr(element, "id") === "card");
  const tabs = elements.find((element) => attr(element, "id") === "tabs");
  const panels = elements.filter((element) => attr(element, "role") === "tabpanel");
  const toggle = elements.find((element) => attr(element, "id") === "toggle");
  const clock = elements.find((element) => attr(element, "id") === "clock");
  const activity = elements.find((element) => attr(element, "id") === "act");
  const tabButtons = elements.filter((element) => hasClass(element, "tab") && element.nodeName === "button");

  check("served resource contains the approved card structure", () => {
    assert.ok(card, "missing #card");
    assert.equal(card.nodeName, "article");
    assert.ok(tabs, "missing #tabs");
    assert.equal(attr(tabs, "role"), "tablist");
    assert.equal(panels.length, 4);
    assert.ok(toggle, "missing #toggle");
    assert.ok(clock, "missing #clock");
    assert.ok(activity, "missing #act");
    assert.equal(tabButtons.length, 4);
    assert.deepEqual(tabButtons.map((button) => attr(button, "data-tab")), ["changes", "commands", "agents", "context"]);
    return { card: "article#card", tabs: tabButtons.length, panels: panels.length, compactSummary: ["#clock", "#act"] };
  });
  check("served resource has no legacy placeholder", () => {
    assert.equal(html.text.includes("Legacy Client Support Only"), false);
    return { placeholderAbsent: true };
  });

  const builtCard = await readFile(join(repositoryRoot, "dist", "ui-card", "workspace-app.html"), "utf8");
  const builtAssets: BuiltAsset[] = [{ path: "dist/ui-card/workspace-app.html", bytes: Buffer.byteLength(builtCard), kind: "other" }];

  check("served HTML is the self-contained production card", () => {
    assert.equal(html.text, builtCard, "served card does not match dist/ui-card/workspace-app.html");
    assert.doesNotMatch(html.text, /(?:src|href)=["']\.\/assets\//, "card still depends on relative asset files");
    assert.doesNotMatch(html.text, /127\.0\.0\.1|localhost/i, "card contains a loopback address");
    return { path: "dist/ui-card/workspace-app.html", bytes: Buffer.byteLength(builtCard) };
  });
  check("production card contains the real app client", () => {
    assert.match(html.text, /qm_session/);
    assert.match(html.text, /member_id/);
    assert.doesNotMatch(html.text, /toolResultFromChatGptGlobals|decodeToolResult|mcp_tool_result/);
    return { bytes: Buffer.byteLength(html.text) };
  });
  check("production card has no mock or demo source", () => {
    const hits = forbiddenBuiltMarkers.filter((marker) => html.text.includes(marker));
    assert.deepEqual(hits, []);
    return { inspected: ["dist/ui-card/workspace-app.html"] };
  });

  process.stdout.write(JSON.stringify({ status: checks.every((item) => item.passed) ? "passed" : "failed", toolCount: tools.length, builtAssets }, null, 2) + "\n");
} catch (error) {
  setupError = error instanceof Error ? error.message : String(error);
  checks.push({ name: "surface check completed", passed: false, detail: setupError });
} finally {
  if (server) await server.dispose();
}

const passed = setupError === null && checks.length > 0 && checks.every((item) => item.passed);
const report = {
  status: passed ? "passed" : "failed",
  startedAt,
  finishedAt: new Date().toISOString(),
  command: "pnpm check:session-surface",
  resourceUri: WORKSPACE_APP_URI,
  setupError,
  checks,
};
await mkdir(join(repositoryRoot, "releases", "session-acceptance"), { recursive: true });
await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
if (!passed) {
  process.stderr.write(JSON.stringify(report, null, 2) + "\n");
  process.exitCode = 1;
}

function check(name: string, operation: () => unknown): void {
  try {
    checks.push({ name, passed: true, detail: operation() });
  } catch (error) {
    checks.push({ name, passed: false, detail: error instanceof Error ? error.message : String(error) });
  }
}

function collectManifestFiles(manifest: Record<string, { file?: string; css?: string[]; imports?: string[] }>, key: string, seen = new Set<string>()): string[] {
  if (seen.has(key)) return [];
  seen.add(key);
  const entry = manifest[key];
  if (!entry?.file) return [];
  const files = [entry.file, ...(entry.css ?? [])];
  for (const imported of entry.imports ?? []) files.push(...collectManifestFiles(manifest, imported, seen));
  return files;
}

function allElements(root: unknown): Array<{ nodeName: string; attrs: Array<{ name: string; value: string }>; childNodes?: unknown[] }> {
  const node = root as { nodeName?: string; attrs?: Array<{ name: string; value: string }>; childNodes?: unknown[] };
  const current = typeof node.nodeName === "string"
    ? [{ nodeName: node.nodeName, attrs: node.attrs ?? [], childNodes: node.childNodes }]
    : [];
  return current.concat((node.childNodes ?? []).flatMap((child) => allElements(child)));
}

function attr(element: { attrs: Array<{ name: string; value: string }> } | undefined, name: string): string | undefined {
  return element?.attrs.find((item) => item.name === name)?.value;
}

function hasClass(element: { attrs: Array<{ name: string; value: string }> }, className: string): boolean {
  return (attr(element, "class") ?? "").split(/\s+/).includes(className);
}

function visibilityIncludes(ui: unknown, visibility: string): boolean {
  const record = ui && typeof ui === "object" ? ui as JsonRecord : undefined;
  return Array.isArray(record?.visibility) && record.visibility.includes(visibility);
}

function resourceUri(ui: unknown): string | undefined {
  const record = ui && typeof ui === "object" ? ui as JsonRecord : undefined;
  return typeof record?.resourceUri === "string" ? record.resourceUri : undefined;
}

