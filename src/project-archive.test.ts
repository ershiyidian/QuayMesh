import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalAgentStore } from "./local-agent-store.js";
import { WorkLedger } from "./work-ledger.js";
import { ProjectArchive } from "./project-archive.js";
import type { ThreadControl, ThreadSnapshot } from "./codex-thread-control.js";
import { ExecutionCoordinator } from "./execution-coordinator.js";
import { LocalActions } from "./console-workbench/actions.js";
import { WriteReceipts } from "./console-workbench/receipts.js";
import type { ServerConfig } from "./config.js";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "quaymesh-archive-")); const project = join(root, "project");
  mkdirSync(join(project, ".git"), { recursive: true });
  const state = join(root, "state"); const store = new LocalAgentStore(state); const ledger = new WorkLedger(state);
  const snapshots = new Map<string, ThreadSnapshot>(); const called: string[] = [];
  let mode: "ok" | "ack_lost" | "before_side_effect" = "ok";
  const provider: ThreadControl = {
    inspect: async (id) => { const snapshot = snapshots.get(id); if (!snapshot) throw new Error("Missing fixture"); return structuredClone(snapshot); },
    archive: async (id) => { called.push(`archive:${id}`); if (mode === "before_side_effect") throw new Error("Disconnected before known result"); snapshots.get(id)!.archived = true; if (mode === "ack_lost") throw new Error("Acknowledgement lost"); },
    unarchive: async (id) => { called.push(`restore:${id}`); snapshots.get(id)!.archived = false; }, close: async () => {},
  };
  const service = new ProjectArchive(ledger, provider);
  t.after(async () => { await service.close(); ledger.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const create = (name: string, createdHere = true) => {
    const agent = store.create({ workspaceRoot: project, workspaceId: "ws", profileName: "codex", provider: "codex" }); store.update(agent.id, { status: "idle" });
    const run = ledger.begin({ root: project, workspaceId: "ws", title: name, workItemId: name, runKey: "one", origin: { entryPoint: "chatgpt_mcp", evidence: "client_reported" } });
    const execution = ledger.beginExecution({ runId: run.id, agentId: agent.id, provider: "codex" });
    const threadKey = ledger.attachThread(execution, { threadId: name, instanceId: "fixture-instance", identityVerified: true, createdHere, priorTurnIds: [], priorTurnsClosed: true });
    ledger.requestStarted(execution); ledger.turnStarted(execution, `${name}-turn`);
    ledger.usage(execution, { threadId: name, turnId: `${name}-turn`, newThread: true, total: { inputTokens: 80, outputTokens: 20, totalTokens: 100 } });
    ledger.providerFinished(execution); ledger.endExecution(execution, "completed");
    ledger.finish(run.id, { status: "completed", acceptance: "passed", summary: "passed", evidence: [{ label: "test", reference: "fixture://test", outcome: "passed" }] });
    snapshots.set(name, { instanceId: "fixture-instance", identityVerified: true, threadId: name, name: ledger.thread(threadKey).title,
      cwd: project, status: "notLoaded", archived: false, turnIds: [`${name}-turn`], turnsClosed: true, inventoryComplete: true, openDescendantIds: [] });
    return { agent, run, threadKey };
  };
  return { project, ledger, store, service, create, snapshots, called, failAs: (value: typeof mode) => { mode = value; } };
}

test("project preview freezes only proven sessions, and archive/restore retain all usage", async (t) => {
  const f = fixture(t); const a = f.create("managed"); f.create("unproven", false);
  const plan = await f.service.plan(a.run.project_id, { mode: "archive" });
  assert.equal(plan.readyCount, 1); assert(plan.entries.some((entry) => entry.reason === "unproven_creation"));
  const newer = f.create("after-preview");
  await assert.rejects(f.service.execute(a.run.project_id, plan.batchId, plan.confirmationHash, false));
  const done = await f.service.execute(a.run.project_id, plan.batchId, plan.confirmationHash, true);
  assert.equal(done.succeededCount, 1); assert.equal(f.ledger.thread(newer.threadKey).archive_state, "active");
  assert.equal(f.ledger.thread(a.threadKey).archive_state, "archived");
  assert.throws(() => f.ledger.assertAgentUsable(a.agent.id));
  assert.equal(f.ledger.receipt(a.run.id).codexUsage?.totalTokens, 100);
  await f.service.execute(a.run.project_id, plan.batchId, plan.confirmationHash, true);
  assert.deepEqual(f.called, ["archive:managed"]);
  const restore = await f.service.plan(a.run.project_id, { mode: "restore", threadKeys: [a.threadKey] });
  await f.service.execute(a.run.project_id, restore.batchId, restore.confirmationHash, true);
  assert.equal(f.ledger.thread(a.threadKey).archive_state, "active");
  assert.deepEqual(f.called, ["archive:managed", "restore:managed"]);
});

test("unknown acknowledgement is reconciled, not blindly replayed", async (t) => {
  const f = fixture(t); const a = f.create("lost-ack"); const plan = await f.service.plan(a.run.project_id, { mode: "archive" });
  f.failAs("ack_lost"); const first = await f.service.execute(a.run.project_id, plan.batchId, plan.confirmationHash, true);
  assert.equal(first.status, "reconciliation_required"); assert.equal(f.ledger.thread(a.threadKey).archive_state, "unknown");
  const second = await f.service.execute(a.run.project_id, plan.batchId, plan.confirmationHash, true);
  assert.equal(second.status, "succeeded"); assert.deepEqual(f.called, ["archive:lost-ack"]);
});

test("an uncertain operation that has not reached its desired state is never automatically repeated", async (t) => {
  const f = fixture(t); const a = f.create("uncertain"); const plan = await f.service.plan(a.run.project_id, { mode: "archive" });
  f.failAs("before_side_effect"); await f.service.execute(a.run.project_id, plan.batchId, plan.confirmationHash, true);
  const checked = await f.service.execute(a.run.project_id, plan.batchId, plan.confirmationHash, true);
  assert.equal(checked.status, "reconciliation_required"); assert.equal(f.called.length, 1);
});

test("active, external, protected, descendant and instance-mismatched sessions are skipped", async (t) => {
  const f = fixture(t); const examples = ["active", "external", "protected", "descendant", "wrong-instance"].map((name) => f.create(name));
  f.snapshots.get("active")!.status = "active";
  f.snapshots.get("external")!.turnIds.push("user-direct-turn");
  f.ledger.protectThread(examples[2]!.run.project_id, examples[2]!.threadKey, true);
  f.snapshots.get("descendant")!.openDescendantIds.push("unmanaged-child");
  f.snapshots.get("wrong-instance")!.instanceId = "another-account";
  const plan = await f.service.plan(examples[0]!.run.project_id, { mode: "archive" });
  assert.equal(plan.readyCount, 0); assert(plan.entries.every((entry) => entry.status === "skipped")); assert.equal(f.called.length, 0);
});

test("changed preview, active reuse and cross-project selections never mutate provider state", async (t) => {
  const f = fixture(t); const a = f.create("protected-later"); const plan = await f.service.plan(a.run.project_id, { mode: "archive" });
  f.ledger.protectThread(a.run.project_id, a.threadKey, true);
  const skipped = await f.service.execute(a.run.project_id, plan.batchId, plan.confirmationHash, true);
  assert.equal(skipped.succeededCount, 0); assert.equal(f.called.length, 0);
  await assert.rejects(f.service.execute("wrong-project", plan.batchId, plan.confirmationHash, true));
  const b = f.create("active-later"); const another = await f.service.plan(b.run.project_id, { mode: "archive", threadKeys: [b.threadKey] });
  f.store.update(b.agent.id, { status: "queued" });
  await f.service.execute(b.run.project_id, another.batchId, another.confirmationHash, true); assert.equal(f.called.length, 0);
});

test("an uncertain entry does not starve independent ready threads or replay its side effect", async t => {
  const f = fixture(t), a = f.create("uncertain-batch-a"); f.create("uncertain-batch-b");
  const plan = await f.service.plan(a.run.project_id, { mode: "archive" });
  f.failAs("before_side_effect");
  const first = await f.service.execute(a.run.project_id, plan.batchId, plan.confirmationHash, true);
  assert.equal(first.status, "executing");
  assert.equal(first.readyCount, 1); assert.equal(first.reconciliationCount, 1);
  assert.equal(first.effect, "unknown");
  const uncertainCall = f.called[0];
  f.failAs("ok");
  const second = await f.service.execute(a.run.project_id, plan.batchId, plan.confirmationHash, true);
  assert.equal(second.succeededCount, 1); assert.equal(second.reconciliationCount, 1);
  assert.equal(second.readyCount, 0); assert.equal(second.status, "reconciliation_required");
  assert.equal(second.effect, "partial");
  await f.service.execute(a.run.project_id, plan.batchId, plan.confirmationHash, true);
  assert.equal(f.called.filter(call => call === uncertainCall).length, 1);
});

test("an archive request key binds one exact step and read-only reconciliation cannot advance the batch", async t => {
  const f = fixture(t), first = f.create("step-one"); f.create("step-two");
  const plan = await f.service.plan(first.run.project_id, { mode: "archive" });
  const actions = new LocalActions({ stateDir: f.ledger.stateDir, allowedRoots: [f.project] } as ServerConfig);
  const result = await f.service.execute(first.run.project_id, plan.batchId, plan.confirmationHash, true, "step-request-1");
  assert.equal(result.succeededCount, 1); assert.equal(result.readyCount, 1);
  const target = f.service.step(first.run.project_id, plan.batchId, "step-request-1")!;
  assert.equal(target.status, "succeeded");
  const verified = await actions.reconcileArchive(first.run.project_id, plan.batchId, "step-request-1");
  assert.equal(verified.verified, true); assert.equal(verified.effect, "applied");
  assert.equal(verified.response?.readyCount, 1); assert.equal(f.called.length, 1);
  assert.equal((await actions.reconcileArchive(first.run.project_id, plan.batchId, "missing-request")).verified, false);
  const replay = await f.service.execute(first.run.project_id, plan.batchId, plan.confirmationHash, true, "step-request-1");
  assert.equal(replay.succeededCount, 1); assert.equal(replay.readyCount, 1); assert.equal(f.called.length, 1);
  await f.service.execute(first.run.project_id, plan.batchId, plan.confirmationHash, true, "step-request-2");
  assert.equal(f.called.length, 2);
});

test("archive unknown and partial outcomes stay unresolved in durable HTTP receipts", async t => {
  const f = fixture(t), first = f.create("unknown-step-one"); f.create("unknown-step-two");
  const plan = await f.service.plan(first.run.project_id, { mode: "archive" });
  const receipts = new WriteReceipts(f.ledger.stateDir);
  f.failAs("before_side_effect");
  await receipts.execute("archive", "unknown", "/archive", { batchId: plan.batchId },
    () => f.service.execute(first.run.project_id, plan.batchId, plan.confirmationHash, true, "unknown"));
  assert.equal(receipts.get("archive", "unknown")?.state, "unknown");
  f.failAs("ok");
  await receipts.execute("archive", "partial", "/archive", { batchId: plan.batchId },
    () => f.service.execute(first.run.project_id, plan.batchId, plan.confirmationHash, true, "partial"));
  assert.equal(receipts.get("archive", "partial")?.state, "partial");
  const actions = new LocalActions({ stateDir: f.ledger.stateDir, allowedRoots: [f.project] } as ServerConfig);
  assert.equal((await actions.reconcileArchive(first.run.project_id, plan.batchId, "unknown")).verified, false);
  assert.equal(f.called.length, 2);
});

test("archiving an idle thread keeps unrelated live work and its claim intact", async t => {
  const f = fixture(t), a = f.create("independent-thread");
  const execution = new ExecutionCoordinator(f.ledger.stateDir);
  const claim = execution.acquire({ workspaceRoot: f.project, kind: "command", operationId: "other-task-command", taskId: "other-task" });
  try {
    const plan = await f.service.plan(a.run.project_id, { mode: "archive", threadKeys: [a.threadKey] });
    assert.equal(plan.readyCount, 1);
    const completed = await f.service.execute(a.run.project_id, plan.batchId, plan.confirmationHash, true);
    assert.equal(completed.succeededCount, 1);
    assert.ok(execution.inspect(f.project).some(value => value.id === claim.id));
  } finally { claim.release(); execution.close(); }
});

test("terminal failed history can be archived and incomplete usage needs explicit confirmation", async t => {
  const f = fixture(t), a = f.create("failed-history");
  f.ledger.db.prepare("UPDATE console_work_runs SET status='failed',acceptance='failed' WHERE id=?").run(a.run.id);
  assert.equal((await f.service.plan(a.run.project_id, { mode: "archive" })).readyCount, 1);
  f.ledger.db.prepare("UPDATE console_executions SET delta=NULL,usage_quality='unavailable' WHERE run_id=?").run(a.run.id);
  const skipped = await f.service.plan(a.run.project_id, { mode: "archive" });
  assert.equal(skipped.entries[0]?.reason, "usage_incomplete");
  const accepted = await f.service.plan(a.run.project_id, { mode: "archive", acceptPartial: true });
  assert.equal(accepted.readyCount, 1); assert.equal(accepted.acceptPartial, true);
});

test("provider cwd is checked at the exact project directory within a checkout", async t => {
  const f = fixture(t), a = f.create("exact-root");
  const nested = join(f.project, "nested"); mkdirSync(nested);
  f.snapshots.get("exact-root")!.cwd = nested;
  const plan = await f.service.plan(a.run.project_id, { mode: "archive" });
  assert.equal(plan.readyCount, 0);
  assert.equal(plan.entries[0]?.reason, "provider_project_mismatch");
});
