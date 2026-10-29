import assert from 'node:assert/strict';
import test from 'node:test';
import { taskLifecycleFixture } from './task-lifecycle-fixture.js';
import { readLocalPage } from '../../src/console-workbench/local-queries.js';
import type { RunPage } from '../../src/ui/console-v5/contracts.js';

test('real Console lifecycle filtering preserves open failed work, closed background work and facet counts', { timeout: 90_000 }, async t => {
  const f = await taskLifecycleFixture();
  t.after(() => f.server.dispose());
  const openIds = [String(f.waiting.task_id), String(f.failed.task_id)].sort();
  const closedIds = [String(f.old.task_id), String(f.completed.task_id)].sort();
  const ids = (page: RunPage) => [...new Set(page.items.map(run => run.taskId))].sort();
  const all = await f.get('runs?days=0') as RunPage;
  assert.equal(all.total, 4);
  assert.deepEqual([all.counts.scopeAll, all.counts.scopeOpen, all.counts.scopeClosed, all.counts.scopeActive], [4, 2, 2, 1]);
  for (const [state, expected] of [['active', openIds], ['closed', closedIds]] as const) {
    const page = await f.get('runs?days=0&requestState=' + state) as RunPage;
    assert.deepEqual(ids(page), expected);
    assert.deepEqual([page.counts.scopeAll, page.counts.scopeOpen, page.counts.scopeClosed], [4, 2, 2]);
    assert.equal(page.items.every(run => run.requestState === state), true);
  }
  const active = await f.get('runs?requestState=active') as RunPage;
  assert.deepEqual(ids(active), openIds, 'open goals remain visible beyond the default seven days');
  assert.equal(active.items.find(run => run.taskId === f.failed.task_id)?.executionStatus, 'failed');
  assert.equal(active.items.find(run => run.taskId === f.waiting.task_id)?.executionStatus, 'waiting');
  const background = await f.get('runs?days=0&stage=running,stopping,queued') as RunPage;
  assert.deepEqual(ids(background), [f.completed.task_id]);
  assert.equal(background.items[0].requestState, 'closed');
  assert.equal(background.items[0].resultStatus, 'completed');
  const detail = await f.get('runs/' + encodeURIComponent('qmtask:' + f.failed.task_id) + '?fresh=1');
  assert.equal(detail.commands.some((command: { exit: number | null }) => command.exit === 7), true,
    'the failed execution is a real temporary process with its exit receipt');

  // This exercises the independent SQL phase query, not only the fleet's JS filter.
  const localOpen = readLocalPage(f.server.config, { days: '7', requestState: 'active', limit: '100' });
  assert.deepEqual([...new Set(localOpen.items.map(run => run.taskId))].sort(), openIds);
  const localClosed = readLocalPage(f.server.config, { days: '0', requestState: 'closed', limit: '100' });
  assert.deepEqual([...new Set(localClosed.items.map(run => run.taskId))].sort(), closedIds);

  const invalid = await fetch(f.server.baseUrl + '/console/api/v4/runs?requestState=running', { headers: { cookie: f.cookie } });
  assert.equal(invalid.status, 422, 'execution names are not accepted as Task lifecycle values');
  assert.equal((await invalid.json() as { code: string }).code, 'invalid_input');
});

test('real Task pagination keeps lifecycle facets stable and rejects a cursor from another lifecycle scope', { timeout: 90_000 }, async t => {
  const f = await taskLifecycleFixture();
  t.after(() => f.server.dispose());
  const first = await f.get('runs?requestState=active&limit=1') as RunPage;
  assert.equal(first.total, 2);
  assert.ok(first.nextCursor);
  const second = await f.get('runs?requestState=active&limit=1&cursor=' + encodeURIComponent(first.nextCursor)) as RunPage;
  assert.equal(second.nextCursor, null);
  assert.deepEqual([first.counts.scopeOpen, first.counts.scopeClosed, second.counts.scopeOpen, second.counts.scopeClosed], [2, 2, 2, 2]);
  assert.deepEqual([first.items[0].taskId, second.items[0].taskId].sort(), [f.waiting.task_id, f.failed.task_id].sort());
  const changed = await fetch(f.server.baseUrl + '/console/api/v4/runs?requestState=closed&limit=1&cursor=' + encodeURIComponent(first.nextCursor),
    { headers: { cookie: f.cookie } });
  assert.equal(changed.status, 409);
  assert.equal((await changed.json() as { code: string }).code, 'cursor_expired');
});
