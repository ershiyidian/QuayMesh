import assert from "node:assert/strict";
import test from "node:test";
import { ExecutionState, type Snapshot } from "../../session/types.js";
import { createCardController } from "./controller.js";
import { createPreviewSource, previewSnapshot } from "./preview.js";
import { applySnapshot, createCardState } from "./state.js";

function fixture() {
  const now = Date.now();
  const snapshot: Snapshot = { ...previewSnapshot, rev: 10, taskState: "closed", taskResult: "completed", status: "done",
    execution_status: ExecutionState.idle, commands: [], agents: [], currentCommand: null, runningCommand: null, lastCommand: null,
    capabilities: { ...previewSnapshot.capabilities, refresh: false, continue: false, revert: false },
    executionObservation: { observedAt: now, activeOperationIds: [], preparingOperationIds: [], staleOperationIds: [] },
    serverNow: now, observedAt: now };
  const state = createCardState();
  applySnapshot(state, snapshot);
  const doc = new class extends EventTarget { hidden = false; defaultView = null; getElementById() { return null; } }();
  const view = { render() {}, renderPanel() {}, renderFooter() {}, fillTimers() {}, dispose() {} };
  return { snapshot, state, doc, view };
}

test("a closed card retries a rejected first revision through its existing timer and accepts the later same-revision shape", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: Date.parse("2026-10-28T06:00:00Z") });
  const { snapshot, state, doc, view } = fixture();
  state.messages.draft = "保留草稿";
  const confirmed = state.lastConfirmedAt;
  let reads = 0, firstStages = 0;
  const source = { ...createPreviewSource(), live: true,
    async snapshot() {
      reads++;
      return reads === 1 ? { ...snapshot, rev: 9 } : { ...snapshot,
        files: snapshot.files.map(file => ({ ...file, recordedAt: 1234 })) };
    },
    async widgetStage(stage: string) { if (stage === "first_snapshot") firstStages++; },
  };
  const controller = createCardController(state, view, source, doc as unknown as Document);
  t.after(() => controller.dispose());
  controller.start(); await controller.pollOnce();
  assert.equal(reads, 1);
  assert.equal(firstStages, 0);
  assert.equal(state.connection, "error");
  assert.equal(state.lastConfirmedAt, confirmed);
  t.mock.timers.tick(5000); await controller.pollOnce();
  assert.equal(reads, 2);
  assert.equal(firstStages, 1);
  assert.equal(state.snapshot!.files[0].recordedAt, 1234);
  assert.equal(state.snapshot!.taskState, "closed");
  assert.equal(state.messages.draft, "保留草稿");
  assert.equal(state.connection, "live");
  t.mock.timers.tick(120_000); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(reads, 2, "a negotiated closed card returns to no network polling");
});

test("first-snapshot retries stop after three failures and do not turn bootstrap capabilities into confirmed actions", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: Date.parse("2026-10-28T06:00:00Z") });
  const { snapshot, state, doc, view } = fixture();
  state.snapshot = { ...snapshot, taskState: "active", capabilities: { ...snapshot.capabilities, continue: true, revert: true } };
  const confirmed = state.lastConfirmedAt;
  let reads = 0;
  const source = { ...createPreviewSource(), live: true, async snapshot() { reads++; throw new Error("offline"); } };
  const controller = createCardController(state, view, source, doc as unknown as Document);
  t.after(() => controller.dispose());
  controller.start(); await controller.pollOnce();
  for (const elapsed of [5000, 10000]) { t.mock.timers.tick(elapsed); await controller.pollOnce(); }
  assert.equal(reads, 3);
  assert.equal(state.connection, "unconfirmed");
  assert.equal(state.lastConfirmedAt, confirmed);
  assert.equal(state.snapshot!.rev, snapshot.rev);
  assert.equal(state.snapshot!.capabilities.continue, false);
  assert.equal(state.snapshot!.capabilities.revert, false);
  t.mock.timers.tick(120_000); await controller.pollOnce();
  doc.hidden = true; doc.dispatchEvent(new Event("visibilitychange"));
  doc.hidden = false; doc.dispatchEvent(new Event("visibilitychange"));
  await controller.pollOnce();
  assert.equal(reads, 3, "visibility changes and elapsed time cannot reset the first-handshake budget");
});
