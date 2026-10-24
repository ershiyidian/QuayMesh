import assert from 'node:assert/strict';
import test from 'node:test';
import { executionTimeEnd, taskTimeEnd, withTaskLifecycle } from './console-task-state.js';
import { elapsed } from './ui/console-v5/presentation.js';
import type { Run } from './console-workbench/types.js';

const now = 1_800_000_000_000;

test('任务起点取真实创建时间，阶段开始时间不会改变总耗时', () => {
  const value = {taskId: 'task', executionStatus: 'waiting', acceptanceStatus: 'not_required',
    startedAt: now - 10_000, finishedAt: null, lastActivityAt: now - 1_000};
  const task = {id: 'task', sessionId: 'session', title: 'Task', state: 'active', resultStatus: null,
    revision: 1, createdAt: now - 60_000, finishedAt: null, lastActivityAt: now - 1_000};
  assert.equal(withTaskLifecycle(value, task).startedAt, now - 60_000);
  assert.equal(value.startedAt, now - 10_000);
});

test('全局最新真实活动可恢复阶段汇总的闲置提示', t => {
  t.mock.method(Date, 'now', () => now);
  const value = {taskId: 'task', executionStatus: 'stalled', acceptanceStatus: 'not_required',
    startedAt: now - 60 * 60_000, finishedAt: null, lastActivityAt: now - 25 * 60_000};
  const task = {id: 'task', sessionId: 'session', title: 'Task', state: 'active', resultStatus: null,
    revision: 1, finishedAt: null, lastActivityAt: now - 10_000};
  assert.equal(withTaskLifecycle(value, task).executionStatus, 'waiting');
  assert.equal(withTaskLifecycle(value, {...task, lastActivityAt: now - 11 * 60_000}).executionStatus, 'stalled');
  assert.equal(withTaskLifecycle({...value, executionStatus: 'unknown'}, task).executionStatus, 'unknown');
  assert.equal(withTaskLifecycle({...value, executionStatus: 'failed'}, task).executionStatus, 'failed');
});

test('任务总耗时按请求生命周期推进，单次执行仍保留原有计时', () => {
  const value = {executionStatus: 'waiting', finishedAt: null, lastActivityAt: now - 50_000,
    observedAt: now - 40_000, stale: true};
  assert.equal(taskTimeEnd({...value, requestState: 'active'}, now), now);
  assert.equal(taskTimeEnd({...value, requestState: 'active'}, now + 10_000), now + 10_000);
  assert.equal(taskTimeEnd({...value, requestState: 'closed', finishedAt: now - 5_000}, now), now - 5_000);
  assert.equal(taskTimeEnd({...value, requestState: 'closed'}, now), null);
  assert.equal(taskTimeEnd(value, now), executionTimeEnd(value, now));
});

test('控制台总耗时随开放任务更新，交付结束后后台执行不会继续推进它', t => {
  t.mock.method(Date, 'now', () => now);
  const run = {requestState: 'active', executionStatus: 'waiting', startedAt: now - 60_000, finishedAt: null,
    lastActivityAt: now - 50_000, observedAt: now - 40_000, stale: true} as Run;
  const open = elapsed(run);
  assert.match(open, /title="本轮耗时"/);
  assert.match(open, /data-elapsed=/);
  assert.match(open, /data-observed="0"/);
  const closed = elapsed({...run, requestState: 'closed', executionStatus: 'running', finishedAt: now - 10_000});
  assert.match(closed, /title="本轮耗时"/);
  assert.doesNotMatch(closed, /data-elapsed=/);
});
