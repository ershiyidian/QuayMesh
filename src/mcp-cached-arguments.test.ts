import assert from "node:assert/strict";
import test from "node:test";
import { ConflictingToolAliasError, normalizeCachedToolCall } from "./mcp-cached-arguments.js";

const call = (name: string, args: Record<string, unknown>) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
test("cached top-level and file-selection aliases become canonical without losing strict fields", () => {
  const source = call("workspace_context", { workspaceId: "ws_a", workRunId: "run_a", action: "capture",
    files: [{ path: "file.ts", startLine: 12, maxLines: 3, unknown: "must still fail canonical validation" }] });
  const result = normalizeCachedToolCall(source) as typeof source;
  assert.deepEqual(result.params.arguments, { workspace_id: "ws_a", work_run_id: "run_a", action: "capture",
    files: [{ path: "file.ts", start_line: 12, max_lines: 3, unknown: "must still fail canonical validation" }] });
  assert(Object.hasOwn(source.params.arguments, "workspaceId"));
});
test("equal aliases are safe; contradictory identities and ranges fail without echoing values", () => {
  assert.deepEqual((normalizeCachedToolCall(call("read", { workspaceId: "same", workspace_id: "same" })) as ReturnType<typeof call>).params.arguments, { workspace_id: "same" });
  for (const input of [call("read", { workspaceId: "private-a", workspace_id: "private-b" }),
    call("workspace_context", { files: [{ path: "a", startLine: 2, start_line: 3 }] })]) {
    assert.throws(() => normalizeCachedToolCall(input), (error: unknown) => error instanceof ConflictingToolAliasError && !error.message.includes("private"));
  }
});
test("prompts, patches, context and numeric bounds are not rewritten", () => {
  const context = { summary: "workspaceId work_run_id", files: [{ path: "file", sha256: "digest", startLine: "data" }] };
  const input = call("spawn_agent", { workspaceId: "ws", context, message: "startLine is data", resources: ["workspaceId"] });
  const output = normalizeCachedToolCall(input) as ReturnType<typeof call>;
  assert.equal(output.params.arguments.context, context);
  assert.equal(output.params.arguments.message, input.params.arguments.message);
  assert.deepEqual(output.params.arguments.resources, ["workspaceId"]);
  const waited = normalizeCachedToolCall(call("wait_agent", { workspaceId: "ws", agentIds: ["agent-a"], timeoutMs: 999999 })) as ReturnType<typeof call>;
  assert.equal(waited.params.arguments.timeout_ms, 999999);
  const patch = "*** Begin Patch\nworkspaceId: x\n*** End Patch";
  assert.equal((normalizeCachedToolCall(call("apply_patch", { patch })) as ReturnType<typeof call>).params.arguments.patch, patch);
});
test("unknown tools and malformed or non-tool requests stay with the original validator", () => {
  for (const input of [call("not-registered", { workspaceId: "x" }), { method: "tools/list", params: { workspaceId: "x" } },
    null, [], { method: "tools/call", params: { name: "read", arguments: "bad" } }]) assert.equal(normalizeCachedToolCall(input), input);
});
