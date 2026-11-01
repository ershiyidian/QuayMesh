import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";
import { migrateDatabase } from "./migrations.js";

export type SqliteDatabase = Database.Database;
export type AppDatabase = ReturnType<typeof createDrizzleDatabase>;

export interface DatabaseHandle {
  sqlite: SqliteDatabase;
  db: AppDatabase;
  close(): void;
}

export function databasePath(stateDir: string): string {
  return join(stateDir, "quaymesh.sqlite");
}

// Called once by the dedicated Console read child before loading query modules.
// There is deliberately no environment switch and no way to turn writes back on.
let readonlyProcess = false;
export function useReadonlyDatabases(): void { readonlyProcess = true; }

export function openDatabase(stateDir: string): DatabaseHandle {
  if (readonlyProcess) {
    const sqlite = new Database(databasePath(stateDir), {readonly: true, fileMustExist: true, timeout: 1000});
    try {
      sqlite.pragma("query_only = ON");
      sqlite.pragma("foreign_keys = ON");
      return {sqlite, db: createDrizzleDatabase(sqlite), close: () => sqlite.close()};
    } catch (error) { sqlite.close(); throw error; }
  }
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
    return {
      sqlite,
      db: createDrizzleDatabase(sqlite),
      close: () => sqlite.close(),
    };
  } catch(error) {
    try {sqlite.close();} finally {throw error;}
  }
}

function createDrizzleDatabase(sqlite: SqliteDatabase) {
  return drizzle(sqlite, { schema });
}
