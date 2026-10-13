import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessSessionManager } from "./process-sessions.js";
import { WorkLedger } from "./work-ledger.js";
import { WorkRunViews } from "./work-run-views.js";
import { trackedWork } from "./tool-surfaces/work-task.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "quaymesh-process-evidence-"));
  const project = join(root, "project"), stateDir = join(root, "state");
  mkdirSync(project);
  const ledger = new WorkLedger(stateDir);
  const run = ledger.begin({ root: project, workspaceId: "ws", workItemId: "test", runKey: "first", title: "Process evidence",
    origin: { entryPoint: "other_mcp", evidence: "server_entry" } });
  const events: { event: string; fields: Record<string, unknown> }[] = [];
  const manager = new ProcessSessionManager({ stateDir, diagnostics: (event, fields) => { events.push({ event, fields }); } });
  return { project, stateDir, ledger, run, events, manager,
    close: async () => { await manager.shutdown(); ledger.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("yielded failure persists safe exit evidence even without a terminal poll", async () => {
  const context = fixture();
  const { manager, ledger, run, project, events } = context;
  try {
    const initial = await manager.start({ workspaceId: "ws", cwd: project, workRunId: run.id,
      command: `"${process.execPath}" -e "console.log('private-output-marker');setTimeout(()=>process.exit(7),100)"`, yieldTimeMs: 0 });
    assert.equal(initial.running, true);
    assert.ok(initial.operationId);
    for (let attempt = 0; attempt < 100 && !events.some((entry) => entry.event === "process_finished"); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const operation = ledger.db.prepare("select status,evidence from console_operations where id=?").get(initial.operationId) as { status: string; evidence: string };
    assert.equal(operation.status, "failed");
    const evidence = JSON.parse(operation.evidence);
    assert.equal(evidence[0].outcome, "failed");
    const details = JSON.parse(evidence[0].reference);
    assert.equal(details.exitCode, 7);
    assert.equal(details.retry, "reconcile_before_replay");
    assert.ok(details.outputBytes > 0);
    assert.ok(!JSON.stringify({ evidence, events }).includes("private-output-marker"));
    assert.equal(events.filter((entry) => entry.event === "process_finished").length, 1);
    assert.equal(events.find((entry) => entry.event === "process_finished")?.fields.operationId, initial.operationId);
    const snapshot = new WorkRunViews(ledger).snapshot(run.id);
    assert.equal(snapshot.executionStatus, "running");
    assert.equal(snapshot.activeOperationCount, 0);
    assert.equal(snapshot.nextAction, "reconcile_and_finish_work");
    const terminal = await manager.write({ workspaceId: "ws", sessionId: initial.sessionId!, yieldTimeMs: 0 });
    assert.equal(terminal.operationId, initial.operationId);
    assert.equal(terminal.workRunId, run.id);
    assert.equal(terminal.exitCode, 7);
  } finally { await context.close(); }
});

test("spawn errors have fingerprints and release claims; logging failures do not break completion", async () => {
  const context = fixture();
  try {
    await assert.rejects(context.manager.start({ workspaceId: "ws", workspaceRoot: context.project,
      cwd: join(context.project, "missing"), command: "echo never" }), { code: "ENOENT" });
    // 已知项目范围下，确认真正的子进程启动失败也保存错误证据。
    await assert.rejects(context.manager.start({ workspaceId: "ws", workspaceRoot: context.project,
      cwd: join(context.project, "missing"), scopeRoot: context.project,
      workRunId: context.run.id, command: "echo never", yieldTimeMs: 1000 }), { code: "ENOENT" });
    const row = context.ledger.db.prepare("select status,evidence from console_operations where run_id=?").get(context.run.id) as { status: string; evidence: string };
    assert.equal(row.status, "failed");
    const evidence = JSON.parse(JSON.parse(row.evidence)[0].reference);
    assert.equal(evidence.errorCode, "ENOENT");
    assert.match(evidence.errorFingerprint, /^[a-f0-9]{16}$/);
    assert.equal(context.manager.executionCoordinator?.inspect(context.project).length, 0);
    const manager = new ProcessSessionManager({ diagnostics: () => { throw new Error("log failure"); } });
    try {
      const success = await manager.start({ workspaceId: "ws", cwd: context.project, command: `"${process.execPath}" -e "process.exit(0)"`, yieldTimeMs: 2000 });
      assert.equal(success.exitCode, 0);
    } finally { await manager.shutdown(); }
  } finally { await context.close(); }
});

test("tracked errors preserve original exception and persist nonempty redacted evidence", async () => {
  const context = fixture();
  try {
    const scope = { root: context.project, workspaceId: "ws" };
    const error = new Error("private-error-marker");
    await assert.rejects(trackedWork(context.stateDir, context.run.id, scope, "read", async () => { throw error; }), (actual) => actual === error);
    const result = { isError: true, content: [{ type: "text", text: "private-error-marker" }] };
    assert.equal(await trackedWork(context.stateDir, context.run.id, scope, "patch", async () => result), result);
    const rows = context.ledger.db.prepare("select status,evidence from console_operations where run_id=?").all(context.run.id) as { status: string; evidence: string }[];
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.status, "failed");
      assert.equal(JSON.parse(row.evidence).length, 1);
      assert.ok(!row.evidence.includes("private-error-marker"));
    }
  } finally { await context.close(); }
});

test("accounting failure is observable without blocking process completion or releasing its claim late", async () => {
  const fixtureContext = fixture();
  try {
    fixtureContext.ledger.db.exec(`CREATE TRIGGER reject_completion BEFORE UPDATE OF status ON console_operations
      WHEN NEW.status IN ('completed', 'failed') BEGIN SELECT RAISE(ABORT, 'private-database-error'); END`);
    const result = await fixtureContext.manager.start({ workspaceId: "ws", cwd: fixtureContext.project,
      workRunId: fixtureContext.run.id, command: `"${process.execPath}" -e "process.exit(0)"`, yieldTimeMs: 2000 });
    assert.equal(result.running, false);
    assert.equal(result.exitCode, 0);
    assert.match(result.output, /accounting could not be finalized/);
    assert.equal(fixtureContext.manager.executionCoordinator?.inspect(fixtureContext.project).length, 0);
    const failure = fixtureContext.events.find((entry) => entry.event === "process_accounting_failed");
    assert.equal(failure?.fields.operationId, result.operationId);
    assert.ok(!JSON.stringify(failure).includes("private-database-error"));
  } finally { await fixtureContext.close(); }
});
