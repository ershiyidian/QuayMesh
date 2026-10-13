import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkLedger } from "./work-ledger.js";
import { LocalAgentStore } from "./local-agent-store.js";
import { managedSessionTitle } from "./managed-session-title.js";

test("missing pooled callbacks never label completed Codex work not_used, on any console surface", (t) => {
  const root = mkdtempSync(join(tmpdir(), "quaymesh-missing-lifecycle-"));
  const project = join(root, "quaymesh"); mkdirSync(project);
  const state = join(root, "state"), ledger = new WorkLedger(state), store = new LocalAgentStore(state);
  t.after(() => { ledger.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const run = ledger.begin({ root: project, workspaceId: "fixture", workItemId: "regression", runKey: "one",
    title: "Missing usage callbacks", origin: { entryPoint: "other_mcp", evidence: "server_entry" } });
  const agent = store.create({ workspaceRoot: project, workspaceId: "fixture", profileName: "codex", provider: "codex" });
  const execution = ledger.beginExecution({ runId: run.id, agentId: agent.id, provider: "codex" });
  // Reproduce the persisted legacy row exactly; no inferred or invented usage.
  ledger.db.prepare("update console_executions set status='completed',requested=0,usage_quality='not_used' where id=?").run(execution);
  ledger.db.prepare("update console_work_runs set status='completed',acceptance='passed' where id=?").run(run.id);
  for (const value of [ledger.receipt(run.id), ledger.detail(run.project_id, run.id), ledger.listRuns(run.project_id).entries[0]!, ledger.projectUsage(run.project_id)]) {
    assert.equal(value.usageStatus, "unavailable"); assert.equal(value.codexUsage, null); assert.equal(value.missingExecutions, 1);
  }
  assert.equal(ledger.detail(run.project_id, run.id).turns[0]!.usageStatus, "unavailable");
  assert.equal(ledger.detail(run.project_id, run.id).turns[0]!.codexUsage, null);
  assert.equal(ledger.projectUsage(run.project_id).needsAttention, 1);
  assert.equal(ledger.execution(execution).requested, 0, "Read-side correction must not fabricate a historical request event");
});

test("host-only and pre-admission cancellation stay zero, while ambiguous dispatch failures stay unknown", (t) => {
  const root = mkdtempSync(join(tmpdir(), "quaymesh-dispatch-boundary-"));
  const ledger = new WorkLedger(join(root, "state")), store = new LocalAgentStore(join(root, "state"));
  t.after(() => { ledger.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const run = ledger.begin({ root, workItemId: "test", runKey: "one", title: "Dispatch boundaries", origin: { entryPoint: "other_mcp", evidence: "server_entry" } });
  assert.equal(ledger.receipt(run.id).usageStatus, "not_used");
  const agent = store.create({ workspaceRoot: root, profileName: "codex", provider: "codex" });
  const cancelled = ledger.beginExecution({ runId: run.id, agentId: agent.id, provider: "codex" });
  ledger.endExecution(cancelled, "cancelled");
  assert.equal(ledger.receipt(run.id).usageStatus, "not_used");
  const dispatched = ledger.beginExecution({ runId: run.id, agentId: agent.id, provider: "codex" });
  ledger.providerDispatchStarted(dispatched); ledger.endExecution(dispatched, "failed");
  assert.equal(ledger.receipt(run.id).usageStatus, "unavailable");
  assert.equal(ledger.receipt(run.id).codexUsage, null);
});

test("session labels contain one case-insensitive brand and do not destroy project identity", () => {
  const task = "修复 Codex TEMP 与 sandbox/apply_patch 链路";
  const result = `[QuayMesh][7a6ace] ${task}`;
  for (const project of ["quaymesh", "QuayMesh", " QUAYMESH "]) {
    assert.equal(managedSessionTitle(project, "7a6ace", task), result);
    assert.equal(managedSessionTitle(project, "7a6ace", `[QuayMesh][quaymesh][7a6ace] ${task}`), result);
    assert.equal(managedSessionTitle(project, "7a6ace", result), result);
  }
  const other = managedSessionTitle("yaxian", "123abc", "[QuayMesh][yaxian][123abc] 独立审查");
  assert.equal(other, "[QuayMesh][yaxian][123abc] 独立审查");
  assert.equal(managedSessionTitle("yaxian", "123abc", "核对 QuayMesh 行为"), "[QuayMesh][yaxian][123abc] 核对 QuayMesh 行为");
  assert.equal(managedSessionTitle("quaymesh", "7a6ace", "x".repeat(400)).length, 160);
  const sessionTitle = managedSessionTitle("project", "12345678", "Shared task");
  assert.equal(managedSessionTitle("project", "12345678", sessionTitle), sessionTitle);
  assert.equal(managedSessionTitle("project", "87654321", sessionTitle), "[QuayMesh][project][87654321] Shared task");
});
