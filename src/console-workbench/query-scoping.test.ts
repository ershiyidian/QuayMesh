import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerConfig } from "../config.js";
import { WorkLedger } from "../work-ledger.js";
import { runExecutionStatus } from "../task-view.js";
import { executionTimeEnd, observeSourceStates } from "../console-task-state.js";
import { readLocalIndex } from "./local.js";
import type { TaskPhaseIndex } from "./local-queries.js";
import { aggregateTaskIndex, fallbackTask, compareTaskIndex } from "./task-aggregation.js";
import { compareRuns, decodeBoundary, pageCursor, runQuery, runSortValue, selectRunPage } from "./run-query.js";
import { WorkbenchError } from "./types.js";

test("a small summary query classifies only requested IDs and metadata-only reads do not classify history", t => {
  const directory = mkdtempSync(join(tmpdir(), "qm-summary-scope-")), root = join(directory, "project");
  mkdirSync(root);
  const config = { stateDir: join(directory, "state"), configDir: directory, allowedRoots: [root] } as ServerConfig;
  const ledger = new WorkLedger(config.stateDir);
  t.after(() => { ledger.close(); rmSync(directory, { recursive: true, force: true }); });
  const ids: string[] = [];
  for (let index = 0; index < 300; index++) ids.push(ledger.begin({ root, workItemId: `item-${index}`, runKey: "one", title: `phase ${index}`,
    origin: { entryPoint: "console", evidence: "server_entry" } }).id);
  const requested = [ids[20]!, ids[240]!], at = Date.now(), prepared: string[] = [];
  const originalPrepare = ledger.db.prepare.bind(ledger.db);
  Object.defineProperty(ledger.db, "prepare", { configurable: true, value: (sql: string) => { prepared.push(sql); return originalPrepare(sql); } });
  const selection = runQuery(ledger, "local", ledger.projects().map(project => project.id), { days: "0" }, at, { ids: requested, counts: false });
  Reflect.deleteProperty(ledger.db, "prepare");
  assert.equal(prepared.filter(sql => sql.includes("quaymesh_execution_status")).length, 0, "building the summary query must not execute an unused global count");
  let classified = 0;
  ledger.db.function("quaymesh_execution_status", { deterministic: true },
    (state, result, status, working, queued, unresolved, progress, finalizing, lastOutcome) => {
      classified++;
      return runExecutionStatus(state as string | null, result as string | null, String(status), working === 1, queued === 1,
        unresolved === 1, typeof progress === "string" ? Date.parse(progress) : null, at, finalizing === 1, typeof lastOutcome === "string" ? lastOutcome : null);
    });
  const rows = ledger.db.prepare(`${selection.sql} SELECT id,execution FROM selected`).all(...selection.params) as Array<{ id: string }>;
  assert.deepEqual(rows.map(row => row.id).sort(), [...requested].sort());
  assert.equal(classified, 2, "only requested phases may be classified");
  const explain = ledger.db.prepare(`EXPLAIN QUERY PLAN ${selection.sql} SELECT id,execution FROM selected`).all(...selection.params) as Array<{ detail: string }>;
  assert.ok(explain.some(row => /json_each/u.test(row.detail)));
  assert.ok(explain.some(row => /SEARCH r USING/u.test(row.detail)));
  t.diagnostic(explain.filter(row => /SEARCH r |json_each/u.test(row.detail)).map(row => row.detail).join("; "));
  assert.equal(readLocalIndex(config, requested).runs.length, 2);
  assert.equal(readLocalIndex(config, []).runs.length, 0);
  const all = runQuery(ledger, "local", ledger.projects().map(project => project.id), { days: "0" }, at);
  assert.equal(all.total, 300, "exact all-history counts remain available to paginated APIs");
});

test("invalid cursors always reject before dispatch with a stable 400 outcome", () => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const valid = { value: 1, id: "run", direction: "next", offset: 0, at: Date.now(), snapshot: "snapshot-1" };
  assert.deepEqual(decodeBoundary(encode(valid)), valid);
  for (const cursor of ["%%%", Buffer.from("not json").toString("base64url"), encode(null), encode({ ...valid, snapshot: 42 }), encode({ ...valid, offset: -1 })]) {
    assert.throws(() => decodeBoundary(cursor), error => error instanceof WorkbenchError
      && error.status === 400 && error.code === "invalid_cursor" && error.effect === "none");
  }
});

test("execution reconciliation reads use active-state indexes and preserve stale and unknown observations", t => {
  const directory = mkdtempSync(join(tmpdir(), "qm-reconciliation-read-")), root = join(directory, "project");
  mkdirSync(root);
  const ledger = new WorkLedger(join(directory, "state")), at = Date.now();
  t.after(() => { ledger.close(); rmSync(directory, { recursive: true, force: true }); });
  const run = ledger.begin({ root, workItemId: "history", runKey: "one", title: "History with a current operation",
    origin: { entryPoint: "console", evidence: "server_entry" } });
  const operation = ledger.operation({runId:run.id,requestKey:"observation",kind:"command",label:"Observation",status:"completed"});
  const selected = runQuery(ledger,"local",ledger.projects().map(project=>project.id),{days:"0"},at,{counts:false});
  const sql = `${selected.sql} SELECT id,unresolved FROM selected`;
  const statement = ledger.db.prepare(sql);
  const observed = (status:string,observation:string|null) => {
    ledger.db.prepare("UPDATE console_operations SET status=?,observed_at=? WHERE id=?").run(status,observation,operation);
    return (statement.get(...selected.params) as {unresolved:number}).unresolved;
  };
  const fresh = new Date(at).toISOString(), stale = new Date(at-60_000).toISOString();
  for(const status of ["running","starting","queued"]) {
    assert.equal(observed(status,fresh),0,`${status} with a current observation`);
    assert.equal(observed(status,stale),1,`${status} with a stale observation`);
    assert.equal(observed(status,null),1,`${status} with no observation`);
  }
  for(const status of ["unknown","reconciliation_required"])assert.equal(observed(status,fresh),1);
  for(const status of ["completed","failed","stopped","cancelled"])assert.equal(observed(status,null),0);
  const plan = ledger.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...selected.params) as Array<{detail:string}>;
  const childSearches = plan.filter(row=>/SEARCH [oe] USING/.test(row.detail));
  assert.equal(childSearches.length,4);
  assert.ok(childSearches.every(row=>/\(run_id=\? AND status=\?\)/.test(row.detail)),
    "checking current execution must skip completed command history on both operation tables");
});

test("task duration sorting preserves the oldest member observation and freezes unknown execution", () => {
  const at = 1_000_000;
  const phase = (id: string, observedAt: number | null, stale: boolean): TaskPhaseIndex => ({ id, localId: id, nodeId: id,
    sessionId: "session", taskId: "task", title: "task", projectId: id, projectName: id, root: `/${id}`,
    executionStatus: "unknown", acceptanceStatus: "not_required", startedAt: 100, finishedAt: null, lastActivityAt: 400,
    tokens: 0, changed: false, actionableInterruption: true, currentPhase: true, observedAt, stale });
  const task = aggregateTaskIndex([phase("a", 500, true), phase("b", at, false)])[0]!;
  assert.equal(task.observedAt, 500); assert.equal(task.stale, true);
  const run = fallbackTask(task);
  assert.equal(runSortValue(run, { sort: "duration" }, at), 400);
  assert.equal(runSortValue(run, { sort: "duration" }, at + 100_000), 400);
  const freshUnknown = { ...run, stale: false, observedAt: at };
  assert.equal(executionTimeEnd(freshUnknown, at), 400);
  assert.equal(executionTimeEnd({ ...freshUnknown, observedAt: at + 5_000 }, at + 5_000), 400);
  const known = { ...task, key: "known", executionStatus: "completed", finishedAt: 2_000, observedAt: at, stale: false };
  assert.ok(compareTaskIndex(known, task, { sort: "duration" }, at) < 0);
  const missing = aggregateTaskIndex([phase("a", 500, true), phase("b", null, true)])[0]!;
  assert.equal(missing.observedAt, null);
  assert.equal(observeSourceStates([{ nodeId: "missing", executionStatus: "running" }], [], at)[0]?.executionStatus, "unknown");
});

test("SQL duration pages agree with in-memory sorting for fresh, stale, unknown and queued executions", t => {
  const directory = mkdtempSync(join(tmpdir(), "qm-duration-order-")), root = join(directory, "project"), at = Date.now();
  mkdirSync(root);
  t.mock.method(Date, "now", () => at);
  const config = { stateDir: join(directory, "state"), configDir: directory, allowedRoots: [root] } as ServerConfig;
  const ledger = new WorkLedger(config.stateDir);
  t.after(() => { ledger.close(); rmSync(directory, { recursive: true, force: true }); });
  const definitions = [
    { key: "fresh", status: "running", start: 100_000, progress: 1_000, observation: 0 },
    { key: "stale", status: "running", start: 120_000, progress: 100_000, observation: 60_000 },
    { key: "unknown", status: "unknown", start: 300_000, progress: 270_000, observation: 0 },
    { key: "queued", status: "queued", start: 600_000, progress: 10_000, observation: 0 },
    { key: "completed", status: "completed", start: 90_000, progress: 40_000, observation: 0 },
  ];
  for (const value of definitions) {
    const run = ledger.begin({ root, workItemId: value.key, runKey: "one", title: value.key,
      origin: { entryPoint: "console", evidence: "server_entry" } });
    const operation = ledger.operation({ runId: run.id, requestKey: value.key, kind: "command", label: value.key, status: value.status });
    ledger.db.prepare("UPDATE console_operations SET observed_at=? WHERE id=?")
      .run(new Date(at - value.observation).toISOString(), operation);
    ledger.db.prepare("UPDATE console_work_runs SET created_at=?,last_activity_at=?,status=?,finished_at=? WHERE id=?")
      .run(new Date(at - value.start).toISOString(), new Date(at - value.progress).toISOString(),
        value.status === "completed" ? "completed" : "running", value.status === "completed" ? new Date(at - value.progress).toISOString() : null, run.id);
  }
  const query = { sort: "duration", days: "0" }, projects = ledger.projects().map(project => project.id);
  const records = readLocalIndex(config).runs, sorted = [...records].sort((a, b) => compareRuns(a, b, query, at));
  assert.deepEqual(sorted.map(run => run.title), ["fresh", "completed", "unknown", "stale", "queued"]);
  assert.equal(records.find(run => run.title === "stale")?.executionStatus, "unknown");
  assert.equal(records.find(run => run.title === "unknown")?.executionStatus, "unknown");
  const all = selectRunPage(ledger, "local", projects, { ...query, limit: "100" });
  assert.deepEqual(all.ids, sorted.map(run => run.localId));
  const first = selectRunPage(ledger, "local", projects, { ...query, limit: "2" });
  const last = records.find(run => run.localId === first.ids.at(-1))!;
  const second = selectRunPage(ledger, "local", projects, { ...query, limit: "2", cursor: pageCursor(last, query, first.at, 2, "next") });
  assert.deepEqual([...first.ids, ...second.ids], sorted.slice(0, 4).map(run => run.localId), "SQL and cursor values use the same frozen clock");
});
