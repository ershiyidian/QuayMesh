import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { consoleExperienceFixture } from './experience-fixture.js';
import { waitForFixture } from '../session-card/server-fixture.js';
import { WorkLedger } from '../../src/work-ledger.js';
import type { RunPage } from '../../src/ui/console-v5/contracts.js';

export async function taskLifecycleFixture() {
  const f = await consoleExperienceFixture({ historicalBackground: true });
  try {
    const selected = await f.call('task_resume', { action: 'inspect', task_id: f.waiting.task_id });
    const failed = await f.call('start_session', { title: '试验失败但工作目标仍开放', request_key: 'console-lifecycle-failed',
      new_goal: true, expected_binding_revision: (selected.binding as { binding_revision: number }).binding_revision });
    const workspace = await f.call('open_workspace', { path: f.server.project });
    const script = join(f.server.project, 'lifecycle-failure.mjs');
    await writeFile(script, "console.error('expected lifecycle test exit'); process.exitCode = 7;\n");
    await f.call('exec_command', { workspace_id: workspace.workspace_id,
      cmd: `"${process.execPath}" "${script}"`, yield_time_ms: 1000 });
    await waitForFixture(f.server, { sessionId: String(failed.session_id) }, 'recorded failed command without closing its Task',
      () => f.get('runs?days=0&fresh=1') as Promise<RunPage>,
      page => page.items.some(run => run.taskId === failed.task_id && run.requestState === 'active' && run.executionStatus === 'failed'));

    const ledger = new WorkLedger(f.server.config.stateDir);
    try {
      // Historical start times are fixture data. Keep the actual failed command
      // and its recent observation; only the long-lived Task's creation is old.
      const old = new Date(Date.now() - 15 * 86_400_000).toISOString();
      ledger.db.prepare('UPDATE qm_tasks SET created_at=? WHERE id=?').run(old, failed.task_id);
      ledger.db.prepare('UPDATE console_work_runs SET created_at=? WHERE id IN (SELECT run_id FROM qm_run_links WHERE task_id=?)')
        .run(old, failed.task_id);
    } finally { ledger.close(); }
    const fixture = { ...f, failed, failedWorkspace: workspace };
    await recordDelayedBackground(fixture);
    return fixture;
  } catch (error) {
    await f.server.dispose();
    throw error;
  }
}

/** Reproduce a saved late execution receipt after a Task has already finished. */
export async function recordDelayedBackground(f: Awaited<ReturnType<typeof consoleExperienceFixture>>) {
  const ledger = new WorkLedger(f.server.config.stateDir);
  try {
    assert.ok(f.historicalBackgroundOperationId);
    const task = ledger.db.prepare('SELECT * FROM qm_tasks WHERE id=?').get(f.completed.task_id) as { state: string };
    assert.equal(task.state, 'closed');
    // Load the saved historical observation of an existing operation. Closed
    // Tasks cannot create new work, and their completion evidence stays intact.
    const changed = ledger.db.prepare(`UPDATE console_operations SET status='running',finished_at=NULL,observed_at=?
      WHERE id=? AND run_id IN (SELECT run_id FROM qm_run_links WHERE task_id=?)`)
      .run(new Date().toISOString(), f.historicalBackgroundOperationId, f.completed.task_id);
    assert.equal(changed.changes, 1);
    assert.deepEqual(ledger.db.prepare('SELECT * FROM qm_tasks WHERE id=?').get(f.completed.task_id), task);
  } finally { ledger.close(); }
  await f.get('runs?days=0&fresh=1');
}
