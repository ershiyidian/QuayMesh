import assert from "node:assert/strict";
import test from "node:test";
import { aggregateTaskIndex, aggregateTasks, taskReference } from "./task-aggregation.js";
import type { TaskPhaseIndex } from "./local-queries.js";
import type { Run } from "./types.js";

function run(id: string, taskId: string, nodeId: string): Run {
  return {
    id, localId: id, title: taskId, nodeId, projectId: `${nodeId}:project`, projectLocalId: "project",
    projectName: "project", root: "/project", executionStatus: "waiting", acceptanceStatus: "pending",
    startedAt: 1, finishedAt: null, lastActivityAt: 2, revision: 1, workspaceRevision: 1,
    sessionId: "session-one", taskId, memberId: `${nodeId}-member`,
    usage: { total: null, input: null, cached: null, output: null, reasoning: null, quality: "unavailable" },
    diff: null, origin: "chatgpt_mcp", branch: null, baseSha: null, command: null, agent: null, reason: null,
    actions: { interrupt: false, resume: false, review: false, revert: false, complete: true, patch: true },
    warnings: [], phaseRefs: [id], nodeIds: [nodeId], workspaceCount: 1, currentPhase: true, currentPhaseRefs: [id],
  };
}

function phase(id: string, taskId: string, nodeId: string): TaskPhaseIndex {
  return {
    id, localId: id, nodeId, sessionId: "session-one", taskId, title: taskId,
    projectId: `${nodeId}:project`, projectName: "project", root: "/project", executionStatus: "waiting",
    acceptanceStatus: "pending", startedAt: 1, finishedAt: null, lastActivityAt: 2, tokens: null,
    changed: false, actionableInterruption: false, currentPhase: true,
  };
}

test("tasks aggregate across nodes by task_id and keep later user requests separate", () => {
  const tasks = aggregateTasks([
    run("run-a", "task-one", "desktop"),
    run("run-b", "task-one", "campus-s1"),
    run("run-c", "task-two", "desktop"),
  ]);
  assert.equal(tasks.length, 2);
  assert.deepEqual(tasks.find((item) => item.taskId === "task-one")?.nodeIds?.sort(), ["campus-s1", "desktop"]);
  assert.equal(tasks.find((item) => item.taskId === "task-one")?.id, taskReference("task-one"));
  assert.equal(tasks.find((item) => item.taskId === "task-two")?.id, taskReference("task-two"));

  const indexed = aggregateTaskIndex([
    phase("phase-a", "task-one", "desktop"),
    phase("phase-b", "task-one", "campus-s1"),
    phase("phase-c", "task-two", "desktop"),
  ]);
  assert.equal(indexed.length, 2);
  assert.equal(indexed.find((item) => item.taskId === "task-one")?.phaseRefs.length, 2);
});
