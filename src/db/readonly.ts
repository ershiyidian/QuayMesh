import { join } from "node:path";
import Database from "better-sqlite3";

export type SqliteDatabase = Database.Database;

export function databasePath(stateDir: string): string {
  return join(stateDir, "quaymesh.sqlite");
}

// Dedicated read children set this before loading any query modules. Keep the
// irreversible process mode independent of ORM, migration and writer imports.
let readonlyProcess = false;
export function useReadonlyDatabases(): void { readonlyProcess = true; }
export function readonlyDatabases(): boolean { return readonlyProcess; }

/** Raw SQL readers do not need the ORM schema or any writer lifecycle code. */
export function openReadonlySqlite(stateDir: string): SqliteDatabase {
  const sqlite = new Database(databasePath(stateDir), { readonly: true, fileMustExist: true, timeout: 1000 });
  try {
    sqlite.pragma("query_only = ON");
    sqlite.pragma("foreign_keys = ON");
    return sqlite;
  } catch (error) { sqlite.close(); throw error; }
}
