import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { ServerConfig } from "../config.js";
import { openReadonlyDatabase } from "../db/client.js";
import { SavedArtifactError, readSavedTextArtifact } from "../session/saved-artifacts.js";
import type { AuditEntry } from "./audit.js";
import { WorkbenchError } from "./types.js";

const LEGACY_SOURCE = "console-workbench-audit.json";
interface AuditRow {
  id: string; time: number; node_id: string; action: string; target: string; actor: string;
  before_json: string; after_json: string; request_key: string;
}

async function legacyAudit(stateDir: string): Promise<AuditRow[]> {
  const path = join(stateDir, LEGACY_SOURCE);
  try { await stat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new WorkbenchError("历史审计文件当前不可读取", 503, "audit_history_unavailable", "none");
  }
  try {
    const values = JSON.parse(await readSavedTextArtifact(stateDir, path, 8 * 1024 * 1024)) as unknown;
    if (!Array.isArray(values)) throw new Error("invalid audit archive");
    const rows = new Map<string, AuditRow>();
    for (const value of values) {
      const entry = value as AuditEntry;
      if (!entry || ![entry.id, entry.nodeId, entry.action, entry.target, entry.actor, entry.requestKey].every(item => typeof item === "string")
        || !entry.id || !Number.isFinite(entry.time)) throw new Error("invalid audit entry");
      // The original INSERT OR IGNORE import retained the first duplicate ID.
      if (!rows.has(entry.id)) rows.set(entry.id, { id: entry.id, time: entry.time, node_id: entry.nodeId,
        action: entry.action, target: entry.target, actor: entry.actor, request_key: entry.requestKey,
        before_json: JSON.stringify(entry.before ?? null), after_json: JSON.stringify(entry.after ?? null) });
    }
    return [...rows.values()];
  } catch (error) {
    if (error instanceof SavedArtifactError && error.code === "artifact_too_large") {
      throw new WorkbenchError("历史审计文件超过单次读取预算", 413, "artifact_too_large", "none");
    }
    throw new WorkbenchError("历史审计文件尚未完整取得", 503, "audit_history_unavailable", "none");
  }
}

/** GET reader: it never imports an archive or creates an import marker. */
export async function readConsoleAudit(config: ServerConfig, input: { q?: string; limit?: number; offset?: number } = {}) {
  const limit = Math.min(1_000_100, Math.max(1, Math.trunc(input.limit ?? 25)));
  const offset = Math.min(1_000_000, Math.max(0, Math.trunc(input.offset ?? 0)));
  if (!Number.isSafeInteger(limit) || !Number.isSafeInteger(offset) || input.q !== undefined && typeof input.q !== "string") {
    throw new WorkbenchError("审计读取参数无效", 400, "invalid_read", "none");
  }
  const database = openReadonlyDatabase(config.stateDir);
  try {
    database.sqlite.exec("BEGIN");
    const imported = database.sqlite.prepare("SELECT 1 FROM console_audit_imports WHERE source=?").get(LEGACY_SOURCE);
    const legacy = imported ? [] : await legacyAudit(config.stateDir);
    const archive = JSON.stringify(legacy);
    const search = (input.q ?? "").trim().toLocaleLowerCase();
    const sql = `WITH legacy AS (
      SELECT json_extract(value,'$.id') id,json_extract(value,'$.time') time,json_extract(value,'$.node_id') node_id,
        json_extract(value,'$.action') action,json_extract(value,'$.target') target,json_extract(value,'$.actor') actor,
        json_extract(value,'$.before_json') before_json,json_extract(value,'$.after_json') after_json,json_extract(value,'$.request_key') request_key
      FROM json_each(?)
    ), saved AS (
      SELECT id,time,node_id,action,target,actor,before_json,after_json,request_key FROM console_audit
      UNION ALL SELECT * FROM legacy WHERE NOT EXISTS(SELECT 1 FROM console_audit a WHERE a.id=legacy.id)
    ), filtered AS (
      SELECT * FROM saved WHERE (?='' OR instr(lower(action||' '||target||' '||request_key||' '||before_json||' '||after_json),?)>0)
    )`;
    const total = (database.sqlite.prepare(`${sql} SELECT COUNT(*) total FROM filtered`).get(archive, search, search) as { total: number }).total;
    const rows = database.sqlite.prepare(`${sql} SELECT * FROM filtered ORDER BY time DESC,id DESC LIMIT ? OFFSET ?`)
      .all(archive, search, search, limit, offset) as AuditRow[];
    const items: AuditEntry[] = rows.map(row => ({ id: row.id, time: row.time, nodeId: row.node_id, action: row.action,
      target: row.target, actor: row.actor, before: JSON.parse(row.before_json), after: JSON.parse(row.after_json), requestKey: row.request_key }));
    return { items, total };
  } finally {
    try { if (database.sqlite.inTransaction) database.sqlite.exec("ROLLBACK"); }
    finally { database.close(); }
  }
}
