import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerConfig } from "../config.js";
import type { SessionRuntime } from "../session/runtime.js";
import { WorkLedger } from "../work-ledger.js";
import { SessionStore } from "../session/store.js";
import { ReviewState } from "../session/types.js";
import { LocalActions } from "./actions.js";
import { WriteReceipts } from "./receipts.js";

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "qm-console-review-")), root = join(directory, "project"), stateDir = join(directory, "state");
  mkdirSync(root);
  const ledger = new WorkLedger(stateDir), store = new SessionStore(ledger.db);
  const config = { stateDir, configDir: directory, allowedRoots: [root] } as ServerConfig;
  const session = store.createSession("owner", "conversation", "Review transaction");
  const member = store.addMember(session.id, "local", "workspace", root, "checkout", null);
  const task = store.createTask(session.id, "Task A");
  const run = ledger.begin({ root, workspaceId: "workspace", workItemId: "review", runKey: "review", title: "Review phase",
    origin: { entryPoint: "console", evidence: "server_entry" } });
  store.linkRun(session.id, member.id, run.id, task.id);
  ledger.db.prepare("UPDATE console_work_runs SET status='completed',acceptance='pending',finished_at=? WHERE id=?")
    .run(new Date().toISOString(), run.id);
  const actions = new LocalActions(config, { store } as SessionRuntime);
  t.after(() => { ledger.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, stateDir, ledger, store, session, member, task, run: ledger.run(run.id), actions };
}

test("console review rolls back the run when the exact Task verification event cannot commit", async t => {
  const f = fixture(t), before = f.ledger.run(f.run.id);
  f.store.closeTask(f.task.id, "completed", "A done");
  const current = f.store.createTask(f.session.id, "Task B");
  f.ledger.db.exec(`CREATE TRIGGER refuse_console_review BEFORE INSERT ON qm_events
    WHEN NEW.event_type='verification_recorded' BEGIN SELECT RAISE(ABORT,'verification refused'); END;`);
  const ref = { id: f.run.id, expectedRevision: before.revision };
  await assert.rejects(f.actions.review(ref, "accept", "checked A", "first"), error =>
    error instanceof Error && /verification refused/.test(error.message) && (error as { effect?: string }).effect === "not_started");
  assert.deepEqual(f.ledger.run(f.run.id), before);
  assert.equal(f.store.eventsForTask(f.task.id).filter(event => event.type === "verification_recorded").length, 0);
  f.ledger.db.exec("DROP TRIGGER refuse_console_review");
  await f.actions.review(ref, "accept", "checked A", "second");
  assert.equal(f.ledger.run(f.run.id).acceptance, "passed");
  const events = f.store.eventsForTask(f.task.id).filter(event => event.type === "verification_recorded");
  assert.equal(events.length, 1); assert.equal(events[0]?.member_id, f.member.id);
  assert.equal(events[0]?.payload.run_id, f.run.id);
  assert.equal(f.store.eventsForTask(current.id).filter(event => event.type === "verification_recorded").length, 0);
  assert.equal(f.store.getSession(f.session.id).review_state, ReviewState.unknown);
});

test("console review notifies after the atomic commit and reconciles a lost acknowledgement without replay", async t => {
  const f = fixture(t), receipts = new WriteReceipts(f.stateDir);
  let notifications = 0;
  const unsubscribe = f.store.onChange(change => {
    notifications++;
    assert.equal(change.taskId, f.task.id);
    assert.equal(f.ledger.db.inTransaction, false);
    assert.equal(f.ledger.run(f.run.id).acceptance, "passed");
    assert.equal(f.store.eventsForTask(f.task.id).filter(event => event.type === "verification_recorded").length, 1);
    throw new Error("notification acknowledgement lost");
  });
  t.after(unsubscribe);
  const ref = { id: f.run.id, expectedRevision: f.run.revision };
  const execute = () => receipts.execute("console:review", "review-request", "/review", ref,
    () => f.actions.review(ref, "accept", "checked", "review-request"));
  await assert.rejects(execute(), /acknowledgement lost/);
  assert.equal(notifications, 1);
  const reconciled = await receipts.reconcile("console:review", "review-request", async () => f.actions.reconcileReview(f.run.id, "accept", "checked"));
  assert.equal(reconciled?.state, "completed");
  const replay = await execute();
  assert.equal(replay.ok, true);
  assert.equal(notifications, 1);
  assert.equal(f.ledger.run(f.run.id).revision, f.run.revision + 1);
});
