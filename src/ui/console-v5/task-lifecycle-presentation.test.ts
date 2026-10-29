import assert from 'node:assert/strict';
import test from 'node:test';
import { lifecycleBadges } from './presentation.js';
import type { Run } from './contracts.js';

type State = Pick<Run, 'requestState' | 'resultStatus' | 'executionStatus' | 'phaseExecutionStatus' | 'acceptanceStatus' | 'finalization'>;
const open = (executionStatus: string): State => ({ requestState: 'active', resultStatus: null,
  executionStatus, acceptanceStatus: 'not_required' });
const plain = (html: string) => html.replace(/<[^>]+>/g, '');
const primary = (html: string) => plain(html.match(/^<span class="state [^"]+">.*?<\/span>/s)?.[0] ?? '');

test('Task lifecycle stays primary while execution facts and freshness stay separate', () => {
  for (const [execution, secondary] of [
    ['waiting', '当前无后台执行'], ['running', '后台执行中'], ['failed', '最近执行失败'],
    ['unknown', '后台执行结果待核对'], ['stalled', '长时间无新执行记录'],
  ]) {
    const html = lifecycleBadges(open(execution), { stale: true, observedAt: 1_800_000_000_000 });
    assert.equal(primary(html), '任务进行中', execution);
    assert.match(html, /^<span class="state active">/);
    assert.ok(plain(html).includes(secondary), execution);
    assert.ok(plain(html).includes('上次确认'), execution);
  }
});

test('a closed result remains primary even with live or unknown background execution', () => {
  for (const [executionStatus, secondary] of [['running', '后台仍在执行'], ['unknown', '后台执行结果待核对']]) {
    const html = lifecycleBadges({ ...open(executionStatus), requestState: 'closed', resultStatus: 'completed' });
    assert.equal(primary(html), '已完成');
    assert.ok(plain(html).includes(secondary));
    assert.doesNotMatch(html, /state active/);
  }
  assert.equal(primary(lifecycleBadges({ ...open('waiting'), requestState: 'closed' })), '已结束 · 交付未确认');
});

test('finalization and acceptance retain their independent evidence', () => {
  for (const [status, label] of [['pending', '交付确认中'], ['failed', '交付确认失败']] as const) {
    const html = lifecycleBadges({ ...open('running'), finalization: { status, requestedAt: 1,
      error: status === 'failed' ? 'result verification failed' : null } });
    assert.equal(primary(html), label);
    assert.ok(plain(html).includes('后台执行中'));
    assert.equal(plain(html).split(label).length, 2, 'finalization is not rendered twice');
  }
  const review = lifecycleBadges({ ...open('waiting'), phaseExecutionStatus: 'completed', acceptanceStatus: 'pending' });
  assert.equal(primary(review), '任务进行中');
  assert.ok(plain(review).includes('结果待验收'));
  assert.ok(plain(review).includes('执行阶段已结束'));
  for (const [acceptanceStatus, label] of [['pending', '待验收'], ['accepted', '已验收'], ['rejected', '已驳回']]) {
    const completed = lifecycleBadges({ ...open('completed'), acceptanceStatus });
    assert.equal(primary(completed), '任务进行中');
    assert.ok(plain(completed).includes(label), 'replacing the primary execution badge must retain its acceptance evidence');
  }
});

test('legacy records without a saved Task lifecycle retain their known execution state', () => {
  const html = lifecycleBadges({ executionStatus: 'waiting', acceptanceStatus: 'not_required' });
  assert.equal(primary(html), '当前无后台执行');
  assert.doesNotMatch(html, /任务进行中/);
});
