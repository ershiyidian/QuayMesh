import { chmodSync, mkdirSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";
import { migrateDatabase } from "./migrations.js";
import { trackDatabaseWriter } from "./wal-checkpoint.js";
import { databasePath, openReadonlySqlite, readonlyDatabases } from "./readonly.js";

export { databasePath, useReadonlyDatabases } from "./readonly.js";

export type SqliteDatabase = Database.Database;
export type AppDatabase = ReturnType<typeof createDrizzleDatabase>;

export interface DatabaseHandle {
  sqlite: SqliteDatabase;
  db: AppDatabase;
  close(): void;
}

/** Explicit readonly entry for query models. Never migrate, mkdir, chmod or
 * change journal mode, including when called outside the dedicated worker. */
export function openReadonlyDatabase(stateDir: string): DatabaseHandle {
  const sqlite = openReadonlySqlite(stateDir);
  try {
    return {sqlite, db: createDrizzleDatabase(sqlite), close: () => sqlite.close()};
  } catch (error) { sqlite.close(); throw error; }
}

export function openDatabase(stateDir: string): DatabaseHandle {
  if (readonlyDatabases()) return openReadonlyDatabase(stateDir);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  const path = databasePath(stateDir);
  const sqlite = new Database(path);
  try {
    chmodSync(path, 0o600);
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("synchronous = NORMAL");
    sqlite.pragma("busy_timeout = 5000");
    sqlite.pragma("foreign_keys = ON");
    migrateDatabase(sqlite);
    const release = trackDatabaseWriter(path, sqlite);
    return {
      sqlite,
      db: createDrizzleDatabase(sqlite),
      close: () => { sqlite.close(); release(); },
    };
  } catch(error) {
    try {sqlite.close();} finally {throw error;}
  }
}

function createDrizzleDatabase(sqlite: SqliteDatabase) {
  return drizzle(sqlite, { schema });
}
