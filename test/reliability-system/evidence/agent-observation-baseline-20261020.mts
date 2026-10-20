import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {Worker} from 'node:worker_threads';
import {setTimeout as delay} from 'node:timers/promises';
const repo = process.argv[2];
if (!repo) throw new Error('Pass the unmodified repository directory.');
const {SessionStore} = await import(pathToFileURL(join(repo, 'src/session/store.ts')).href);
const {databasePath, openDatabase} = await import(pathToFileURL(join(repo, 'src/db/client.ts')).href);
const root = await mkdtemp(join(tmpdir(), 'qm-agent-observation-baseline-'));
const database = openDatabase(root), store = new SessionStore(database.sqlite);
const released = new Int32Array(new SharedArrayBuffer(4));
let worker: Worker | undefined, timer: NodeJS.Timeout | undefined;
try {
  const session = store.createSession('fixture-owner', 'fixture-conversation', 'Observation baseline');
  const waitMs = 1500;
  worker = new Worker(`const {parentPort,workerData}=require('node:worker_threads');
    const Database=require(workerData.modulePath),db=new Database(workerData.filename);
    db.exec('BEGIN IMMEDIATE');parentPort.postMessage('locked');
    setTimeout(()=>{db.exec('ROLLBACK');Atomics.store(new Int32Array(workerData.released),0,1);db.close();parentPort.close();},workerData.waitMs);`,
    {eval:true,workerData:{filename:databasePath(root),modulePath:createRequire(join(repo,'package.json')).resolve('better-sqlite3'),released:released.buffer,waitMs}});
  const done = new Promise<void>((resolve,reject)=>{worker!.once('exit',code=>code===0?resolve():reject(new Error('worker exit '+code)));worker!.once('error',reject);});
  await new Promise<void>((resolve,reject)=>{worker!.once('message',()=>resolve());worker!.once('error',reject);});
  let timerDelayMs: number | null = null;
  const start = performance.now();
  timer = setTimeout(()=>{timerDelayMs=performance.now()-start;},10);
  store.rememberAgentObservation(session.id,'fixture-agent','fixture-turn',1);
  const methodElapsedMs = performance.now()-start;
  const writerReleasedAtReturn = Atomics.load(released,0)===1;
  await done;await delay(20);
  const result = {scope:'Unmodified SessionStore.rememberAgentObservation, real independent Worker SQLite writer; no TCP',runtime:process.version,busy_timeout:database.sqlite.pragma('busy_timeout',{simple:true}),writer_hold_ms:waitMs,method_elapsed_ms:methodElapsedMs,timer_requested_ms:10,timer_elapsed_ms:timerDelayMs,writer_released_at_method_return:writerReleasedAtReturn,saved:store.lastAgentObservation(session.id,'fixture-agent')};
  await writeFile('/tmp/quaymesh-agent-observation-baseline-20261020.json',JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));
} finally {if(timer)clearTimeout(timer);if(worker)await worker.terminate();database.close();await rm(root,{recursive:true,force:true});}
