import assert from 'node:assert/strict';
import test from 'node:test';
import { filterRuns } from './query.js';
import { aggregateTaskIndex, filterTaskIndex } from './task-aggregation.js';
import type { Run } from './types.js';

const now = 1_800_000_000_000;
function run(id: string, requestState: string | undefined, executionStatus: string, old = true): Run {
  return { id, localId: id, title: id, nodeId: 'local', projectId: 'project', projectLocalId: 'project',
    projectName: 'project', root: '/project', executionStatus, requestState,
    resultStatus: requestState === 'closed' ? 'completed' : null, acceptanceStatus: 'not_required',
    startedAt: now - (old ? 15 * 86_400_000 : 1000), finishedAt: requestState === 'closed' ? now - 500 : null,
    lastActivityAt: now - 500, revision: 1, workspaceRevision: 1, sessionId: 'legacy-storage', taskId: id,
    memberId: 'member', usage: { total: 0, input: 0, cached: 0, output: 0, reasoning: 0, quality: 'not_used' },
    diff: null, origin: 'chatgpt_mcp', branch: null, baseSha: null, command: null, agent: null, reason: null,
    warnings: [], currentPhase: true,
    actions: { interrupt: false, resume: false, review: false, revert: false, complete: false } };
}
const runs = [run('open-idle', 'active', 'waiting'), run('open-failed', 'active', 'failed'),
  run('open-phase-complete', 'active', 'completed'), run('closed-background', 'closed', 'running'),
  run('closed-result', 'closed', 'completed', false), run('legacy', undefined, 'completed', false)];
const index = aggregateTaskIndex(runs.map(value => ({ ...value, tokens: 0, changed: false,
  currentPhase: true, actionableInterruption: false })), now);
const identities = (values: Array<{ taskId: string | null }>) => values.map(value => value.taskId).sort();

test('JS and aggregated Task filters use lifecycle, independently of execution', () => {
  for (const requestState of ['active', 'closed']) {
    const expected = identities(runs.filter(value => value.requestState === requestState));
    const query = { requestState, days: '0' };
    assert.deepEqual(identities(filterRuns(runs, query, now)), expected);
    assert.deepEqual(identities(filterTaskIndex(index, query, now)), expected);
  }
  const execution = { stage: 'running,stopping,queued', days: '0' };
  assert.deepEqual(identities(filterRuns(runs, execution, now)), ['closed-background']);
  assert.deepEqual(identities(filterTaskIndex(index, execution, now)), ['closed-background']);
  assert.deepEqual(filterTaskIndex(index, { ...execution, requestState: 'active' }, now), []);
});

test('open Tasks remain in the default seven-day view after an old execution phase completes', () => {
  for (const values of [filterRuns(runs, { requestState: 'active' }, now),
    filterTaskIndex(index, { requestState: 'active' }, now)]) {
    assert.deepEqual(identities(values), ['open-failed', 'open-idle', 'open-phase-complete']);
  }
  const oldClosed = run('old-closed', 'closed', 'completed');
  assert.deepEqual(filterRuns([oldClosed], { requestState: 'closed' }, now), []);
  assert.equal(filterRuns(runs, { days: '0' }, now).some(value => value.taskId === 'legacy'), true);
  assert.equal(filterTaskIndex(index, { requestState: 'active', date: '2000-01-01' }, now).length, 0,
    'an explicit date filter still restricts open Tasks');
});
