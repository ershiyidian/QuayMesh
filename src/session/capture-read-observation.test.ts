import assert from "node:assert/strict";
import test from "node:test";
import { CaptureReadClock } from "./capture-read-observation.js";

const scope = { sessionId: "s", memberId: "m", taskId: "task_a" };
const idle = { state: "idle" as const, error: null };

test("a complete capture cycle is detected even when both observations are idle", () => {
  const clock = new CaptureReadClock();
  const before = clock.fence();
  clock.touch(scope.memberId, scope.taskId);
  clock.touch(scope.memberId, scope.taskId);
  assert.equal(clock.observe(scope, before, idle).unchanged, false);
  assert.equal(clock.observe(scope, clock.fence(), idle).unchanged, true);
});

test("another Task does not invalidate the read but another collector generation does", () => {
  const clock = new CaptureReadClock();
  const before = clock.fence();
  clock.touch(scope.memberId, "task_b");
  assert.equal(clock.observe(scope, before, idle).unchanged, true);
  assert.equal(new CaptureReadClock().observe(scope, before, idle).unchanged, false);
  assert.equal(clock.observe(scope, { ...before, sequence: 999 }, idle).unchanged, false);
});
