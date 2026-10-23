import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WorkLedger } from "../work-ledger.js";

export interface AuditEntry {
  id: string; time: number; nodeId: string; action: string; target: string; actor: string;
  before: unknown; after: unknown; requestKey: string;
}
interface AuditRow {
  id: string; time: number; node_id: string; action: string; target: string; actor: string;
  before_json: string; after_json: string; request_key: string;
}
const entry = (row: AuditRow): AuditEntry => ({ id: row.id, time: row.time, nodeId: row.node_id, action: row.action,
  target: row.target, actor: row.actor, before: JSON.parse(row.before_json), after: JSON.parse(row.after_json), requestKey: row.request_key });

export class ConsoleAudit {
  constructor(private readonly stateDir: string, readonly nodeId: string) {}

  private open() {
    const ledger = new WorkLedger(this.stateDir);
    try {
      const source = "console-workbench-audit.json";
      if (!ledger.db.prepare("SELECT 1 FROM console_audit_imports WHERE source=?").get(source)) {
        const path = join(this.stateDir, source);
        const values = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as AuditEntry[] : [];
        ledger.db.transaction(() => {
          const insert = ledger.db.prepare("INSERT OR IGNORE INTO console_audit VALUES(?,?,?,?,?,?,?,?,?)");
          for (const value of values) insert.run(value.id, value.time, value.nodeId, value.action, value.target, value.actor,
            JSON.stringify(value.before ?? null), JSON.stringify(value.after ?? null), value.requestKey);
          ledger.db.prepare("INSERT OR IGNORE INTO console_audit_imports VALUES(?,?)").run(source, new Date().toISOString());
        }).immediate();
      }
      return ledger;
    } catch (error) { ledger.close(); throw error; }
  }

  entries(): AuditEntry[] {
    const ledger = this.open();
    try { return (ledger.db.prepare("SELECT * FROM console_audit ORDER BY time DESC,id DESC").all() as AuditRow[]).map(entry); }
    finally { ledger.close(); }
  }

  page(input: { q?: string; limit?: number; offset?: number } = {}) {
    const ledger = this.open();
    try {
      const search = (input.q ?? "").trim().toLocaleLowerCase();
      const limit = Math.min(1_000_100, Math.max(1, Math.trunc(input.limit ?? 25)));
      const offset = Math.min(1_000_000, Math.max(0, Math.trunc(input.offset ?? 0)));
      const where = "(?='' OR instr(lower(action||' '||target||' '||request_key||' '||before_json||' '||after_json),?)>0)";
      const total = (ledger.db.prepare(`SELECT COUNT(*) total FROM console_audit WHERE ${where}`).get(search, search) as { total: number }).total;
      const items = (ledger.db.prepare(`SELECT * FROM console_audit WHERE ${where} ORDER BY time DESC,id DESC LIMIT ? OFFSET ?`)
        .all(search, search, limit, offset) as AuditRow[]).map(entry);
      return { items, total };
    } finally { ledger.close(); }
  }

  find(action: string, target: string, requestKey: string): AuditEntry | null {
    const ledger = this.open();
    try {
      const row = ledger.db.prepare("SELECT * FROM console_audit WHERE action=? AND target=? AND request_key=? ORDER BY time DESC,id DESC LIMIT 1")
        .get(action, target, requestKey) as AuditRow | undefined;
      return row ? entry(row) : null;
    } finally { ledger.close(); }
  }

  record(action: string, target: string, before: unknown, after: unknown, requestKey: string): void {
    const ledger = this.open();
    try {
      ledger.db.prepare("INSERT INTO console_audit VALUES(?,?,?,?,?,?,?,?,?)").run(randomUUID(), Date.now(), this.nodeId,
        action, target, "owner", JSON.stringify(before ?? null), JSON.stringify(after ?? null), requestKey);
    } finally { ledger.close(); }
  }
}
