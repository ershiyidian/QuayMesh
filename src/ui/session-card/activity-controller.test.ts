import assert from "node:assert/strict";
import test from "node:test";
import { ExecutionState, type Snapshot } from "../../session/types.js";
import { createCardController } from "./controller.js";
import { createPreviewSource, previewSnapshot } from "./preview.js";
import { applySnapshot, createCardState } from "./state.js";
import { activityAgeText, cardPresentation, taskActivityAt } from "./timing.js";
import type { CardView } from "./view.js";

test("completed cards age locally without polling, and stop their clock when hidden or disposed", async (t) => {
  const now = Date.parse("2026-10-28T06:00:00Z");
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now });
  const snapshot: Snapshot = {
    ...previewSnapshot, taskState: "closed", taskResult: "completed", status: "done",
    execution_status: ExecutionState.idle, startedAt: now - 600_000, endedAt: now - 60_000,
    deliveryEndedAt: now - 60_000, lastActivityAt: now - 70_000, serverNow: now, observedAt: now,
    commands: [], currentCommand: null, runningCommand: null, lastCommand: null, lastOperation: null,
    agents: [], files: [], totals: { files: 0, commands: 0, agents: 0 },
    executionObservation: { observedAt: now, activeOperationIds: [], preparingOperationIds: [], staleOperationIds: [] },
    capabilities: { ...previewSnapshot.capabilities, refresh: false },
  };
  const state = createCardState();
  state.connection = "live";
  applySnapshot(state, snapshot);
  const doc = new class extends EventTarget {
    hidden = false;
    defaultView = null;
    getElementById() { return null; }
  }();
  let reads = 0, paints = 0, disposed = 0;
  const ticks: Array<{ activity: string; duration: number | null }> = [];
  const view: CardView = {
    render() { paints++; }, renderPanel() {}, renderFooter() {}, dispose() {},
    fillTimers() {
      ticks.push({ activity: activityAgeText(Date.now() - taskActivityAt(state.snapshot!)!),
        duration: cardPresentation(state.snapshot!, Date.now()).taskElapsedMs });
    },
  };
  const source = { ...createPreviewSource(), live: true,
    async snapshot() { reads++; return snapshot; },
    dispose() { disposed++; },
  };
  const controller = createCardController(state, view, source, doc as unknown as Document);
  t.after(() => controller.dispose());
  controller.start();
  await controller.pollOnce();
  assert.equal(reads, 1);
  const before = { ticks: ticks.length, paints };
  t.mock.timers.tick(65_000);
  assert.ok(ticks.length > before.ticks);
  assert.equal(ticks.at(-1)?.activity, "2 分 15 秒前");
  assert.ok(ticks.every(tick => tick.duration === 540_000));
  assert.equal(paints, before.paints);
  assert.equal(reads, 1);

  doc.hidden = true;
  doc.dispatchEvent(new Event("visibilitychange"));
  const hiddenTicks = ticks.length;
  t.mock.timers.tick(65_000);
  assert.equal(ticks.length, hiddenTicks);
  assert.equal(reads, 1);

  doc.hidden = false;
  doc.dispatchEvent(new Event("visibilitychange"));
  await controller.pollOnce();
  assert.ok(ticks.length > hiddenTicks);
  controller.dispose();
  const finalTicks = ticks.length, finalReads = reads;
  t.mock.timers.tick(65_000);
  assert.equal(ticks.length, finalTicks);
  assert.equal(reads, finalReads);
  assert.equal(disposed, 1);
});
