import assert from "node:assert/strict";
import test from "node:test";
import type { CommandSummary } from "../../session/types.js";
import { activityAgeText, modelActivityAt, taskActivityAt } from "./timing.js";

test("new observations do not reset the last task activity clock", () => {
  const now = Date.parse("2026-10-28T06:00:00Z");
  const snapshot = { lastActivityAt: now - 70_000, observedAt: now, serverNow: now, startedAt: now - 600_000 };
  assert.equal(taskActivityAt(snapshot), now - 70_000);
  const refreshed = { ...snapshot, observedAt: now + 30_000, serverNow: now + 30_000 };
  assert.equal(taskActivityAt(refreshed), now - 70_000);
  assert.equal(activityAgeText(now - taskActivityAt(snapshot)!), "1 分 10 秒前");
  assert.equal(activityAgeText(now + 30_000 - taskActivityAt(refreshed)!), "1 分 40 秒前");
});

test("missing work times remain unknown even in a freshly observed Task", () => {
  const now = Date.now();
  const snapshot = { lastActivityAt: undefined, observedAt: now, serverNow: now, startedAt: now };
  assert.equal(taskActivityAt(snapshot), null);
  assert.equal(taskActivityAt({ lastActivityAt: null, lastModelToolAt: Number.NaN, lastOutputAt: Number.POSITIVE_INFINITY }), null);
});

test("a new command output or file activity advances the existing task clock", () => {
  const prior = { lastActivityAt: 10_000, lastModelToolAt: 9_000, lastExecutionActivityAt: 8_000, lastOutputAt: 7_000 };
  assert.equal(taskActivityAt(prior), 10_000);
  assert.equal(taskActivityAt({ ...prior, lastOutputAt: 12_000 }), 12_000);
  assert.equal(taskActivityAt({ ...prior, lastActivityAt: 15_000 }), 15_000);
});

test("file activity does not invent a model call when that timestamp is explicitly absent", () => {
  assert.equal(modelActivityAt({ lastModelToolAt: null, lastActivityAt: 10_000 }), null);
  assert.equal(modelActivityAt({ lastActivityAt: 10_000 }), 10_000);
});

test("older snapshots can use recorded command start and completion times", () => {
  const command: CommandSummary = {
    id: "command", operation_id: "operation", member_id: "member", cmd: "example", agent: "host",
    status: "ok", startedAt: 10_000, endedAt: 20_000, exitCode: 0, signal: null,
    attempt: null, supersededBy: null, summary: null, output_ref: "operation", output_available: true,
  };
  assert.equal(taskActivityAt({ lastCommand: command }), 20_000);
  assert.equal(taskActivityAt({ runningCommand: { ...command, status: "run", endedAt: null } }), 10_000);
});
