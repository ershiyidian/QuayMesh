import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import Database from "better-sqlite3";
import { taskBindingSchema } from "../db/task-binding-schema.js";
import { TaskBindingStore, taskExecutionEntryFromAuthInfo, type TaskExecutionEntry } from "./task-binding.js";

const entry = (correlation: string, owner = "owner", clientId = "client") => taskExecutionEntryFromAuthInfo(
  { clientId, extra: { owner_id: owner } }, correlation);

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "qm-task-bindings-"));
  const filename = join(directory, "test.sqlite"), db = new Database(filename);
  db.pragma("journal_mode=WAL"); db.pragma("foreign_keys=ON"); db.pragma("busy_timeout=0");
  db.exec(`CREATE TABLE qm_sessions(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,current_task_id TEXT);
    CREATE TABLE qm_tasks(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES qm_sessions(id),state TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0,title TEXT NOT NULL DEFAULT 'Fixture goal');
    CREATE TABLE qm_task_finalizations(task_id TEXT PRIMARY KEY REFERENCES qm_tasks(id),completed_at TEXT,error TEXT,finalization_revision INTEGER NOT NULL DEFAULT 0,recovery_state TEXT);
    INSERT INTO qm_sessions VALUES('canonical-a','owner','task-a'),('canonical-b','owner','task-b'),('private','other','private-task');
    INSERT INTO qm_tasks(id,session_id,state) VALUES('task-a','canonical-a','active'),('task-b','canonical-b','active'),('private-task','private','active');`);
  db.exec(taskBindingSchema);
  const other = new Database(filename); other.pragma("foreign_keys=ON"); other.pragma("busy_timeout=0");
  t.after(async () => { other.close(); db.close(); await rm(directory, { recursive: true, force: true }); });
  return { db, other, bindings: new TaskBindingStore(db, { ownerSource: "legacy-session" }),
    otherBindings: new TaskBindingStore(other, { ownerSource: "legacy-session" }) };
}

test("two external entries resume the same owned Task without moving its canonical storage or the other entry", async t => {
  const f = await fixture(t), first = entry("first-conversation"), second = entry("replacement-conversation");
  await f.bindings.initializeLegacy(first, "task-a");
  const resumed = await f.bindings.resume(second, "task-a", 0, "resume-a");
  assert.equal(resumed.taskId, "task-a");
  assert.equal(resumed.binding.revision, 1);
  await f.bindings.resume(second, "task-b", 1, "select-b");
  assert.equal(f.bindings.current(first)?.taskId, "task-a");
  assert.equal(f.bindings.current(second)?.taskId, "task-b");
  const canonical = f.db.prepare("SELECT id,current_task_id FROM qm_sessions ORDER BY id").all() as Array<{ id: string; current_task_id: string }>;
  assert.deepEqual(canonical.map(row => ({ id: row.id, current_task_id: row.current_task_id })), [
    { id: "canonical-a", current_task_id: "task-a" }, { id: "canonical-b", current_task_id: "task-b" }, { id: "private", current_task_id: "private-task" },
  ]);
  assert.equal((f.db.prepare("SELECT COUNT(*) AS n FROM qm_tasks").get() as { n: number }).n, 3);
  assert.equal(f.otherBindings.current(first)?.taskId, "task-a", "binding identity survives another database connection");
  assert.ok(!JSON.stringify(f.db.prepare("SELECT * FROM qm_task_bindings").all()).includes("replacement-conversation"));
});

test("start retries retain one Task and cannot switch an entry back from newer work", async t => {
  const f = await fixture(t), identity = entry("goals");
  let creations = 0;
  const create = () => {
    creations++;
    f.db.prepare("INSERT INTO qm_tasks(id,session_id,state) VALUES('new-goal','canonical-a','active')").run();
    return "new-goal";
  };
  const first = await f.bindings.start(identity, "new-goal-key", { title: "Independent goal" }, create);
  assert.ok(first.binding);
  await f.bindings.resume(identity, "task-b", first.binding.revision, "next-goal");
  const retried = await f.bindings.start(identity, "new-goal-key", { title: "Independent goal" }, create);
  assert.equal(retried.taskId, first.taskId);
  assert.equal(retried.replayed, true);
  assert.equal(retried.binding?.taskId, "task-b");
  assert.equal(creations, 1);
  await assert.rejects(f.bindings.start(identity, "new-goal-key", { title: "Different goal" }, create), /TASK_BINDING_KEY_CONFLICT/);
  assert.equal(f.bindings.current(identity)?.taskId, "task-b");
});

test("resume replay does not undo a subsequent selection and conflicting idempotency input is rejected", async t => {
  const f = await fixture(t), identity = entry("resume-replay");
  const first = await f.bindings.resume(identity, "task-a", 0, "resume");
  assert.equal((await f.bindings.resume(identity, "task-a", 0, "resume")).replayed, true);
  await assert.rejects(f.bindings.resume(identity, "task-b", 0, "resume"), /TASK_BINDING_KEY_CONFLICT/);
  await f.bindings.resume(identity, "task-b", first.binding.revision, "change");
  await assert.rejects(f.bindings.resume(identity, "task-a", 0, "resume"), /TASK_BINDING_REPLAY_SUPERSEDED/);
  assert.equal(f.bindings.current(identity)?.taskId, "task-b");
  await f.bindings.initializeLegacy(identity, "task-a");
  assert.equal(f.bindings.current(identity)?.taskId, "task-b", "legacy compatibility never overwrites an explicit binding");
});

test("concurrent selection uses one entry revision and the write-lock winner remains authoritative", async t => {
  const f = await fixture(t), identity = entry("concurrent");
  const settled = await Promise.allSettled([
    f.bindings.resume(identity, "task-a", 0, "first"), f.otherBindings.resume(identity, "task-b", 0, "second"),
  ]);
  assert.equal(settled.filter(result => result.status === "fulfilled").length, 1);
  const rejected = settled.find(result => result.status === "rejected") as PromiseRejectedResult;
  assert.match(String(rejected.reason), /TASK_BINDING_CHANGED/);
  const selected = f.bindings.current(identity)!;
  assert.equal(selected.revision, 1);
  assert.equal((f.db.prepare("SELECT COUNT(*) AS n FROM qm_task_binding_requests").get() as { n: number }).n, 1);
});

test("first workspace initialization cannot overwrite a resume that won the write lock", async t => {
  const f = await fixture(t), identity = entry("first-open-race");
  f.db.exec("BEGIN IMMEDIATE");
  let created = false;
  const initializing = f.otherBindings.initialize(identity, () => { created = true; return "task-b"; });
  f.db.exec("COMMIT");
  await f.bindings.resume(identity, "task-a", 0, "explicit-resume");
  assert.equal((await initializing).taskId, "task-a");
  assert.equal(created, false);
  assert.equal(f.bindings.current(identity)?.revision, 1);
});

test("a queued resume rechecks Task closure after another connection releases its write lock", async t => {
  const f = await fixture(t), identity = entry("closing");
  f.db.exec("BEGIN IMMEDIATE");
  const resumed = f.otherBindings.resume(identity, "task-a", 0, "late-resume");
  f.db.prepare("UPDATE qm_tasks SET state='closed' WHERE id='task-a'").run();
  f.db.exec("COMMIT");
  await assert.rejects(resumed, /TASK_NOT_ACTIVE/);
  assert.equal(f.bindings.current(identity), null, "failed resume rolls back entry creation too");
});

test("Task ownership, stable entry identity and finalization constrain every binding mutation", async t => {
  const f = await fixture(t), identity = entry("owner-entry");
  assert.throws(() => taskExecutionEntryFromAuthInfo({ clientId: "client", extra: { owner_id: "owner" } }, null), /TASK_ENTRY_REQUIRED/);
  assert.throws(() => taskExecutionEntryFromAuthInfo({ extra: { owner_id: "owner" } }, "entry"), /TASK_ENTRY_REQUIRED/);
  await assert.rejects(f.bindings.resume({ principal: identity.principal, clientId: "client", key: identity.key } as TaskExecutionEntry,
    "task-a", 0, "forged-entry"), /TASK_ENTRY_REQUIRED/);
  await assert.rejects(f.bindings.resume(entry("foreign", "other"), "task-a", 0, "foreign-owner"), /TASK_ACCESS_DENIED/);
  f.db.prepare("INSERT INTO qm_task_finalizations(task_id,completed_at,error) VALUES('task-a',NULL,NULL)").run();
  assert.equal(f.bindings.inspect(identity, "task-a").status, "finalizing");
  await assert.rejects(f.bindings.resume(identity, "task-a", 0, "during-finish"), /TASK_FINISHING/);
  f.db.prepare("UPDATE qm_task_finalizations SET error='delivery failed',recovery_state='safe' WHERE task_id='task-a'").run();
  assert.equal((await f.bindings.resume(identity, "task-a", 0, "after-failure")).taskId, "task-a");
  f.db.prepare("UPDATE qm_tasks SET state='closed' WHERE id='task-a'").run();
  assert.equal(f.bindings.inspect(identity, "task-a").can_continue, false);
  await assert.rejects(f.bindings.resume(identity, "task-a", 1, "no-reopen"), /TASK_NOT_ACTIVE/);
});

test("Task creation and entry selection roll back together on failure", async t => {
  const f = await fixture(t), identity = entry("atomic-start");
  await assert.rejects(f.bindings.start(identity, "atomic", { title: "Cannot partially create" }, () => {
    f.db.prepare("INSERT INTO qm_tasks(id,session_id,state) VALUES('incomplete','canonical-a','active')").run();
    throw new Error("create-failed");
  }), /create-failed/);
  assert.equal(f.bindings.current(identity), null);
  assert.equal(f.db.prepare("SELECT id FROM qm_tasks WHERE id='incomplete'").get(), undefined);
});

function persistedState(db: Database.Database): unknown {
  return Object.fromEntries([
    "qm_sessions", "qm_tasks", "qm_task_bindings", "qm_task_binding_requests", "qm_task_finalizations",
  ].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()]));
}

function insertGoal(db: Database.Database, id: string): string {
  assert.equal(db.inTransaction, true, "creation must share the binding transaction");
  db.prepare("INSERT INTO qm_tasks(id,session_id,state,title) VALUES(?,'canonical-a','active',?)").run(id, id);
  db.prepare("UPDATE qm_sessions SET current_task_id=? WHERE id='canonical-a'").run(id);
  return id;
}

test("start refuses a default fresh key for an open or closed selected Task without writing any state", async t => {
  for (const state of ["active", "closed"] as const) {
    await t.test(state, async t => {
      const f = await fixture(t), identity = entry(`selected-${state}`);
      await f.bindings.resume(identity, "task-a", 0, "select-original");
      f.db.prepare("UPDATE qm_tasks SET state=? WHERE id='task-a'").run(state);
      const before = persistedState(f.db);
      let created = false;
      await assert.rejects(f.bindings.start(identity, "accidental-follow-up", { title: "Another user message" }, () => {
        created = true;
        return insertGoal(f.db, "must-not-exist");
      }), (error: unknown) => {
        const value = error as { code: string; effect: string; details: Record<string, unknown> };
        assert.equal(value.code, "TASK_START_SELECTION_REQUIRED");
        assert.equal(value.effect, "not_started");
        assert.deepEqual(value.details, {
          binding_revision: 1,
          existing_task: { task_id: "task-a", title: "Fixture goal", state },
          selection_source: "entry",
          next_action: { tool: "task_resume", arguments: { action: "inspect", task_id: "task-a" } },
        });
        return true;
      });
      assert.equal(created, false);
      assert.deepEqual(persistedState(f.db), before);
    });
  }
});

test("an explicit independent goal needs the observed revision and leaves the old Task and finalization untouched", async t => {
  const f = await fixture(t), identity = entry("explicit-new-goal");
  await f.bindings.resume(identity, "task-a", 0, "select-a");
  f.db.prepare("INSERT INTO qm_task_finalizations(task_id,error,finalization_revision,recovery_state) VALUES('task-a','unsent finish',4,'safe')").run();
  const before = persistedState(f.db);
  await assert.rejects(f.bindings.start(identity, "missing-revision", { title: "New goal", newGoal: true },
    () => insertGoal(f.db, "missing")), { code: "TASK_BINDING_REVISION_REQUIRED", effect: "not_started" });
  await assert.rejects(f.bindings.start(identity, "stale-revision", { title: "New goal", newGoal: true, expectedBindingRevision: 0 },
    () => insertGoal(f.db, "stale")), { code: "TASK_BINDING_CHANGED", effect: "not_started" });
  assert.deepEqual(persistedState(f.db), before);
  const originalTask = f.db.prepare("SELECT * FROM qm_tasks WHERE id='task-a'").get();
  const originalFinish = f.db.prepare("SELECT * FROM qm_task_finalizations WHERE task_id='task-a'").get();
  const result = await f.bindings.start(identity, "explicit-b", { title: "New goal", newGoal: true, expectedBindingRevision: 1 },
    () => insertGoal(f.db, "task-new"));
  assert.equal(result.binding?.revision, 2);
  assert.equal(result.binding?.taskId, "task-new");
  assert.deepEqual(f.db.prepare("SELECT * FROM qm_tasks WHERE id='task-a'").get(), originalTask);
  assert.deepEqual(f.db.prepare("SELECT * FROM qm_task_finalizations WHERE task_id='task-a'").get(), originalFinish);
  await assert.rejects(f.bindings.start(identity, "explicit-b", { title: "New goal", newGoal: true, expectedBindingRevision: 2 },
    () => insertGoal(f.db, "wrong-replay")), { code: "TASK_BINDING_KEY_CONFLICT" });
});

test("legacy current Task is a conflict candidate, not an implicit binding; its old receipt is a read-only replay", async t => {
  const f = await fixture(t), identity = entry("legacy-candidate");
  const before = persistedState(f.db);
  const legacy = () => ({ replayTaskId: null, currentTaskId: "task-a" });
  await assert.rejects(f.bindings.start(identity, "follow-up", { title: "Continuing" },
    () => insertGoal(f.db, "wrong"), legacy), (error: unknown) => {
    const details = (error as { details: { binding_revision: number; selection_source: string; existing_task: { task_id: string } } }).details;
    assert.equal(details.binding_revision, 0);
    assert.equal(details.selection_source, "legacy");
    assert.equal(details.existing_task.task_id, "task-a");
    return (error as { code: string }).code === "TASK_START_SELECTION_REQUIRED";
  });
  assert.deepEqual(persistedState(f.db), before);
  const replay = await f.bindings.start(identity, "historical", { title: "Legacy retry title" },
    () => insertGoal(f.db, "also-wrong"), () => ({ replayTaskId: "task-a", currentTaskId: "task-b" }));
  assert.equal(replay.taskId, "task-a");
  assert.equal(replay.replayed, true);
  assert.equal(replay.binding, null);
  assert.deepEqual(persistedState(f.db), before, "legacy receipt replay must not create an empty binding row");
  const result = await f.bindings.start(identity, "new-independent", { title: "New goal", newGoal: true, expectedBindingRevision: 0 },
    () => insertGoal(f.db, "legacy-next"), legacy);
  assert.equal(result.binding?.taskId, "legacy-next");
  assert.equal((f.db.prepare("SELECT state FROM qm_tasks WHERE id='task-a'").get() as { state: string }).state, "active");
});

test("v1 binding receipts replay before new creation policy or legacy fallback without changing a later selection", async t => {
  const f = await fixture(t), identity = entry("old-binding-receipt");
  const first = await f.bindings.start(identity, "old-key", { title: "Original" }, () => insertGoal(f.db, "original-goal"));
  assert.ok(first.binding);
  f.db.prepare("UPDATE qm_task_binding_requests SET input_json=? WHERE binding_id=? AND action='start' AND request_key='old-key'")
    .run(JSON.stringify({ title: "Original", source_task_id: null }), first.binding.id);
  await f.bindings.resume(identity, "task-b", first.binding.revision, "later-selection");
  const before = persistedState(f.db);
  let legacyReads = 0;
  const replay = await f.bindings.start(identity, "old-key", { title: "Original", newGoal: true, expectedBindingRevision: 0 },
    () => insertGoal(f.db, "not-a-replay"), () => { legacyReads++; return { replayTaskId: "task-a", currentTaskId: "task-a" }; });
  assert.equal(replay.taskId, first.taskId);
  assert.equal(replay.binding?.taskId, "task-b");
  assert.equal(legacyReads, 0, "the precise entry receipt precedes the older Session namespace");
  assert.deepEqual(persistedState(f.db), before);
});

test("same-key starts on separate SQLite connections converge after waiting for the writer", async t => {
  const f = await fixture(t), identity = entry("same-key-concurrent");
  let creations = 0;
  const create = (db: Database.Database) => { creations++; return insertGoal(db, "created-once"); };
  f.db.exec("BEGIN IMMEDIATE");
  const waiting = f.otherBindings.start(identity, "same-key", { title: "One goal" }, () => create(f.other));
  f.db.exec("COMMIT");
  const winner = await f.bindings.start(identity, "same-key", { title: "One goal" }, () => create(f.db));
  const replay = await waiting;
  assert.equal(creations, 1);
  assert.equal(replay.taskId, winner.taskId);
  assert.equal(replay.replayed, true);
  assert.equal((f.db.prepare("SELECT COUNT(*) AS n FROM qm_task_binding_requests").get() as { n: number }).n, 1);
});

test("different default start keys recheck the selected Task after waiting and cannot both create goals", async t => {
  const f = await fixture(t), identity = entry("different-keys-concurrent");
  let waitingCreated = false;
  f.db.exec("BEGIN IMMEDIATE");
  const waiting = f.otherBindings.start(identity, "waiting-key", { title: "Follow-up" }, () => {
    waitingCreated = true;
    return insertGoal(f.other, "waiting-goal");
  });
  f.db.exec("COMMIT");
  const winner = await f.bindings.start(identity, "winner-key", { title: "Original" }, () => insertGoal(f.db, "winner-goal"));
  const afterWinner = persistedState(f.db);
  await assert.rejects(waiting, { code: "TASK_START_SELECTION_REQUIRED", effect: "not_started" });
  assert.equal(waitingCreated, false);
  assert.equal(f.bindings.current(identity)?.taskId, winner.taskId);
  assert.deepEqual(persistedState(f.db), afterWinner);
});

test("concurrent explicit new goals compare the binding revision before any creation", async t => {
  const f = await fixture(t), identity = entry("explicit-start-race");
  await f.bindings.resume(identity, "task-a", 0, "initial");
  const input = { title: "Independent", newGoal: true as const, expectedBindingRevision: 1 };
  f.db.exec("BEGIN IMMEDIATE");
  const waiting = f.otherBindings.start(identity, "queued", input, () => insertGoal(f.other, "queued-goal"));
  f.db.exec("COMMIT");
  await f.bindings.start(identity, "winner", input, () => insertGoal(f.db, "chosen-goal"));
  const afterWinner = persistedState(f.db);
  await assert.rejects(waiting, { code: "TASK_BINDING_CHANGED", effect: "not_started" });
  assert.deepEqual(persistedState(f.db), afterWinner);
});

test("an implicit workspace selection winning the writer prevents a queued default start from splitting the Task", async t => {
  const f = await fixture(t), identity = entry("workspace-before-start");
  f.db.exec("BEGIN IMMEDIATE");
  const waiting = f.otherBindings.start(identity, "queued", { title: "Continue opening" }, () => insertGoal(f.other, "split-goal"));
  f.db.exec("COMMIT");
  await f.bindings.initialize(identity, () => "task-a");
  const afterOpen = persistedState(f.db);
  await assert.rejects(waiting, { code: "TASK_START_SELECTION_REQUIRED" });
  assert.deepEqual(persistedState(f.db), afterOpen);
  assert.equal(f.bindings.current(identity)?.taskId, "task-a");
});

test("legacy selection is read inside the writer and foreign-owner candidates are never disclosed", async t => {
  const f = await fixture(t), identity = entry("legacy-lock-recheck");
  f.db.exec("BEGIN IMMEDIATE");
  const waiting = f.otherBindings.start(identity, "queued", { title: "Follow-up" }, () => insertGoal(f.other, "split-legacy"), () => ({
    replayTaskId: null,
    currentTaskId: (f.other.prepare("SELECT current_task_id FROM qm_sessions WHERE id='canonical-a'").get() as { current_task_id: string }).current_task_id,
  }));
  insertGoal(f.db, "updated-legacy");
  f.db.exec("COMMIT");
  await assert.rejects(waiting, (error: unknown) => {
    assert.equal((error as { code: string }).code, "TASK_START_SELECTION_REQUIRED");
    assert.equal((error as { details: { existing_task: { task_id: string } } }).details.existing_task.task_id, "updated-legacy");
    return true;
  });
  assert.equal(f.bindings.current(identity), null);
  await assert.rejects(f.bindings.start(identity, "foreign-candidate", { title: "Private" }, () => insertGoal(f.db, "wrong-owner"),
    () => ({ replayTaskId: null, currentTaskId: "private-task" })), (error: unknown) => {
    assert.equal((error as { code: string }).code, "TASK_ACCESS_DENIED");
    assert.equal((error as { details?: unknown }).details, undefined);
    return true;
  });
  assert.equal(f.bindings.current(identity), null);
});
