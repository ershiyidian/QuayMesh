import assert from 'node:assert/strict';
import test from 'node:test';
import type { TaskIndex } from './task-aggregation.js';
import { overviewTaskProgress, selectOverviewTasks, taskAttention } from './overview-tasks.js';

const now = Date.parse('2026-10-30T11:38:00Z');
const yesterday = Date.parse('2026-10-29T11:59:00Z');
const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
const todayAt = (at: number) => (time: number) => date.format(time) === date.format(at);

function task(id: string, changes: Partial<TaskIndex> = {}): TaskIndex {
  return {
    key: `task:${id}`, sessionId: `session:${id}`, taskId: id, title: id,
    phaseRefs: [], currentPhaseRefs: [], nodeIds: ['node'], projectIds: [], projectNames: [], roots: [],
    executionStatus: 'waiting', acceptanceStatus: 'not_required', startedAt: yesterday,
    finishedAt: null, lastActivityAt: now - 60_000, tokens: null, changed: false, actionableInterruption: false,
    requestState: 'active', resultStatus: null, observedAt: now, stale: false,
    ...changes,
  };
}

test('recent open requests remain current without background execution', () => {
  const rows = [task('thinking'), task('between-tools', { executionStatus: 'stalled', lastActivityAt: now - 29 * 60_000 }),
    task('phase-done', { executionStatus: 'waiting', phaseExecutionStatus: 'completed' })];
  const before = structuredClone(rows);
  const result = selectOverviewTasks(rows, now, todayAt(now));
  assert.deepEqual(new Set(result.current.map(row => row.taskId)), new Set(['thinking', 'between-tools', 'phase-done']));
  assert.equal(result.attention.length, 0);
  assert.equal(result.completedToday, 0);
  assert.equal(overviewTaskProgress(rows[1]!, 'current', now).progressLabel, '最近有活动');
  assert.deepEqual(rows, before, 'display grouping must not change saved Task state');
});

test('yesterday\'s 19:59 request is older at today\'s 19:38, despite being less than 24 hours old', () => {
  const old = task('older', { executionStatus: 'stalled', lastActivityAt: yesterday });
  const result = selectOverviewTasks([old], now, todayAt(now));
  assert.equal(result.current.length, 0);
  assert.deepEqual(result.olderOpen.map(row => row.taskId), ['older']);
  assert.deepEqual(overviewTaskProgress(old, 'older', now), { progressLabel: '等待继续', progressSummary: '最近 30 分钟没有新活动；任务仍可继续' });
  assert.equal(old.requestState, 'active');
  assert.equal(result.attention.length, 0);
});

test('recent Task activity carries across local midnight without extending yesterday all day', () => {
  const afterMidnight = Date.parse('2026-10-30T16:10:00Z');
  const recent = task('late-work', { lastActivityAt: Date.parse('2026-10-30T15:50:00Z') });
  assert.equal(selectOverviewTasks([recent], afterMidnight, todayAt(afterMidnight)).current.length, 1);
  const later = Date.parse('2026-10-30T18:10:00Z');
  assert.equal(selectOverviewTasks([recent], later, todayAt(later)).olderOpen.length, 1);
});

test('confirmed long running and queued requests remain current; old finalization alone does not', () => {
  const old = now - 3 * 86_400_000;
  const rows = [task('experiment', { lastActivityAt: old, executionStatus: 'running', executionObservedAt: now-1000 }),
    task('queue', { lastActivityAt: old, executionStatus: 'queued', executionObservedAt: now-1000 }),
    task('delivery', { lastActivityAt: old, finalization: { status: 'pending', requestedAt: old, error: null } })];
  const result = selectOverviewTasks(rows, now, todayAt(now));
  assert.deepEqual(result.current.map(row => row.taskId), ['experiment', 'queue']);
  assert.deepEqual(result.olderOpen.map(row=>row.taskId), ['delivery']);
  assert.equal(result.attention.length, 0, 'normal finalization is not a user action');
});

test('a missing observation keeps the Task reachable without retaining a current execution claim', () => {
  const cached = task('experiment', { executionStatus: 'unknown', stale: true,
    observedAt: now - 10 * 60_000, lastActivityAt: now - 3 * 86_400_000 });
  const result = selectOverviewTasks([cached], now, todayAt(now), new Set([cached.key]));
  assert.equal(result.current.length, 0);
  assert.equal(result.olderOpen.length, 1);
  assert.deepEqual(overviewTaskProgress(cached, 'older', now), {
    progressLabel: '等待继续', progressSummary: '最近 30 分钟没有新活动；任务仍可继续',
  });
  assert.equal(result.attention.length, 0, 'unavailable data is not automatically a user task');
});

test('an open Task without an activity time stays available without inventing a stopped state', () => {
  const unknown = task('missing-time', { lastActivityAt: NaN, executionStatus: 'unknown', stale: true, observedAt: null });
  const result = selectOverviewTasks([unknown], now, todayAt(now));
  assert.equal(result.current.length, 0);
  assert.deepEqual(result.olderOpen.map(row => row.taskId), ['missing-time']);
  assert.equal(overviewTaskProgress(unknown, 'older', now).progressLabel, '活动待确认');
  assert.equal(unknown.requestState, 'active');
  assert.equal(unknown.finishedAt, null);
});

test('recent results and today counts use the Task lifecycle and outcome', () => {
  const rows = [
    task('task-done', { requestState: 'closed', resultStatus: 'completed', executionStatus: 'unknown', finishedAt: now - 1000 }),
    task('task-failed', { requestState: 'closed', resultStatus: 'failed', executionStatus: 'failed', finishedAt: now - 2000 }),
    task('unconfirmed-end', { requestState: 'closed', resultStatus: null, executionStatus: 'completed', finishedAt: now - 3000 }),
    task('phase-only-success', { executionStatus: 'completed', finishedAt: now - 4000 }),
    task('closed-with-residual-work', { requestState: 'closed', resultStatus: 'cancelled', executionStatus: 'running', finishedAt: now - 5000 }),
    task('legacy-run', { taskId: null, requestState: undefined, executionStatus: 'completed', finishedAt: now - 6000 }),
  ];
  const result = selectOverviewTasks(rows, now, todayAt(now));
  assert.deepEqual(result.recent.map(row => row.taskId), ['task-done', 'task-failed', 'unconfirmed-end', 'closed-with-residual-work']);
  assert.deepEqual(result.current.map(row => row.taskId), ['phase-only-success']);
  assert.equal(result.completedToday, 1);
  assert.equal(result.failedToday, 1);
  assert.equal(overviewTaskProgress(rows[0]!, 'recent').progressLabel, '已完成');
  assert.equal(overviewTaskProgress(rows[2]!, 'recent', now).progressLabel, '已结束 · 交付未确认');
  assert.equal(overviewTaskProgress(rows[4]!, 'recent').progressLabel, '已停止');
});

test('attention requires an explicit unresolved action on a real Task', () => {
  const rows = [
    task('review', { executionStatus: 'waiting', phaseExecutionStatus: 'completed', acceptanceStatus: 'pending' }),
    task('interrupted', { executionStatus: 'interrupted_recoverable', actionableInterruption: true }),
    task('confirmation-failed', { finalization: { status: 'failed', requestedAt: now, error: 'test failure' } }),
    task('stalled', { executionStatus: 'stalled', lastActivityAt: yesterday }),
    task('unknown', { executionStatus: 'unknown', actionableInterruption: true }),
    task('historical-failure', { requestState: 'closed', resultStatus: 'failed', executionStatus: 'failed', actionableInterruption: true, finishedAt: yesterday }),
    task('ordinary-failure', { executionStatus: 'failed' }),
    task('normal-finalization', { finalization: { status: 'pending', requestedAt: now, error: null } }),
    task('rejected-phase', { acceptanceStatus: 'rejected' }),
    task('legacy-anomaly', { taskId: null, requestState: undefined, executionStatus: 'interrupted_recoverable', actionableInterruption: true }),
  ];
  const result = selectOverviewTasks(rows, now, todayAt(now));
  assert.deepEqual(new Set(result.attention.map(row => row.taskId)), new Set(['review', 'interrupted', 'confirmation-failed']));
  assert.equal(result.reviewCount, 1);
  assert.equal(taskAttention(rows[0]!)?.actionLabel, '验收结果');
  assert.equal(taskAttention(rows[1]!)?.actionLabel, '处理执行中断');
  assert.equal(taskAttention(rows[2]!)?.actionLabel, '查看确认失败');
});

test('a pending acceptance on an executing phase is not yet an actionable review', () => {
  const running = task('work', { executionStatus: 'running', acceptanceStatus: 'pending' });
  assert.equal(taskAttention(running), null);
  assert.equal(selectOverviewTasks([running], now, todayAt(now)).reviewCount, 0);
});

test('stopping an execution does not label its open Task as stopped', () => {
  for (const executionStatus of ['running','starting']) {
    assert.equal(overviewTaskProgress(task(executionStatus,{executionStatus,executionObservedAt:now}),'current',now).progressLabel,'执行中');
  }
  assert.deepEqual(overviewTaskProgress(task('stopping',{executionStatus:'stopping',executionObservedAt:now}),'current',now),{
    progressLabel:'执行中',progressSummary:'正在停止当前执行',
  });
  assert.equal(overviewTaskProgress(task('queued',{executionStatus:'queued',executionObservedAt:now}),'current',now).progressLabel,'等待执行');
  assert.equal(overviewTaskProgress(task('cancelled',{requestState:'closed',resultStatus:'cancelled',executionStatus:'stopping'}),'recent').progressLabel,'已停止');
});
