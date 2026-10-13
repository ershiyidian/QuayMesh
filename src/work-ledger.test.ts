import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalAgentStore } from "./local-agent-store.js";
import { WorkLedger } from "./work-ledger.js";

test("successful artifact evidence survives failure of the overall acceptance", (t) => {
  const f = fixture(t);
  const run = f.begin("artifact-partial");
  const evidence = [{ label: "APK generated", reference: "artifact:apk-fixture", outcome: "passed" as const },
    { label: "Device installation", reference: "check:device", outcome: "failed" as const }];
  const receipt = f.ledger.finish(run.id, { status: "failed", acceptance: "failed", summary: "APK ready; installation failed", evidence });
  assert.equal(receipt.acceptanceStatus, "failed");
  assert.deepEqual(receipt.evidence, evidence);
  assert.deepEqual(f.ledger.receipt(run.id).evidence, evidence, "Recovery preserves per-artifact facts independently of total goal status");
});

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "quaymesh-work-ledger-"));
  const project = join(root, "project"); mkdirSync(join(project, ".git"), { recursive: true });
  const state = join(root, "state"); const store = new LocalAgentStore(state); const ledger = new WorkLedger(state);
  const agent = store.create({ workspaceRoot: project, workspaceId: "ws", profileName: "codex", provider: "codex" });
  store.update(agent.id, { status: "idle" });
  t.after(() => { ledger.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const begin = (key: string) => ledger.begin({ root: project, workspaceId: "ws", workItemId: "feature", runKey: key,
    title: "Implement feature", origin: { entryPoint: "chatgpt_mcp", evidence: "client_reported", modelLabel: "GPT-6 Pro" } });
  const make = (runId: string, turnId: string, ids: string[] = [], createdHere = true) => {
    const executionId = ledger.beginExecution({ runId, agentId: agent.id, provider: "codex" });
    ledger.attachThread(executionId, { threadId: "thread", instanceId: "instance", identityVerified: true, createdHere,
      priorTurnIds: ids, priorTurnsClosed: true });
    ledger.requestStarted(executionId); ledger.turnStarted(executionId, turnId); return executionId;
  };
  const usage = (executionId: string, turnId: string, total: number) => ledger.usage(executionId, { threadId: "thread", turnId, newThread: false,
    total: { inputTokens: total * .8, cachedInputTokens: total * .6, outputTokens: total * .2, reasoningOutputTokens: total * .1, totalTokens: total } });
  const finishExecution = (executionId: string) => { ledger.providerFinished(executionId); ledger.endExecution(executionId, "completed"); };
  const finish = (runId: string) => ledger.finish(runId, { status: "completed", acceptance: "passed", summary: "Verified",
    evidence: [{ label: "Unit tests", reference: "test://fixture", outcome: "passed" }] });
  return { root, project, state, store, ledger, agent, begin, make, usage, finishExecution, finish };
}

test("explicit project names preserve identity and survive ordinary registration", (t) => {
  const f = fixture(t);
  const original = f.ledger.project(f.project);
  const named = f.ledger.project(f.project, "LanggraphAgent");
  assert.equal(named.id, original.id);
  assert.equal(named.root, original.root);
  assert.equal(f.ledger.project(f.project).name, "LanggraphAgent");
  assert.throws(() => f.ledger.project(f.project, " "));
  assert.equal(f.ledger.project(f.project).name, "LanggraphAgent");
});

test("a host-only run has an explicit zero receipt and idempotent final acceptance", (t) => {
  const f = fixture(t); const run = f.begin("host");
  assert.equal(f.begin("host").id, run.id);
  f.ledger.operation({ runId: run.id, requestKey: "inspect", kind: "read", label: "Host inspected source", status: "completed" });
  const receipt = f.finish(run.id);
  assert.equal(receipt.usageStatus, "not_used"); assert.equal(receipt.codexUsage?.totalTokens, 0);
  assert.equal(f.finish(run.id).receiptRevision, receipt.receiptRevision);
  assert.throws(() => f.ledger.finish(run.id, { status: "failed", acceptance: "failed", summary: "changed", evidence: [] }));
  assert.throws(() => f.ledger.requireScope(run.id, f.project, "another-workspace"));
});

test("per-run usage excludes prior session history and does not sum cache/reasoning details twice", (t) => {
  const f = fixture(t); const first = f.begin("one"); const a = f.make(first.id, "t1");
  f.usage(a, "t1", 1000); f.usage(a, "t1", 1000); f.usage(a, "t1", 500);
  f.finishExecution(a); assert.equal(f.finish(first.id).codexUsage?.totalTokens, 1000);
  const second = f.begin("two"); const b = f.make(second.id, "t2", ["t1"], false);
  f.usage(b, "t2", 1500); f.finishExecution(b); const receipt = f.finish(second.id);
  assert.equal(receipt.usageStatus, "complete");
  assert.deepEqual(receipt.codexUsage, { inputTokens: 400, cachedInputTokens: 300, outputTokens: 100, reasoningOutputTokens: 50, totalTokens: 500 });
  assert.equal(f.ledger.projectUsage(first.project_id).codexUsage?.totalTokens, 1500);
});

test("external turns and missing usage remain unknown rather than attributed or replaced with zero", (t) => {
  const f = fixture(t); const first = f.begin("one"); const a = f.make(first.id, "t1"); f.usage(a, "t1", 1000); f.finishExecution(a); f.finish(first.id);
  const second = f.begin("external"); const b = f.make(second.id, "t2", ["t1", "external-user-turn"], false);
  f.usage(b, "t2", 10000); f.finishExecution(b);
  const result = f.finish(second.id); assert.equal(result.usageStatus, "unavailable"); assert.equal(result.codexUsage, null);
  assert.equal(f.ledger.threads(first.project_id)[0]!.external_activity, 1);
  const third = f.begin("missing"); const c = f.make(third.id, "t3", ["t1", "external-user-turn", "t2"], false); f.finishExecution(c);
  assert.equal(f.finish(third.id).codexUsage, null);
});

test("aggregation includes more than twenty turns and includes failed paid executions", (t) => {
  const f = fixture(t); const run = f.begin("many"); const ids: string[] = [];
  for (let index = 0; index < 26; index++) {
    const turnId = `t${index}`; const execution = f.make(run.id, turnId, [...ids], index === 0);
    f.usage(execution, turnId, (index + 1) * 100); f.ledger.providerFinished(execution);
    f.ledger.endExecution(execution, index === 5 ? "failed" : "completed"); ids.push(turnId);
  }
  const receipt = f.finish(run.id); assert.equal(receipt.executions, 26); assert.equal(receipt.codexUsage?.totalTokens, 2600);
});

test("late predecessor usage increments receipt revision and corrects successor attribution", (t) => {
  const f = fixture(t); const first = f.begin("first"); const a = f.make(first.id, "t1");
  f.usage(a, "t1", 1000); f.finishExecution(a); const before = f.finish(first.id);
  const second = f.begin("second"); const b = f.make(second.id, "t2", ["t1"], false);
  f.usage(b, "t2", 1500); f.finishExecution(b); f.finish(second.id);
  f.usage(a, "t1", 1100);
  assert(f.ledger.receipt(first.id).receiptRevision > before.receiptRevision);
  assert.equal(f.ledger.receipt(second.id).codexUsage?.totalTokens, 400);
  assert.equal(f.ledger.projectUsage(first.project_id).codexUsage?.totalTokens, 1500);
});

test("execution completion never auto-passes acceptance; active operations block finish", (t) => {
  const f = fixture(t); const run = f.begin("active"); const operationId = f.ledger.operation({ runId: run.id,
    requestKey: "build", kind: "build", label: "Build", status: "running" });
  assert.throws(() => f.finish(run.id), /active/);
  f.ledger.endOperation(operationId, "completed");
  const exec = f.make(run.id, "turn"); f.usage(exec, "turn", 1000); f.finishExecution(exec);
  assert.equal(f.ledger.run(run.id).acceptance, "pending");
  assert.throws(() => f.ledger.finish(run.id, { status: "completed", acceptance: "passed", summary: "done", evidence: [] }), /evidence/);
  assert.equal(f.finish(run.id).acceptanceStatus, "passed");
});

test("interrupted execution is marked for reconciliation without deleting usage or replaying work", (t) => {
  const f = fixture(t); const run = f.begin("interrupted"); const execution = f.make(run.id, "t1");
  f.usage(execution, "t1", 1000);
  assert.equal(f.ledger.reconcileInterruptedExecutions(), 1);
  assert.equal(f.ledger.run(run.id).status, "reconciliation_required");
  assert.equal(f.ledger.receipt(run.id).usageStatus, "partial");
  assert.equal(f.ledger.receipt(run.id).codexUsage?.totalTokens, 1000);
  assert.equal(f.ledger.reconcileInterruptedExecutions(), 0);
});
