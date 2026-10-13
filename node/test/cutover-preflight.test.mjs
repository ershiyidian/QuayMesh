import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { checkCutoverIdle } from "../cutover-preflight.mjs";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

test("网络交接前准确拒绝进行中的命令、代理和执行资源", () => {
  const root = mkdtempSync(join(tmpdir(), "quaymesh-cutover-preflight-"));
  const core = join(root, "core");
  mkdirSync(core);
  const db = new Database(join(core, "quaymesh.sqlite"));
  try {
    db.exec([
      "CREATE TABLE execution_claims (id TEXT);",
      "CREATE TABLE qm_runtime_work (id TEXT, blocking INTEGER);",
      "CREATE TABLE console_operations (id TEXT, status TEXT);",
      "CREATE TABLE console_executions (id TEXT, status TEXT);",
    ].join("\n"));
    assert.equal(checkCutoverIdle(root).idle, true);
    for (const [table, column] of [
      ["execution_claims", "id"],
      ["qm_runtime_work", "blocking"],
      ["console_operations", "status"],
      ["console_executions", "status"],
    ]) {
      const value = column === "blocking" ? 1 : column === "status" ? "running" : "claim";
      db.prepare("INSERT INTO " + table + "(" + column + ") VALUES (?)").run(value);
      assert.equal(checkCutoverIdle(root).idle, false, table);
      db.exec("DELETE FROM " + table);
    }
    db.prepare("INSERT INTO console_operations(status) VALUES ('completed')").run();
    db.prepare("INSERT INTO qm_runtime_work(blocking) VALUES (0)").run();
    assert.equal(checkCutoverIdle(root).idle, true);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
