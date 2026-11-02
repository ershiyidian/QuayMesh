import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { Worker } from "node:worker_threads";
import Database from "better-sqlite3";
import { openDatabase } from "../db/client.js";
import { ExecutionCoordinator } from "../execution-coordinator.js";
import { git } from "../git.js";
import { SessionChangeCollector } from "./changes.js";
import { SessionStore } from "./store.js";

async function until(check: () => boolean, message: string): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (!check()) { assert.ok(performance.now() < deadline, message); await delay(10); }
}

async function fixture(t: TestContext, taskScoped: boolean) {
  const directory = await mkdtemp(join(tmpdir(), "qm-capture-publish-"));
  const root = join(directory, "project"), stateDir = join(directory, "state");
  await mkdir(root);
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "capture-publish@example.invalid"]);
  await git(root, ["config", "user.name", "Capture publication test"]);
  await writeFile(join(root, "tracked.txt"), "base\n");
  await writeFile(join(root, ".gitattributes"), "tracked.txt filter=capturewait\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "baseline"]);
  const database = openDatabase(stateDir), store = new SessionStore(database.sqlite);
  const execution = new ExecutionCoordinator(stateDir);
  const reader = new Database(join(stateDir, "quaymesh.sqlite"), { readonly: true });
  reader.pragma("query_only = ON");
  const readerStore = new SessionStore(reader);
  const collector = new SessionChangeCollector(store, stateDir, execution);
  const session = store.createSession("owner", "capture-publication", "Capture publication");
  const member = store.addMember(session.id, "local", "workspace", root, "checkout", null);
  const taskId = taskScoped ? store.createTask(session.id, "Atomic capture publication").id : undefined;
  if (taskId) store.touchTaskMember(taskId, member.id);
  const filterEntered = join(directory, "filter-entered"), filterRelease = join(directory, "filter-release");
  t.after(async () => {
    await writeFile(filterRelease, "release");
    await collector.close(); await execution.close(); reader.close(); database.close();
    await rm(directory, { recursive: true, force: true });
  });
  await collector.ensureBaseline(member, ["tracked.txt"], root, taskId);
  await writeFile(join(root, "tracked.txt"), "base\nfirst change\n");
  await collector.capture(member.id, taskId);
  const snapshot = () => reader.transaction(() => ({
    baseline: readerStore.getChangeBaseline(session.id, member.id, root, taskId),
    files: readerStore.fileSummaries(session.id, member.id, taskId),
    events: readerStore.eventsByType(session.id, "file_changed").length,
  })).deferred();
  const leaseCount = () => Number(reader.prepare("SELECT count(*) FROM qm_runtime_work WHERE kind='capture' AND blocking=1").pluck().get());
  return { directory, root, stateDir, database, store, execution, reader, collector, session, member, taskId,
    filterEntered, filterRelease, snapshot, leaseCount,
    async blockGit() {
      const script = join(directory, "wait-filter.mjs");
      await writeFile(script, `import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
const data=readFileSync(0);writeFileSync(process.argv[2],'ready');
const deadline=Date.now()+15000;
while(!existsSync(process.argv[3])){if(Date.now()>deadline)throw new Error('filter timeout');await delay(10);}
process.stdout.write(data);\n`);
      const quote = (value: string) => '"' + value.replaceAll('"', '\\"') + '"';
      await git(root, ["config", "filter.capturewait.clean", [process.execPath, script, filterEntered, filterRelease].map(quote).join(" ")]);
      await git(root, ["config", "filter.capturewait.required", "true"]);
    },
  };
}

async function holdWriter(path: string, holdMs: number) {
  const worker = new Worker(`const {workerData,parentPort}=require('node:worker_threads');
const Database=require(workerData.module),db=new Database(workerData.path);
db.exec('BEGIN IMMEDIATE');
let closed=false;const release=()=>{if(closed)return;closed=true;clearTimeout(timer);db.exec('ROLLBACK');db.close();parentPort.close();};
const timer=setTimeout(release,workerData.holdMs);parentPort.on('message',release);parentPort.postMessage('locked');`,
  { eval: true, execArgv: [], workerData: { path, holdMs, module: createRequire(import.meta.url).resolve("better-sqlite3") } });
  const exit = once(worker, "exit");
  await once(worker, "message");
  return { worker, exit, async close() { worker.postMessage("release"); await worker.terminate(); await exit.catch(() => {}); } };
}

for (const taskScoped of [false, true]) {
  test(`${taskScoped ? "Task" : "legacy session"} capture waits for a real SQLite writer without blocking timers or publishing partial evidence`,
    { timeout: 20_000 }, async t => {
      const f = await fixture(t, taskScoped), before = f.snapshot();
      await f.blockGit();
      await writeFile(join(f.root, "tracked.txt"), "base\nfirst change\nsecond change\n");
      const seen: ReturnType<typeof f.snapshot>[] = [];
      let changedNotifications = 0, capturedNotifications = 0, ticks = 0, maxGapMs = 0;
      f.store.onChange(() => { changedNotifications++; seen.push(f.snapshot()); assert.equal(f.database.sqlite.inTransaction, false); });
      f.collector.setCaptureListener(() => {
        capturedNotifications++; seen.push(f.snapshot());
        assert.equal(f.leaseCount(), 1, "the real capture lease still owns post-commit notification");
      });
      f.database.sqlite.function("observe_capture_publication", () => { seen.push(f.snapshot()); return 1; });
      const baselineTable = taskScoped ? "qm_task_change_baselines" : "qm_change_baselines";
      const filesTable = taskScoped ? "qm_task_file_changes" : "qm_file_changes";
      f.database.sqlite.exec(`CREATE TRIGGER observe_capture_baseline AFTER UPDATE OF latest_ref ON ${baselineTable}
        BEGIN SELECT observe_capture_publication(); END;
        CREATE TRIGGER observe_capture_files BEFORE INSERT ON ${filesTable}
        BEGIN SELECT observe_capture_publication(); END;`);
      const capture = f.collector.capture(f.member.id, f.taskId);
      void capture.catch(() => {});
      await until(() => existsSync(f.filterEntered), "capture has its real lease and is inside Git");
      assert.equal(f.leaseCount(), 1);
      const blocker = await holdWriter(join(f.stateDir, "quaymesh.sqlite"), 1_000);
      let last = performance.now();
      const interval = setInterval(() => {
        const now = performance.now(); maxGapMs = Math.max(maxGapMs, now - last); last = now; ticks++;
        seen.push(f.snapshot());
      }, 20);
      try {
        await writeFile(f.filterRelease, "release");
        await capture;
        await delay(25);
        clearInterval(interval);
        const after = f.snapshot();
        t.diagnostic(JSON.stringify({ heldMs: 1000, ticks, maxGapMs, observations: seen.length }));
        assert.ok(ticks >= 10, `the timer ran only ${ticks} times during the held write lock`);
        assert.ok(maxGapMs < 500, `the timer stalled for ${maxGapMs} ms`);
        assert.notEqual(after.baseline!.latest_ref, before.baseline!.latest_ref);
        assert.equal(after.files.length, 1); assert.equal(after.files[0]!.additions, 2);
        assert.equal(after.events, before.events + 1);
        assert.equal(changedNotifications, 1); assert.equal(capturedNotifications, 1);
        for (const observed of seen) assert.ok(
          JSON.stringify(observed) === JSON.stringify(before) || JSON.stringify(observed) === JSON.stringify(after),
          "an independent read must see the complete previous or complete published capture");
        assert.equal(f.leaseCount(), 0);
        assert.match(await readFile(after.files[0]!.patchRef, "utf8"), /\+second change/);
        await blocker.exit;
      } finally { clearInterval(interval); await blocker.close(); }
    });
}

test("failed capture publication rolls back baseline, files and event together, then publishes once after repair", async t => {
  const f = await fixture(t, true), before = f.snapshot();
  let changed = 0, captured = 0;
  f.store.onChange(() => { changed++; }); f.collector.setCaptureListener(() => { captured++; });
  await writeFile(join(f.root, "tracked.txt"), "base\nfirst change\nsecond change\n");
  f.database.sqlite.exec(`CREATE TRIGGER refuse_capture BEFORE INSERT ON qm_task_file_changes
    BEGIN SELECT RAISE(ABORT, 'publication fixture failure'); END`);
  await assert.rejects(f.collector.capture(f.member.id, f.taskId), /publication fixture failure/);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(changed, 0); assert.equal(captured, 0); assert.equal(f.leaseCount(), 0);
  assert.equal(f.collector.captureObservation(f.member.id, f.taskId).state, "failed");
  f.database.sqlite.exec("DROP TRIGGER refuse_capture");
  await f.collector.capture(f.member.id, f.taskId);
  assert.equal(f.snapshot().events, before.events + 1);
  assert.equal(f.snapshot().files[0]!.additions, 2);
  assert.equal(changed, 1); assert.equal(captured, 1);
  assert.equal(f.collector.captureObservation(f.member.id, f.taskId).state, "idle");
});
