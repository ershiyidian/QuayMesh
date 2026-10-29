import assert from 'node:assert/strict';
import test from 'node:test';
import { taskView, taskLifecycleView } from './task-view.js';

test('任务主状态取持久生命周期，后台状态变化不能结束开放任务', () => {
  for (const execution of ['running', 'queued', 'idle', 'waiting', 'failed', 'unknown', 'stalled', 'completed']) {
    const input = {requestState:'active', result:null, execution};
    assert.deepEqual(taskLifecycleView(input), {status:'active', label:'任务进行中'});
    assert.equal(taskView(input).requestEnded, false);
  }
  assert.equal(taskLifecycleView({requestState:'closed',result:'failed'})?.label,'未完成');
  assert.equal(taskLifecycleView({requestState:'closed',result:'completed',finalizing:true})?.status,'completed');
  assert.equal(taskLifecycleView({requestState:'active',finalizing:true,finalizationFailed:true})?.label,'交付确认失败');
  assert.equal(taskLifecycleView({}),null,'旧记录缺少任务生命周期时保留执行状态回退');
});

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
