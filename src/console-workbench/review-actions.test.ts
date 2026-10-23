import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerConfig } from "../config.js";
import type { SessionRuntime } from "../session/runtime.js";
import { WorkLedger } from "../work-ledger.js";
import { WorkspaceRegistry } from "../workspaces.js";
import { ExecutionCoordinator } from "../execution-coordinator.js";
import { SessionChangeCollector } from "../session/changes.js";
import { SessionProjector } from "../session/projection.js";
import { SessionService } from "../session/service.js";
import { SessionReverter } from "../session/revert.js";
import { readRunCheckpoint, saveRunCheckpoint } from "../session/run-checkpoints.js";
import { SessionStore } from "../session/store.js";
import { ReviewState } from "../session/types.js";
import { LocalActions } from "./actions.js";
import { WriteReceipts } from "./receipts.js";
import { WorkbenchError } from "./types.js";

async function waitForPublication(entered: Promise<void>, capture: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      entered,
      capture.then(() => { throw new Error("Capture completed without reaching its publication callback"); }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Capture did not reach its publication callback within 15 seconds")), 15_000);
      }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

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
  const changes = new SessionChangeCollector(store, stateDir), execution = new ExecutionCoordinator(stateDir);
  const reverter = new SessionReverter(store, stateDir, execution, changes);
  const projector = new SessionProjector(store, stateDir);
  const service = new SessionService(store, new WorkspaceRegistry(config), ledger, undefined, changes, projector);
  const actions = new LocalActions(config, { store, changes, reverter, service } as SessionRuntime);
  t.after(async () => {
    await service.close(); await projector.close(); await changes.close(); execution.close();
    ledger.close(); rmSync(directory, { recursive: true, force: true });
  }, { timeout: 20_000 });
  return { directory, root, stateDir, ledger, store, session, member, task, changes, execution, reverter, service, run: ledger.run(run.id), actions };
}

async function changedFile(f: ReturnType<typeof fixture>, name = "tracked.txt", taskId = f.task.id) {
  const path = join(f.root, name);
  await writeFile(path, "base\n");
  const evidence = await f.changes.prepareWrite(f.member, [name], f.root, taskId);
  await writeFile(path, "owned change\n");
  await f.changes.recordWrite(f.member, evidence, taskId);
  return path;
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

test("live pending or failed capture blocks review, revert preview and commit without changing files or acceptance", { timeout: 60_000 }, async t => {
  const f = fixture(t), path = await changedFile(f), ref = { id: f.run.id, expectedRevision: f.run.revision };
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.changes.setCaptureListener(async () => { entered(); await gate; });
  const pending = f.changes.capture(f.member.id, f.task.id);
  void pending.catch(() => undefined);
  const baseline = join(f.stateDir, "session-file-baselines", f.session.id, f.member.id, f.task.id, "baseline.json");
  let originalBaseline: string | undefined;
  try {
    await waitForPublication(reached, pending);
    assert.equal(f.changes.captureObservation(f.member.id, f.task.id).state, "pending");
    const files = f.changes.readSummaries(f.session.id, f.member.id, f.task.id).map(file => file.id);
    const blocked = (code: string) => (error: unknown) => error instanceof WorkbenchError && error.status === 409 && error.code === code && error.effect === "none";
    for (const verdict of ["accept", "reject"] as const)
      await assert.rejects(f.actions.review(ref, verdict, "not yet captured", `pending-${verdict}`), blocked("file_capture_pending"));
    await assert.rejects(f.actions.revertPreview(f.run.id, files, f.run.revision), blocked("file_capture_pending"));
    assert.equal((f.ledger.db.prepare("SELECT COUNT(*) count FROM console_revert_previews").get() as { count: number }).count, 0);
    release(); await pending;
    const preview = await f.actions.revertPreview(f.run.id, files, f.run.revision);
    originalBaseline = await readFile(baseline, "utf8");
    await writeFile(baseline, "{invalid baseline");
    await assert.rejects(f.changes.capture(f.member.id, f.task.id));
    assert.equal(f.changes.captureObservation(f.member.id, f.task.id).state, "failed");
    for (const verdict of ["accept", "reject"] as const)
      await assert.rejects(f.actions.review(ref, verdict, "failed evidence", `failed-${verdict}`), blocked("file_capture_failed"));
    await assert.rejects(f.actions.revertPreview(f.run.id, files, f.run.revision), blocked("file_capture_failed"));
    await assert.rejects(f.actions.revertCommit(preview.id, preview.hash, "failed-revert"), blocked("file_capture_failed"));
    assert.equal(await readFile(path, "utf8"), "owned change\n");
    assert.equal(f.ledger.run(f.run.id).acceptance, "pending");
    assert.equal(f.ledger.run(f.run.id).revision, f.run.revision, "file_changed does not make the run revision a sufficient evidence fence");
    assert.equal(f.store.eventsForTask(f.task.id).filter(event => event.type === "verification_recorded" || event.type === "operation_started").length, 0);
    assert.equal(f.execution.inspect(f.root).length, 0);
  } finally {
    release(); f.changes.setCaptureListener(() => undefined);
    if (originalBaseline !== undefined) { await writeFile(baseline, originalBaseline); await f.changes.capture(f.member.id, f.task.id); }
  }
});

test("running review refuses evidence captured during checkpoint preparation instead of accepting the new revision", async t => {
  const f = fixture(t);
  await changedFile(f);
  f.ledger.db.prepare("UPDATE console_work_runs SET status='running',finished_at=NULL WHERE id=?").run(f.run.id);
  const prepare = f.service.prepareRunCheckpoint.bind(f.service);
  t.mock.method(f.service, "prepareRunCheckpoint", async (sessionId: string, memberId: string, taskId?: string) => {
    await f.changes.capture(memberId, taskId);
    return prepare(sessionId, memberId, taskId);
  });
  await assert.rejects(f.actions.review({ id: f.run.id, expectedRevision: f.run.revision, completeExecution: true }, "accept", "unseen change", "racing-review"),
    error => error instanceof WorkbenchError && error.code === "revision_conflict" && error.effect === "none");
  assert.equal(f.ledger.run(f.run.id).status, "running");
  assert.equal(f.ledger.run(f.run.id).acceptance, "pending");
  assert.equal(readRunCheckpoint(f.ledger.db, f.run.id), null);
  assert.equal(f.store.eventsForTask(f.task.id).filter(event => event.type === "verification_recorded").length, 0);
});

test("a frozen historical review and old revert preview keep Task A scope while Task B capture has failed", async t => {
  const f = fixture(t), path = await changedFile(f);
  await f.changes.capture(f.member.id, f.task.id);
  saveRunCheckpoint(f.ledger.db, f.run.id, await f.service.prepareRunCheckpoint(f.session.id, f.member.id, f.task.id));
  f.store.closeTask(f.task.id, "completed", "A done");
  const current = f.store.createTask(f.session.id, "Task B");
  const other = await changedFile(f, "next.txt", current.id);
  const baseline = join(f.stateDir, "session-file-baselines", f.session.id, f.member.id, current.id, "baseline.json");
  const original = await readFile(baseline, "utf8");
  try {
    await writeFile(baseline, "{invalid B baseline");
    await assert.rejects(f.changes.capture(f.member.id, current.id));
    await f.actions.review({ id: f.run.id, expectedRevision: f.run.revision }, "accept", "frozen A", "review-A");
    assert.equal(f.ledger.run(f.run.id).acceptance, "passed");
    assert.equal(f.store.eventsForTask(current.id).filter(event => event.type === "verification_recorded").length, 0);
    assert.equal(f.store.getSession(f.session.id).review_state, ReviewState.unknown);
    const files = f.changes.readSummaries(f.session.id, f.member.id, f.task.id).map(file => file.id);
    const preview = await f.actions.revertPreview(f.run.id, files, f.ledger.run(f.run.id).revision);
    const saved = f.ledger.db.prepare("SELECT data_json FROM console_revert_previews WHERE id=?").get(preview.id) as { data_json: string };
    const legacy = JSON.parse(saved.data_json); delete legacy.taskId;
    f.ledger.db.prepare("UPDATE console_revert_previews SET data_json=? WHERE id=?").run(JSON.stringify(legacy), preview.id);
    await f.actions.revertCommit(preview.id, preview.hash, "old-preview-A");
    assert.equal(await readFile(path, "utf8"), "base\n");
    assert.equal(await readFile(other, "utf8"), "owned change\n");
    assert.equal(f.changes.captureObservation(f.member.id, current.id).state, "failed");
  } finally { await writeFile(baseline, original); await f.changes.capture(f.member.id, current.id); }
});

test("a frozen phase can be reviewed while the next phase of the same Task is still collecting files", { timeout: 60_000 }, async t => {
  const f = fixture(t);
  await changedFile(f); await f.changes.capture(f.member.id, f.task.id);
  saveRunCheckpoint(f.ledger.db, f.run.id, await f.service.prepareRunCheckpoint(f.session.id, f.member.id, f.task.id));
  const next = f.ledger.begin({ root: f.root, workspaceId: "workspace", workItemId: "next-phase", runKey: "next-phase", title: "Next phase",
    origin: { entryPoint: "console", evidence: "server_entry" } });
  f.store.linkRun(f.session.id, f.member.id, next.id, f.task.id);
  await changedFile(f, "next-phase.txt");
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.changes.setCaptureListener(async () => { entered(); await gate; });
  const pending = f.changes.capture(f.member.id, f.task.id);
  void pending.catch(() => undefined);
  try {
    await waitForPublication(reached, pending);
    await f.actions.review({ id: f.run.id, expectedRevision: f.run.revision }, "accept", "frozen phase only", "historical-phase");
    assert.equal(f.ledger.run(f.run.id).acceptance, "passed");
    assert.equal(f.ledger.run(next.id).status, "running");
    assert.equal(f.ledger.run(next.id).acceptance, "pending");
    const reviewed = f.store.eventsForTask(f.task.id).filter(event => event.type === "verification_recorded");
    assert.equal(reviewed.length, 1); assert.equal(reviewed[0]?.payload.run_id, f.run.id);
    assert.equal(f.changes.captureObservation(f.member.id, f.task.id).state, "pending");
    release(); await pending;
  } finally { release(); }
});

test("revert preview refuses a newer phase captured during eligibility even after capture returns idle", async t => {
  const f = fixture(t), path = await changedFile(f);
  await f.changes.capture(f.member.id, f.task.id);
  const originalCheckpoint = await f.service.prepareRunCheckpoint(f.session.id, f.member.id, f.task.id);
  saveRunCheckpoint(f.ledger.db, f.run.id, originalCheckpoint);
  const files = originalCheckpoint.files.map(file => file.id);
  const next = f.ledger.begin({ root: f.root, workspaceId: "workspace", workItemId: "preview-next-phase", runKey: "preview-next-phase", title: "Next phase",
    origin: { entryPoint: "console", evidence: "server_entry" } });
  f.store.linkRun(f.session.id, f.member.id, next.id, f.task.id);
  const eligibility = f.reverter.eligibility.bind(f.reverter);
  let captured = false;
  t.mock.method(f.reverter, "eligibility", async (...args: Parameters<typeof eligibility>) => {
    if (!captured) {
      captured = true;
      const evidence = await f.changes.prepareWrite(f.member, ["tracked.txt"], f.root, f.task.id);
      await writeFile(path, "new phase evidence\n");
      await f.changes.recordWrite(f.member, evidence, f.task.id);
      await f.changes.capture(f.member.id, f.task.id);
    }
    return eligibility(...args);
  });
  await assert.rejects(f.actions.revertPreview(f.run.id, files, f.run.revision),
    error => error instanceof WorkbenchError && error.code === "revision_conflict" && error.effect === "none");
  assert.equal(captured, true);
  assert.equal(f.changes.captureObservation(f.member.id, f.task.id).state, "idle");
  assert.equal((f.ledger.db.prepare("SELECT COUNT(*) count FROM console_revert_previews").get() as { count: number }).count, 0);
  assert.equal(await readFile(path, "utf8"), "new phase evidence\n");
  assert.equal(f.store.eventsForTask(f.task.id).filter(event => event.type === "operation_started").length, 0);
  assert.notEqual(f.changes.readSummaries(f.session.id, f.member.id, f.task.id)[0]?.hash, originalCheckpoint.files[0]?.hash);
  await assert.rejects(f.actions.revertPreview(f.run.id, files, f.run.revision),
    error => error instanceof WorkbenchError && error.code === "revision_conflict");

  // A fresh intent names the new phase and its current immutable evidence.
  f.ledger.db.prepare("UPDATE console_work_runs SET status='completed',finished_at=? WHERE id=?").run(new Date().toISOString(), next.id);
  const refreshed = await f.service.prepareRunCheckpoint(f.session.id, f.member.id, f.task.id);
  saveRunCheckpoint(f.ledger.db, next.id, refreshed);
  const preview = await f.actions.revertPreview(next.id, refreshed.files.map(file => file.id), f.ledger.run(next.id).revision);
  assert.equal(preview.revision, f.store.getMember(f.session.id, f.member.id).revision);
  assert.equal((f.ledger.db.prepare("SELECT COUNT(*) count FROM console_revert_previews").get() as { count: number }).count, 1);
});
