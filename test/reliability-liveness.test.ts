import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkLedger } from '../src/work-ledger.js';
import { readLocalIndex } from '../src/console-workbench/local.js';
import { taskView } from '../src/task-view.js';
import { fixture, until } from './tool-contract/fixture.js';

test('租约过期且没有后台工作时显示停滞、停止计时，下一次工具调用复用原任务', {timeout: 30_000}, async t => {
  const f = await fixture(t, {git: false});
  const command = await f.execute("console.log('first completed')", {operation_key: 'liveness-first'});
  assert.equal(command.exit_code, 0);
  const ledger = new WorkLedger(f.config.stateDir);
  try {
    const linked = ledger.db.prepare('SELECT run_id FROM qm_run_links WHERE task_id=?').get(f.task.task_id) as {run_id: string};
    await until(() => !ledger.hasActiveChild(linked.run_id));
    const expired = new Date(Date.now() - 3_600_000).toISOString();
    ledger.db.prepare('UPDATE console_work_runs SET last_activity_at=?,lease_expires_at=? WHERE id=?')
      .run(expired, expired, linked.run_id);
    const before = ledger.run(linked.run_id);
    assert.equal(before.status, 'running');
    for (let i = 0; i < 10; i++) {
      const run = readLocalIndex(f.config, [linked.run_id]).runs[0];
      assert.equal(run.executionStatus, 'stalled');
      assert.equal(taskView({execution: run.executionStatus}).clockRunning, false);
      assert.equal(ledger.projectUsage(before.project_id).activeTasks, 0);
    }
    assert.deepEqual(ledger.run(linked.run_id), before);
    assert.equal((ledger.db.prepare('SELECT COUNT(*) count FROM execution_claims').get() as {count: number}).count, 0);
    const continued = await f.execute("console.log('continued original task')", {operation_key: 'liveness-next'});
    assert.equal(continued.exit_code, 0);
    assert.equal((ledger.db.prepare('SELECT run_id FROM qm_run_links WHERE task_id=?').get(f.task.task_id) as {run_id: string}).run_id, linked.run_id);
    assert.equal((ledger.db.prepare('SELECT state FROM qm_tasks WHERE id=?').get(f.task.task_id) as {state: string}).state, 'active');
    assert.ok(Date.parse(ledger.run(linked.run_id).last_activity_at!) > Date.parse(expired));
  } finally {
    // after 按注册顺序执行；先关闭旁路连接，再让 fixture 删除 Windows 上的数据库目录。
    ledger.close();
  }
});
