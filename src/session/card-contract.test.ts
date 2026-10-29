import assert from 'node:assert/strict';
import test from 'node:test';
import * as z from 'zod/v4';
import { commandSchema, snapshotSchema } from './schema.js';
import { ExecutionState, HostState, ReviewState, type Snapshot } from './types.js';
import {
  CARD_RESOURCES, PREVIOUS_WORKSPACE_APP_URI, WORKSPACE_APP_URI, WORKSPACE_APP_VERSION,
  projectionForCard, snapshotForCard,
} from './card-contract.js';

// A cached pre-reconciliation reader still rejects extra keys in nested commands,
// even though its top-level Snapshot reader strips unknown display fields.
const oldCommandSchema = commandSchema.omit({ invocation_id: true, effect: true }).strict();
const oldReader = snapshotSchema.extend({
  commands: z.array(oldCommandSchema),
  currentCommand: oldCommandSchema.nullable().optional(),
  runningCommand: oldCommandSchema.nullable().optional(),
  lastCommand: oldCommandSchema.nullable().optional(),
}).strip();

function fixture(): Snapshot {
  const command: Snapshot['commands'][number] = {
    id: 'op-a', operation_id: 'op-a', invocation_id: 'inv-a', effect: 'completed',
    member_id: 'member-a', cmd: 'verify', agent: 'host', status: 'ok',
    startedAt: 100, endedAt: 200, exitCode: 0, signal: null, attempt: 1,
    supersededBy: null, summary: null, output_ref: 'op-a', output_available: true,
  };
  return {
    sessionId: 'storage-a', taskId: 'task-a', sourceTaskId: 'source-task', taskState: 'active',
    rev: 3, title: 'Task', status: 'running',
    execution_status: ExecutionState.active, review_status: ReviewState.unknown, host_status: HostState.connected,
    startedAt: 100, endedAt: null, observedAt: 200, consoleUrl: null,
    workspace: null, workspaces: [], files: [], commands: [command], agents: [], instructions: [], skills: [],
    totals: { files: 0, commands: 1, agents: 0 }, cursors: { files: null, commands: null, agents: null },
    capabilities: { refresh: true, revert: false, continue: true, open_file: false }, notices: [],
    currentCommand: command,
    runningCommand: { ...command, id: 'op-running', operation_id: 'op-running', invocation_id: 'inv-running',
      status: 'run', effect: 'started', endedAt: null, exitCode: null },
    lastCommand: command,
    executionObservation: { observedAt: 200, activeOperationIds: ['op-running'], preparingOperationIds: [],
      staleOperationIds: ['op-stale'], stale: true, operationObservedAt: { 'op-running': 200, 'op-stale': 100 } },
    live: { observedAt: 200, hostStatus: HostState.connected, executionStatus: ExecutionState.active },
    finalization: { state: 'pending', requestedAt: 190, error: null },
  };
}

function assertPrivateIdentityAbsent(snapshot: Snapshot): void {
  const commands = [...snapshot.commands, snapshot.currentCommand, snapshot.runningCommand, snapshot.lastCommand];
  for (const command of commands) {
    if (!command) continue;
    assert.equal(Object.hasOwn(command, 'invocation_id'), false);
    assert.equal(Object.hasOwn(command, 'effect'), false);
  }
  assert.doesNotThrow(() => oldReader.parse(snapshot));
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

test('new cards use v10 while every actually published historical resource stays registered', () => {
  assert.equal(WORKSPACE_APP_VERSION, 'task-card-v10');
  assert.equal(WORKSPACE_APP_URI, 'ui://quaymesh/task-card/v10.html');
  assert.equal(PREVIOUS_WORKSPACE_APP_URI, 'ui://quaymesh/task-card/v9.html');
  assert.deepEqual(CARD_RESOURCES.map(item => item.version),
    [1, 3, 4, 5, 6, 7, 8, 9, 10].map(version => `task-card-v${version}`));
  assert.equal(new Set(CARD_RESOURCES.map(item => item.uri)).size, CARD_RESOURCES.length);
  for (const version of [1, 3, 4, 5, 6, 7, 8, 9, 10]) {
    assert.ok(CARD_RESOURCES.some(item => item.uri === `ui://quaymesh/task-card/v${version}.html`));
  }
});

test('all card versions strip private attempt evidence from command arrays and every alias', () => {
  const internal = fixture();
  assert.equal(oldReader.safeParse(internal).success, false, 'the fixture must reproduce the old strict-reader failure');
  for (const version of [undefined, 'unknown-card', ...CARD_RESOURCES.map(item => item.version)]) {
    assertPrivateIdentityAbsent(snapshotForCard(internal, version));
  }
});

test('card serialization preserves the original evidence and persisted Snapshot objects', () => {
  const internal = freezeDeep(fixture());
  const before = structuredClone(internal);
  for (const version of [undefined, ...CARD_RESOURCES.map(item => item.version)]) {
    const view = snapshotForCard(internal, version);
    assertPrivateIdentityAbsent(view);
    assert.notEqual(view.commands[0], internal.commands[0]);
  }
  assert.deepEqual(internal, before);
  assert.equal(internal.commands[0].invocation_id, 'inv-a');
  assert.equal(internal.runningCommand?.effect, 'started');
});

test('v8, v9 and v10 retain the live and stale-observation fields already understood by v8', () => {
  const internal = fixture();
  for (const version of ['task-card-v8', 'task-card-v9', 'task-card-v10']) {
    const view = snapshotForCard(internal, version);
    assert.deepEqual(view.executionObservation, internal.executionObservation);
    assert.deepEqual(view.live, internal.live);
    assert.deepEqual(view.finalization, internal.finalization);
    assert.equal(view.sourceTaskId, internal.sourceTaskId);
    assertPrivateIdentityAbsent(view);
  }
});

test('v10 preserves the v9 wire shape with and without explicit file-time negotiation', () => {
  const snapshot = fixture();
  snapshot.files = [{ id: 'file-a', member_id: 'member-a', status: 'M', path: 'file.txt', from: null,
    additions: 1, removals: 0, hash: 'hash-a', large: false, binary: false,
    coverage: 'session_owned', revertible: false, recordedAt: 150 }];
  const result = { unchanged: false, rev: snapshot.rev, snapshot,
    observation: snapshot.executionObservation, live: snapshot.live };
  for (const fileRecordedAt of [false, true]) {
    assert.deepEqual(snapshotForCard(snapshot, 'task-card-v10', fileRecordedAt),
      snapshotForCard(snapshot, 'task-card-v9', fileRecordedAt));
    assert.deepEqual(projectionForCard(result, 'task-card-v10', fileRecordedAt),
      projectionForCard(result, 'task-card-v9', fileRecordedAt));
  }
});

test('v7, v6 and older versions retain their original observation downgrade behavior', () => {
  const internal = fixture();
  for (const version of ['task-card-v7', 'task-card-v6']) {
    const view = snapshotForCard(internal, version);
    assert.equal(view.executionObservation?.stale, undefined);
    assert.equal(view.executionObservation?.operationObservedAt, undefined);
    assert.deepEqual(view.executionObservation?.activeOperationIds, ['op-running']);
    assert.equal(view.sourceTaskId, internal.sourceTaskId);
    assert.equal(Object.hasOwn(view, 'live'), version === 'task-card-v7');
    assert.equal(Object.hasOwn(view, 'finalization'), version === 'task-card-v7');
  }
  for (const version of [undefined, 'task-card-v1', 'task-card-v3', 'task-card-v4', 'task-card-v5']) {
    const view = snapshotForCard(internal, version);
    for (const field of ['live', 'finalization', 'executionObservation', 'sourceTaskId']) {
      assert.equal(Object.hasOwn(view, field), false, `${version ?? 'initial metadata'}: ${field}`);
    }
  }
});

test('qm_session projection envelopes use the same public boundary, including current-version replies', () => {
  const snapshot = freezeDeep(fixture());
  const result = freezeDeep({ unchanged: false, rev: snapshot.rev, snapshot,
    observation: snapshot.executionObservation, live: snapshot.live });
  const before = structuredClone(result);
  for (const version of [undefined, ...CARD_RESOURCES.map(item => item.version)]) {
    const reply = projectionForCard(result, version);
    assertPrivateIdentityAbsent(reply.snapshot);
    if (version === 'task-card-v8' || version === 'task-card-v9' || version === 'task-card-v10') {
      assert.deepEqual(reply.observation, result.observation);
      assert.deepEqual(reply.live, result.live);
    } else if (version === 'task-card-v6' || version === 'task-card-v7') {
      assert.equal(reply.observation?.stale, undefined);
      assert.equal(reply.observation?.operationObservedAt, undefined);
      assert.equal(Object.hasOwn(reply, 'live'), version === 'task-card-v7');
    } else {
      assert.equal(Object.hasOwn(reply, 'observation'), false);
      assert.equal(Object.hasOwn(reply, 'live'), false);
    }
  }
  assert.deepEqual(result, before);
});

test('unchanged replies and absent command aliases preserve the documented shape', () => {
  const snapshot = fixture();
  const unchanged = { unchanged: true, rev: snapshot.rev, observation: snapshot.executionObservation, live: snapshot.live };
  for (const version of ['task-card-v8', 'task-card-v9', 'task-card-v10']) {
    assert.deepEqual(projectionForCard(unchanged, version), unchanged);
  }
  const input = { ...snapshot, commands: [], currentCommand: null, runningCommand: undefined, lastCommand: null };
  const view = snapshotForCard(input, WORKSPACE_APP_VERSION);
  assert.deepEqual(view.commands, []);
  assert.equal(view.currentCommand, null);
  assert.equal(view.runningCommand, undefined);
  assert.equal(view.lastCommand, null);
  assertPrivateIdentityAbsent(view);
});
