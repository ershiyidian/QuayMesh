import assert from 'node:assert/strict';
import test from 'node:test';
import { taskView } from './task-view.js';

test('其它成员过期时，新鲜运行和排队事实仍然有效', () => {
  const active = taskView({requestState: 'active', execution: 'idle', active: true, stale: true});
  assert.equal(active.status, 'running');
  assert.equal(active.backgroundActive, true);
  const queued = taskView({requestState: 'active', execution: 'idle', queued: true, stale: true});
  assert.equal(queued.status, 'queued');
  assert.equal(queued.backgroundActive, true);
});

test('旧执行标签和空闲确认过期后都显示待核对', () => {
  for (const execution of ['running', 'queued', 'idle']) {
    const view = taskView({requestState: 'active', execution, stale: true});
    assert.equal(view.status, 'unknown');
    assert.equal(view.backgroundActive, false);
  }
});

test('交付终态与未取得的来源状态分别保留', () => {
  const closed = taskView({requestState: 'closed', result: 'completed', execution: 'idle', stale: true});
  assert.equal(closed.status, 'completed');
  assert.equal(closed.requestEnded, true);
  const background = taskView({requestState: 'closed', result: 'handed_off', execution: 'idle', active: true, stale: true});
  assert.equal(background.status, 'running');
  assert.equal(background.resultStatus, 'handed_off');
  assert.equal(background.clockRunning, false);
});
