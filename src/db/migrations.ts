import type Database from "better-sqlite3";
import { initialSchema } from "./initial-schema.js";
import { runtimeSchema } from "./runtime-schema.js";
import { taskSchema, migrateCurrentTaskData } from "./task-schema.js";
import { resourceSchema } from "./resource-schema.js";
import { reliabilitySchema } from "./reliability-schema.js";
import { taskLifecycleSchema } from "./task-lifecycle-schema.js";

export const LATEST_DATABASE_VERSION = 4;

export function migrateDatabase(sqlite: Database.Database): void {
  sqlite.pragma("foreign_keys = ON");
  sqlite.transaction(() => {
    const existing = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='qm_schema_migrations'").get();
    let version = existing
      ? (sqlite.prepare("SELECT max(version) AS version FROM qm_schema_migrations").get() as { version: number }).version
      : 0;
    if (!Number.isInteger(version) || version < 0 || version > LATEST_DATABASE_VERSION) {
      throw new Error(`不支持的 QuayMesh 数据库版本：${version}`);
    }
    const record = (number: number, name: string) => sqlite.prepare(
      "INSERT INTO qm_schema_migrations(version,name,applied_at) VALUES(?,?,?)",
    ).run(number, name, new Date().toISOString());
    if (version === 0) {
      sqlite.exec(initialSchema);
      sqlite.exec("CREATE TABLE qm_schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
      record(1, "quaymesh-initial");
      version = 1;
    }
    if (version === 1) {
      sqlite.exec(runtimeSchema);
      sqlite.exec(taskSchema);
      sqlite.exec(resourceSchema);
      if (existing) sqlite.exec(migrateCurrentTaskData);
      record(2, "quaymesh-runtime-ownership");
      version = 2;
    }
    if (version === 2) {
      sqlite.exec(reliabilitySchema);
      record(3, "quaymesh-durable-results");
      version = 3;
    }
    if (version === 3) {
      sqlite.exec(taskLifecycleSchema);
      record(4, "quaymesh-task-lifecycle");
    }
    // Earlier standalone TaskQuay/Agent stores sometimes retained their own
    // migration history. Their `thinking` value is an actual operator setting;
    // preserve it and supply only missing agent columns/turns, transactionally.
    const legacy=sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='local_agent_sessions'").get();
    if(legacy){
      const names=new Set((sqlite.pragma("table_info(local_agent_sessions)") as Array<{name:string}>).map(c=>c.name));
      if(names.has("thinking")){
        for(const [name,definition] of Object.entries({
          effort:"TEXT",task_name:"TEXT",error_code:"TEXT",error_retryable:"TEXT",
          context_key:"TEXT",context_signature:"TEXT",work_item_id:"TEXT",progress:"TEXT",
          recovery_type:"TEXT",parent_provider_session_id:"TEXT",
          control_state:"TEXT NOT NULL DEFAULT 'terminal'",provider_turn_id:"TEXT",
          control_revision:"INTEGER NOT NULL DEFAULT 0",
        }))if(!names.has(name))sqlite.exec(`ALTER TABLE local_agent_sessions ADD COLUMN ${name} ${definition}`);
        sqlite.prepare("UPDATE local_agent_sessions SET effort=thinking WHERE effort IS NULL AND thinking IS NOT NULL").run();
        sqlite.exec(`CREATE TABLE IF NOT EXISTS local_agent_turns(
          id INTEGER PRIMARY KEY AUTOINCREMENT,agent_id TEXT NOT NULL REFERENCES local_agent_sessions(id) ON DELETE CASCADE,
          prompt TEXT NOT NULL,status TEXT NOT NULL,response TEXT,error TEXT,error_code TEXT,error_retryable TEXT,
          created_at TEXT NOT NULL,completed_at TEXT)`);
      }
    }
  }).immediate();
}
