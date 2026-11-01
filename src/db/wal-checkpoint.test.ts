import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";
import test from "node:test";
import Database from "better-sqlite3";
import { databasePath, openDatabase, openReadonlyDatabase, type DatabaseHandle } from "./client.js";
import { startDatabaseCheckpoints, type WalCheckpointDiagnostic, type WalCheckpointLease } from "./wal-checkpoint.js";
import { WAL_CHECKPOINT_GUARD_PAGES, WAL_CHECKPOINT_TARGET_PAGES } from "./wal-checkpoint-protocol.js";

const execute = promisify(execFile);
const modulePath = createRequire(import.meta.url).resolve("better-sqlite3");
function automatic(db: Database.Database): number { return db.pragma("wal_autocheckpoint", { simple: true }) as number; }
function frameState(db: Database.Database): { busy: number; log: number; checkpointed: number } {
  return (db.pragma("wal_checkpoint(NOOP)") as Array<{ busy: number; log: number; checkpointed: number }>)[0]!;
}
async function until(condition: () => boolean, timeout = 4_000): Promise<void> {
  const end = performance.now() + timeout;
  while (!condition()) { if (performance.now() > end) throw new Error("condition not reached"); await delay(10); }
}
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "qm-wal-checkpoint-"));
  const handles: DatabaseHandle[] = [openDatabase(directory)];
  const leases: WalCheckpointLease[] = [];
  const db = handles[0]!.sqlite;
  db.exec("CREATE TABLE checkpoint_records(id INTEGER PRIMARY KEY, payload BLOB)");
  db.pragma("wal_checkpoint(TRUNCATE)");
  return { directory, path: databasePath(directory), db, handles, leases,
    writer() { const handle = openDatabase(directory); handles.push(handle); return handle.sqlite; },
    start(options: Parameters<typeof startDatabaseCheckpoints>[1] = {}) {
      const lease = startDatabaseCheckpoints(databasePath(directory), options); leases.push(lease); return lease;
    },
    async close() {
      for (const handle of handles) if (handle.sqlite.open) handle.close();
      for (const lease of leases) await lease.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
function insertPages(db: Database.Database, rows: number): void {
  const statement = db.prepare("INSERT INTO checkpoint_records(payload) VALUES(zeroblob(3900))");
  db.transaction(() => { for (let i = 0; i < rows; i++) statement.run(); })();
}

test("real worker checkpoints a WAL above 1000 pages while every live writer retains NORMAL and a finite guard", { timeout: 12_000 }, async t => {
  const f = fixture(), events: WalCheckpointDiagnostic[] = [];
  t.after(() => f.close());
  assert.equal(automatic(f.db), 1000);
  const lease = f.start({ report: event => events.push(event) });
  // Startup is asynchronous: the original policy is still active before ready.
  assert.equal(automatic(f.db), 1000);
  assert.equal(await lease.ready, true);
  const second = f.writer();
  const outsider = new Database(f.path), readonly = openReadonlyDatabase(f.directory);
  try {
    assert.equal(automatic(f.db), WAL_CHECKPOINT_GUARD_PAGES);
    assert.equal(automatic(second), WAL_CHECKPOINT_GUARD_PAGES);
    assert.equal(automatic(outsider), WAL_CHECKPOINT_TARGET_PAGES);
    assert.equal(automatic(readonly.sqlite), WAL_CHECKPOINT_TARGET_PAGES);
    assert.equal(f.db.pragma("synchronous", { simple: true }), 1);
    assert.equal(second.pragma("synchronous", { simple: true }), 1);
    assert.equal(f.db.pragma("busy_timeout", { simple: true }), 5000);
    const start = performance.now();
    insertPages(f.db, 1_200);
    const afterCommit = frameState(f.db);
    assert.ok(afterCommit.log >= 1_000 && afterCommit.log < 4_096);
    assert.ok(afterCommit.checkpointed < afterCommit.log, "commit must not have checkpointed this batch on the caller");
    await until(() => events.some(event => event.phase === "passive" && event.log! >= 1_000 && event.log === event.checkpointed));
    const afterWorker = frameState(second);
    assert.equal(afterWorker.log, afterWorker.checkpointed);
    assert.equal(readonly.sqlite.prepare("SELECT count(*) FROM checkpoint_records").pluck().get(), 1_200);
    assert.equal(f.db.pragma("quick_check", { simple: true }), "ok");
    assert.equal(f.db.pragma("busy_timeout", { simple: true }), 5000);
    t.diagnostic(JSON.stringify({ rows: 1200, afterCommit, afterWorker, elapsedMs: performance.now() - start,
      passive: events.filter(event => event.phase === "passive") }));
  } finally { outsider.close(); readonly.close(); }
});

test("a reader-held WAL causes bounded-policy fallback and resumes background work when the reader ends", { timeout: 12_000 }, async t => {
  const f = fixture(), events: WalCheckpointDiagnostic[] = [], reader = new Database(f.path, { readonly: true });
  t.after(async () => { if (reader.open) { if (reader.inTransaction) reader.exec("ROLLBACK"); reader.close(); } await f.close(); });
  assert.equal(await f.start({ report: event => events.push(event) }).ready, true);
  reader.exec("BEGIN");
  reader.prepare("SELECT count(*) FROM checkpoint_records").get();
  insertPages(f.db, 4_300);
  await until(() => events.some(event => event.phase === "fallback" && event.reason === "wal_pressure"));
  assert.equal(automatic(f.db), 1000);
  const held = frameState(f.db);
  assert.ok(held.log - held.checkpointed >= 4096);
  assert.equal(reader.prepare("SELECT count(*) FROM checkpoint_records").pluck().get(), 0);
  // Automatic PASSIVE checkpoints cannot force a reader to release its snapshot.
  reader.exec("ROLLBACK");
  await until(() => automatic(f.db) === 4096 && frameState(f.db).log === frameState(f.db).checkpointed);
  assert.equal(reader.prepare("SELECT count(*) FROM checkpoint_records").pluck().get(), 4300);
  assert.equal(f.db.pragma("synchronous", { simple: true }), 1);
  t.diagnostic(JSON.stringify({ held, pressureFallback: true, recovered: true }));
});

test("worker startup failure and actual worker termination restore defaults, including raw-close tracking", { timeout: 12_000 }, async t => {
  const f = fixture(), events: WalCheckpointDiagnostic[] = [];
  t.after(() => f.close());
  const failed = f.start({ report: event => events.push(event),
    createWorker: (_entry, options) => new Worker(new URL("./missing-checkpoint-worker.js", import.meta.url), options) });
  assert.equal(await failed.ready, false);
  assert.equal(automatic(f.db), 1000);
  insertPages(f.db, 3);
  await failed.close();
  const custom = f.writer(); custom.pragma("wal_autocheckpoint = 23");
  let worker: Worker | undefined;
  const lease = f.start({ report: event => events.push(event), createWorker: (entry, options) => worker = new Worker(entry, options) });
  assert.equal(await lease.ready, true);
  const second = f.writer();
  assert.equal(automatic(custom), 23);
  // Close the original handle through the raw API used by SessionStore.
  f.db.close();
  assert.equal(automatic(second), 4096);
  await worker!.terminate();
  await until(() => automatic(second) === 1000);
  assert.equal(automatic(custom), 23);
  assert.ok(!events.some(event => event.reason === "pragma_failed"));
  insertPages(second, 7);
  assert.equal(second.prepare("SELECT count(*) FROM checkpoint_records").pluck().get(), 10);
  assert.equal(second.pragma("busy_timeout", { simple: true }), 5000);
  assert.equal(second.pragma("quick_check", { simple: true }), "ok");
});

test("multiple Core owners share one real worker; normal shutdown waits for its final database close", { timeout: 12_000 }, async t => {
  const f = fixture(); let workers = 0, worker: Worker | undefined, exited = false;
  t.after(() => f.close());
  const first = f.start({ createWorker: (entry, options) => {
    workers++; worker = new Worker(entry, options); worker.once("exit", () => { exited = true; }); return worker;
  } });
  const second = f.start({ createWorker: () => { throw new Error("must reuse the maintenance owner"); } });
  assert.equal(await first.ready, true); assert.equal(await second.ready, true); assert.equal(workers, 1);
  await first.close(); assert.equal(exited, false); assert.equal(automatic(f.db), 4096);
  insertPages(f.db, 15);
  // Native last-connection cleanup belongs to the still-open maintenance worker.
  f.handles[0]!.close();
  assert.equal(exited, false);
  await second.close();
  assert.equal(exited, true); assert.equal(worker!.threadId, -1);
  const reopened = new Database(f.path);
  try { assert.equal(reopened.prepare("SELECT count(*) FROM checkpoint_records").pluck().get(), 15);
    assert.equal(reopened.pragma("quick_check", { simple: true }), "ok"); }
  finally { reopened.close(); }
});

test("a live but unresponsive worker triggers fallback without pretending its native work has stopped", { timeout: 15_000 }, async t => {
  const f = fixture(), events: WalCheckpointDiagnostic[] = []; let worker: Worker | undefined;
  t.after(() => f.close());
  const lease = f.start({ report: event => events.push(event), createWorker: (_entry, options) => worker = new Worker(`
    const {parentPort,workerData}=require('node:worker_threads');
    const Database=require(workerData.modulePath),db=new Database(workerData.path);
    db.pragma('synchronous=NORMAL');
    parentPort.on('message',message=>{if(message==='close'){db.close();parentPort.close();}});
    parentPort.postMessage({type:'ready',snapshot:db.pragma('wal_checkpoint(NOOP)')[0]});
    db.function('slow_native_callback',()=>{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,7500);return 1;});
    db.prepare('SELECT slow_native_callback()').get();
  `, { ...options, eval: true, workerData: { ...options.workerData, modulePath } }) });
  assert.equal(await lease.ready, true);
  assert.equal(automatic(f.db), 4096);
  // The worker is unavailable, yet automatic checkpointing was never disabled.
  // A large transaction still invokes the finite native guard before watchdog recovery.
  insertPages(f.db, 4_300);
  const guarded = frameState(f.db);
  assert.ok(guarded.log >= 4096); assert.equal(guarded.log, guarded.checkpointed);
  await until(() => events.some(event => event.reason === "worker_unresponsive"), 8_000);
  assert.equal(automatic(f.db), 1000);
  assert.notEqual(worker!.threadId, -1);
  insertPages(f.db, 2);
  assert.equal(f.db.prepare("SELECT count(*) FROM checkpoint_records").pluck().get(), 4302);
  await lease.close();
  assert.equal(worker!.threadId, -1);
});

test("the packaged native addon survives 500 real worker-thread close/GC cycles and ten worker teardowns", { timeout: 60_000 }, async t => {
  const f = fixture(); t.after(() => f.close());
  insertPages(f.db, 1);
  const program = `import {Worker} from 'node:worker_threads';import assert from 'node:assert/strict';
    const [modulePath,path]=process.argv.slice(1);
    for(let round=0;round<10;round++) {
      const worker=new Worker(\`const {parentPort,workerData}=require('node:worker_threads');
        const Database=require(workerData.modulePath);if(typeof global.gc!=='function')throw Error('gc not exposed');
        for(let i=0;i<50;i++){let db=new Database(workerData.path,{fileMustExist:true});
          if(db.prepare('SELECT count(*) FROM checkpoint_records').pluck().get()!==1)throw Error('row changed');
          db.close();db=null;global.gc();}parentPort.postMessage(50);parentPort.close();\`,
        {eval:true,execArgv:[],workerData:{modulePath,path}});
      let count=0;worker.on('message',n=>count=n);
      await new Promise((resolve,reject)=>{worker.once('error',reject);worker.once('exit',code=>code===0?resolve():reject(Error('worker exit '+code)));});
      assert.equal(count,50);global.gc();
    }process.stdout.write(JSON.stringify({cycles:500,workers:10,result:'pass'}));`;
  const { stdout } = await execute(process.execPath, ["--expose-gc", "--input-type=module", "-e", program, modulePath, f.path], { timeout: 50_000 });
  assert.deepEqual(JSON.parse(stdout), { cycles: 500, workers: 10, result: "pass" });
});

test("a small committed batch is written back by the timed worker without waiting for 1000 pages", { timeout: 8_000 }, async t => {
  const f = fixture(), events: WalCheckpointDiagnostic[] = [];
  t.after(() => f.close());
  assert.equal(await f.start({ report: event => events.push(event) }).ready, true);
  insertPages(f.db, 9);
  const pending = frameState(f.db);
  assert.ok(pending.log > 0 && pending.log < 1000 && pending.checkpointed < pending.log);
  await until(() => events.some(event => event.phase === "passive" && event.log! > 0 && event.log === event.checkpointed));
  assert.equal(frameState(f.db).log, frameState(f.db).checkpointed);
  assert.equal(f.db.pragma("synchronous", { simple: true }), 1);
});
