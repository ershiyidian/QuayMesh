import assert from "node:assert/strict";
import test from "node:test";
import { createCardController } from "./controller.js";
import { createPreviewSource, previewSnapshot } from "./preview.js";
import type { SessionCardSource } from "./source.js";
import { applySnapshot, createCardState } from "./state.js";

function fixture(continueSession: SessionCardSource["continueSession"]) {
  const state = createCardState();
  applySnapshot(state, { ...previewSnapshot, taskState: "active", finalization: null });
  state.connection = "live";
  const source: SessionCardSource = { ...createPreviewSource(), live: true, supportsHostMessage: true, continueSession };
  const doc = new class extends EventTarget { hidden = false; defaultView = null; getElementById() { return null; } }();
  const view = { render() {}, renderPanel() {}, renderFooter() {}, fillTimers() {}, dispose() {} };
  const controller = createCardController(state, view, source, doc as unknown as Document);
  return { controller, state };
}

test("a concurrent continuation returns an explicit not-sent result while only the accepted send can report success", async t => {
  let sends = 0, release!: () => void;
  const f = fixture(async () => { sends++; await new Promise<void>(resolve => { release = resolve; }); });
  t.after(() => { release?.(); f.controller.dispose(); });
  const snapshot = f.state.snapshot;
  const first = f.controller.handleIntent({ type: "continue_session" });
  assert.equal(f.state.busy, true);
  assert.equal(sends, 1);
  assert.deepEqual(await f.controller.handleIntent({ type: "continue_session" }), { sent: false, reason: "busy" });
  assert.equal(sends, 1, "the repeated intent neither dispatches again nor fabricates success");
  release();
  assert.deepEqual(await first, { sent: true });
  assert.equal(f.state.busy, false);
  assert.equal(f.state.snapshot, snapshot, "sending a host request does not manufacture Task progress");
});

test("host rejection cannot become a successful continuation result and always releases the busy state", async t => {
  const f = fixture(async () => { throw new Error("CONTINUE_MESSAGE_REJECTED"); });
  t.after(() => f.controller.dispose());
  await assert.rejects(f.controller.handleIntent({ type: "continue_session" }), /CONTINUE_MESSAGE_REJECTED/);
  assert.equal(f.state.busy, false);
});
