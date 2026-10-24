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

const at = 1_800_000_000_000;
const scenarios: Array<{name: string; values: Array<Partial<Run>>; expected: string}> = [
  {name: '新工作区十秒前完成命令，旧工作区闲置二十五分钟', values: [
    {executionStatus: 'waiting', lastActivityAt: at - 10_000},
    {executionStatus: 'stalled', lastActivityAt: at - 25 * 60_000},
  ], expected: 'waiting'},
  {name: '全部工作区确实超过十分钟没有活动', values: [
    {executionStatus: 'stalled', lastActivityAt: at - 11 * 60_000},
    {executionStatus: 'stalled', lastActivityAt: at - 25 * 60_000},
  ], expected: 'stalled'},
  {name: '新鲜命令运行时另一个空闲成员暂时失联', values: [
    {executionStatus: 'running', lastActivityAt: at - 1_800_000},
    {executionStatus: 'waiting', lastActivityAt: at - 60_000, stale: true},
  ], expected: 'running'},
  {name: '空闲成员失联时停止推断全任务长期无活动', values: [
    {executionStatus: 'stalled', lastActivityAt: at - 11 * 60_000},
    {executionStatus: 'waiting', lastActivityAt: at - 10_000, stale: true},
  ], expected: 'unknown'},
  {name: '过期运行观测不会压过其他节点的新鲜空闲', values: [
    {executionStatus: 'running', lastActivityAt: at - 60_000, stale: true},
    {executionStatus: 'waiting', lastActivityAt: at - 10_000},
  ], expected: 'unknown'},
  {name: '已保存交付结果在来源过期后保持完成', values: [
    {executionStatus: 'completed', requestState: 'closed', resultStatus: 'completed', stale: true},
  ], expected: 'completed'},
  {name: '历史已完成执行记录不随来源过期复活', values: [
    {executionStatus: 'completed', stale: true},
  ], expected: 'completed'},
  {name: '交付后继续运行的后台命令保持可见', values: [
    {executionStatus: 'running', requestState: 'closed', resultStatus: 'handed_off'},
    {executionStatus: 'completed', requestState: 'closed', resultStatus: 'handed_off'},
  ], expected: 'running'},
  {name: '另一个工作区的新活动不清除明确失败', values: [
    {executionStatus: 'failed', lastActivityAt: at - 20_000},
    {executionStatus: 'waiting', lastActivityAt: at - 10_000},
  ], expected: 'failed'},
];

for (const scenario of scenarios) {
  test(`任务索引与详情统一聚合：${scenario.name}`, () => {
    const runs = scenario.values.map((value, i) => ({...run(`run-${i}`, 'task', `node-${i}`),
      observedAt: at, stale: false, lastActivityAt: at - 10_000, ...value}));
    const phases = runs.map((value, i) => ({...phase(`run-${i}`, 'task', `node-${i}`), ...value,
      currentPhase: value.currentPhase !== false, actionableInterruption: Boolean(value.actionableInterruption)}));
    for (const result of [aggregateTasks(runs, at)[0]!, aggregateTaskIndex(phases, at)[0]!]) {
      assert.equal(result.executionStatus, scenario.expected);
      assert.equal(result.lastActivityAt, Math.max(...runs.map(value => value.lastActivityAt)));
    }
  });
}
