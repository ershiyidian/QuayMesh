import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { openDatabase } from "../db/client.js";
import type { SqliteWriteOptions } from "../db/async-write.js";
import { ExecutionCoordinator } from "../execution-coordinator.js";
import { RecoveryService } from "./recovery.js";
import { SessionStore } from "./store.js";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "quaymesh-recovery-"));
  const root = join(directory, "project");
  await mkdir(root, { recursive: true });
  const database = openDatabase(join(directory, "state"));
  const store = new SessionStore(database.sqlite);
  const recovery = new RecoveryService(store, join(directory, "state"));
  return {
    directory,
    root,
    database,
    store,
    recovery,
    async close() {
      await recovery.close();
      database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>, description: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(description)), 4_000);
    })]);
  } finally { clearTimeout(timer); }
}

async function exportedTitles(root: string): Promise<string[]> {
  const saved = JSON.parse(await readFile(join(root, ".quaymesh", "sessions.json"), "utf8")) as {
    sessions: Array<{ title: string }>;
  };
  return saved.sessions.map(row => row.title).sort();
}

test("recovery coalesces concurrent requests into fresh rounds and close waits for the last publication", { timeout: 10_000 }, async t => {
  const f = await fixture();
  const entered = Array.from({ length: 3 }, deferred), release = Array.from({ length: 3 }, deferred);
  const requests: Promise<void>[] = [];
  const write = f.store.writeAsync.bind(f.store);
  let rounds = 0, active = 0, maxActive = 0;
  t.mock.method(f.store, "writeAsync", async <T>(action: () => T, options?: SqliteWriteOptions): Promise<T> => {
    const round = rounds++;
    active++; maxActive = Math.max(maxActive, active);
    try {
      entered[round]?.resolve();
      if (release[round]) await release[round]!.promise;
      return await write(action, options);
    } finally { active--; }
  });
  t.after(async () => {
    for (const gate of release) gate.resolve();
    await Promise.allSettled(requests);
    await f.close();
  });
  const addSession = (title: string) => {
    const session = f.store.createSession("owner", title, title);
    f.store.addMember(session.id, "local", title, f.root, "checkout", null);
  };
  addSession("first");
  const first = f.recovery.exportRoot(f.root); requests.push(first);
  await bounded(entered[0]!.promise, "first export reaches its real database publication");
  assert.deepEqual(await exportedTitles(f.root), ["first"]);

  addSession("during-first");
  let secondSettled = 0, thirdSettled = false;
  for (let index = 0; index < 64; index++) {
    requests.push(f.recovery.exportRoot(f.root).then(() => { secondSettled++; }));
  }
  assert.equal(secondSettled, 0);
  release[0]!.resolve();
  await bounded(first, "first request receives its own completed publication");
  await bounded(entered[1]!.promise, "concurrent requests share one fresh export");
  assert.deepEqual(await exportedTitles(f.root), ["during-first", "first"]);
  assert.equal(secondSettled, 0, "file writes alone do not resolve requests before database publication");

  addSession("during-second");
  const third = f.recovery.exportRoot(f.root).then(() => { thirdSettled = true; }); requests.push(third);
  let closed = false;
  const closing = f.recovery.close().then(() => { closed = true; });
  await assert.rejects(f.recovery.exportRoot(f.root), /RECOVERY_SERVICE_CLOSED/);
  release[1]!.resolve();
  await bounded(entered[2]!.promise, "request arriving during the second export gets a third fresh round");
  assert.equal(secondSettled, 64, "the entire second batch resolves from its completed round");
  assert.equal(thirdSettled, false);
  assert.equal(closed, false);
  assert.deepEqual(await exportedTitles(f.root), ["during-first", "during-second", "first"]);
  release[2]!.resolve();
  await bounded(Promise.all([...requests, closing]), "all accepted exports and close settle");
  assert.equal(rounds, 3);
  assert.equal(maxActive, 1);
  assert.equal(thirdSettled, true);
  assert.equal(closed, true);
});

test("a failed recovery round rejects its callers while a queued fresh round still publishes before close", { timeout: 10_000 }, async t => {
  const f = await fixture();
  const entered = [deferred(), deferred()], release = [deferred(), deferred()];
  const write = f.store.writeAsync.bind(f.store);
  const requests: Promise<unknown>[] = [];
  let rounds = 0;
  t.mock.method(f.store, "writeAsync", async <T>(action: () => T, options?: SqliteWriteOptions): Promise<T> => {
    const round = rounds++;
    entered[round]?.resolve();
    if (release[round]) await release[round]!.promise;
    return write(action, options);
  });
  t.after(async () => {
    for (const gate of release) gate.resolve();
    await Promise.allSettled(requests);
    await f.close();
  });
  const session = f.store.createSession("owner", "failed-export", "before failure");
  const member = f.store.addMember(session.id, "local", "failed-export", f.root, "checkout", null);
  f.database.sqlite.exec(`CREATE TRIGGER reject_recovery_export BEFORE UPDATE OF exported_revision ON qm_session_members
    BEGIN SELECT RAISE(ABORT, 'recovery publication rejected'); END`);
  const first = f.recovery.exportRoot(f.root), joined = f.recovery.exportRoot(f.root);
  const failures = Promise.all([first, joined].map(request => request.then(
    () => assert.fail("the failed publication must not resolve"), error => error as Error)));
  requests.push(failures);
  await bounded(entered[0]!.promise, "first export reaches its failing database publication");
  f.store.appendEvent({ session_id: session.id, member_id: member.id, type: "file_changed",
    source_id: "after-first-read", timestamp: new Date().toISOString(), payload: { path: "after-first-read.txt" } });
  let nextSettled = false, closed = false;
  const next = f.recovery.exportRoot(f.root).then(() => { nextSettled = true; }); requests.push(next);
  const closing = f.recovery.close().then(() => { closed = true; }); requests.push(closing);
  release[0]!.resolve();
  const errors = await bounded(failures, "all first-round callers observe the real SQLite error");
  assert.equal(errors[0], errors[1]);
  assert.match(errors[0]!.message, /recovery publication rejected/);
  assert.equal(f.database.sqlite.inTransaction, false);
  await bounded(entered[1]!.promise, "a queued fresh round runs after the failed round");
  assert.equal(nextSettled, false);
  assert.equal(closed, false);
  f.database.sqlite.exec("DROP TRIGGER reject_recovery_export");
  release[1]!.resolve();
  await bounded(Promise.all([next, closing]), "fresh publication succeeds and close drains it");
  assert.equal(rounds, 2);
  const rows = await f.recovery.readLocalHistoricalTable(f.root);
  assert.deepEqual(rows[0]?.files, ["after-first-read.txt"]);
  const saved = f.database.sqlite.prepare("SELECT revision, exported_revision FROM qm_session_members WHERE id=?").get(member.id) as {
    revision: number; exported_revision: number;
  };
  assert.equal(saved.exported_revision, saved.revision);
});

test("recovery content and revisions share one read snapshot and never acknowledge another workspace", { timeout: 10_000 }, async t => {
  const f = await fixture(), otherRoot = join(f.directory, "other-project");
  await mkdir(otherRoot);
  const competing = openDatabase(join(f.directory, "state")), otherStore = new SessionStore(competing.sqlite);
  t.after(async () => { competing.close(); await f.close(); });
  const session = f.store.createSession("owner", "snapshot-revisions", "Consistent recovery");
  const member = f.store.addMember(session.id, "local", "primary", f.root, "checkout", null);
  const otherMember = f.store.addMember(session.id, "local", "other", otherRoot, "checkout", null);
  const append = (store: SessionStore, memberId: string, path: string) => store.appendEvent({
    session_id: session.id, member_id: memberId, type: "file_changed", source_id: path,
    timestamp: new Date().toISOString(), payload: { path },
  });
  append(f.store, member.id, "before-read.txt");
  append(f.store, otherMember.id, "other-workspace.txt");
  const readRevision = (id: string) => f.database.sqlite.prepare(
    "SELECT revision, exported_revision FROM qm_session_members WHERE id=?").get(id) as {
      revision: number; exported_revision: number;
    };
  const observed = readRevision(member.id), otherBefore = readRevision(otherMember.id);
  const read = f.store.recentRecoveryRows.bind(f.store);
  let inserted = false;
  t.mock.method(f.store, "recentRecoveryRows", (...args: Parameters<SessionStore["recentRecoveryRows"]>) => {
    const rows = read(...args);
    if (!inserted) {
      inserted = true;
      assert.equal(f.database.sqlite.inTransaction, true, "content and revision reads share a deferred read transaction");
      // WAL permits this independent connection to commit between the content
      // query and the revision query; both export reads must still see the old snapshot.
      append(otherStore, member.id, "between-content-and-revision.txt");
    }
    return rows;
  });
  await f.recovery.exportRoot(f.root);
  assert.deepEqual((await f.recovery.readLocalHistoricalTable(f.root))[0]?.files, ["before-read.txt"]);
  assert.deepEqual(readRevision(member.id), { revision: observed.revision + 1, exported_revision: observed.revision });
  assert.deepEqual(readRevision(otherMember.id), otherBefore, "this root's file does not acknowledge a different workspace");
  await f.recovery.exportRoot(f.root);
  assert.deepEqual((await f.recovery.readLocalHistoricalTable(f.root))[0]?.files.sort(), ["before-read.txt", "between-content-and-revision.txt"]);
  assert.deepEqual(readRevision(member.id), { revision: observed.revision + 1, exported_revision: observed.revision + 1 });
  assert.deepEqual(readRevision(otherMember.id), otherBefore);
});

test("recovery publication waits for a real SQLite writer without blocking HTTP or timers and retains its capture lease", { timeout: 10_000 }, async t => {
  const f = await fixture(), stateDir = join(f.directory, "state");
  const execution = new ExecutionCoordinator(stateDir);
  const session = f.store.createSession("owner", "locked-export", "Lock contention");
  const member = f.store.addMember(session.id, "local", "locked-export", f.root, "checkout", null);
  f.store.appendEvent({ session_id: session.id, member_id: member.id, type: "file_changed",
    source_id: "lock-contention", timestamp: new Date().toISOString(), payload: { path: "ready.txt" } });
  const observedRevision = f.store.getMember(session.id, member.id).revision;
  const lease = await execution.beginWorkAsync({ kind: "capture" });
  const worker = new Worker(`
    const {parentPort,workerData}=require('node:worker_threads');
    const Database=require(workerData.module),db=new Database(workerData.path);
    db.exec('BEGIN IMMEDIATE');
    const at=new Date().toISOString();
    db.prepare("INSERT INTO qm_events(session_id,member_id,source_id,event_type,data_json,created_at) VALUES(?,?,?,?,?,?)")
      .run(workerData.sessionId,workerData.memberId,'during-export-lock','file_changed',JSON.stringify({path:'during-lock.txt'}),at);
    db.prepare('UPDATE qm_sessions SET revision=revision+1,last_activity_at=? WHERE id=?').run(at,workerData.sessionId);
    db.prepare('UPDATE qm_session_members SET revision=revision+1,dirty_revision=revision+1 WHERE id=?').run(workerData.memberId);
    let released=false;
    const release=()=>{if(released)return;released=true;clearTimeout(timer);db.exec('COMMIT');db.close();parentPort.close();};
    const timer=setTimeout(release,2000);parentPort.on('message',release);parentPort.postMessage('locked');
  `, { eval: true, execArgv: [], workerData: {
    module: createRequire(import.meta.url).resolve("better-sqlite3"), path: join(stateDir, "quaymesh.sqlite"),
    sessionId: session.id, memberId: member.id,
  } });
  const exited = once(worker, "exit"); void exited.catch(() => {});
  const listener = createServer((_request, response) => {
    const active = f.database.sqlite.prepare("SELECT COUNT(*) FROM qm_runtime_work WHERE id=? AND kind='capture' AND blocking=1").pluck().get(lease.id);
    response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ active }));
  });
  const continued = deferred(), releaseContinuation = deferred();
  let timer: NodeJS.Timeout | undefined, pending: Promise<void> | undefined, next: Promise<void> | undefined;
  t.after(async () => {
    if (timer) clearInterval(timer);
    worker.postMessage("release");
    await bounded(exited, "fixture SQLite writer exits").catch(() => worker.terminate());
    releaseContinuation.resolve();
    await pending?.catch(() => {});
    await next?.catch(() => {});
    await lease.releaseAsync();
    await new Promise<void>(resolve => listener.close(() => resolve()));
    await execution.closeAsync(); await f.close();
  });
  await bounded(once(worker, "message"), "independent writer obtains the real SQLite write lock");
  listener.listen(0, "127.0.0.1"); await once(listener, "listening");
  const address = listener.address(); assert.ok(address && typeof address === "object");
  const publishing = deferred(), write = f.store.writeAsync.bind(f.store);
  let publications = 0;
  t.mock.method(f.store, "writeAsync", async <T>(action: () => T, options?: SqliteWriteOptions): Promise<T> => {
    if (publications++ === 0) publishing.resolve();
    else { continued.resolve(); await releaseContinuation.promise; }
    return write(action, options);
  });
  let settled = false, ticks = 0, last = performance.now(), maxGapMs = 0;
  timer = setInterval(() => { const now = performance.now(); maxGapMs = Math.max(maxGapMs, now - last); last = now; ticks++; }, 10);
  pending = lease.run(() => f.recovery.exportRoot(f.root)).finally(() => lease.releaseAsync()).then(() => { settled = true; });
  void pending.catch(() => {});
  await bounded(publishing.promise, "real export reaches asynchronous database publication");
  const requestStarted = performance.now();
  const response = await fetch(`http://127.0.0.1:${address.port}/idle`, { signal: AbortSignal.timeout(1000) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { active: 1 });
  const requestMs = performance.now() - requestStarted;
  const until = performance.now() + 1000;
  while (ticks < 3 && performance.now() < until) await delay(10);
  assert.ok(ticks >= 3);
  assert.ok(maxGapMs < 500, `timer gap ${maxGapMs} ms`);
  assert.equal(settled, false, "real writer still blocks metadata publication, not the event loop");
  assert.equal(f.database.sqlite.inTransaction, false);
  assert.equal(f.database.sqlite.pragma("busy_timeout", { simple: true }), 5000);
  assert.deepEqual((await f.recovery.readLocalHistoricalTable(f.root))[0]?.files, ["ready.txt"]);
  next = f.recovery.exportRoot(f.root); void next.catch(() => {});
  worker.postMessage("release");
  await bounded(Promise.all([pending, exited]), "publication commits and releases its capture lease after the competing writer exits");
  assert.equal(f.database.sqlite.prepare("SELECT COUNT(*) FROM qm_runtime_work WHERE id=?").pluck().get(lease.id), 0);
  const readRevision = () => f.database.sqlite.prepare("SELECT revision, exported_revision FROM qm_session_members WHERE id=?").get(member.id) as {
    revision: number; exported_revision: number;
  };
  assert.deepEqual(readRevision(), { revision: observedRevision + 1, exported_revision: observedRevision },
    "the old snapshot must not acknowledge the newer event committed while its metadata write waited");
  await bounded(continued.promise, "queued export reads the newly committed event");
  assert.deepEqual((await f.recovery.readLocalHistoricalTable(f.root))[0]?.files.sort(), ["during-lock.txt", "ready.txt"]);
  releaseContinuation.resolve();
  await bounded(next, "fresh continuation publishes the new revision");
  assert.deepEqual(readRevision(), { revision: observedRevision + 1, exported_revision: observedRevision + 1 });
  assert.equal(publications, 2);
  t.diagnostic(JSON.stringify({ requestMs, ticks, maxGapMs, publications }));
});

test("recovery export writes a short real table with operation and file facts", async (t) => {
  const f = await fixture();
  t.after(() => f.close());

  const session = f.store.createSession("owner-a", "conversation-recovery", "Login repair");
  const member = f.store.addMember(session.id, "desktop", "workspace-a", f.root, "checkout", null);
  const now = new Date().toISOString();
  f.store.appendEvent({
    session_id: session.id,
    member_id: member.id,
    type: "operation_finished",
    source_id: "op-ok-finish",
    timestamp: now,
    payload: {
      operation_id: "op-ok",
      kind: "command",
      label: "pnpm test",
      status: "succeeded",
      effect: "completed",
      result_ref: "output:op-ok",
      stdout: "this raw stdout must not be exported",
      environment: { API_KEY: "super-secret-value" },
    },
  });
  f.store.appendEvent({
    session_id: session.id,
    member_id: member.id,
    type: "operation_finished",
    source_id: "op-fail-finish",
    timestamp: now,
    payload: { operation_id: "op-fail", kind: "command", label: "pnpm build", status: "failed", effect: "completed", error_code: "EXIT_1" },
  });
  f.store.appendEvent({
    session_id: session.id,
    member_id: member.id,
    type: "operation_started",
    source_id: "op-running",
    timestamp: now,
    payload: { operation_id: "op-running", kind: "command", label: "pnpm dev", status: "running" },
  });
  f.store.appendEvent({
    session_id: session.id,
    member_id: member.id,
    type: "file_changed",
    source_id: "file-login",
    timestamp: now,
    payload: { path: "src/login.ts" },
  });
  f.store.appendEvent({
    session_id: session.id,
    member_id: member.id,
    type: "agent_changed",
    source_id: "agent-1",
    timestamp: now,
    payload: { agent_id: "agent-1", state: "working", name: "reviewer" },
  });
  f.store.appendEvent({
    session_id: session.id,
    member_id: member.id,
    type: "verification_recorded",
    source_id: "review-1",
    timestamp: now,
    payload: { decision: "passed" },
  });

  await f.recovery.exportRoot(f.root);

  const jsonText = await readFile(join(f.root, ".quaymesh", "sessions.json"), "utf8");
  const markdown = await readFile(join(f.root, ".quaymesh", "Sessions.md"), "utf8");
  const parsed = JSON.parse(jsonText) as { sessions: Array<Record<string, unknown>> };
  assert.equal(parsed.sessions.length, 1);
  const row = parsed.sessions[0]!;
  assert.equal(row.session_id, session.id);
  assert.equal(row.title, "Login repair");
  assert.deepEqual(row.files, ["src/login.ts"]);
  assert.deepEqual(row.commands, {
    succeeded: 1,
    failed: 1,
    running: 1,
    last_summary: "pnpm build",
  });
  assert.deepEqual(row.agents, { completed: 0, running: 1, failed: 0 });
  assert.equal(row.verification, "passed");
  assert.equal(row.execution_state, "idle");

  assert.match(markdown, /Login repair/);
  assert.match(markdown, /pnpm build/);
  assert.match(markdown, /src\/login\.ts/);
  assert.doesNotMatch(jsonText, /super-secret-value/);
  assert.doesNotMatch(markdown, /super-secret-value/);
  assert.doesNotMatch(jsonText, /raw stdout must not be exported/);
  assert.doesNotMatch(jsonText, /AGENTS\.md content/);

  const reopened = await f.recovery.readLocalHistoricalTable(f.root);
  assert.equal(reopened.length, 1);
  assert.equal(reopened[0]?.session_id, session.id);
});

test("recovery summary is bounded to five rows and detail is bounded to twenty operations", async (t) => {
  const f = await fixture();
  t.after(() => f.close());

  for (let index = 0; index < 7; index += 1) {
    const session = f.store.createSession("owner-a", `conversation-${index}`, `task-${index}`);
    const member = f.store.addMember(session.id, "desktop", `workspace-${index}`, f.root, "checkout", null);
    for (let operation = 0; operation < 25; operation += 1) {
      f.store.appendEvent({
        session_id: session.id,
        member_id: member.id,
        type: "operation_finished",
        source_id: `op-${index}-${operation}-finish`,
        timestamp: new Date(Date.now() - 60_000 + operation).toISOString(),
        payload: {
          operation_id: `op-${index}-${operation}`,
          kind: "command",
          label: `command-${index}-${operation}`,
          status: operation % 2 === 0 ? "succeeded" : "failed",
          effect: "completed",
          result_ref: `output:op-${index}-${operation}`,
        },
      });
    }

    const summary = f.recovery.summaryForOpen("owner-a", f.root);
    assert.ok(summary.length <= 5);

    const detail = f.recovery.detail("owner-a", f.root, session.id);
    assert.equal(detail.operations.length, 20);
    assert.equal(detail.operations.at(-1)?.label, `command-${index}-24`);
    assert.equal(detail.operations.at(0)?.label, `command-${index}-5`);
    assert.ok(detail.row.files.length <= 5);
  }
});

test("recovery keeps an interrupted session observable after the database is reopened", async (t) => {
  const f = await fixture();
  const stateDir = join(f.directory, "state");
  const session = f.store.createSession("owner-a", "conversation-interrupted", "Interrupted work");
  const member = f.store.addMember(session.id, "desktop", "workspace-a", f.root, "checkout", null);
  f.store.appendEvent({
    session_id: session.id,
    member_id: member.id,
    type: "operation_started",
    source_id: "op-unknown",
    timestamp: new Date().toISOString(),
    payload: { operation_id: "op-unknown", kind: "command", label: "long command", status: "running" },
  });
  f.store.setExecutionState(session.id, "interrupted" as never);
  await f.recovery.exportRoot(f.root);
  f.database.close();

  const reopened = openDatabase(stateDir);
  const store = new SessionStore(reopened.sqlite);
  const recovery = new RecoveryService(store, stateDir);
  try {
    const rows = recovery.summaryForOpen("owner-a", f.root);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.execution_state, "interrupted");
    assert.match(rows[0]?.next_step ?? "", /核对结果未知的操作/);
    const detail = recovery.detail("owner-a", f.root, session.id);
    assert.equal(detail.operations.length, 1);
    assert.equal(detail.operations[0]?.state, "running");
  } finally {
    await recovery.close();
    reopened.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
