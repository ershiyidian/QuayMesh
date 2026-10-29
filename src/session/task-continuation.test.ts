import assert from "node:assert/strict";
import test from "node:test";
import { taskContinuationEligibility } from "./task-continuation.js";

test("an open Task can continue without an agent when its original binding remains selected", () => {
  assert.deepEqual(taskContinuationEligibility({ id: "task-a", state: "active" }, "task-a", null), { allowed: true });
});

test("missing or closed Tasks cannot be silently reopened", () => {
  for (const task of [null, { id: "task-a", state: "closed" as const }]) {
    assert.deepEqual(taskContinuationEligibility(task, "task-a", null), { allowed: false, code: "TASK_NOT_ACTIVE" });
  }
});

test("only a failed proven-unsent or retired finalization permits continuation", () => {
  const task = { id: "task-a", state: "active" as const };
  assert.deepEqual(taskContinuationEligibility(task, "task-a", { error: null }), { allowed: false, code: "TASK_FINISHING" });
  assert.deepEqual(taskContinuationEligibility(task, "task-a", { error: "owner unavailable" }), { allowed: false, code: "TASK_FINISHING" });
  assert.deepEqual(taskContinuationEligibility(task, "task-a", { error: "owner unavailable", recovery_state: "safe" }), { allowed: true });
  assert.deepEqual(taskContinuationEligibility(task, "task-a", { error: "connection interrupted", recovery_state: "reconcile" }), { allowed: false, code: "TASK_FINISHING" });
  assert.deepEqual(taskContinuationEligibility(task, "task-a", { error: "retired", recovery_state: "superseded" }), { allowed: true });
});

test("another or missing legacy binding remains fail-closed until explicit Task binding migration", () => {
  for (const current of ["task-b", null, undefined]) {
    assert.deepEqual(taskContinuationEligibility({ id: "task-a", state: "active" }, current, null),
      { allowed: false, code: "TASK_CONTINUATION_BINDING_REQUIRED" });
  }
});
