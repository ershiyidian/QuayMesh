import type Database from "better-sqlite3";
import { initialSchema } from "./initial-schema.js";
import { runtimeSchema } from "./runtime-schema.js";
import { taskSchema, migrateCurrentTaskData } from "./task-schema.js";
import { resourceSchema } from "./resource-schema.js";
import { reliabilitySchema } from "./reliability-schema.js";
import { taskLifecycleSchema } from "./task-lifecycle-schema.js";
import { invocationAttemptSchema } from "./invocation-attempt-schema.js";
import { consoleAuditSchema } from "./console-audit-schema.js";
import { executionOwnerSchema } from "./execution-owner-schema.js";
import { executionQuiescenceSchema } from "./execution-quiescence-schema.js";
import { taskMailboxSchema } from "./task-mailbox-schema.js";
import { fileChangeTimeSchema } from "./file-change-time-schema.js";
import { taskBindingSchema } from "./task-binding-schema.js";

import { taskFinalizationSchema } from "./task-finalization-schema.js";
import { taskMemberSchema } from "./task-member-schema.js";
import { invocationPayloadSchema } from "./invocation-payload-schema.js";
import { taskCreationSchema } from "./task-creation-schema.js";
import { diagnosticQuerySchema } from "./diagnostic-query-schema.js";
import { needsLegacyAgentRepair, prepareStandaloneLegacyAgentMigration, repairLegacyAgentSchema } from "./legacy-agent-schema.js";

export const LATEST_DATABASE_VERSION = 17;

function migrationState(sqlite:Database.Database):{existing:boolean;version:number} {
  const existing=Boolean(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='qm_schema_migrations'").get());
  const version=existing
    ? (sqlite.prepare("SELECT max(version) AS version FROM qm_schema_migrations").get() as {version:number}).version : 0;
  if(!Number.isInteger(version)||version<0||version>LATEST_DATABASE_VERSION)
    throw new Error(`不支持的 QuayMesh 数据库版本：${version}`);
  return {existing,version};
}

export function migrateDatabase(sqlite: Database.Database): void {
  sqlite.pragma("foreign_keys = ON");
  // 已最新且无旧字段待修复时，只读检查即可；普通打开不能争抢写锁。
  if(migrationState(sqlite).version===LATEST_DATABASE_VERSION&&!needsLegacyAgentRepair(sqlite))return;
  sqlite.transaction(() => {
    // 等到写锁后重新读取，兼容另一个进程已经完成升级的情况。
    let {existing,version}=migrationState(sqlite);
    const standaloneSchema = prepareStandaloneLegacyAgentMigration(sqlite);
    if (standaloneSchema) { existing = false; version = 0; }
    const record = (number: number, name: string) => sqlite.prepare(
      "INSERT INTO qm_schema_migrations(version,name,applied_at) VALUES(?,?,?)",
    ).run(number, name, new Date().toISOString());
    if (version === 0) {
      sqlite.exec(standaloneSchema ?? initialSchema);
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
      version = 6;
    }
    if (version === 6) {
      sqlite.exec(consoleAuditSchema);
      record(7, "quaymesh-console-audit");
      version = 7;
    }
    if (version === 7) {
      sqlite.exec(executionOwnerSchema);
      record(8, "quaymesh-execution-owner");
      version = 8;
    }
    if (version === 8) {
      sqlite.exec(executionQuiescenceSchema);
      record(9, "quaymesh-execution-quiescence");
      version = 9;
    }
    if (version === 9) {
      sqlite.exec(taskMailboxSchema);
      sqlite.exec("ALTER TABLE qm_task_finalizations ADD COLUMN mailbox_sequence INTEGER NOT NULL DEFAULT 0");
      record(10, "quaymesh-task-messages");
      version = 10;
    }
    if (version === 10) {
      sqlite.exec(fileChangeTimeSchema);
      record(11, "quaymesh-file-evidence-time");
      version = 11;
    }
    if (version === 11) {
      sqlite.exec(taskBindingSchema);
      record(12, "quaymesh-task-entry-bindings");
      version = 12;
    }
    if (version === 12) {
      sqlite.exec(taskFinalizationSchema);
      record(13, "quaymesh-finalization-fence");
      version = 13;
    }
    if (version === 13) {
      sqlite.exec(taskMemberSchema);
      record(14, "quaymesh-task-member-index");
      version = 14;
    }
    if (version === 14) {
      sqlite.exec(invocationPayloadSchema);
      record(15, "quaymesh-invocation-payload-sharing");
      version = 15;
    }
    if (version === 15) {
      sqlite.exec(taskCreationSchema);
      record(16, "quaymesh-task-creation-receipts");
      version = 16;
    }
    if (version === 16) {
      sqlite.exec(diagnosticQuerySchema);
      record(17, "quaymesh-bounded-diagnostic-queries");
    }
    repairLegacyAgentSchema(sqlite);
  }).immediate();
}
