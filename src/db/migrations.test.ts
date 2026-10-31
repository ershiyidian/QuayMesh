import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { databasePath, openDatabase, type DatabaseHandle } from "./client.js";
import { migrateDatabase, LATEST_DATABASE_VERSION } from "./migrations.js";
import { initialSchema } from "./initial-schema.js";
import { runtimeSchema } from "./runtime-schema.js";
import { taskSchema } from "./task-schema.js";
import { resourceSchema } from "./resource-schema.js";
import { reliabilitySchema } from "./reliability-schema.js";

function removeExactExecutionClaims(db: Database.Database) {
  db.exec(`DROP INDEX execution_claims_execution;
    ALTER TABLE execution_claims DROP COLUMN execution_id;
    ALTER TABLE execution_claims DROP COLUMN execution_generation;
    ALTER TABLE execution_claims DROP COLUMN owner_process_start;
    ALTER TABLE execution_waiters DROP COLUMN execution_id;
    ALTER TABLE execution_waiters DROP COLUMN execution_generation;
    ALTER TABLE execution_waiters DROP COLUMN owner_process_start;
    DELETE FROM qm_schema_migrations WHERE version>=18;`);
}

function removeQuiescenceMigration(db: Database.Database) {
  removeExactExecutionClaims(db);
  db.exec(`DROP INDEX qm_events_task_diagnostic_time;
    DROP INDEX qm_invocations_task_diagnostic_time;
    DROP INDEX qm_invocations_pending_state;`);
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'execution_quiescence_%'").all() as {name:string}[])
    db.exec(`DROP TRIGGER "${name}"`);
  db.exec(`DROP TABLE execution_quiescence;
    DROP TABLE qm_task_creation_receipts;
    DROP INDEX console_operations_maintenance_status;
    DROP INDEX console_executions_maintenance_status;
    DROP TABLE qm_task_binding_requests;
    DROP TABLE qm_task_bindings;
    DROP TABLE qm_task_messages;
    DROP TABLE qm_task_message_deliveries;
    DROP TABLE qm_task_message_receivers;
    ALTER TABLE qm_task_finalizations DROP COLUMN mailbox_sequence;
    ALTER TABLE qm_task_finalizations DROP COLUMN recovery_state;
    ALTER TABLE qm_task_finalizations DROP COLUMN finalization_revision;
    ALTER TABLE qm_file_changes DROP COLUMN recorded_at;
    ALTER TABLE qm_task_file_changes DROP COLUMN recorded_at;
    ALTER TABLE qm_task_members DROP COLUMN context_inherited;
    ALTER TABLE qm_invocations DROP COLUMN response_uses_result;
    DELETE FROM qm_schema_migrations WHERE version>=9;`);
}

test("版本八增量升级只增加物理证据结构，不推断旧unknown已完成或已排空",()=>{
  const db=new Database(":memory:");
  try{
    migrateDatabase(db);removeQuiescenceMigration(db);
    db.prepare("INSERT INTO console_projects(id,root,name,created_at) VALUES('project','/project','history','2026-10-12')").run();
    db.prepare("INSERT INTO console_work_items(id,project_id,item_key,title,created_at) VALUES('item','project','key','history','2026-10-12')").run();
    db.prepare(`INSERT INTO console_work_runs(id,project_id,item_id,run_key,request_hash,origin,created_at,status)
      VALUES('run','project','item','key','hash','{}','2026-10-12','reconciliation_required')`).run();
    db.prepare(`INSERT INTO console_operations(id,run_id,request_key,kind,label,status,evidence,created_at,finished_at)
      VALUES('legacy','run','key','command','history','reconciliation_required','[]','2026-10-12','2026-10-13')`).run();
    const before=db.prepare("SELECT * FROM console_operations").all();
    migrateDatabase(db);migrateDatabase(db);
    assert.deepEqual(db.prepare("SELECT * FROM console_operations").all(),before);
    assert.equal(db.prepare("SELECT count(*) FROM execution_quiescence").pluck().get(),0);
    assert.equal(db.prepare("SELECT status FROM console_work_runs").pluck().get(),"reconciliation_required");
    assert.equal(db.prepare("SELECT max(version) FROM qm_schema_migrations").pluck().get(),LATEST_DATABASE_VERSION);
    assert.equal(db.pragma("integrity_check",{simple:true}),"ok");
  }finally{db.close();}
});

test("初始数据库创建全部工作区、任务和认证表", () => {
  const db = new Database(":memory:");
  try {
    migrateDatabase(db);
    assert.deepEqual(db.prepare("SELECT version,name FROM qm_schema_migrations").all(),
      [{version:1,name:"quaymesh-initial"},{version:2,name:"quaymesh-runtime-ownership"},{version:3,name:"quaymesh-durable-results"},{version:4,name:"quaymesh-task-lifecycle"},
        {version:5,name:"quaymesh-execution-observation"},{version:6,name:"quaymesh-invocation-attempts"},{version:7,name:"quaymesh-console-audit"},
        {version:8,name:"quaymesh-execution-owner"},{version:9,name:"quaymesh-execution-quiescence"},
        {version:10,name:"quaymesh-task-messages"},{version:11,name:"quaymesh-file-evidence-time"},
        {version:12,name:"quaymesh-task-entry-bindings"},{version:13,name:"quaymesh-finalization-fence"},
        {version:14,name:"quaymesh-task-member-index"},{version:15,name:"quaymesh-invocation-payload-sharing"},
        {version:16,name:"quaymesh-task-creation-receipts"},
        {version:17,name:"quaymesh-bounded-diagnostic-queries"},
        {version:18,name:"quaymesh-exact-execution-claims"}]);
    for (const name of ["workspace_sessions","oauth_clients","console_work_runs","execution_claims",
      "local_agent_sessions","qm_sessions","qm_tasks","qm_task_members","qm_task_snapshots","qm_task_context",
      "qm_runtime_work","qm_runtime_admission","qm_transfers","qm_task_change_baselines","qm_task_file_changes","qm_task_finalizations",
      "console_audit","console_archive_steps","execution_owners","execution_quiescence"]) {
      assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name));
    }
    assert.equal(db.pragma("foreign_keys",{simple:true}),1);
    assert.equal(db.pragma("integrity_check",{simple:true}),"ok");
  } finally { db.close(); }
});

test("版本十七的旧占用增量升级保留原归属，不猜测执行代次或物理结束", () => {
  const db=new Database(":memory:");
  try {
    migrateDatabase(db);removeExactExecutionClaims(db);
    db.prepare(`INSERT INTO execution_claims
      (id,owner_id,owner_pid,kind,checkout_root,agent_id,resources,acquired_at,operation_id,task_id)
      VALUES('legacy-claim','legacy-owner',123,'agent','/project','legacy-agent','[]','2026-10-30T01:00:00.000Z',NULL,'legacy-task')`).run();
    const before=db.prepare("SELECT id,owner_id,owner_pid,kind,checkout_root,agent_id,resources,acquired_at,operation_id,task_id FROM execution_claims").all();
    migrateDatabase(db);migrateDatabase(db);
    assert.deepEqual(db.prepare("SELECT id,owner_id,owner_pid,kind,checkout_root,agent_id,resources,acquired_at,operation_id,task_id FROM execution_claims").all(),before);
    assert.deepEqual(db.prepare("SELECT execution_id,execution_generation,owner_process_start FROM execution_claims").get(),
      {execution_id:null,execution_generation:null,owner_process_start:null});
    assert.equal(db.prepare("SELECT COUNT(*) FROM execution_quiescence").pluck().get(),0);
    assert.equal(db.prepare("SELECT max(version) FROM qm_schema_migrations").pluck().get(),LATEST_DATABASE_VERSION);
    assert.equal(db.pragma("integrity_check",{simple:true}),"ok");
  } finally {db.close();}
});

test("再次打开数据库保留任务数据", () => {
  const db = new Database(":memory:");
  try {
    migrateDatabase(db);
    db.prepare("INSERT INTO qm_sessions(id,owner_id,title,created_at,last_activity_at) VALUES(?,?,?,?,?)")
      .run("session-a","owner","对话","2026-10-01","2026-10-01");
    migrateDatabase(db);
    assert.equal((db.prepare("SELECT title FROM qm_sessions WHERE id=?").get("session-a") as {title:string}).title,"对话");
    assert.equal((db.prepare("SELECT count(*) AS n FROM qm_schema_migrations").get() as {n:number}).n,LATEST_DATABASE_VERSION);
  } finally { db.close(); }
});

test("无法识别的数据库版本立即报告错误", () => {
  const db = new Database(":memory:");
  try {
    migrateDatabase(db);
    db.prepare("UPDATE qm_schema_migrations SET version=999 WHERE version=?").run(LATEST_DATABASE_VERSION);
    assert.throws(() => migrateDatabase(db),/不支持的 QuayMesh 数据库版本/);
  } finally { db.close(); }
});

test("版本一数据库保留当前任务的真实文件基准并只迁移一次", () => {
  const db = new Database(":memory:");
  try {
    db.exec(initialSchema);
    db.exec("CREATE TABLE qm_schema_migrations(version INTEGER PRIMARY KEY,name TEXT,applied_at TEXT)");
    db.prepare("INSERT INTO qm_schema_migrations VALUES(1,'quaymesh-initial',?)").run(new Date().toISOString());
    db.prepare("INSERT INTO qm_sessions(id,owner_id,title,created_at,last_activity_at) VALUES(?,?,?,?,?)")
      .run("session","owner","对话","2026-10-03","2026-10-03");
    db.prepare("INSERT INTO qm_tasks(id,session_id,title,start_sequence,created_at,last_activity_at) VALUES(?,?,?,?,?,?)")
      .run("task","session","任务",0,"2026-10-03","2026-10-03");
    db.prepare("UPDATE qm_sessions SET current_task_id='task' WHERE id='session'").run();
    db.prepare("INSERT INTO qm_session_members(id,session_id,node_id,workspace_id,root,mode,recovery_root,first_seen_at,last_observed_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run("member","session","node","workspace","/work","checkout","/work","2026-10-03","2026-10-03");
    db.prepare("INSERT INTO qm_change_baselines(session_id,member_id,repo_root,baseline_ref,latest_ref,coverage) VALUES(?,?,?,?,?,?)")
      .run("session","member","/work","initial-content","latest-content","session_owned");
    migrateDatabase(db); migrateDatabase(db);
    assert.deepEqual(db.prepare("SELECT task_id,baseline_ref,latest_ref FROM qm_task_change_baselines").all(),
      [{task_id:"task",baseline_ref:"initial-content",latest_ref:"latest-content"}]);
    assert.equal(db.pragma("integrity_check",{simple:true}),"ok");
  } finally { db.close(); }
});

test("附件版本二数据库增量升级，保留既有任务并创建持久结果结构", () => {
  const db=new Database(":memory:");
  try {
    db.exec(initialSchema);db.exec(runtimeSchema);db.exec(taskSchema);db.exec(resourceSchema);
    db.exec("CREATE TABLE qm_schema_migrations(version INTEGER PRIMARY KEY,name TEXT,applied_at TEXT)");
    db.prepare("INSERT INTO qm_schema_migrations VALUES(?,?,?)").run(1,"quaymesh-initial","2026-10-04");
    db.prepare("INSERT INTO qm_schema_migrations VALUES(?,?,?)").run(2,"quaymesh-runtime-ownership","2026-10-04");
    db.prepare("INSERT INTO qm_sessions(id,owner_id,title,created_at,last_activity_at) VALUES(?,?,?,?,?)")
      .run("v2-session","owner","既有对话","2026-10-04","2026-10-04");
    db.prepare("INSERT INTO qm_tasks(id,session_id,title,created_at,last_activity_at) VALUES(?,?,?,?,?)")
      .run("v2-task","v2-session","保留原任务","2026-10-04","2026-10-04");
    migrateDatabase(db);migrateDatabase(db);
    const row=db.prepare("SELECT title,source_task_id FROM qm_tasks WHERE id=?").get("v2-task") as {title:string;source_task_id:null};
    assert.equal(row.title,"保留原任务");assert.equal(row.source_task_id,null);
    assert.equal((db.prepare("SELECT COUNT(*) n FROM qm_schema_migrations").get() as {n:number}).n,LATEST_DATABASE_VERSION);
    for(const table of ["qm_operation_keys","qm_process_handles","qm_context_results","qm_task_checkpoints"]) {
      assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table));
    }
    assert.equal(db.pragma("integrity_check",{simple:true}),"ok");
    assert.deepEqual(db.pragma("foreign_key_check"),[]);
  } finally {db.close();}
});

test("版本三数据库区分明确交付与历史归档",()=>{
  const db=new Database(":memory:");
  try {
    db.exec(initialSchema);db.exec(runtimeSchema);db.exec(taskSchema);db.exec(resourceSchema);db.exec(reliabilitySchema);
    db.exec("CREATE TABLE qm_schema_migrations(version INTEGER PRIMARY KEY,name TEXT,applied_at TEXT)");
    for(const [version,name] of [[1,"quaymesh-initial"],[2,"quaymesh-runtime-ownership"],[3,"quaymesh-durable-results"]] as const)
      db.prepare("INSERT INTO qm_schema_migrations VALUES(?,?,?)").run(version,name,"2026-10-07");
    db.prepare("INSERT INTO qm_sessions(id,owner_id,title,created_at,last_activity_at) VALUES(?,?,?,?,?)")
      .run("session","owner","对话","2026-10-07","2026-10-07");
    db.prepare("INSERT INTO qm_tasks(id,session_id,title,state,created_at,last_activity_at,finished_at,result_status) VALUES(?,?,?,?,?,?,?,?)")
      .run("done","session","完成","closed","2026-10-07","2026-10-07","2026-10-07T01:00:00.000Z","completed");
    db.prepare("INSERT INTO qm_tasks(id,session_id,title,state,created_at,last_activity_at,finished_at) VALUES(?,?,?,?,?,?,?)")
      .run("archive","session","归档","closed","2026-10-07","2026-10-07","2026-10-07T02:00:00.000Z");
    migrateDatabase(db);migrateDatabase(db);
    assert.deepEqual(db.prepare("SELECT id,closure_reason,archived_at,delivery_ended_at,source_kind,change_summary_state FROM qm_tasks ORDER BY id").all(),[
      {id:"archive",closure_reason:"legacy_archive",archived_at:"2026-10-07T02:00:00.000Z",delivery_ended_at:null,source_kind:"legacy_unknown",change_summary_state:"not_started"},
      {id:"done",closure_reason:"explicit",archived_at:"2026-10-07T01:00:00.000Z",delivery_ended_at:"2026-10-07T01:00:00.000Z",source_kind:"legacy_unknown",change_summary_state:"not_started"},
    ]);
    assert.equal(db.pragma("integrity_check",{simple:true}),"ok");
  } finally {db.close();}
});

test("已最新数据库在真实写锁下仍可通过正式连接工厂读取，未知新版仍立即拒绝",t=>{
  const directory=mkdtempSync(join(tmpdir(),"qm-migration-read-lock-"));
  const initial=openDatabase(directory);
  let blocker:Database.Database|undefined, opened:DatabaseHandle|undefined;
  try {
    initial.sqlite.prepare("INSERT INTO qm_sessions(id,owner_id,title,created_at,last_activity_at) VALUES(?,?,?,?,?)")
      .run("session","owner","committed","2026-10-20","2026-10-20");
    blocker=new Database(databasePath(directory));
    blocker.exec("BEGIN IMMEDIATE");
    blocker.prepare("UPDATE qm_sessions SET title='uncommitted' WHERE id='session'").run();
    const started=performance.now();
    opened=openDatabase(directory);
    assert.equal(blocker.inTransaction,true);
    assert.equal(opened.sqlite.prepare("SELECT title FROM qm_sessions WHERE id='session'").pluck().get(),"committed");
    assert.equal(opened.sqlite.prepare("SELECT total_changes()").pluck().get(),0);
    t.diagnostic(`已最新数据库持锁打开并读取耗时 ${performance.now()-started} ms`);
    opened.close();opened=undefined;
    blocker.exec("ROLLBACK");
    initial.sqlite.prepare("UPDATE qm_schema_migrations SET version=999 WHERE version=?").run(LATEST_DATABASE_VERSION);
    blocker.exec("BEGIN IMMEDIATE");
    assert.throws(()=>openDatabase(directory),/不支持的 QuayMesh 数据库版本：999/);
    assert.equal(blocker.inTransaction,true);
  } finally {
    opened?.close();
    if(blocker?.inTransaction)blocker.exec("ROLLBACK");
    blocker?.close();initial.close();rmSync(directory,{recursive:true,force:true});
  }
});

test("最新版本的 legacy thinking 修复保留值，修复后打开不再抢写锁",()=>{
  const directory=mkdtempSync(join(tmpdir(),"qm-migration-legacy-lock-"));
  const legacy=new Database(databasePath(directory));
  let opened:DatabaseHandle|undefined;
  try {
    legacy.pragma("journal_mode = WAL");
    legacy.exec(`CREATE TABLE qm_schema_migrations(version INTEGER PRIMARY KEY,name TEXT,applied_at TEXT);
      CREATE TABLE local_agent_sessions(id TEXT PRIMARY KEY,thinking TEXT,effort TEXT);
      INSERT INTO local_agent_sessions VALUES('copy','high',NULL),('keep','high','medium'),('empty',NULL,NULL);`);
    legacy.prepare("INSERT INTO qm_schema_migrations VALUES(?,'legacy','2026-10-20')").run(LATEST_DATABASE_VERSION);
    migrateDatabase(legacy);
    assert.deepEqual(legacy.prepare("SELECT id,effort FROM local_agent_sessions ORDER BY id").all(),[
      {id:"copy",effort:"high"},{id:"empty",effort:null},{id:"keep",effort:"medium"},
    ]);
    const columns=new Set((legacy.pragma("table_info(local_agent_sessions)") as Array<{name:string}>).map(row=>row.name));
    assert.ok(columns.has("control_revision"));assert.ok(columns.has("task_name"));
    assert.ok(legacy.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='local_agent_turns'").get());
    legacy.exec("BEGIN IMMEDIATE");
    opened=openDatabase(directory);
    assert.equal(legacy.inTransaction,true);
    assert.equal(opened.sqlite.prepare("SELECT total_changes()").pluck().get(),0);
    opened.close();opened=undefined;legacy.exec("ROLLBACK");
    // 仍检查后来出现的旧格式数据，不以进程内缓存跳过需要修复的行。
    legacy.prepare("INSERT INTO local_agent_sessions(id,thinking) VALUES('later','low')").run();
    migrateDatabase(legacy);
    assert.equal(legacy.prepare("SELECT effort FROM local_agent_sessions WHERE id='later'").pluck().get(),"low");
  } finally {
    opened?.close();if(legacy.inTransaction)legacy.exec("ROLLBACK");legacy.close();
    rmSync(directory,{recursive:true,force:true});
  }
});

test("首次建表和旧版本升级失败均回滚全部迁移，再次升级可成功",()=>{
  const fresh=new Database(":memory:"), old=new Database(":memory:");
  try {
    fresh.exec("CREATE TABLE oauth_clients(preserved TEXT)");
    assert.throws(()=>migrateDatabase(fresh),/already exists/);
    assert.deepEqual(fresh.prepare("SELECT name FROM sqlite_master WHERE type='table'").all(),[{name:"oauth_clients"}]);
    assert.equal(fresh.inTransaction,false);

    migrateDatabase(old);removeQuiescenceMigration(old);
    old.exec(`DROP INDEX qm_invocations_retry_of;
      ALTER TABLE qm_invocations DROP COLUMN retry_of_invocation_id;
      ALTER TABLE qm_invocations DROP COLUMN task_id;
      ALTER TABLE qm_invocations DROP COLUMN response_json;
      DROP TABLE console_archive_steps;
      DROP TABLE console_audit;
      DROP TABLE console_audit_imports;
      DROP TABLE execution_owners;
      DROP INDEX qm_events_source_type;
      DROP INDEX qm_events_operation_type;
      DELETE FROM qm_schema_migrations WHERE version>=6;
      CREATE TRIGGER reject_upgrade BEFORE INSERT ON qm_schema_migrations WHEN NEW.version=6
        BEGIN SELECT RAISE(ABORT,'migration stopped'); END;`);
    assert.throws(()=>migrateDatabase(old),/migration stopped/);
    assert.equal(old.inTransaction,false);
    assert.equal(old.prepare("SELECT max(version) FROM qm_schema_migrations").pluck().get(),5);
    const columns=(old.pragma("table_info(qm_invocations)") as Array<{name:string}>).map(row=>row.name);
    assert.ok(!columns.includes("task_id"));assert.ok(!columns.includes("retry_of_invocation_id"));
    old.exec("DROP TRIGGER reject_upgrade");migrateDatabase(old);
    assert.equal(old.prepare("SELECT max(version) FROM qm_schema_migrations").pluck().get(),LATEST_DATABASE_VERSION);
    assert.equal(old.pragma("integrity_check",{simple:true}),"ok");
  } finally {fresh.close();old.close();}
});

test("版本六调用保留历史结果，升级不把当前终态结果冒充首响应", () => {
  const db = new Database(":memory:");
  try {
    migrateDatabase(db);removeQuiescenceMigration(db);
    db.exec(`ALTER TABLE qm_invocations DROP COLUMN response_json;
      DROP TABLE console_archive_steps;
      DROP TABLE console_audit;
      DROP TABLE console_audit_imports;
      DROP TABLE execution_owners;
      DROP INDEX qm_events_source_type;
      DROP INDEX qm_events_operation_type;
      DELETE FROM qm_schema_migrations WHERE version>=7;`);
    const at = "2026-10-20T01:00:00.000Z", result = JSON.stringify({ kind: "error", message: "later process failure" });
    db.prepare("INSERT INTO qm_sessions(id,owner_id,title,created_at,last_activity_at) VALUES(?,?,?,?,?)")
      .run("history-session", "owner", "Historical call", at, at);
    db.prepare(`INSERT INTO qm_session_members(id,session_id,node_id,workspace_id,root,mode,recovery_root,first_seen_at,last_observed_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run("history-member", "history-session", "local", "workspace", "/work", "checkout", "/work", at, at);
    db.prepare(`INSERT INTO qm_invocations(id,owner_id,transport_instance_id,request_id,session_id,member_id,tool_name,arguments_json,
      state,effect,result_json,created_at,response_at,finished_at) VALUES(?,?,?,?,?,?,?,'{}','failed','completed',?,?,?,?)`)
      .run("history-call", "owner", "transport", "request", "history-session", "history-member", "exec_command", result, at, at, at);
    migrateDatabase(db);
    const call = db.prepare("SELECT result_json,response_json,response_at FROM qm_invocations WHERE id='history-call'").get() as {
      result_json: string; response_json: string | null; response_at: string;
    };
    assert.equal(call.result_json, result); assert.equal(call.response_json, null); assert.equal(call.response_at, at);
    assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
  } finally { db.close(); }
});
