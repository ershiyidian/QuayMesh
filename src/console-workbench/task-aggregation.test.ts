import assert from "node:assert/strict";
import test from "node:test";
import { aggregateTaskIndex, aggregateTasks, filterTaskIndex, taskReference } from "./task-aggregation.js";
import type { TaskPhaseIndex } from "./local-queries.js";
import type { Run } from "./types.js";
import { lastObservedExecutingTasks, selectOverviewTasks } from './overview-tasks.js';
import { dayAt } from './query.js';

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

test('未关闭按任务生命周期筛选，包含无命令和失败试验，排除已交接的后台执行', () => {
  const rows=aggregateTaskIndex([
    {...phase('idle','open-idle','desktop'),requestState:'active',executionStatus:'waiting'},
    {...phase('failed','open-failed','desktop'),requestState:'active',executionStatus:'failed'},
    {...phase('running','handed','desktop'),requestState:'closed',resultStatus:'handed_off',executionStatus:'running'},
  ],at);
  assert.deepEqual(filterTaskIndex(rows,{requestState:'active',days:'7'},at).map(row=>row.taskId).sort(),['open-failed','open-idle']);
  assert.deepEqual(filterTaskIndex(rows,{requestState:'closed',days:'0'},at).map(row=>row.taskId),['handed']);
  assert.deepEqual(filterTaskIndex(rows,{stage:'running,stopping,queued',days:'0'},at).map(row=>row.taskId),['handed']);
});

const scenarios: Array<{name: string; values: Array<Partial<Run>>; expected: string}> = [
  {name: '新工作区十秒前完成命令，旧工作区闲置二十五分钟', values: [
    {executionStatus: 'waiting', lastActivityAt: at - 10_000},
    {executionStatus: 'stalled', lastActivityAt: at - 25 * 60_000},
  ], expected: 'waiting'},
  {name: '全部工作区确实超过三十分钟没有活动', values: [
    {executionStatus: 'stalled', lastActivityAt: at - 31 * 60_000},
    {executionStatus: 'stalled', lastActivityAt: at - 45 * 60_000},
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

test('Task attention paging uses the same actionable categories as the overview', () => {
  const rows = aggregateTaskIndex([
    {...phase('old-stalled', 'old-stalled', 'desktop'), requestState:'active', executionStatus:'stalled'},
    {...phase('unknown', 'unknown', 'desktop'), requestState:'active', executionStatus:'unknown', actionableInterruption:true},
    {...phase('old-failure', 'old-failure', 'desktop'), requestState:'closed', resultStatus:'failed', executionStatus:'failed', actionableInterruption:true},
    {...phase('resume', 'resume', 'desktop'), requestState:'active', executionStatus:'interrupted_recoverable', actionableInterruption:true},
    {...phase('review', 'review', 'desktop'), requestState:'closed', resultStatus:'completed', executionStatus:'completed'},
    {...phase('finalization', 'finalization', 'desktop'), requestState:'active', executionStatus:'finalizing',
      finalization:{status:'failed' as const,requestedAt:at,error:'test failure'}},
  ], at);
  assert.deepEqual(filterTaskIndex(rows,{attention:'1',days:'0'},at).map(row=>row.taskId).sort(),
    ['finalization','resume','review']);
});

test('completed Task results remain filterable independently of the last execution state', () => {
  const rows = aggregateTaskIndex([
    {...phase('uncertain', 'task-done', 'desktop'), requestState:'closed', resultStatus:'completed', executionStatus:'unknown', finishedAt:at},
    {...phase('residual', 'residual', 'desktop'), requestState:'closed', resultStatus:'completed', executionStatus:'running', finishedAt:at},
    {...phase('only-phase', 'open-task', 'desktop'), requestState:'active', executionStatus:'completed', finishedAt:at},
    {...phase('stopped', 'stopped-task', 'desktop'), requestState:'closed', resultStatus:'cancelled', executionStatus:'cancelled', finishedAt:at},
  ], at);
  assert.deepEqual(filterTaskIndex(rows,{requestState:'closed',resultStatus:'completed',days:'0'},at)
    .map(row=>row.taskId).sort(),['residual','task-done']);
});

test('overview view-all filters retain exactly the displayed current and older groups beyond twelve rows', () => {
  const time=Date.parse('2026-10-30T11:38:00Z');
  const yesterday=Date.parse('2026-10-29T11:59:00Z');
  const phases=[...Array.from({length:15},(_,i)=>({...phase(`new-${i}`,`new-${i}`,'desktop'),
    requestState:'active',lastActivityAt:time-60_000,executionStatus:'waiting'})),
    {...phase('old','old','desktop'),requestState:'active',lastActivityAt:yesterday,executionStatus:'waiting'},
    {...phase('cached','cached','desktop'),requestState:'active',lastActivityAt:yesterday,executionStatus:'running'},
  ];
  const retained=lastObservedExecutingTasks(phases);
  const indexed=aggregateTaskIndex(phases.map(value=>value.taskId==='cached'
    ? {...value,executionStatus:'unknown',stale:true} : value),time);
  const groups=selectOverviewTasks(indexed,time,value=>dayAt(value,'Asia/Shanghai')===dayAt(time,'Asia/Shanghai'),retained);
  const keys=(values:typeof indexed)=>values.map(value=>value.key).sort();
  assert.equal(groups.current.length,15);
  assert.deepEqual(keys(filterTaskIndex(indexed,{overviewGroup:'current',tz:'Asia/Shanghai',days:'0'},time,retained)),keys(groups.current));
  assert.deepEqual(keys(filterTaskIndex(indexed,{overviewGroup:'olderOpen',tz:'Asia/Shanghai',days:'0'},time,retained)),keys(groups.olderOpen));
  assert.deepEqual(new Set(groups.olderOpen.map(value=>value.taskId)),new Set(['old','cached']));
});
