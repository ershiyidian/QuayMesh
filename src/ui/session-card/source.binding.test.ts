import assert from "node:assert/strict";
import test from "node:test";
import type { App } from "@modelcontextprotocol/ext-apps";
import type { TaskBindingState, TaskBindingView } from "../../tasks/task-binding.js";
import { createMcpSource, type SessionCardSource } from "./source.js";
import { previewSnapshot } from "./preview.js";

function authority(source: SessionCardSource): TaskBindingState | null | undefined { return source.taskBinding; }

const snapshot = { ...previewSnapshot, sessionId: "storage-a", taskId: "task-a", rev: 7 };
function binding(overrides: Partial<TaskBindingView> = {}): TaskBindingView {
  return { task_id: "task-a", entry_available: true, binding_revision: 0, selected_task_id: null,
    status: "unbound", can_resume: true, can_continue: false, ...overrides };
}
function selected(revision = 1): TaskBindingView {
  return binding({ binding_revision: revision, selected_task_id: "task-a", status: "selected", can_continue: true });
}
function full(meta: unknown) { return { content: [], structuredContent: { unchanged: false, rev: 7, snapshot }, _meta: meta }; }
function unchanged(meta?: unknown) { return { content: [], structuredContent: { unchanged: true, rev: 7 }, _meta: meta }; }
function meta(value: unknown) { return { quaymesh: { task_binding: value } }; }
function resumed(value = selected()) {
  return { content: [], structuredContent: { task_id: "task-a", session_id: "storage-a", title: "A", binding: value,
    workspaces: [], workspace_page: { offset: 0, next_offset: null, total: 0 }, replayed: false } };
}
type Input = { name: string; arguments: Record<string, unknown> };

test("unchanged snapshots update entry authority; missing or malformed sidebands clear prior authority without changing the Task", async () => {
  const calls: Input[] = [];
  let result: unknown = full(meta(selected()));
  const app = { getHostCapabilities: () => ({ serverTools: {}, message: {} }),
    callServerTool: async (input: Input) => { calls.push(input); return result; },
  } as unknown as App;
  const source = createMcpSource(app, snapshot.sessionId, snapshot.taskId, snapshot);
  try {
    assert.equal(authority(source), null, "bootstrap data does not prove current entry authority");
    const first = await source.snapshot(7, undefined, "member-a");
    assert.equal(first!.rev, 7);
    assert.equal(calls[0].arguments.since_rev, -1);
    assert.equal(calls[0].arguments.file_recorded_at, true);
    assert.equal(authority(source)?.can_continue, true);
    result = unchanged(meta(binding({ binding_revision: 2, selected_task_id: "task-b", status: "different_task" })));
    assert.equal(await source.snapshot(7), null);
    assert.equal(authority(source)?.selected_task_id, "task-b");
    assert.equal(authority(source)?.can_continue, false);
    assert.equal(first!.rev, 7);
    result = unchanged();
    await source.snapshot(7);
    assert.equal(authority(source), null);
    for (const malformed of [selected(-1), { ...selected(), task_id: "another-task" },
      { ...selected(), status: "different_task" }, { ...selected(), binding_revision: Number.MAX_SAFE_INTEGER + 1 }]) {
      result = unchanged(meta(malformed)); await source.snapshot(7); assert.equal(authority(source), null);
    }
    result = unchanged(meta({ task_id: "task-a", entry_available: false, binding_revision: null, selected_task_id: null,
      status: "entry_unavailable", can_resume: false, can_continue: false, reason: "stable entry absent" }));
    await source.snapshot(7);
    assert.equal(authority(source)?.status, "entry_unavailable");
  } finally { source.dispose(); }
});

test("resume uses only explicit Task arguments and a late unchanged poll cannot replace its newer binding", async () => {
  const calls: Input[] = [];
  let polls = 0, followups = 0, release!: (value: unknown) => void;
  const app = { getHostCapabilities: () => ({ serverTools: {}, message: {} }),
    callServerTool: async (input: Input) => {
      calls.push(input);
      if (input.name === "qm_session") return ++polls === 1 ? full(meta(binding())) : new Promise(resolve => { release = resolve; });
      return resumed();
    }, sendMessage: async () => { followups++; return {}; },
  } as unknown as App;
  const source = createMcpSource(app, snapshot.sessionId, snapshot.taskId);
  try {
    await source.snapshot(7, undefined, "member-a");
    const late = source.snapshot(7, undefined, "member-a");
    await source.resumeTask!(0, "stable-key");
    assert.deepEqual(calls.at(-1), { name: "task_resume", arguments: {
      action: "resume", expected_binding_revision: 0, request_key: "stable-key", task_id: "task-a",
    } });
    release(unchanged(meta(binding()))); await late;
    assert.deepEqual(authority(source), selected());
    await source.inspectTaskBinding!();
    assert.deepEqual(calls.at(-1), { name: "task_resume", arguments: { action: "inspect", task_id: "task-a" } });
    assert.equal(followups, 0);
  } finally { source.dispose(); }
});

test("mismatched resume receipts and cancelled replies cannot grant authority", async () => {
  let result: unknown = resumed();
  const app = { getHostCapabilities: () => ({ serverTools: {} }), callServerTool: async () => result } as unknown as App;
  const source = createMcpSource(app, snapshot.sessionId, snapshot.taskId);
  try {
    for (const partial of [{ task_id: "wrong-task" }, { session_id: "wrong-storage" }, { binding: { ...selected(), task_id: "wrong-task" } }]) {
      result = { ...resumed(), structuredContent: { ...resumed().structuredContent, ...partial } };
      await assert.rejects(source.resumeTask!(0, "key"), /RECEIPT_IDENTITY_MISMATCH/);
      assert.equal(authority(source), null);
    }
    let release!: (value: unknown) => void;
    (app as unknown as { callServerTool: () => Promise<unknown> }).callServerTool = () => new Promise(resolve => { release = resolve; });
    const abort = new AbortController(), pending = source.inspectTaskBinding!(abort.signal);
    abort.abort(new Error("CANCELLED_BY_TEST")); release(resumed());
    await assert.rejects(pending, /CANCELLED_BY_TEST/);
    assert.equal(authority(source), null);
  } finally { source.dispose(); }
});

test("page reads started during an explicit resume cannot supersede it, whether their replies arrive before or after commit", async () => {
  for (const pageFirst of [true, false]) {
    let polls = 0, finishResume!: (value: unknown) => void, finishPage!: (value: unknown) => void;
    const app = { getHostCapabilities: () => ({ serverTools: {} }), callServerTool: async (input: Input) => {
      if (input.name === "task_resume") return new Promise(resolve => { finishResume = resolve; });
      return ++polls === 1 ? full(meta(binding())) : new Promise(resolve => { finishPage = resolve; });
    } } as unknown as App;
    const source = createMcpSource(app, snapshot.sessionId, snapshot.taskId);
    try {
      await source.snapshot(7);
      const resume = source.resumeTask!(0, "same-request");
      const page = source.snapshot(7, undefined, "member-a", "files-next");
      if (pageFirst) { finishPage(full(meta(binding()))); await page; }
      finishResume(resumed()); await resume;
      if (!pageFirst) { finishPage(full(meta(binding()))); await page; }
      assert.deepEqual(authority(source), selected());
    } finally { source.dispose(); }
  }
});

test("the missing-entry fallback sends only an explicit request to the host and never guesses a binding", async () => {
  const calls: Input[] = [], messages: unknown[] = [];
  const app = { getHostCapabilities: () => ({ serverTools: {}, message: {} }),
    callServerTool: async (input: Input) => { calls.push(input); return full(undefined); },
    sendMessage: async (message: unknown) => { messages.push(message); return {}; },
  } as unknown as App;
  const source = createMcpSource(app, snapshot.sessionId, snapshot.taskId);
  try {
    await source.snapshot(7);
    assert.equal(messages.length, 0);
    await source.requestHostTaskResume!();
    assert.equal(calls.length, 1);
    assert.equal(authority(source), null);
    assert.match(JSON.stringify(messages[0]), /task-a/);
    assert.match(JSON.stringify(messages[0]), /task_resume/);
    assert.match(JSON.stringify(messages[0]), /等待我明确要求/);
    (app as unknown as { getHostCapabilities: () => unknown }).getHostCapabilities = () => ({ serverTools: {} });
    await assert.rejects(source.requestHostTaskResume!(), /HOST_MESSAGE_UNAVAILABLE/);
    assert.equal(messages.length, 1);
  } finally { source.dispose(); }
});

test("MCP adapter prefixes preserve the server's definite binding-conflict code", async () => {
  const app = { getHostCapabilities: () => ({ serverTools: {} }), callServerTool: async () => ({ isError: true,
    content: [{ type: "text", text: "Error executing tool task_resume: TASK_BINDING_CHANGED: Inspect again." }],
  }) } as unknown as App;
  const source = createMcpSource(app, snapshot.sessionId, snapshot.taskId);
  try {
    await assert.rejects(source.resumeTask!(0, "key"), error => (error as { code?: string }).code === "TASK_BINDING_CHANGED");
    assert.equal(authority(source), null);
  } finally { source.dispose(); }
});
