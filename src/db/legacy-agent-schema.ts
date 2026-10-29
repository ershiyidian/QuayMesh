import type Database from "better-sqlite3";
import { initialSchemaSql } from "./initial-schema.js";

const legacyAgentColumns = {
  effort: "TEXT", task_name: "TEXT", error_code: "TEXT", error_retryable: "TEXT",
  context_key: "TEXT", context_signature: "TEXT", work_item_id: "TEXT", progress: "TEXT",
  recovery_type: "TEXT", parent_provider_session_id: "TEXT",
  control_state: "TEXT NOT NULL DEFAULT 'terminal'", provider_turn_id: "TEXT",
  control_revision: "INTEGER NOT NULL DEFAULT 0",
};

function agentColumns(sqlite: Database.Database): Set<string> {
  return new Set((sqlite.pragma("table_info(local_agent_sessions)") as Array<{ name: string }>).map(column => column.name));
}

export function needsLegacyAgentRepair(sqlite: Database.Database): boolean {
  const columns = agentColumns(sqlite);
  if (!columns.has("thinking")) return false;
  if (Object.keys(legacyAgentColumns).some(name => !columns.has(name))) return true;
  if (!sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='local_agent_turns'").get()) return true;
  return Boolean(sqlite.prepare("SELECT 1 FROM local_agent_sessions WHERE effort IS NULL AND thinking IS NOT NULL LIMIT 1").get());
}

function repairColumns(sqlite: Database.Database, columns: Set<string>): void {
  for (const [name, definition] of Object.entries(legacyAgentColumns)) {
    if (!columns.has(name)) sqlite.exec(`ALTER TABLE local_agent_sessions ADD COLUMN ${name} ${definition}`);
  }
  sqlite.prepare("UPDATE local_agent_sessions SET effort=thinking WHERE effort IS NULL AND thinking IS NOT NULL").run();
}

export function repairLegacyAgentSchema(sqlite: Database.Database): void {
  const columns = agentColumns(sqlite);
  if (!columns.has("thinking")) return;
  repairColumns(sqlite, columns);
  sqlite.exec(`CREATE TABLE IF NOT EXISTS local_agent_turns(
    id INTEGER PRIMARY KEY AUTOINCREMENT,agent_id TEXT NOT NULL REFERENCES local_agent_sessions(id) ON DELETE CASCADE,
    prompt TEXT NOT NULL,status TEXT NOT NULL,response TEXT,error TEXT,error_code TEXT,error_retryable TEXT,
    created_at TEXT NOT NULL,completed_at TEXT)`);
}

/** The original standalone-store compatibility fixture uses this exact history
 * and only an Agent table. It is a different namespace from unified v1-v4.
 * Called inside the main migration transaction; unrecognized shapes stay strict. */
export function prepareStandaloneLegacyAgentMigration(sqlite: Database.Database): string | undefined {
  const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as Array<{ name: string }>;
  if (tables.length !== 2 || tables[0].name !== "local_agent_sessions" || tables[1].name !== "qm_schema_migrations") return;
  if (sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('view','trigger') LIMIT 1").get()) return;
  const expected = [[1, "workspace-state"], [2, "oauth-state"], [4, "workspace-conversation-bindings"]] as const;
  const history = sqlite.prepare("SELECT version,name FROM qm_schema_migrations ORDER BY version")
    .all() as Array<{ version: number; name: string }>;
  if (history.length !== expected.length || history.some((row, index) => row.version !== expected[index][0] || row.name !== expected[index][1])) return;
  const columns = agentColumns(sqlite);
  if (!["id", "workspace_id", "workspace_root", "profile_name", "provider", "model", "thinking", "provider_session_id",
    "status", "latest_response", "error", "created_at", "updated_at"].every(name => columns.has(name))) return;
  const key = (sqlite.pragma("table_info(local_agent_sessions)") as Array<{ name: string; pk: number }>).find(column => column.name === "id");
  if (key?.pk !== 1) return;

  // Keep both the old migration evidence and Agent rows in place. Only the
  // recognized pre-existing Agent table is reused by unified initialization.
  sqlite.exec("ALTER TABLE qm_schema_migrations RENAME TO qm_legacy_agent_migrations");
  repairColumns(sqlite, columns);
  return initialSchemaSql({ existingAgentSessions: true });
}
