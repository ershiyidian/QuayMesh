import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { ConsoleAudit, type AuditEntry } from "../../src/console-workbench/audit.js";
import { readConsoleAudit } from "../../src/console-workbench/audit-read.js";
import { WorkbenchError } from "../../src/console-workbench/types.js";
import { readonlyDetailFixture } from "./readonly-detail-fixture.js";

const saved = (id: string, time: number, text: string): AuditEntry => ({ id, time, nodeId: "local", action: "fixture.review",
  target: "task_fixture", actor: "owner", before: null, after: { note: text }, requestKey: id });

test("audit GET merges the saved legacy archive without importing or creating a marker", async () => {
  const f = await readonlyDetailFixture();
  try {
    f.ledger.db.prepare("INSERT INTO console_audit VALUES(?,?,?,?,?,?,?,?,?)")
      .run("duplicate", 200, "local", "fixture.review", "task_fixture", "owner", "null", JSON.stringify({ note: "database wins" }), "duplicate");
    const path = join(f.config.stateDir, "console-workbench-audit.json");
    await writeFile(path, JSON.stringify([saved("duplicate", 300, "old duplicate"), saved("legacy", 100, "legacy body"), saved("legacy", 400, "later duplicate")]));
    const version = f.ledger.db.pragma("data_version", { simple: true });
    const page = await readConsoleAudit(f.config, { limit: 1 });
    assert.equal(page.total, 2); assert.equal(page.items[0]?.id, "duplicate");
    assert.deepEqual(page.items[0]?.after, { note: "database wins" });
    const second = await readConsoleAudit(f.config, { limit: 1, offset: 1 });
    assert.equal(second.items[0]?.id, "legacy"); assert.deepEqual(second.items[0]?.after, { note: "legacy body" });
    const filtered = await readConsoleAudit(f.config, { q: "legacy body" });
    assert.equal(filtered.total, 1); assert.equal(filtered.items[0]?.id, "legacy");
    assert.equal(f.ledger.db.pragma("data_version", { simple: true }), version);
    assert.equal((f.ledger.db.prepare("SELECT COUNT(*) n FROM console_audit").get() as { n: number }).n, 1);
    assert.equal((f.ledger.db.prepare("SELECT COUNT(*) n FROM console_audit_imports").get() as { n: number }).n, 0);
    // Explicit recording retains the existing import behavior. Later GETs use
    // that committed database history, not a changed legacy file.
    new ConsoleAudit(f.config.stateDir, "local").record("fixture.write", "task_fixture", null, {}, "write_key");
    await writeFile(path, "malformed stale archive");
    const afterWrite = await readConsoleAudit(f.config);
    assert.equal(afterWrite.total, 3);
  } finally { await f.close(); }
});

test("a malformed unimported audit archive is explicit incomplete evidence, never an empty success", async () => {
  const f = await readonlyDetailFixture();
  try {
    await writeFile(join(f.config.stateDir, "console-workbench-audit.json"), "not JSON");
    await assert.rejects(readConsoleAudit(f.config), error => error instanceof WorkbenchError && error.code === "audit_history_unavailable");
    assert.equal((f.ledger.db.prepare("SELECT COUNT(*) n FROM console_audit_imports").get() as { n: number }).n, 0);
    assert.equal((f.ledger.db.prepare("SELECT COUNT(*) n FROM console_audit").get() as { n: number }).n, 0);
  } finally { await f.close(); }
});
