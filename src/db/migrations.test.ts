import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { migrateDatabase, LATEST_DATABASE_VERSION } from "./migrations.js";
import { initialSchema } from "./initial-schema.js";
import { runtimeSchema } from "./runtime-schema.js";
import { taskSchema } from "./task-schema.js";
import { resourceSchema } from "./resource-schema.js";
import { reliabilitySchema } from "./reliability-schema.js";

test("初始数据库创建全部工作区、任务和认证表", () => {
  const db = new Database(":memory:");
  try {
    migrateDatabase(db);
    assert.deepEqual(db.prepare("SELECT version,name FROM qm_schema_migrations").all(),
      [{version:1,name:"quaymesh-initial"},{version:2,name:"quaymesh-runtime-ownership"},{version:3,name:"quaymesh-durable-results"},{version:4,name:"quaymesh-task-lifecycle"}]);
    for (const name of ["workspace_sessions","oauth_clients","console_work_runs","execution_claims",
      "local_agent_sessions","qm_sessions","qm_tasks","qm_task_members","qm_task_snapshots","qm_task_context",
      "qm_runtime_work","qm_runtime_admission","qm_transfers","qm_task_change_baselines","qm_task_file_changes","qm_task_finalizations"]) {
      assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name));
    }
    assert.equal(db.pragma("foreign_keys",{simple:true}),1);
    assert.equal(db.pragma("integrity_check",{simple:true}),"ok");
  } finally { db.close(); }
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
    assert.equal((db.prepare("SELECT COUNT(*) n FROM qm_schema_migrations").get() as {n:number}).n,4);
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
