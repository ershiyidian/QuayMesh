import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerConfig } from "../config.js";
import { WorkLedger } from "../work-ledger.js";
import { LocalAgentStore } from "../local-agent-store.js";
import { reconcileControl, type ControlOutcome } from "./control-actions.js";
import { WriteReceipts } from "./receipts.js";

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "qm-control-reconcile-")), root = join(directory, "project");
  mkdirSync(root);
  const config = { stateDir: join(directory, "state"), configDir: directory, allowedRoots: [root] } as ServerConfig;
  const ledger = new WorkLedger(config.stateDir), agents = new LocalAgentStore(config.stateDir), receipts = new WriteReceipts(config.stateDir);
  const run = ledger.begin({ root, workItemId: "controlled", runKey: "one", title: "controlled",
    origin: { entryPoint: "console", evidence: "server_entry" } });
  t.after(() => { agents.close(); ledger.close(); rmSync(directory, { recursive: true, force: true }); });
  return { config, ledger, agents, receipts, run, root };
}

test("accepted command targets reconcile one by one without dispatch or affecting later commands", async t => {
  const f = fixture(t), key = "interrupt";
  const targets = ["a", "b"].map(label => ({ id: f.ledger.operation({ runId: f.run.id, requestKey: label,
    kind: "command", label, status: "running" }), kind: "command" as const, executionIds: [] }));
  await f.receipts.execute(`control-plan:${f.run.id}`, key, "control-plan", {}, () => ({ action: "interrupt", targets }));
  for (const target of targets) await f.receipts.execute(`control-target:${f.run.id}:command:${target.id}`, key, "control-target", {},
    () => ({ id: target.id, kind: target.kind, status: "accepted", effect: "applied" }));
  let dispatched = 0;
  const original = () => f.receipts.execute("node:control", key, "/control", {}, () => {
    dispatched++; return reconcileControl(f.config, f.run.id, key).response;
  });
  const initial = await original() as { status: string };
  assert.equal(initial.status, "accepted");
  f.ledger.db.prepare("UPDATE console_operations SET status='cancelled',finished_at=? WHERE id=?")
    .run(new Date().toISOString(), targets[0]!.id);
  const first = await f.receipts.reconcile("node:control", key, async () => reconcileControl(f.config, f.run.id, key));
  assert.equal(first?.state, "completed");
  assert.deepEqual((first?.response as { counts: unknown }).counts, { completed: 1, accepted: 1, rejected: 0, unknown: 0 });
  f.ledger.db.prepare("UPDATE console_operations SET status='cancelled',finished_at=? WHERE id=?")
    .run(new Date().toISOString(), targets[1]!.id);
  const later = f.ledger.operation({ runId: f.run.id, requestKey: "later", kind: "command", label: "later", status: "running" });
  const terminal = await f.receipts.reconcile("node:control", key, async () => reconcileControl(f.config, f.run.id, key));
  assert.equal((terminal?.response as { status: string }).status, "completed");
  assert.deepEqual(await original(), terminal?.response); assert.equal(dispatched, 1);
  assert.equal((f.ledger.db.prepare("SELECT status FROM console_operations WHERE id=?").get(later) as { status: string }).status, "running");
});

test("resume reconciliation follows its recorded execution identity and cannot adopt a later unrelated turn", async t => {
  const f = fixture(t), key = "resume";
  const agentId = f.agents.create({ workspaceRoot: f.root, profileName: "codex", provider: "codex" }).id;
  const before = f.ledger.beginExecution({ runId: f.run.id, agentId, provider: "codex" });
  f.ledger.endExecution(before, "cancelled");
  const resumed = f.ledger.beginExecution({ runId: f.run.id, agentId, provider: "codex" });
  const target = { id: agentId, kind: "agent", executionIds: [before] };
  await f.receipts.execute(`control-plan:${f.run.id}`, key, "control-plan", {}, () => ({ action: "resume", targets: [target] }));
  await f.receipts.execute(`control-target:${f.run.id}:agent:${agentId}`, key, "control-target", {},
    () => ({ id: agentId, kind: "agent", status: "accepted", effect: "applied", executionIds: [resumed] }));
  assert.equal((reconcileControl(f.config, f.run.id, key).response as { status: string }).status, "accepted");
  f.ledger.endExecution(resumed, "completed");
  f.ledger.beginExecution({ runId: f.run.id, agentId, provider: "codex" });
  const completed = reconcileControl(f.config, f.run.id, key);
  assert.equal(completed.verified, true);
  assert.equal((completed.response as { status: string }).status, "completed");
  assert.deepEqual((completed.response as { targets: ControlOutcome[] }).targets[0]?.executionIds, [resumed]);
  await f.receipts.execute(`control-plan:${f.run.id}`, "lost", "control-plan", {}, () => ({ action: "resume", targets: [target] }));
  assert.equal(reconcileControl(f.config, f.run.id, "lost").verified, false,
    "a later turn is not proof that an unacknowledged request was dispatched");
});
