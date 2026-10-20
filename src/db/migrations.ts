import type Database from "better-sqlite3";
import { initialSchema } from "./initial-schema.js";
import { runtimeSchema } from "./runtime-schema.js";
import { taskSchema, migrateCurrentTaskData } from "./task-schema.js";
import { resourceSchema } from "./resource-schema.js";
import { reliabilitySchema } from "./reliability-schema.js";
import { taskLifecycleSchema } from "./task-lifecycle-schema.js";
import { invocationAttemptSchema } from "./invocation-attempt-schema.js";

export const LATEST_DATABASE_VERSION = 6;

const legacyAgentColumns = {
  effort:"TEXT",task_name:"TEXT",error_code:"TEXT",error_retryable:"TEXT",
  context_key:"TEXT",context_signature:"TEXT",work_item_id:"TEXT",progress:"TEXT",
  recovery_type:"TEXT",parent_provider_session_id:"TEXT",
  control_state:"TEXT NOT NULL DEFAULT 'terminal'",provider_turn_id:"TEXT",
  control_revision:"INTEGER NOT NULL DEFAULT 0",
};

function migrationState(sqlite:Database.Database):{existing:boolean;version:number} {
  const existing=Boolean(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='qm_schema_migrations'").get());
  const version=existing
    ? (sqlite.prepare("SELECT max(version) AS version FROM qm_schema_migrations").get() as {version:number}).version : 0;
  if(!Number.isInteger(version)||version<0||version>LATEST_DATABASE_VERSION)
    throw new Error(`不支持的 QuayMesh 数据库版本：${version}`);
  return {existing,version};
}

function needsLegacyAgentRepair(sqlite:Database.Database):boolean {
  const columns=new Set((sqlite.pragma("table_info(local_agent_sessions)") as Array<{name:string}>).map(column=>column.name));
  if(!columns.has("thinking"))return false;
  if(Object.keys(legacyAgentColumns).some(name=>!columns.has(name)))return true;
  if(!sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='local_agent_turns'").get())return true;
  return Boolean(sqlite.prepare("SELECT 1 FROM local_agent_sessions WHERE effort IS NULL AND thinking IS NOT NULL LIMIT 1").get());
}

export function migrateDatabase(sqlite: Database.Database): void {
  sqlite.pragma("foreign_keys = ON");
  // 已最新且无旧字段待修复时，只读检查即可；普通打开不能争抢写锁。
  if(migrationState(sqlite).version===LATEST_DATABASE_VERSION&&!needsLegacyAgentRepair(sqlite))return;
  sqlite.transaction(() => {
    // 等到写锁后重新读取，兼容另一个进程已经完成升级的情况。
    let {existing,version}=migrationState(sqlite);
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
      version = 4;
    }
    if (version === 4) {
      sqlite.exec("ALTER TABLE console_operations ADD COLUMN observed_at TEXT; ALTER TABLE console_executions ADD COLUMN observed_at TEXT;");
      record(5, "quaymesh-execution-observation");
      version = 5;
    }
    if (version === 5) {
      sqlite.exec(invocationAttemptSchema);
      record(6, "quaymesh-invocation-attempts");
    }
    // 旧独立 Agent 存储可能沿用原版本号；保留 thinking 设置并原子补齐缺失结构。
    const legacy=sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='local_agent_sessions'").get();
    if(legacy){
      const names=new Set((sqlite.pragma("table_info(local_agent_sessions)") as Array<{name:string}>).map(c=>c.name));
      if(names.has("thinking")){
        for(const [name,definition] of Object.entries(legacyAgentColumns))
          if(!names.has(name))sqlite.exec(`ALTER TABLE local_agent_sessions ADD COLUMN ${name} ${definition}`);
        sqlite.prepare("UPDATE local_agent_sessions SET effort=thinking WHERE effort IS NULL AND thinking IS NOT NULL").run();
        sqlite.exec(`CREATE TABLE IF NOT EXISTS local_agent_turns(
          id INTEGER PRIMARY KEY AUTOINCREMENT,agent_id TEXT NOT NULL REFERENCES local_agent_sessions(id) ON DELETE CASCADE,
          prompt TEXT NOT NULL,status TEXT NOT NULL,response TEXT,error TEXT,error_code TEXT,error_retryable TEXT,
          created_at TEXT NOT NULL,completed_at TEXT)`);
      }
    }
  }).immediate();
}
