import assert from 'node:assert/strict';
import test from 'node:test';
import { EXECUTION_OBSERVATION_TTL_MS, mergeExecutionObservations, sameExecutionObservation, type ExecutionObservation } from './execution-observation.js';

const now = 1_800_000_000_000;
const idle = (observedAt: number): ExecutionObservation => ({observedAt, activeOperationIds: [], preparingOperationIds: [], staleOperationIds: []});

test('空闲观测同样过期，重复读取不能改写来源确认时间', () => {
  const original = idle(now - EXECUTION_OBSERVATION_TTL_MS - 1);
  const merged = mergeExecutionObservations([original], now);
  assert.equal(merged.stale, true);
  assert.equal(merged.observedAt, original.observedAt);
  assert.equal(mergeExecutionObservations([merged], now + 60_000).observedAt, original.observedAt);
  assert.deepEqual(merged.activeOperationIds, []);
  assert.deepEqual(merged.staleOperationIds, []);
});

test('旧空闲成员不使其他成员的新鲜执行过期，二次合并保持结果', () => {
  const merged = mergeExecutionObservations([
    idle(now - 10 * 60_000),
    {...idle(now - 5_000), activeOperationIds: ['active'], preparingOperationIds: ['queued']},
  ], now);
  assert.equal(merged.stale, true);
  assert.equal(merged.observedAt, now - 5_000);
  assert.deepEqual(merged.activeOperationIds, ['active']);
  assert.deepEqual(merged.preparingOperationIds, ['queued']);
  assert.deepEqual(mergeExecutionObservations([merged], now + 1_000), merged);
  const expired = mergeExecutionObservations([merged], now + EXECUTION_OBSERVATION_TTL_MS);
  assert.deepEqual(expired.activeOperationIds, []);
  assert.deepEqual(expired.preparingOperationIds, []);
  assert.deepEqual(expired.staleOperationIds, ['active', 'queued']);
});

test('新鲜观测保留真实时间，成员恢复后清除待确认标记', () => {
  const fresh = mergeExecutionObservations([idle(now - 3_000), idle(now - 1_000)], now);
  assert.equal(fresh.observedAt, now - 3_000);
  assert.equal(fresh.stale, false);
  const stale = {...fresh, stale: true};
  assert.equal(sameExecutionObservation(stale, fresh), false);
  assert.equal(sameExecutionObservation(fresh, {...fresh, observedAt: now}), true);
  assert.equal(sameExecutionObservation(idle(now), fresh), true);
});

test('最新来源可确认旧来源的同一命令，空闲缺失仍独立保留', () => {
  const merged = mergeExecutionObservations([
    {...idle(now - 40_000), activeOperationIds: ['same', 'old']},
    {...idle(now), activeOperationIds: ['same']},
  ], now);
  assert.deepEqual(merged.activeOperationIds, ['same']);
  assert.deepEqual(merged.staleOperationIds, ['old']);
  assert.equal(merged.stale, true);
  assert.equal(merged.observedAt, now);
});

test('不同节点的运行和排队各自过期，连续聚合不借用最旧成员时间', () => {
  const initial = mergeExecutionObservations([
    {...idle(now - 20_000), activeOperationIds: ['older-active'], preparingOperationIds: ['older-queued']},
    {...idle(now), activeOperationIds: ['new-active'], preparingOperationIds: ['new-queued']},
  ], now);
  assert.equal(initial.observedAt, now - 20_000);
  const later = mergeExecutionObservations([initial], now + 11_000);
  assert.deepEqual(later.activeOperationIds, ['new-active']);
  assert.deepEqual(later.preparingOperationIds, ['new-queued']);
  assert.deepEqual(later.staleOperationIds, ['older-active', 'older-queued']);
  assert.equal(later.operationObservedAt?.['new-active'], now);
  assert.equal(later.operationObservedAt?.['older-active'], now - 20_000);
  const expired = mergeExecutionObservations([later], now + 31_000);
  assert.deepEqual(expired.activeOperationIds, []);
  assert.deepEqual(expired.preparingOperationIds, []);
  assert.deepEqual(expired.staleOperationIds, ['new-active', 'new-queued', 'older-active', 'older-queued']);
  assert.equal(expired.operationObservedAt?.['new-active'], now);
  assert.equal(mergeExecutionObservations([expired], now + 90_000).operationObservedAt?.['new-active'], now);
});

test('近期失联的空闲成员不缩短新鲜运行的有效期', () => {
  const initial = mergeExecutionObservations([
    {...idle(now - 20_000), stale: true},
    {...idle(now), activeOperationIds: ['active']},
  ], now);
  const later = mergeExecutionObservations([initial], now + 11_000);
  assert.deepEqual(later.activeOperationIds, ['active']);
  assert.deepEqual(later.staleOperationIds, []);
  assert.equal(later.operationObservedAt?.active, now);
  assert.equal(later.stale, true);
});

test('每条操作确认时间更新不单独重绘，更新后的时间决定有效期', () => {
  const earlier = mergeExecutionObservations([{...idle(now - 20_000), activeOperationIds: ['active']}], now);
  const latest = mergeExecutionObservations([earlier, {...idle(now), activeOperationIds: ['active']}], now);
  assert.equal(latest.operationObservedAt?.active, now);
  assert.equal(sameExecutionObservation(earlier, latest), true);
  assert.deepEqual(mergeExecutionObservations([latest], now + 11_000).activeOperationIds, ['active']);
  assert.equal(mergeExecutionObservations([{...idle(now), staleOperationIds: ['unknown']}], now).operationObservedAt, undefined);
});
