import assert from "node:assert/strict";
import test from "node:test";
import { previewSnapshot } from "./preview.js";
import { applySnapshot, createCardState } from "./state.js";

test("the first negotiated same-revision shape adds file evidence and capability fields while keeping the draft", () => {
  const state = createCardState();
  const bootstrap = { ...previewSnapshot, capabilities: { ...previewSnapshot.capabilities, continue: false } };
  applySnapshot(state, bootstrap);
  state.messages.draft = "保留这份未发送草稿";
  const current = { ...bootstrap, files: bootstrap.files.map(file => ({ ...file, recordedAt: 1234 })),
    capabilities: { ...bootstrap.capabilities, continue: true } };
  applySnapshot(state, current);
  assert.equal(state.snapshot!.files[0].recordedAt, undefined, "ordinary equal-revision updates retain the original deduplication");
  applySnapshot(state, current, { acceptSameRevision: true });
  assert.equal(state.snapshot!.files[0].recordedAt, 1234);
  assert.equal(state.snapshot!.capabilities.continue, true);
  assert.equal(state.messages.draft, "保留这份未发送草稿");
  applySnapshot(state, { ...bootstrap, rev: bootstrap.rev - 1 }, { acceptSameRevision: true });
  assert.equal(state.snapshot!.files[0].recordedAt, 1234, "negotiation does not authorize an older revision");
});

test("shape negotiation preserves Task identity and a durable closed lifecycle including its action eligibility", () => {
  const state = createCardState();
  const closed = { ...previewSnapshot, taskState: "closed" as const, taskResult: "completed" as const,
    capabilities: { ...previewSnapshot.capabilities, continue: false, revert: false } };
  applySnapshot(state, closed);
  assert.throws(() => applySnapshot(state, { ...closed, taskId: "different-task" }, { acceptSameRevision: true }), /TASK_CHANGED/);
  applySnapshot(state, { ...closed, taskState: "active", taskResult: null,
    capabilities: { ...closed.capabilities, continue: true, revert: true } }, { acceptSameRevision: true });
  assert.equal(state.snapshot!.taskState, "closed");
  assert.equal(state.snapshot!.taskResult, "completed");
  assert.equal(state.snapshot!.capabilities.continue, false);
  assert.equal(state.snapshot!.capabilities.revert, false);
});
