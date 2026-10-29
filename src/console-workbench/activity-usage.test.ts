import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerConfig } from "../config.js";
import { WorkLedger } from "../work-ledger.js";
import { LocalAgentStore } from "../local-agent-store.js";
import { SessionStore } from "../session/store.js";
import { OperationState } from "../session/types.js";
import { readLocalActivity } from "./activity.js";
import { readLocalUsage } from "./usage-query.js";
import { readLocalOverviewUsage } from "./local-queries.js";

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "qm-console-activity-")), project = join(directory, "project"), stateDir = join(directory, "state");
  mkdirSync(project);
  const ledger = new WorkLedger(stateDir), agents = new LocalAgentStore(stateDir), store = new SessionStore(ledger.db);
  const config = { stateDir, configDir: directory, allowedRoots: [project] } as ServerConfig;
  const session = store.createSession("owner", "conversation", "Activity and usage");
  const member = store.addMember(session.id, "local", "workspace", project, "checkout", null);
  const task = store.createTask(session.id, "A task with multiple phases");
  const createRun = (key: string) => {
    const run = ledger.begin({ root: project, workspaceId: "workspace", workItemId: key, runKey: key, title: key,
      origin: { entryPoint: "console", evidence: "server_entry" } });
    store.linkRun(session.id, member.id, run.id, task.id);
    return run;
  };
  const execution = (runId: string, tokens: number, finishedAt: string | null) => {
    const agent = agents.create({ workspaceRoot: project, workspaceId: "workspace", profileName: "codex", provider: "codex" });
    const id = ledger.beginExecution({ runId, agentId: agent.id, provider: "codex" });
    ledger.db.prepare("UPDATE console_executions SET status=?,requested=1,provider_finished=?,delta=?,usage_quality=?,finished_at=? WHERE id=?")
      .run(finishedAt ? "completed" : "running", finishedAt ? 1 : 0, JSON.stringify({ inputTokens: tokens - 10, outputTokens: 10, totalTokens: tokens }),
        finishedAt ? "complete" : "partial", finishedAt, id);
    return id;
  };
  t.after(() => { agents.close(); ledger.close(); rmSync(directory, { recursive: true, force: true }); });
  return { ledger, store, config, session, member, task, createRun, execution };
}

test("calls keep request identity and first response time while events use transition timestamps", t => {
  const f = fixture(t), run = f.createRun("cross-midnight-command");
  const finished = Date.now(), started = finished - 90_000_000;
  const operation = f.ledger.operation({ runId: run.id, requestKey: "operation", kind: "command", label: "a long background command", status: "running" });
  f.ledger.db.prepare("UPDATE console_operations SET created_at=?,finished_at=?,status='failed' WHERE id=?")
    .run(new Date(started).toISOString(), new Date(finished).toISOString(), operation);
  f.store.reserveInvocation({ id: "invocation-original", ownerId: "owner", transportInstanceId: "transport", requestId: "request-42",
    sessionId: f.session.id, memberId: f.member.id, toolName: "exec_command", argumentsJson: "{}", operationId: operation, taskId: f.task.id });
  f.ledger.db.prepare("UPDATE qm_invocations SET created_at=?,response_at=?,finished_at=?,state='failed',result_json=? WHERE id='invocation-original'")
    .run(new Date(started).toISOString(), new Date(started + 50).toISOString(), new Date(finished).toISOString(), JSON.stringify({ kind: "result", value: { accepted: true } }));
  f.store.appendEvent({ session_id: f.session.id, task_id: f.task.id, member_id: f.member.id, source_id: "started", type: "operation_started",
    timestamp: new Date(started).toISOString(), payload: { operation_id: operation, invocation_id: "invocation-original", status: "running", label: "a long background command" } });
  f.store.appendEvent({ session_id: f.session.id, task_id: f.task.id, member_id: f.member.id, source_id: "finished", type: "operation_finished",
    timestamp: new Date(finished).toISOString(), payload: { operation_id: operation, invocation_id: "invocation-original", status: "failed" } });
  const calls = readLocalActivity(f.config, "calls", { limit: 20, q: "exec_command" });
  assert.equal(calls.total, 1);
  assert.equal(calls.items[0]?.requestId, "request-42");
  assert.equal(calls.items[0]?.operationId, operation);
  assert.equal(calls.items[0]?.state, "responded");
  assert.equal(calls.items[0]?.duration, 50);
  assert.equal(calls.items[0]?.executionDuration, 90_000_000);
  const events = readLocalActivity(f.config, "events", { limit: 20, q: "exec_command", level: "error" });
  assert.equal(events.total, 1); assert.equal(events.items[0]?.time, finished);
  assert.equal(events.bins.reduce((sum, bin) => sum + bin.errors, 0), 1);
});

test("unknown operation observations are warnings and incremental events preserve tied timestamps", t => {
  const f = fixture(t), run = f.createRun("unresolved");
  const operation = f.ledger.operation({ runId: run.id, requestKey: "unknown", kind: "command", label: "unresolved command", status: "unknown" });
  const time = Date.now();
  f.ledger.db.prepare("UPDATE console_operations SET observed_at=? WHERE id=?").run(new Date(time).toISOString(), operation);
  f.store.appendEvent({ session_id: f.session.id, task_id: f.task.id, member_id: f.member.id, source_id: "initial", type: "operation_started",
    timestamp: new Date(time - 1000).toISOString(), payload: { operation_id: operation, status: "running" } });
  assert.equal(readLocalActivity(f.config, "events", { limit: 20, level: "warn" }).items[0]?.details.status, "unknown");
  for (const source of ["one", "two"]) f.store.appendEvent({ session_id: f.session.id, task_id: f.task.id, member_id: f.member.id,
    source_id: source, type: "operation_finished", timestamp: new Date(time).toISOString(), payload: { operation_id: `op-${source}`, status: "failed" } });
  const first = readLocalActivity(f.config, "events", { limit: 1, level: "error", after: String(time - 1) });
  assert.equal(first.hasMore, true); assert.ok(first.nextAfter);
  const next = readLocalActivity(f.config, "events", { limit: 1, level: "error", after: String(first.nextAfter.after), afterId: first.nextAfter.afterId });
  assert.equal(next.items.length, 1); assert.notEqual(next.items[0]?.id, first.items[0]?.id);
  assert.equal(next.hasMore, false);
});

test("invocation first response is immutable and structured tool errors remain failed calls", t => {
  const f = fixture(t);
  const reserve = (id: string) => f.store.reserveInvocation({ id, ownerId: "owner", transportInstanceId: "transport", requestId: id,
    sessionId: f.session.id, memberId: f.member.id, toolName: "exec_command", argumentsJson: "{}", taskId: f.task.id });
  reserve("accepted-command");
  const identity = { ownerId: "owner", transportInstanceId: "transport", requestId: "accepted-command" };
  f.store.updateInvocation({ ...identity, state: OperationState.running, effect: "started", responded: true,
    result: { kind: "result", value: { accepted: true, running: true } } });
  const first = f.store.findInvocation("owner", "transport", "accepted-command")!;
  assert.ok(first.response_json);
  f.store.updateInvocation({ ...identity, state: OperationState.failed, effect: "completed", finished: true, responded: true,
    result: { kind: "error", message: "later process failure" } });
  const saved = f.store.findInvocation("owner", "transport", "accepted-command")!;
  assert.equal(saved.response_json, first.response_json);
  assert.equal(saved.response_at, first.response_at);
  assert.notEqual(saved.result_json, saved.response_json);

  reserve("rejected-command");
  f.store.updateInvocation({ ownerId: "owner", transportInstanceId: "transport", requestId: "rejected-command",
    state: OperationState.failed, effect: "not_started", responded: true, finished: true,
    result: { kind: "result", value: { isError: true, content: [{ type: "text", text: "Execution was not admitted" }] } } });
  const calls = readLocalActivity(f.config, "calls", { limit: 20 });
  const accepted = calls.items.find(row => row.requestId === "accepted-command")!;
  assert.equal(accepted.ok, true); assert.equal(accepted.executionState, "failed");
  assert.equal(accepted.responseRecorded, true);
  const rejected = calls.items.find(row => row.requestId === "rejected-command")!;
  assert.equal(rejected.ok, false); assert.equal(rejected.level, "error");
  assert.equal(rejected.error, "Execution was not admitted");
});

test("usage is recognized by execution finish day with active usage kept separately", t => {
  const f = fixture(t), run = f.createRun("old-run-new-turns");
  const at = Date.parse("2026-10-22T16:00:00.000Z");
  f.ledger.db.prepare("UPDATE console_work_runs SET created_at=? WHERE id=?").run("2026-08-01T00:00:00.000Z", run.id);
  f.execution(run.id, 100, "2026-10-21T23:00:00.000Z");
  f.execution(run.id, 200, "2026-10-22T01:00:00.000Z");
  f.execution(run.id, 50, null);
  const usage = readLocalUsage(f.config, { days: "2", tz: "UTC" }, at);
  assert.equal(usage.total, 300); assert.equal(usage.records, 2);
  assert.deepEqual(usage.daily.map(day => [day.day, day.total]), [["2026-10-21", 100], ["2026-10-22", 200]]);
  assert.equal(usage.pendingUsage.total, 50); assert.equal(usage.pendingUsage.records, 1);
  assert.equal(usage.basis, "execution_finished_at"); assert.equal(usage.unit, "execution");
  assert.equal(usage.top[0]?.usage.total, 300);
  assert.equal(usage.runIds.length, 1);
  const withoutRuns = readLocalUsage(f.config, { days: "2", tz: "UTC" }, at, { includeRuns: false });
  assert.equal(withoutRuns.total, 300); assert.equal(withoutRuns.top.length, 0);
  assert.deepEqual(withoutRuns.runIds, usage.runIds);
  const overview = readLocalOverviewUsage(f.config, "UTC", at);
  assert.equal(overview.todayUsage.total, 200); assert.equal(overview.projects[0]?.usage, 200);
});

test("usage returns every contributing phase so a global task ranking can aggregate before truncation", t => {
  const f = fixture(t), at = Date.now();
  for (let index = 0; index < 10; index++) {
    const run = f.createRun(`phase-${index}`);
    f.execution(run.id, 20 + index, new Date(at).toISOString());
  }
  const usage = readLocalUsage(f.config, { days: "1", tz: "UTC" }, at);
  assert.equal(usage.top.length, 10);
  assert.equal(new Set(usage.top.map(run => run.taskId)).size, 1);
  assert.equal(usage.total, 245);
});
