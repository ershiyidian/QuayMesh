import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { WorkLedger } from "../src/work-ledger.js";
import { SessionStore } from "../src/session/store.js";
import { readLocalTaskIndex } from "../src/console-workbench/local-queries.js";
import { createRealTestServer } from "./session-card/server-fixture.js";

test("the full task index omits unused summary bodies while preserving every field, row and old active task", { timeout: 120_000 }, async t => {
  const server = await createRealTestServer({ git: false, uiEnabled: false });
  const ledger = new WorkLedger(server.config.stateDir), store = new SessionStore(ledger.db);
  t.after(async () => { ledger.close(); await server.dispose(); });
  const historyCount = 2000, summary = "h".repeat(8192);
  const oldTime = new Date(Date.now() - 90 * 86_400_000).toISOString();
  const historical = ledger.begin({ root: server.project, workspaceId: "history-workspace", workItemId: "history",
    runKey: "history-template", title: "Historical result", origin: { entryPoint: "console", evidence: "server_entry" } });
  ledger.finish(historical.id, { status: "completed", acceptance: "not_applicable", summary, evidence: [] });
  ledger.db.prepare("UPDATE console_work_runs SET created_at=?,finished_at=?,last_activity_at=?,summary=? WHERE id=?")
    .run(oldTime, oldTime, oldTime, summary, historical.id);
  const historyIds = [historical.id];
  const insert = ledger.db.prepare(`INSERT INTO console_work_runs
    (id,project_id,item_id,workspace_id,run_key,request_hash,origin,status,acceptance,summary,evidence,revision,created_at,finished_at,last_activity_at)
    SELECT ?,project_id,item_id,workspace_id,?,request_hash,origin,status,acceptance,summary,evidence,revision,created_at,finished_at,last_activity_at
    FROM console_work_runs WHERE id=?`);
  ledger.db.transaction(() => {
    for (let index = 1; index < historyCount; index++) {
      const id = `history-run-${index}`;
      insert.run(id, `history-${index}`, historical.id);
      historyIds.push(id);
    }
  }).immediate();

  // An old Task remains open without a running command. A time window must not
  // hide it just because its run was created before the window.
  const session = store.createSession("owner", "index-history-conversation", "Old active task");
  const nodeId = server.config.federation?.nodeId ?? "local";
  const member = store.addMember(session.id, nodeId, "active-workspace", server.project, "checkout", null);
  const task = store.createTask(session.id, "Old active task", "old-active-request");
  const active = ledger.begin({ root: server.project, workspaceId: "active-workspace", workItemId: "active",
    runKey: "active", title: "Old active task", origin: { entryPoint: "console", evidence: "server_entry" } });
  store.linkRun(session.id, member.id, active.id, task.id);
  ledger.db.prepare("UPDATE qm_tasks SET created_at=? WHERE id=?").run(oldTime, task.id);
  ledger.db.prepare("UPDATE console_work_runs SET created_at=? WHERE id=?").run(oldTime, active.id);

  const ending = " FROM selected ORDER BY started_ms DESC,reference";
  const prepare = Database.prototype.prepare;
  let comparison: { rows: number; currentStringBytes: number; legacyStringBytes: number; removedSummaryBytes: number } | undefined;
  const stringBytes = (rows: Array<Record<string, unknown>>) => rows.reduce((sum, row) => sum +
    Object.values(row).reduce<number>((bytes, value) => bytes + (typeof value === "string" ? Buffer.byteLength(value) : 0), 0), 0);
  const capture = t.mock.method(Database.prototype, "prepare", function (this: Database.Database, sql: string) {
    const statement = prepare.call(this, sql);
    if (!sql.includes(ending)) return statement;
    const database = this;
    return new Proxy(statement, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (key === "all") return (...parameters: unknown[]) => {
          const current = Reflect.apply(value, target, parameters) as Array<Record<string, unknown>>;
          // Replay exactly this real query with only the discarded legacy column
          // restored. No alternate filters, ordering or history limit are used.
          const legacyStatement = prepare.call(database, sql.replace(ending, ",summary" + ending));
          const legacy = Reflect.apply(legacyStatement.all, legacyStatement, parameters) as Array<Record<string, unknown>>;
          assert.ok(current.every(row => !("summary" in row)));
          const withoutSummary = legacy.map(({ summary: _summary, ...row }) => row);
          assert.deepEqual(current, withoutSummary, "all remaining SQLite fields and their order must match exactly");
          const removedSummaryBytes = legacy.reduce((sum, row) => sum + Buffer.byteLength(String(row.summary ?? "")), 0);
          comparison = { rows: current.length, currentStringBytes: stringBytes(current), legacyStringBytes: stringBytes(legacy), removedSummaryBytes };
          return current;
        };
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  });
  const before = Date.now();
  const index = readLocalTaskIndex(server.config, before);
  capture.mock.restore();
  assert.ok(comparison);
  assert.equal(comparison.rows, historyCount + 1);
  assert.equal(comparison.removedSummaryBytes, historyCount * Buffer.byteLength(summary));
  assert.equal(comparison.legacyStringBytes - comparison.currentStringBytes, comparison.removedSummaryBytes);
  assert.equal(index.items.length, historyCount + 1);
  assert.deepEqual(new Set(index.items.map(row => row.localId)), new Set([...historyIds, active.id]));
  assert.ok(index.observedAt >= before && index.observedAt <= Date.now());
  const oldActive = index.items.find(row => row.taskId === task.id)!;
  assert.equal(oldActive.requestState, "active");
  assert.equal(oldActive.executionStatus, "waiting");
  assert.ok(oldActive.startedAt < before - 86_400_000);

  const login = await fetch(server.baseUrl + "/console/api/login", { method: "POST",
    headers: { origin: server.baseUrl, "content-type": "application/json" },
    body: JSON.stringify({ password: server.config.oauth.ownerToken }) });
  assert.equal(login.status, 200, await login.clone().text());
  const cookie = login.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
  const get = async (path: string) => {
    const response = await fetch(server.baseUrl + "/console/api/v4/" + path, { headers: { cookie } });
    assert.equal(response.status, 200, await response.clone().text());
    return await response.json() as any;
  };
  const all = await get("runs?days=0&limit=25&fresh=1");
  assert.equal(all.total, historyCount + 1);
  assert.equal(all.counts.all, historyCount + 1);
  assert.equal(all.items.length, 25);
  assert.equal(all.complete, true);
  const activePage = await get("runs?days=1&requestState=active&limit=25&fresh=1");
  assert.equal(activePage.total, 1);
  assert.equal(activePage.items[0].taskId, task.id);
  assert.equal(activePage.items[0].requestState, "active");
  assert.equal(activePage.complete, true);
  assert.ok(activePage.sources.every((source: any) => source.observedAt !== null && !source.stale && !source.error));
  const overview = await get("overview?tz=UTC&fresh=1");
  assert.equal(overview.waitingCount, 1);
  assert.equal(overview.runningCount, 0);
  assert.equal(overview.completedToday, 0);
  assert.equal(overview.coverage.tasks, true);
  assert.equal(overview.complete, true);
  assert.ok(overview.waiting.some((row: any) => row.taskId === task.id));
  assert.ok(overview.sources.every((source: any) => source.observedAt !== null && !source.stale && !source.error));
  t.diagnostic(JSON.stringify({ fixture: "2000 historical runs with 8192-byte summaries plus one 90-day-old active Task",
    ...comparison, indexedRows: index.items.length, allTaskCount: all.total, activeTasksInOneDayWindow: activePage.total }));
});
