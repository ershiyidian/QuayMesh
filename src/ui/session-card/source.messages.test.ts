import assert from "node:assert/strict";
import test from "node:test";
import type { App } from "@modelcontextprotocol/ext-apps";
import { createMcpSource } from "./source.js";
import { previewSnapshot } from "./preview.js";

test("Task messages omit legacy session/member arguments and never wake the host implicitly", async () => {
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  let followups = 0;
  const app = { getHostCapabilities: () => ({ serverTools: {}, message: {} }),
    callServerTool: async (input: typeof calls[number]) => {
      calls.push(input);
      return { content: [], structuredContent: input.name === "qm_session"
        ? { unchanged: false, snapshot: { ...previewSnapshot, sessionId: "legacy-storage", taskId: "task-a" } }
        : { task_id: "task-a" } };
    },
    sendMessage: async () => { followups++; return {}; },
  } as unknown as App;
  const source = createMcpSource(app, "legacy-storage", "task-a");
  try {
    assert.equal(source.supportsHostMessage, true);
    await source.snapshot(1, undefined, "member-a");
    assert.equal(calls[0].arguments.since_rev, -1);
    assert.equal(calls[0].arguments.file_recorded_at, true);
    assert.equal(calls[0].arguments.member_id, "member-a");
    await source.taskMessages!(12);
    await source.enqueueTaskMessage!("message-key", "用户消息");
    assert.deepEqual(calls[1], { name: "qm_task_messages", arguments: { task_id: "task-a", limit: 20, before_sequence: 12 } });
    assert.deepEqual(calls[2], { name: "qm_task_message_enqueue", arguments: { task_id: "task-a", message_key: "message-key", body: "用户消息" } });
    assert.equal(followups, 0);
  } finally { source.dispose(); }
});

test("Task-less cards do not obtain a mutable current Task and mismatched response identities are rejected", async () => {
  const app = { getHostCapabilities: () => ({ serverTools: {} }),
    callServerTool: async () => ({ content: [], structuredContent: { task_id: "other-task" } }),
  } as unknown as App;
  const legacy = createMcpSource(app, "legacy-storage", undefined);
  const source = createMcpSource(app, "legacy-storage", "task-a");
  try {
    assert.equal(source.supportsHostMessage, false);
    assert.equal(legacy.taskMessages, undefined);
    assert.equal(legacy.enqueueTaskMessage, undefined);
    await assert.rejects(source.taskMessages!(), /IDENTITY_MISMATCH/);
    await assert.rejects(source.enqueueTaskMessage!("key", "body"), /RECEIPT_MISMATCH/);
  } finally { legacy.dispose(); source.dispose(); }
});
