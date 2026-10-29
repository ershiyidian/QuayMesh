import assert from "node:assert/strict";
import test from "node:test";
import { createPendingMessageState, PENDING_MESSAGE_NAMESPACE, type PendingTaskMessage } from "./pending-message-state.js";

const pending: PendingTaskMessage = { taskId: "task-a", key: "stable-message-key", body: "先核对原始日志。\n再讨论修改。" };
function fixture(initial: unknown = {}) {
  let value = initial, writes = 0;
  const host = {
    get widgetState() { return value; },
    setWidgetState(next: unknown) { assert.equal(this, host); value = next; writes++; },
  };
  const store = createPendingMessageState(() => host);
  return { store, host, value: () => value as Record<string, any>, writes: () => writes, replace(next: unknown) { value = next; } };
}

test("the optional adapter stores only bounded pending input under privateContent and preserves other widget state", () => {
  const original = { modelContent: { selected: "unchanged" }, imageIds: [], topLevel: "preserved",
    privateContent: { otherWidget: { expanded: true } } };
  const f = fixture(original);
  assert.equal(f.store.save(pending), true);
  assert.equal(f.writes(), 1);
  assert.deepEqual(f.value().modelContent, original.modelContent);
  assert.deepEqual(f.value().imageIds, original.imageIds);
  assert.deepEqual(f.value().privateContent.otherWidget, original.privateContent.otherWidget);
  assert.equal(f.value().topLevel, "preserved");
  assert.equal(JSON.stringify(f.value().modelContent).includes(pending.body), false);
  assert.equal(Object.hasOwn(original.privateContent, PENDING_MESSAGE_NAMESPACE), false, "saving never mutates the host's old snapshot");
  assert.deepEqual(f.store.load("task-a"), pending);
  const read = f.store.load("task-a")!; read.body = "changed locally";
  assert.deepEqual(f.store.load("task-a"), pending, "restored state is a copy of known fields");
  assert.equal(f.store.clear(pending), true);
  assert.deepEqual(f.value(), original);
  assert.equal(f.store.load("task-a"), null);
});

test("another Task or mismatched receipt cannot replace or erase the visible pending intent", () => {
  const f = fixture();
  f.store.save(pending);
  const before = f.value(), writes = f.writes();
  assert.equal(f.store.load("task-b"), null);
  assert.equal(f.store.clear({ ...pending, taskId: "task-b" }), false);
  assert.equal(f.store.clear({ ...pending, body: "different body under the same key" }), false);
  assert.equal(f.store.save({ taskId: "task-b", key: "other-task-key", body: "另一目标的消息" }), false);
  assert.equal(f.value(), before); assert.equal(f.writes(), writes);
  const newer = { ...pending, key: "newer-key", body: "另一次明确发送" };
  f.store.save(newer);
  assert.equal(f.store.clear(pending), false);
  assert.deepEqual(f.store.load("task-a"), newer);
  assert.equal(f.store.clear(newer), true);
});

test("unsupported or throwing host capabilities degrade to no persistence without escaping errors", () => {
  const hosts: Array<() => unknown> = [
    () => undefined, () => null, () => ({}), () => ({ widgetState: {}, setWidgetState: 42 }),
    () => { throw new Error("HOST_GLOBAL_UNAVAILABLE"); },
    () => ({ get widgetState() { throw new Error("HOST_STATE_UNAVAILABLE"); }, setWidgetState() {} }),
    () => ({ widgetState: {}, setWidgetState() { throw new Error("HOST_STATE_WRITE_FAILED"); } }),
  ];
  for (const host of hosts) {
    const store = createPendingMessageState(host);
    assert.equal(store.load("task-a"), null);
    assert.equal(store.save(pending), false);
    assert.equal(store.clear(pending), false);
  }
});

test("malformed, future-version, wrong-Task and oversized recovery records are ignored", () => {
  const invalid: unknown[] = [null, [], "text", {}, { version: 2, ...pending },
    { version: 1, ...pending, taskId: "task-b" }, { version: 1, ...pending, taskId: "x".repeat(257) },
    { version: 1, ...pending, key: "" }, { version: 1, ...pending, key: "x".repeat(129) },
    { version: 1, ...pending, body: 42 }, { version: 1, ...pending, body: " " },
    { version: 1, ...pending, body: "x".repeat(16_385) },
    { version: 1, ...pending, body: "中".repeat(6000) },
    { version: 1, ...pending, body: "\\".repeat(9000) },
    { version: 1, ...pending, get body() { throw new Error("UNREADABLE_VALUE"); } },
  ];
  for (const value of invalid) {
    const f = fixture({ privateContent: { [PENDING_MESSAGE_NAMESPACE]: value } });
    assert.equal(f.store.load("task-a"), null);
    assert.equal(f.store.save(pending), false);
    assert.equal(f.store.clear(pending), false);
    assert.equal(f.writes(), 0, "an unreadable or foreign pending record is left intact");
  }
});

test("oversized or non-JSON widget snapshots do not cause a destructive truncated write", () => {
  const circular: Record<string, unknown> = {}; circular.self = circular;
  for (const state of ["text", [], { privateContent: "other state" }, { privateContent: [] },
    { modelContent: "x".repeat(65_536), privateContent: { preserve: true } }, circular,
    { toJSON() { return undefined; } }]) {
    const f = fixture(state);
    assert.equal(f.store.save(pending), false);
    assert.equal(f.value(), state);
    assert.equal(f.writes(), 0);
  }
  const f = fixture({ privateContent: { preserve: true } });
  assert.equal(f.store.save({ ...pending, body: "\\".repeat(9000) }), false);
  assert.equal(f.writes(), 0);
});

test("clearing merges unrelated fields only when the visible record matches completely", () => {
  const f = fixture({ privateContent: { other: 1 } });
  f.store.save(pending);
  f.replace({ ...f.value(), privateContent: { ...f.value().privateContent, other: 2 } });
  f.store.clear(pending);
  assert.deepEqual(f.value().privateContent, { other: 2 });

});

test("an old iframe with an empty getter never clears a newer cached record", () => {
  const newer = { version: 1, ...pending, key: "newer-key", body: "另一份待确认消息" };
  const actual = { privateContent: { other: 3, [PENDING_MESSAGE_NAMESPACE]: newer } };
  let durable: unknown = actual, writes = 0;
  const host = {
    widgetState: { privateContent: { other: 3 } },
    setWidgetState(next: unknown) { durable = next; writes++; },
  };
  const store = createPendingMessageState(() => host);
  assert.equal(store.clear(pending), false);
  assert.equal(writes, 0, "no visible matching record means no host write");
  assert.equal(durable, actual);
});
