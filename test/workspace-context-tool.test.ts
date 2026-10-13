import assert from "node:assert/strict";
import test from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRealTestServer, structured } from "./session-card/server-fixture.js";
import { ExecutionCoordinator, type ExecutionClaim } from "../src/execution-coordinator.js";
import { parseLocalAgentRunArgs, parseLocalAgentContinueArgs } from "../src/local-agent-targets.js";
import { decodeLocalAgentDaemonRequest } from "../src/local-agent-daemon-protocol.js";

test("host can capture, search and version exact source through MCP without any provider", async (t) => {
  const server = await createRealTestServer({ git:false, files:{"source.ts":"// 主控直接读取\nexport const value = 1;\n"} });
  t.after(() => server.dispose());
  const { client, project } = server;
  const meta = { "openai/session":"workspace-context-observation" };
  const opened = structured(await client.callTool({name:"open_workspace",arguments:{path:project},_meta:meta}));
  const call = async (args: Record<string, unknown>) => {
    const response = await client.callTool({ name: "workspace_context", arguments: { workspace_id: opened.workspace_id, ...args },_meta:meta });
    const text = (response.content as Array<{ type: string; text: string }>).find((item) => item.type === "text")!.text;
    return { error: response.isError, value: response.isError ? text : response.structuredContent as any };
  };
  const advertised = (await client.listTools()).tools.find((tool) => tool.name === "workspace_context")!;
  const schema = advertised.inputSchema as { properties: Record<string, any>; required: string[] };
  assert.ok(schema.required.includes("workspace_id"));
  assert.deepEqual(schema.properties.action.enum, ["list","capture","search","status","recovery"]);
  for (const field of ["files", "line_offset", "query", "operation_id", "limit", "session_id", "cursor"]) {
    assert.ok(schema.properties[field], field);
  }
  assert.ok((await call({ action: "capture", files: [{ path: "source.ts" }], limit: 1 })).error);
  const listed = await call({ action: "list" });
  assert.equal(listed.value.providerInvoked, false); assert(listed.value.entries.some((entry: { name: string }) => entry.name === "source.ts"));
  const captured = await call({ action: "capture", files: [{ path: "source.ts", max_lines: 1 }] });
  assert(!captured.error); assert.equal(captured.value.entries[0].lines[0].text, "// 主控直接读取");
  assert.equal(captured.value.entries[0].lines.length, 1); assert.match(captured.value.entries[0].sha256, /^[0-9a-f]{64}$/);
  const searched = await call({ action: "search", query: "value", files: [{ path: "source.ts" }] });
  assert.equal(searched.value.entries[0].lines[0].line, 2); assert.equal(searched.value.entries[0].sha256, captured.value.entries[0].sha256);
  writeFileSync(join(project, "source.ts"), "changed\n");
  const changed = await call({ action: "capture", files: [{ path: "source.ts" }] });
  assert.notEqual(changed.value.result_ref, captured.value.result_ref);
  assert.notEqual(changed.value.entries[0].sha256, captured.value.entries[0].sha256);
  const outside = await call({ action: "capture", files: [{ path: "../outside" }] });
  assert.ok(outside.error || outside.value.partial && outside.value.entries[0].error);
  const owner = new ExecutionCoordinator(server.config.stateDir);
  let claim: ExecutionClaim | undefined;
  try {
    claim = owner.acquire({ workspaceRoot: project, kind: "mutation" });
    const observed = await call({ action:"capture",files:[{path:"source.ts"}] });
    assert.ok(!observed.error);
    assert.equal(observed.value.entries[0].lines[0].text,"changed");
    assert.ok(!(await call({action:"status",limit:1})).error);
  } finally { claim?.release(); owner.close(); }
});

test("CLI and daemon preserve affinity, fresh context, continuation keys and host evidence", () => {
  const parsed = parseLocalAgentRunArgs(["codex", "--task-key", "one", "--work-item", "fix", "--context-key", "module/reviewer", "--fresh-context", "inspect"]);
  assert.equal(parsed.contextKey, "module/reviewer"); assert.equal(parsed.freshContext, true);
  assert.equal(parseLocalAgentContinueArgs(["agt_x", "--request-key", "phase2", "review"]).requestKey, "phase2");
  assert.throws(() => parseLocalAgentRunArgs(["codex", "--request-key", "wrong", "inspect"]));
  const decoded = decodeLocalAgentDaemonRequest({ requestId: "fixture", protocolVersion: 5, authToken: "fixture", method: "agent.start", params: {
    ...parsed, workspaceRoot: process.cwd(), context: { summary: "already inspected", files: [{ path: "source.ts", sha256: "0".repeat(64) }] }, resources: ["build:shared"],
  } });
  assert.equal(decoded.method, "agent.start");
  if (decoded.method !== "agent.start") throw new Error("wrong method");
  assert.equal(decoded.params.context?.summary, "already inspected"); assert.equal(decoded.params.contextKey, parsed.contextKey);
  assert.deepEqual(decoded.params.resources, ["build:shared"]);
});
