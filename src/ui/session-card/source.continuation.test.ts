import assert from "node:assert/strict";
import test from "node:test";
import type { App } from "@modelcontextprotocol/ext-apps";
import { createMcpSource } from "./source.js";

function fixture(options: { taskId?: string; returnedTaskId?: string; returnedSessionId?: string; rejected?: boolean; hostMessage?: boolean } = {}) {
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  const messages: Array<{ role: string; content: Array<{ type: string; text: string }> }> = [];
  const app = {
    getHostCapabilities: () => ({ serverTools: {}, ...(options.hostMessage === false ? {} : { message: {} }) }),
    callServerTool: async (input: typeof calls[number]) => {
      calls.push(input);
      return { content: [], structuredContent: {
        session_id: options.returnedSessionId ?? "storage-a",
        task_id: options.returnedTaskId ?? "task-a",
        message: "继续处理同一任务 task-a，复用原 task_id。",
      } };
    },
    sendMessage: async (input: typeof messages[number]) => {
      messages.push(input);
      return { isError: options.rejected ?? false };
    },
  } as unknown as App;
  const source = createMcpSource(app, "storage-a", options.taskId);
  return { source, calls, messages };
}

test("card continuation carries its Task to the app tool before sending the verified follow-up", async () => {
  const f = fixture({ taskId: "task-a" });
  try {
    await f.source.continueSession("agent-a");
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].name, "qm_session_continue");
    assert.equal(f.calls[0].arguments.task_id, "task-a");
    assert.equal(f.calls[0].arguments.agent_id, "agent-a");
    assert.equal(f.messages.length, 1);
    assert.equal(f.messages[0].role, "user");
    assert.ok(f.messages[0].content[0].text.includes("task-a"));
  } finally { f.source.dispose(); }
});

test("cards without a Task do not fall back to a mutable current Task", async () => {
  const f = fixture();
  try {
    await assert.rejects(f.source.continueSession(), /SESSION_CARD_TASK_REQUIRED/);
    assert.equal(f.calls.length, 0);
    assert.equal(f.messages.length, 0);
  } finally { f.source.dispose(); }
});

test("mismatched Task or storage identity is never forwarded to the host as a user message", async () => {
  for (const options of [{ returnedTaskId: "task-b" }, { returnedSessionId: "storage-b" }]) {
    const f = fixture({ taskId: "task-a", ...options });
    try {
      await assert.rejects(f.source.continueSession(), /SESSION_CARD_CONTINUATION_IDENTITY_MISMATCH/);
      assert.equal(f.messages.length, 0);
    } finally { f.source.dispose(); }
  }
});

test("host rejection remains a failed follow-up, not an acknowledged Task message", async () => {
  const f = fixture({ taskId: "task-a", rejected: true });
  try {
    await assert.rejects(f.source.continueSession(), /CONTINUE_MESSAGE_REJECTED/);
    assert.equal(f.messages.length, 1);
  } finally { f.source.dispose(); }
});

test("continuation itself refuses a host without message capability before preparing or sending a request", async () => {
  const f = fixture({ taskId: "task-a", hostMessage: false });
  try {
    assert.equal(f.source.supportsHostMessage, false);
    await assert.rejects(f.source.continueSession(), /SESSION_CARD_HOST_MESSAGE_UNAVAILABLE/);
    assert.equal(f.calls.length, 0);
    assert.equal(f.messages.length, 0);
  } finally { f.source.dispose(); }
});
