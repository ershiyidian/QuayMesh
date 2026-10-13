import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../config.js";
import { WorkspaceRegistry } from "../workspaces.js";
import { SqliteWorkspaceStore } from "../workspace-store.js";
import { WorkLedger } from "../work-ledger.js";
import { LocalAgentStore } from "../local-agent-store.js";
import { writeTestQuayMeshConfig } from "../test-support/config.test.js";
import { createSessionRuntime, type SessionRuntime } from "./runtime.js";
import { AgentOperationTracker, type AgentOperationIdentity } from "./agent-operations.js";
import { OperationState, type InvocationContext } from "./types.js";

interface Fixture {
  root: string;
  project: string;
  runtime: SessionRuntime;
  ledger: WorkLedger;
  agents: LocalAgentStore;
  workspaces: WorkspaceRegistry;
  workspaceStore: SqliteWorkspaceStore;
}

interface OperationFixture {
  context: InvocationContext;
  operationId: string;
  workspaceId: string;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "quaymesh-agent-ops-"));
  const project = join(root, "project");
  const stateDir = join(root, "state");
  await mkdir(project, { recursive: true });
  const configDir = join(root, "config");
  const env = writeTestQuayMeshConfig(configDir, {
    storage: { stateDir },
    workspaces: { allowedRoots: [root], worktreeRoot: join(root, "worktrees") },
    subagents: { enabled: false, instructions: "on-demand", providers: [] },
  });
  const config = loadConfig(env);
  const workspaceStore = new SqliteWorkspaceStore(stateDir);
  const workspaces = new WorkspaceRegistry(config, workspaceStore);
  const ledger = new WorkLedger(stateDir);
  const agents = new LocalAgentStore(stateDir);
  const runtime = createSessionRuntime({ config, workspaces, ledger, agents });
  return { root, project, runtime, ledger, agents, workspaces, workspaceStore };
}

async function closeFixture(f: Fixture): Promise<void> {
  await f.runtime.close();
  f.agents.close();
  f.ledger.close();
  f.workspaceStore.close?.();
  await rm(f.root, { recursive: true, force: true });
}

async function operationFixture(f: Fixture, suffix: string): Promise<OperationFixture> {
  const conversationId = `conversation-${suffix}`;
  const openedWorkspace = await f.workspaces.openWorkspace(
    { path: f.project },
    { conversationScopeId: conversationId },
  );
  await f.runtime.service.open(
    { owner_id: "owner-a", conversation_id: conversationId },
    {
      id: openedWorkspace.workspace.id,
      node: "desktop",
      root: openedWorkspace.workspace.root,
      mode: "checkout",
      sourceRoot: null,
    },
    `agent operation ${suffix}`,
  );
  await f.runtime.recorder.record({
    identity: {
      owner_id: "owner-a",
      conversation_id: conversationId,
      transport_instance_id: "transport-a",
      request_id: `request-${suffix}`,
    },
    workspace_id: openedWorkspace.workspace.id,
    tool_name: "spawn_agent",
    kind: "agent_control",
    label: "spawn_agent",
    input: { suffix },
    operation: async () => ({ structuredContent: { state: "queued" } }),
    runningResult: () => true,
    operationStatus: () => ({ state: OperationState.running, effect: "started" as const }),
  });
  const invocation = f.runtime.store.findInvocation(
    "owner-a",
    "transport-a",
    `request-${suffix}`,
  )!;
  const context: InvocationContext = {
    owner_id: invocation.owner_id,
    conversation_id: conversationId,
    transport_instance_id: invocation.transport_instance_id,
    request_id: invocation.request_id,
    invocation_id: invocation.id,
    session_id: invocation.session_id,
    member_id: invocation.member_id,
    actor: "model",
    tool_name: invocation.tool_name,
    workspace_id: openedWorkspace.workspace.id,
    operation_id: invocation.operation_id!,
  };
  return { context, operationId: invocation.operation_id!, workspaceId: openedWorkspace.workspace.id };
}

async function waitForState(runtime: SessionRuntime, operationId: string, expected: OperationState): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const invocation = runtime.store.findInvocationByOperationId(operationId);
    if (invocation?.state === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const current = runtime.store.findInvocationByOperationId(operationId)?.state ?? "missing";
  assert.fail(`Timed out waiting for ${expected}; current state is ${current}.`);
}

test("agent operation completes from the durable agent record", async (t) => {
  const f = await fixture();
  t.after(() => closeFixture(f));
  const operation = await operationFixture(f, "completed");
  const agent = f.agents.create({
    workspaceId: operation.workspaceId,
    workspaceRoot: f.project,
    profileName: "reviewer",
    provider: "codex",
  });
  const identity: AgentOperationIdentity = {
    operationId: operation.operationId,
    agentId: agent.id,
    sessionId: operation.context.session_id,
    memberId: operation.context.member_id,
  };
  const tracker = new AgentOperationTracker(f.agents, f.runtime.service, f.runtime.store, { intervalMs: 5 });
  try {
    tracker.track(identity);
    f.agents.update(agent.id, { status: "idle", latestResponse: "完成" });
    await waitForState(f.runtime, operation.operationId, OperationState.succeeded);
    const invocation = f.runtime.store.findInvocationByOperationId(operation.operationId)!;
    assert.equal(invocation.effect, "completed");
    assert.equal(invocation.result_ref, `agent:${agent.id}:${agent.controlRevision}`);
    const snapshot = await f.runtime.projector.materialize(identity.sessionId, identity.memberId);
    assert.equal(snapshot.agents.length, 1);
    assert.equal(snapshot.agents[0]?.id, agent.id);
    assert.equal(snapshot.agents[0]?.name, "reviewer");
    assert.equal(snapshot.agents[0]?.state, "done");
    assert.equal(snapshot.agents[0]?.result_available, true);
  } finally {
    await tracker.close();
  }
});

test("agent operation preserves failure and cancellation states", async (t) => {
  const f = await fixture();
  t.after(() => closeFixture(f));
  const failed = await operationFixture(f, "failed");
  const failedAgent = f.agents.create({
    workspaceId: failed.workspaceId,
    workspaceRoot: f.project,
    profileName: "reviewer",
    provider: "codex",
  });
  const stopped = await operationFixture(f, "stopped");
  const stoppedAgent = f.agents.create({
    workspaceId: stopped.workspaceId,
    workspaceRoot: f.project,
    profileName: "reviewer",
    provider: "codex",
  });
  const tracker = new AgentOperationTracker(f.agents, f.runtime.service, f.runtime.store, { intervalMs: 5 });
  try {
    tracker.track({
      operationId: failed.operationId,
      agentId: failedAgent.id,
      sessionId: failed.context.session_id,
      memberId: failed.context.member_id,
    });
    tracker.track({
      operationId: stopped.operationId,
      agentId: stoppedAgent.id,
      sessionId: stopped.context.session_id,
      memberId: stopped.context.member_id,
    });
    f.agents.update(failedAgent.id, {
      status: "error",
      error: "provider failed",
      errorCode: "PROVIDER_EXECUTION_ERROR",
    });
    f.agents.update(stoppedAgent.id, {
      status: "stopped",
      error: "cancelled by user",
      errorCode: "PROVIDER_CANCELLED",
    });
    await waitForState(f.runtime, failed.operationId, OperationState.failed);
    await waitForState(f.runtime, stopped.operationId, OperationState.cancelled);
    assert.equal(f.runtime.store.findInvocationByOperationId(failed.operationId)!.effect, "completed");
    assert.equal(f.runtime.store.findInvocationByOperationId(stopped.operationId)!.effect, "completed");
    const snapshot = await f.runtime.projector.materialize(failed.context.session_id, failed.context.member_id);
    assert.deepEqual(snapshot.agents.map((agent) => agent.id), [failedAgent.id]);
  } finally {
    await tracker.close();
  }
});

test("agent operation becomes unknown when the durable record disappears", async (t) => {
  const f = await fixture();
  t.after(() => closeFixture(f));
  const operation = await operationFixture(f, "missing");
  const tracker = new AgentOperationTracker(f.agents, f.runtime.service, f.runtime.store, { intervalMs: 5 });
  try {
    tracker.track({
      operationId: operation.operationId,
      agentId: "agt_missing",
      sessionId: operation.context.session_id,
      memberId: operation.context.member_id,
    });
    await waitForState(f.runtime, operation.operationId, OperationState.unknown);
    const invocation = f.runtime.store.findInvocationByOperationId(operation.operationId)!;
    assert.equal(invocation.effect, "unknown");
    assert.equal(invocation.result_ref, "agent:agt_missing:missing");
  } finally {
    await tracker.close();
  }
});
