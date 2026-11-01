import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { ExecutionCoordinator } from "../../src/execution-coordinator.js";
import { LocalAgentStore } from "../../src/local-agent-store.js";
import { readProjectSessions } from "../../src/console-workbench/project-sessions-read.js";
import { WorkbenchError } from "../../src/console-workbench/types.js";
import { readonlyDetailFixture } from "./readonly-detail-fixture.js";

test("project sessions read preserves tasks without executions in a readonly snapshot", async () => {
  const f = await readonlyDetailFixture();
  try {
    const projectId = f.ledger.run(f.run.id).project_id;
    const continuation = f.store.createTask(f.session.id, "Observed continuation", "request_2");
    f.store.touchTaskMember(continuation.id, f.member.id);
    const version = f.ledger.db.pragma("data_version", { simple: true });
    const events = f.ledger.db.prepare("SELECT count(*) n FROM qm_events").get();
    const projections = f.ledger.db.prepare("SELECT id,revision,snapshot_json FROM qm_session_members ORDER BY id").all();
    const page = readProjectSessions(f.config, projectId);
    const session = page.conversations.find(value => value.id === f.session.id);
    assert.ok(session);
    assert.equal(session.taskCount, 2);
    assert.equal(session.tasks.find(value => value.taskId === f.task.id)?.hasRun, true);
    assert.equal(session.tasks.find(value => value.taskId === continuation.id)?.hasRun, false);
    assert.deepEqual(page.executionClaims, []);
    assert.deepEqual(page.claims, []);
    assert.equal(f.ledger.db.pragma("data_version", { simple: true }), version);
    assert.deepEqual(f.ledger.db.prepare("SELECT count(*) n FROM qm_events").get(), events);
    assert.deepEqual(f.ledger.db.prepare("SELECT id,revision,snapshot_json FROM qm_session_members ORDER BY id").all(), projections);
    assert.throws(() => readProjectSessions({ ...f.config, allowedRoots: [] }, projectId),
      error => error instanceof WorkbenchError && error.code === "project_scope");
    assert.throws(() => readProjectSessions(f.config, ""),
      error => error instanceof WorkbenchError && error.code === "invalid_read");
  } finally { await f.close(); }
});

test("project claim inspection keeps expired waiters and interrupted owners unchanged", async () => {
  const f = await readonlyDetailFixture();
  const coordinator = new ExecutionCoordinator(f.config.stateDir);
  try {
    const projectId = f.ledger.run(f.run.id).project_id;
    const otherRoot = join(f.directory, "other-workspace");
    await mkdir(otherRoot);
    const local = coordinator.acquire({ workspaceRoot: f.root, kind: "command", taskId: f.task.id, title: "Local work" });
    const other = coordinator.acquire({ workspaceRoot: otherRoot, kind: "command", resources: ["fixture_shared"],
      agentId: "private_external_agent", title: "Private external title" });
    const queued = coordinator.enqueue({ workspaceRoot: f.root, kind: "agent", agentId: "queued_agent",
      taskId: f.task.id, resources: ["fixture_shared"] }, 60_000);
    const expired = coordinator.enqueue({ workspaceRoot: f.root, kind: "agent", agentId: "expired_agent" }, 60_000);
    f.ledger.db.prepare("UPDATE execution_waiters SET expires_at_ms=? WHERE id=?").run(Date.now() - 1, expired.id);
    // A dead owner is not physical completion proof. The reader must keep it.
    f.ledger.db.prepare("UPDATE execution_claims SET owner_pid=-1 WHERE id=?").run(local.id);
    const before = {
      claims: f.ledger.db.prepare("SELECT * FROM execution_claims ORDER BY id").all(),
      waiters: f.ledger.db.prepare("SELECT * FROM execution_waiters ORDER BY sequence").all(),
      reconciliations: f.ledger.db.prepare("SELECT * FROM execution_claim_reconciliations ORDER BY id").all(),
      version: f.ledger.db.pragma("data_version", { simple: true }),
    };
    const page = readProjectSessions(f.config, projectId);
    assert.equal(page.executionClaims.find(value => value.id === local.id)?.ownerPid, -1);
    assert.equal(page.executionClaims.find(value => value.id === local.id)?.state, "active");
    assert.equal(page.executionClaims.some(value => value.id === other.id || value.id === expired.id), false);
    const waiting = page.executionClaims.find(value => value.id === queued.id)?.waiting;
    assert.equal(waiting?.state, "queued");
    assert.equal(waiting?.owners.find(value => value.claimId === local.id)?.scope, "checkout");
    const shared = waiting?.owners.find(value => value.claimId === other.id);
    assert.equal(shared?.scope, "shared_resource");
    assert.deepEqual(Object.keys(shared!).sort(), ["access", "claimId", "kind", "scope", "state"]);
    assert.equal(JSON.stringify(waiting).includes(otherRoot), false);
    assert.equal(JSON.stringify(waiting).includes("private_external_agent"), false);
    assert.equal(JSON.stringify(waiting).includes("Private external title"), false);
    assert.equal(coordinator.waitingState(f.root, "expired_agent")?.state, "expired_pending_settlement");
    assert.deepEqual(f.ledger.db.prepare("SELECT * FROM execution_claims ORDER BY id").all(), before.claims);
    assert.deepEqual(f.ledger.db.prepare("SELECT * FROM execution_waiters ORDER BY sequence").all(), before.waiters);
    assert.deepEqual(f.ledger.db.prepare("SELECT * FROM execution_claim_reconciliations ORDER BY id").all(), before.reconciliations);
    assert.equal(f.ledger.db.pragma("data_version", { simple: true }), before.version);
  } finally { coordinator.close(); await f.close(); }
});

test("project thread controls use saved metadata without materializing agent responses", async () => {
  const f = await readonlyDetailFixture();
  const agents = new LocalAgentStore(f.config.stateDir);
  try {
    const agent = agents.create({ workspaceRoot: f.root, profileName: "fixture", provider: "codex" });
    const executionId = f.ledger.beginExecution({ runId: f.run.id, agentId: agent.id, provider: "codex" });
    const threadId = f.ledger.attachThread(executionId, { instanceId: "fixture_instance", identityVerified: true,
      threadId: "fixture_thread", createdHere: true, priorTurnIds: [], priorTurnsClosed: true, title: "Managed thread" });
    f.ledger.db.prepare(`UPDATE local_agent_sessions SET control_state='desktop_owned',provider_turn_id='fixture_turn',
      control_revision=7,latest_response=? WHERE id=?`).run("Private response body ".repeat(100), agent.id);
    const version = f.ledger.db.pragma("data_version", { simple: true });
    const page = readProjectSessions(f.config, f.ledger.run(f.run.id).project_id);
    const thread = page.items.find(value => value.localId === threadId);
    assert.equal(thread?.control, "desktop");
    assert.equal(thread?.turnId, "fixture_turn");
    assert.equal(thread?.revision, 7);
    assert.equal(thread?.runIds.length, 1);
    assert.equal(page.claims.length, 1);
    assert.equal(JSON.stringify(page).includes("Private response body"), false);
    assert.equal(f.ledger.db.pragma("data_version", { simple: true }), version);
  } finally { agents.close(); await f.close(); }
});
