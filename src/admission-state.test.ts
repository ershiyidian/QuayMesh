import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import Database from "better-sqlite3";
import { changeAdmission, isAdmissionPrecondition, readAdmissionState, sameAdmissionInstance } from "./admission-state.js";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "qm-admission-cas-"));
  const file = join(root, "admission.sqlite");
  const first = new Database(file);
  first.exec(`CREATE TABLE qm_runtime_admission(
    id INTEGER PRIMARY KEY CHECK(id=1), accepting INTEGER NOT NULL,
    reason TEXT, changed_at TEXT NOT NULL);
    INSERT INTO qm_runtime_admission VALUES(1,1,NULL,'2026-01-01T00:00:00.000Z');`);
  const second = new Database(file);
  t.after(() => { second.close(); first.close(); rmSync(root, { recursive: true, force: true }); });
  return { first, second };
}

test("independent SQLite connections cannot both acquire the same admission version", t => {
  const { first, second } = fixture(t);
  const firstRead = readAdmissionState(first), secondRead = readAdmissionState(second);
  const acquired = changeAdmission(first, { accepting: false, reason: "release-preflight:first" }, firstRead);
  assert.equal(acquired.changed, true);
  const before = second.prepare("SELECT total_changes()").pluck().get();
  const rejected = changeAdmission(second, { accepting: false, reason: "release-preflight:second" }, secondRead);
  assert.equal(rejected.changed, false);
  assert.deepEqual(rejected.state, acquired.state);
  assert.equal(second.prepare("SELECT total_changes()").pluck().get(), before);
  assert.deepEqual(readAdmissionState(first), acquired.state);
});

test("each admission ownership field must match and stale resumes never write", t => {
  const { first } = fixture(t);
  const owned = changeAdmission(first, { accepting: false, reason: "owned-pause" }).state;
  const before = first.prepare("SELECT total_changes()").pluck().get();
  for (const expected of [
    { ...owned, accepting: true },
    { ...owned, reason: "another-pause" },
    { ...owned, changedAt: "2025-01-01T00:00:00.000Z" },
  ]) {
    assert.equal(changeAdmission(first, { accepting: true, reason: null }, expected).changed, false);
    assert.deepEqual(readAdmissionState(first), owned);
  }
  assert.equal(first.prepare("SELECT total_changes()").pluck().get(), before);
  const released = changeAdmission(first, { accepting: true, reason: null }, owned);
  assert.equal(released.changed, true);
  assert.equal(released.state.accepting, true);
  assert.equal(released.state.reason, null);
});

test("legacy writes advance the version across equal pauses, clock regression and ABA", t => {
  const { first } = fixture(t);
  // An existing timestamp in the future exercises clock regression without
  // changing the process clock or relying on sub-millisecond test timing.
  const future = new Date(Date.now() + 86_400_000).toISOString();
  first.prepare("UPDATE qm_runtime_admission SET changed_at=? WHERE id=1").run(future);
  const original = changeAdmission(first, { accepting: false, reason: "same-reason" }).state;
  const repeated = changeAdmission(first, { accepting: false, reason: "same-reason" }).state;
  changeAdmission(first, { accepting: true, reason: null });
  const latest = changeAdmission(first, { accepting: false, reason: "same-reason" }).state;
  assert.ok(Date.parse(original.changedAt) > Date.parse(future));
  assert.ok(Date.parse(repeated.changedAt) > Date.parse(original.changedAt));
  assert.ok(Date.parse(latest.changedAt) > Date.parse(repeated.changedAt));
  assert.equal(changeAdmission(first, { accepting: true, reason: null }, original).changed, false);
  assert.deepEqual(readAdmissionState(first), latest);
});

test("admission updates remain part of an existing transaction and roll back with it", t => {
  const { first, second } = fixture(t), before = readAdmissionState(first);
  assert.throws(() => first.transaction(() => {
    assert.equal(changeAdmission(first, { accepting: false, reason: "uncommitted" }, before).changed, true);
    assert.deepEqual(readAdmissionState(second), before);
    throw new Error("fixture rollback");
  }).immediate(), /fixture rollback/);
  assert.deepEqual(readAdmissionState(first), before);
});

test("conditional requests require all state fields and all Core generation fields", () => {
  const instance = { pid: 123, processStart: "linux:boot:100", token: "core-generation" };
  const valid = { instance, accepting: false, reason: "owned", changedAt: "2026-10-23T00:00:00.000Z" };
  assert.equal(isAdmissionPrecondition(valid), true);
  assert.equal(isAdmissionPrecondition({ ...valid, instance: { ...instance, processStart: null } }), true);
  for (const invalid of [undefined, null, [], {}, { ...valid, accepting: 0 },
    { ...valid, reason: undefined }, { ...valid, changedAt: "" },
    { ...valid, instance: null }, { ...valid, instance: { ...instance, pid: 0 } },
    { ...valid, instance: { ...instance, processStart: undefined } },
    { ...valid, instance: { ...instance, token: "" } }]) assert.equal(isAdmissionPrecondition(invalid), false);
  assert.equal(sameAdmissionInstance(instance, { ...instance }), true);
  for (const stale of [{ ...instance, pid: 124 }, { ...instance, processStart: "linux:boot:101" },
    { ...instance, token: "retired-core" }]) assert.equal(sameAdmissionInstance(instance, stale), false);
});
