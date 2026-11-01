import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { Worker } from "node:worker_threads";
import Database from "better-sqlite3";
import { runSqliteWrite } from "./async-write.js";
import type { SqliteWriteDiagnostic } from "./write-diagnostics.js";
import { SessionStore } from "../session/store.js";
import { ServerDiagnostics } from "../server-diagnostics.js";

function fixture() {
  const directory=mkdtempSync(join(tmpdir(),"qm-async-write-")),path=join(directory,"test.sqlite");
  const db=new Database(path);
  db.pragma("journal_mode = WAL");db.pragma("busy_timeout = 137");
  db.exec("CREATE TABLE entries(id INTEGER PRIMARY KEY,value TEXT)");
  return {db,path,directory,close(){if(db.open)db.close();rmSync(directory,{recursive:true,force:true});}};
}

function slowStatement(db: Database.Database) {
  const wait = new Int32Array(new SharedArrayBuffer(4));
  db.function("diagnostic_fixture_pause", () => { Atomics.wait(wait, 0, 0, 75); return 1; });
  return db.prepare("SELECT diagnostic_fixture_pause()");
}

test("独立 Worker 持有五秒真实写锁时，读取和计时器继续响应，写入体只执行一次",{timeout:15_000},async t=>{
  const f=fixture(),reader=new Database(f.path,{readonly:true});
  const worker=new Worker(`
    const {workerData,parentPort}=require('node:worker_threads');
    const Database=require(workerData.module),db=new Database(workerData.path);
    db.exec('BEGIN IMMEDIATE');db.prepare('INSERT INTO entries(value) VALUES(?)').run('uncommitted');
    let closed=false;const release=()=>{if(closed)return;closed=true;clearTimeout(timer);db.exec('ROLLBACK');db.close();parentPort.close();};
    const timer=setTimeout(release,5000);parentPort.on('message',release);parentPort.postMessage('locked');
  `,{eval:true,execArgv:[],workerData:{module:createRequire(import.meta.url).resolve("better-sqlite3"),path:f.path}});
  const exit=once(worker,"exit");
  let interval:NodeJS.Timeout|undefined;
  try {
    await once(worker,"message");
    let calls=0,ticks=0,maxGapMs=0,last=performance.now();const start=last;
    const diagnostics:SqliteWriteDiagnostic[]=[];
    const reportedConnections:Array<{transaction:boolean;timeout:number}>=[];
    const checks:Array<{count:number;transaction:boolean;timeout:number}>=[];
    interval=setInterval(()=>{
      const now=performance.now();maxGapMs=Math.max(maxGapMs,now-last);last=now;ticks++;
      checks.push({count:reader.prepare("SELECT count(*) FROM entries").pluck().get() as number,
        transaction:f.db.inTransaction,timeout:f.db.pragma("busy_timeout",{simple:true}) as number});
    },20);
    const value=await runSqliteWrite(f.db,()=>{
      calls++;
      // 现有同步事务可嵌套为 savepoint，不需要改写内部 API。
      return f.db.transaction(()=>f.db.prepare("INSERT INTO entries(value) VALUES(?)").run("once").changes).immediate();
    },{timeoutMs:10_000,diagnosticSource:"session_feed_update",diagnostics:event=>{
      diagnostics.push(event);
      reportedConnections.push({transaction:f.db.inTransaction,timeout:f.db.pragma("busy_timeout",{simple:true}) as number});
    }});
    clearInterval(interval);interval=undefined;
    assert.equal(value,1);assert.equal(calls,1);assert.ok(ticks>=20);
    assert.ok(maxGapMs<1000,`计时器最长间隔 ${maxGapMs} ms`);
    assert.ok(checks.every(row=>row.count===0 && !row.transaction && row.timeout===137));
    assert.deepEqual(reader.prepare("SELECT value FROM entries").all(),[{value:"once"}]);
    assert.equal(f.db.inTransaction,false);assert.equal(f.db.pragma("busy_timeout",{simple:true}),137);
    assert.equal(diagnostics.length,1);
    const diagnostic=diagnostics[0]!;
    assert.equal(diagnostic.source,"session_feed_update");assert.equal(diagnostic.outcome,"committed");
    assert.ok(diagnostic.retryCount>0);assert.ok(diagnostic.retryScheduledMs>0);
    assert.ok(diagnostic.retryElapsedMs>=4000);assert.ok(diagnostic.elapsedMs>=diagnostic.retryElapsedMs);
    assert.equal(diagnostic.attempts,diagnostic.phases.begin.count);
    assert.equal(diagnostic.retryCount,diagnostic.attempts-1);
    assert.equal(diagnostic.phases.body.count,1);assert.equal(diagnostic.phases.commit.count,1);
    assert.equal(diagnostic.phases.rollback.count,0);assert.equal(diagnostic.phases.restore.count,diagnostic.attempts);
    assert.equal(diagnostic.errorStage,undefined);assert.equal(diagnostic.cleanupFailed,false);
    assert.deepEqual(reportedConnections,[{transaction:false,timeout:137}]);
    t.diagnostic(JSON.stringify({heldMs:5000,elapsedMs:performance.now()-start,ticks,maxGapMs,calls}));
    await exit;
  } finally {
    if(interval)clearInterval(interval);
    worker.postMessage("release");await worker.terminate();await exit.catch(()=>{});
    reader.close();f.close();
  }
});

test("事务体真实 SQLITE_BUSY 与提交约束失败都回滚且绝不重放",async()=>{
  const f=fixture(),competitor=new Database(f.path);
  competitor.pragma("busy_timeout = 0");
  try {
    let calls=0,nativeError:unknown;
    await assert.rejects(runSqliteWrite(f.db,()=>{
      calls++;f.db.prepare("INSERT INTO entries(value) VALUES(?)").run("must-rollback");
      try {competitor.prepare("INSERT INTO entries(value) VALUES(?)").run("locked-by-body");}
      catch(error) {nativeError=error;throw error;}
    }),error=>error===nativeError && (error as {code?:string}).code==="SQLITE_BUSY");
    assert.equal(calls,1);assert.equal(f.db.prepare("SELECT count(*) FROM entries").pluck().get(),0);
    assert.equal(f.db.inTransaction,false);assert.equal(f.db.pragma("busy_timeout",{simple:true}),137);

    f.db.pragma("foreign_keys = ON");
    f.db.exec("CREATE TABLE parent(id INTEGER PRIMARY KEY);CREATE TABLE child(parent_id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)");
    let commitCalls=0;
    await assert.rejects(runSqliteWrite(f.db,()=>{
      commitCalls++;f.db.prepare("INSERT INTO child VALUES(999)").run();
    }),{code:"SQLITE_CONSTRAINT_FOREIGNKEY"});
    assert.equal(commitCalls,1);assert.equal(f.db.prepare("SELECT count(*) FROM child").pluck().get(),0);
    assert.equal(f.db.inTransaction,false);assert.equal(f.db.pragma("busy_timeout",{simple:true}),137);
  } finally {competitor.close();f.close();}
});

test("取锁预算和取消保留原错误且不进入事务体、不留下事务或临时 pragma",async()=>{
  const f=fixture(),blocker=new Database(f.path);let calls=0;
  try {
    blocker.exec("BEGIN IMMEDIATE");
    const write=()=>{calls++;f.db.prepare("INSERT INTO entries(value) VALUES(?)").run("unexpected");};
    await assert.rejects(runSqliteWrite(f.db,write,{timeoutMs:35}),{code:"SQLITE_BUSY"});
    assert.equal(calls,0);assert.equal(f.db.inTransaction,false);assert.equal(f.db.pragma("busy_timeout",{simple:true}),137);
    await assert.rejects(runSqliteWrite(f.db,write,{timeoutMs:0}),{code:"SQLITE_BUSY"});
    const controller=new AbortController(),reason=new Error("cancel only the lock wait");
    const pending=runSqliteWrite(f.db,write,{signal:controller.signal});
    const rejected=assert.rejects(pending,error=>error===reason);
    await delay(25);controller.abort(reason);await rejected;
    await assert.rejects(runSqliteWrite(f.db,write,{signal:controller.signal}),error=>error===reason);
    assert.equal(calls,0);assert.equal(f.db.inTransaction,false);assert.equal(f.db.pragma("busy_timeout",{simple:true}),137);
  } finally {if(blocker.inTransaction)blocker.exec("ROLLBACK");blocker.close();f.close();}
});

test("已有外层事务与异步回调被拒绝，普通回调返回 Promise 也会回滚",async()=>{
  const f=fixture();let calls=0;
  try {
    f.db.exec("BEGIN IMMEDIATE");f.db.prepare("INSERT INTO entries(value) VALUES(?)").run("outer");
    await assert.rejects(runSqliteWrite(f.db,()=>{calls++;}),{code:"SQLITE_WRITE_OUTER_TRANSACTION"});
    assert.equal(f.db.inTransaction,true);assert.equal(f.db.prepare("SELECT value FROM entries").pluck().get(),"outer");
    f.db.exec("ROLLBACK");assert.equal(calls,0);
    const asyncWrite=async()=>{calls++;f.db.prepare("INSERT INTO entries(value) VALUES(?)").run("async");};
    await assert.rejects(runSqliteWrite(f.db,asyncWrite),{code:"SQLITE_WRITE_ASYNC_CALLBACK"});
    await assert.rejects(runSqliteWrite(f.db,asyncWrite.bind(null)),{code:"SQLITE_WRITE_ASYNC_CALLBACK"});
    assert.equal(calls,0);
    await assert.rejects(runSqliteWrite(f.db,()=>{
      calls++;f.db.prepare("INSERT INTO entries(value) VALUES(?)").run("promise");
      return Promise.reject(new Error("must be observed"));
    }),{code:"SQLITE_WRITE_ASYNC_CALLBACK"});
    await delay(0);
    assert.equal(calls,1);assert.equal(f.db.prepare("SELECT count(*) FROM entries").pluck().get(),0);
    assert.equal(f.db.inTransaction,false);assert.equal(f.db.pragma("busy_timeout",{simple:true}),137);
    await assert.rejects(runSqliteWrite(f.db,()=>{calls++;},{timeoutMs:-1}),RangeError);
    assert.equal(calls,1);
  } finally {if(f.db.inTransaction)f.db.exec("ROLLBACK");f.close();}
});

test("等待期间出现外层事务时拒绝接管，保留其他调用的事务与连接设置",async()=>{
  const f=fixture(),blocker=new Database(f.path);let calls=0;
  try {
    blocker.exec("BEGIN IMMEDIATE");
    const pending=runSqliteWrite(f.db,()=>{calls++;},{timeoutMs:1000});
    const rejected=assert.rejects(pending,{code:"SQLITE_WRITE_OUTER_TRANSACTION"});
    f.db.pragma("busy_timeout = 23");f.db.exec("BEGIN");
    await rejected;
    assert.equal(calls,0);assert.equal(f.db.inTransaction,true);
    assert.equal(f.db.pragma("busy_timeout",{simple:true}),23);
  } finally {if(f.db.inTransaction)f.db.exec("ROLLBACK");if(blocker.inTransaction)blocker.exec("ROLLBACK");blocker.close();f.close();}
});

test("清理连接设置失败时仍保留原 SQLite 错误码与 cause",async()=>{
  const f=fixture(),pause=slowStatement(f.db),events:SqliteWriteDiagnostic[]=[];let original:unknown,calls=0;
  try {
    await assert.rejects(runSqliteWrite(f.db,()=>{
      calls++;pause.get();
      try {f.db.prepare("INSERT INTO absent_table VALUES(1)").run();}
      catch(error) {
        original=error;
        // 用真实关闭连接制造恢复失败，验证清理异常不会覆盖最初的 SQLite 错误。
        f.db.exec("ROLLBACK");f.db.close();throw error;
      }
    },{diagnostics:event=>events.push(event)}),error=>error instanceof AggregateError && error.cause===original && "code" in error && error.code==="SQLITE_ERROR");
    assert.equal(calls,1);
    assert.equal(events.length,1);assert.equal(events[0]!.cleanupFailed,true);
    assert.equal(events[0]!.errorStage,"body");assert.equal(events[0]!.errorCode,"SQLITE_ERROR");
  } finally {f.close();}
});

test("慢事务体的诊断在提交并恢复连接后才进入异步日志",async()=>{
  const f=fixture(),pause=slowStatement(f.db),path=join(f.directory,"logs","server-diagnostics.jsonl");
  const diagnostics=new ServerDiagnostics({stateDir:f.directory,logging:{
    level:"info",format:"json",requests:false,assets:false,toolCalls:false,shellCommands:false,trustProxy:false,
  }});
  const reportedConnections:Array<{transaction:boolean;timeout:number}>=[];
  const store=new SessionStore(f.db,false,event=>{
    reportedConnections.push({transaction:f.db.inTransaction,timeout:f.db.pragma("busy_timeout",{simple:true}) as number});
    diagnostics.record("sqlite_write",{...event},"info");
  });
  try {
    const value=await store.writeAsync(()=>{
      pause.get();f.db.prepare("INSERT INTO entries(value) VALUES(?)").run("fixture-secret-sql-value");return 7;
    },{diagnosticSource:"session_feed_update"});
    assert.equal(value,7);assert.deepEqual(reportedConnections,[{transaction:false,timeout:137}]);
    // The existing info buffer must not append synchronously when the transaction returns.
    assert.equal(readFileSync(path,"utf8").includes('"event":"sqlite_write"'),false);
    await diagnostics.flush();
    const rows=readFileSync(path,"utf8").trim().split("\n").map(line=>JSON.parse(line));
    const events=rows.filter(row=>row.event==="sqlite_write");assert.equal(events.length,1);
    const event=events[0];
    assert.equal(event.level,"info");assert.equal(event.source,"session_feed_update");assert.equal(event.outcome,"committed");
    assert.ok(event.phases.body.maxMs>=50);assert.equal(event.phases.body.count,1);assert.equal(event.phases.commit.count,1);
    assert.equal(event.retryCount,0);assert.equal(event.retryElapsedMs,0);assert.equal(event.cleanupFailed,false);
    assert.equal(readFileSync(path,"utf8").includes("fixture-secret"),false);
  } finally {await diagnostics.dispose();f.close();}
});

test("真实 COMMIT 外键失败记录提交阶段且不重放事务体",async()=>{
  const f=fixture(),pause=slowStatement(f.db),events:SqliteWriteDiagnostic[]=[];
  const connections:Array<{transaction:boolean;timeout:number}>=[];
  try {
    f.db.pragma("foreign_keys = ON");
    f.db.exec("CREATE TABLE parent(id INTEGER PRIMARY KEY);CREATE TABLE child(parent_id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)");
    let calls=0;
    await assert.rejects(runSqliteWrite(f.db,()=>{
      calls++;pause.get();f.db.prepare("INSERT INTO child VALUES(999)").run();
    },{diagnosticSource:"session_reconcile",diagnostics:event=>{
      events.push(event);connections.push({transaction:f.db.inTransaction,timeout:f.db.pragma("busy_timeout",{simple:true}) as number});
    }}),{code:"SQLITE_CONSTRAINT_FOREIGNKEY"});
    assert.equal(calls,1);assert.equal(f.db.prepare("SELECT count(*) FROM child").pluck().get(),0);
    assert.equal(events.length,1);const event=events[0]!;
    assert.equal(event.source,"session_reconcile");assert.equal(event.outcome,"failed");
    assert.equal(event.errorStage,"commit");assert.equal(event.errorCode,"SQLITE_CONSTRAINT_FOREIGNKEY");
    assert.equal(event.phases.body.count,1);assert.ok(event.phases.body.maxMs>=50);
    assert.equal(event.phases.commit.count,1);assert.equal(event.phases.rollback.count,1);
    assert.equal(event.retryCount,0);assert.equal(event.cleanupFailed,false);
    assert.deepEqual(connections,[{transaction:false,timeout:137}]);
  } finally {f.close();}
});

test("取消与预算耗尽记录异步重试等待并保留原错误，不记录取消正文",async()=>{
  const f=fixture(),blocker=new Database(f.path),events:SqliteWriteDiagnostic[]=[];
  const connections:Array<{transaction:boolean;timeout:number}>=[];
  const report=(event:SqliteWriteDiagnostic)=>{
    events.push(event);connections.push({transaction:f.db.inTransaction,timeout:f.db.pragma("busy_timeout",{simple:true}) as number});
  };
  let calls=0;
  try {
    blocker.exec("BEGIN IMMEDIATE");
    await assert.rejects(runSqliteWrite(f.db,()=>{calls++;},{timeoutMs:300,diagnostics:report}),{code:"SQLITE_BUSY"});
    const controller=new AbortController(),reason=new Error("fixture-secret-cancellation");
    const pending=runSqliteWrite(f.db,()=>{calls++;},{signal:controller.signal,diagnostics:report});
    const rejected=assert.rejects(pending,error=>error===reason);
    await delay(300);controller.abort(reason);await rejected;
    assert.equal(calls,0);assert.equal(events.length,2);
    assert.equal(events[0]!.outcome,"failed");assert.equal(events[0]!.errorStage,"begin");assert.equal(events[0]!.errorCode,"SQLITE_BUSY");
    assert.equal(events[1]!.outcome,"cancelled");assert.equal(events[1]!.errorStage,"retry");assert.equal(events[1]!.errorCode,undefined);
    for(const event of events) {
      assert.ok(event.elapsedMs>=250);assert.ok(event.retryElapsedMs>=250);assert.ok(event.retryCount>0);
      assert.equal(event.phases.body.count,0);assert.equal(event.phases.commit.count,0);assert.equal(event.phases.rollback.count,0);
      assert.equal(event.phases.restore.count,event.attempts);assert.equal(event.cleanupFailed,false);
    }
    assert.deepEqual(connections,[{transaction:false,timeout:137},{transaction:false,timeout:137}]);
    assert.equal(JSON.stringify(events).includes("fixture-secret"),false);
  } finally {if(blocker.inTransaction)blocker.exec("ROLLBACK");blocker.close();f.close();}
});

test("诊断回调失败不改变提交结果或原错误，诊断字段不接受任意错误正文",async()=>{
  const f=fixture(),pause=slowStatement(f.db),events:SqliteWriteDiagnostic[]=[];
  const store=new SessionStore(f.db,false,event=>{events.push(event);throw new Error("fixture-secret-reporter");});
  try {
    const value=await store.writeAsync(()=>{pause.get();return f.db.prepare("INSERT INTO entries(value) VALUES(?)").run("kept").changes;});
    assert.equal(value,1);
    const original=Object.assign(new Error("fixture-secret-error"),{code:"SQLITE_BUSY_FIXTURE_SECRET"});
    await assert.rejects(store.writeAsync(()=>{
      pause.get();f.db.prepare("INSERT INTO entries(value) VALUES(?)").run("rolled-back");throw original;
    }),error=>error===original);
    assert.deepEqual(f.db.prepare("SELECT value FROM entries").all(),[{value:"kept"}]);
    assert.equal(f.db.inTransaction,false);assert.equal(f.db.pragma("busy_timeout",{simple:true}),137);
    assert.equal(events.length,2);assert.equal(events[0]!.outcome,"committed");assert.equal(events[1]!.outcome,"failed");
    assert.equal(events[0]!.source,"session_store");assert.equal(events[1]!.errorStage,"body");assert.equal(events[1]!.errorCode,"SQLITE_BUSY");
    assert.equal(events[1]!.phases.rollback.count,1);assert.equal(events[1]!.retryCount,0);
    assert.equal(/fixture.secret/iu.test(JSON.stringify(events)),false);
  } finally {f.close();}
});
