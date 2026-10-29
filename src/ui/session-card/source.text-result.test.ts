import assert from "node:assert/strict";
import test from "node:test";
import type { App } from "@modelcontextprotocol/ext-apps";
import { toolResultForTextClients } from "../../mcp-tool-result.js";
import { createMcpSource, toolResultData } from "./source.js";
import { previewSnapshot } from "./preview.js";

function textResult(body: Record<string, unknown>, meta?: Record<string, unknown>, isError = false) {
  const { structuredContent: _body, ...result } = toolResultForTextClients({
    content: [{ type: "text", text: "Task result" }], structuredContent: body,
    ...(meta ? { _meta: meta } : {}), ...(isError ? { isError } : {}),
  });
  return result;
}

test("a content-only MCP mirror supplies the same Task snapshot and later observations without granting entry authority", async () => {
  const initial = { ...previewSnapshot, sessionId: "session-text", taskId: "task-text" };
  const selected = { task_id: initial.taskId, entry_available: true, binding_revision: 1,
    selected_task_id: initial.taskId, status: "selected", can_resume: true, can_continue: true };
  let reply = textResult({ unchanged: false, rev: initial.rev, snapshot: initial,
    _meta: { quaymesh: { task_binding: selected } } });
  const app = { getHostCapabilities: () => ({ serverTools: {} }), callServerTool: async () => reply } as unknown as App;
  const source = createMcpSource(app, initial.sessionId, initial.taskId);
  try {
    assert.deepEqual(await source.snapshot(-1), initial);
    assert.equal(source.taskBinding, null, "a field inside text data is not the private response sideband");
    const observedAt = Date.now() + 1000;
    reply = textResult({ unchanged: true, rev: initial.rev,
      observation: { observedAt, activeOperationIds: [], preparingOperationIds: [], staleOperationIds: [] },
      live: { observedAt, hostStatus: "connected", executionStatus: "idle" } },
    { quaymesh: { task_binding: selected } });
    const refreshed = await source.snapshot(initial.rev);
    assert.equal(refreshed!.taskId, initial.taskId);
    assert.equal(refreshed!.live!.observedAt, observedAt);
    assert.deepEqual(source.taskBinding, selected);
  } finally { source.dispose(); }
});

test("only a unique JSON text object can replace absent structuredContent; an existing structured result remains authoritative", () => {
  const body = { task_id: "task-original", session_id: "session-original" };
  const text = JSON.stringify(body);
  const content = [{ type: "text", text }];
  assert.deepEqual(toolResultData({ content }), body, "the host need not retain the text-block marker");
  assert.deepEqual(toolResultData({ content, structuredContent: { task_id: "task-structured" } }), { task_id: "task-structured" });
  for (const value of [
    { content, structuredContent: null }, { content, structuredContent: [] },
    { content, structuredContent: "invalid" }, { content: [...content, ...content] },
    { content: [{ type: "text", text: "ordinary text" }] },
    { content: [{ type: "text", text: "[]" }] }, { content: [{ type: "text", text: "null" }] },
  ]) assert.equal(toolResultData(value), undefined);
});

test("content-only replies still enforce snapshot schema, Task identity, and tool errors", async () => {
  const initial = { ...previewSnapshot, sessionId: "session-text", taskId: "task-text" };
  let reply = textResult({ unchanged: false, rev: initial.rev, snapshot: { ...initial, taskId: "task-foreign" } });
  const app = { getHostCapabilities: () => ({ serverTools: {} }), callServerTool: async () => reply } as unknown as App;
  const source = createMcpSource(app, initial.sessionId, initial.taskId);
  try {
    await assert.rejects(source.snapshot(-1), /SNAPSHOT_IDENTITY_MISMATCH/);
    reply = textResult({ unchanged: false, rev: initial.rev, snapshot: { ...initial, sessionId: "session-foreign" } });
    await assert.rejects(source.snapshot(-1), /SNAPSHOT_IDENTITY_MISMATCH/);
    reply = textResult({ unchanged: false, rev: initial.rev, snapshot: { ...initial, commands: "invalid" } });
    await assert.rejects(source.snapshot(-1), /commands/);
    reply = textResult({ error_code: "NODE_ADMISSION_PAUSED", effect: "not_started", retry_after_ms: 30_000 }, undefined, true);
    await assert.rejects(source.snapshot(-1), (error: Error & { code?: string; retryAfterMs?: number }) => {
      assert.equal(error.code, "NODE_ADMISSION_PAUSED");
      assert.equal(error.retryAfterMs, 30_000);
      return true;
    });
    assert.equal(source.taskBinding, null);
  } finally { source.dispose(); }
});
