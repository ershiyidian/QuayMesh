import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalAgentStore } from "./local-agent-store.js";
import { WorkLedger } from "./work-ledger.js";
import { ProjectArchive } from "./project-archive.js";
import type { ThreadControl, ThreadSnapshot } from "./codex-thread-control.js";

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
