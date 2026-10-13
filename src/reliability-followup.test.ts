import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkLedger } from "./work-ledger.js";
import { WorkRunReconciler } from "./work-run-reconciler.js";
import { dispatchPeerRequest, READ_TOTAL_BUDGET_MS } from "./federation/read-retry.js";
import { NodeUnavailableError, RpcInterruptedError } from "./federation/transport.js";
import { FederationRuntime, type FederationHooks } from "./federation/runtime.js";
import type { FederationConfig } from "./federation/types.js";
import type { ReadRetryLink } from "./federation/read-retry.js";

const origin = { entryPoint: "chatgpt_mcp" as const, evidence: "server_entry" as const };

function link<T>(call: ReadRetryLink<T>["call"], connected = true): ReadRetryLink<T> {
  return { connected, call, close() { (this as { connected: boolean }).connected = false; } };
}

test("idempotent reads retry inside 30s and mutations are not replayed", async () => {
  let reads = 0;
  const makeReadLink = () => link<string>(async () => {
    reads += 1;
    if (reads === 1) {
      const error = new Error("socket hang up") as Error & { code: string };
      error.code = "ECONNRESET";
      throw error;
    }
    return "ok";
  });
  let readLink = makeReadLink();
  const value = await dispatchPeerRequest({
    node: "s2", method: "tool", params: { name: "read", input: { path: "a" } }, rpcTimeoutMs: 120_000,
    sleep: async () => {}, random: () => 0,
    getLink: () => {
      if (!readLink.connected) readLink = makeReadLink();
      return readLink;
    },
  });
    assert.equal(value, "ok");
  assert.equal(reads, 2);

  let writes = 0;
  let closed = false;
  const writeLink: ReadRetryLink<never> = {
    connected: true,
    async call() {
      writes += 1;
      throw new RpcInterruptedError("s2", "write-1", "timeout");
    },
    close() { closed = true; this.connected = false; },
  };
  await assert.rejects(() => dispatchPeerRequest({
    node: "s2", method: "tool", params: { name: "apply_patch", input: {} }, rpcTimeoutMs: 120_000,
    getLink: () => writeLink,
  }), (error: unknown) => error instanceof RpcInterruptedError);
  assert.equal(writes, 1);
  assert.equal(closed, false, "a timed-out write must not drop state by replaying or recycling the call");

  let now = 1_000;
  let attempts = 0;
  await assert.rejects(() => dispatchPeerRequest({
    node: "s2", method: "settings.get", params: {}, rpcTimeoutMs: 120_000,
    now: () => now,
    sleep: async (ms) => { now += ms; },
    random: () => 0,
    getLink: () => undefined,
    waitForLink: async (ms) => { now += ms; attempts += 1; return undefined; },
  }), (error: unknown) => error instanceof NodeUnavailableError || error instanceof RpcInterruptedError);
  assert.ok(now - 1_000 <= READ_TOTAL_BUDGET_MS);
  assert.ok(attempts >= 1 && attempts <= 4);

  let openCalls = 0;
  await assert.rejects(() => dispatchPeerRequest({
    node: "s2", method: "tool", params: { name: "open_workspace", input: { mode: "worktree", path: "/repo" } },
    rpcTimeoutMs: 30_000,
    getLink: () => link(async () => { openCalls += 1; throw new RpcInterruptedError("s2", "open", "timeout"); }),
  }));
  assert.equal(openCalls, 1);
});

test("workspace_catalog answers from memory without dialing an offline peer", async () => {
  const root = await mkdtemp(join(tmpdir(), "quaymesh-catalog-"));
  const config = {
    enabled: true, coordinatorId: "cloud", nodeId: "local", nickname: "Local", capabilities: {coordinator:true,worker:false,discovery:false,egress:false,meshRelay:true,desktopUi:false}, priority: 300,
    host: "127.0.0.1", port: 0, tokenEnv: "QUAYMESH_TEST_TOKEN",
    peers: [{ id: "campus-s2", url: "https://127.0.0.1:1", nickname: "S2" }],
    roots: [{ id: "proj", nickname: "Project", path: root, description: "local", tags: ["dev"], enabled: true }],
    heartbeatMs: 10_000, rpcTimeoutMs: 30_000,
    egress: { enabled: false, listenPort: 0, proxyUrl: "http://127.0.0.1:9", controllerSecretEnv: "UNUSED",
      probeUrl: "https://example.invalid", probeIntervalMs: 60_000, recoveryDelayMs: 0, inheritProxy: false },
  } as FederationConfig;
  const hooks = {
    stateDir: join(root, "state"), httpPort: 7676, ingressPort: 0, publicBaseUrl: "http://127.0.0.1:7676",
    providers: () => [], prepareOpen: async (input: Record<string, unknown>) => input, checkWorkspace: async () => {},
    console: async () => ({ status: 200, body: {} }), settings: () => ({}), updateSettings: async () => {},
    mihomoImport: async () => ({}), mihomoRead: async () => "", resolveProxy: async () => "http://127.0.0.1:9",
    artifactStat: async () => ({ size: 0 }), artifactRead: async () => { throw new Error("not used"); },
    artifactWrite: async () => {},
  } as FederationHooks;
  const runtime = new FederationRuntime(config, "token", hooks);
  const started = Date.now();
  const result = await runtime.tool("workspace_catalog", { include_offline: true, query: "" }) as { structuredContent: { offline_nodes: { node_id: string }[]; workspaces: unknown[] } };
  assert.ok(Date.now() - started < 100);
  assert.equal(result.structuredContent.workspaces.length, 1);
  assert.equal(result.structuredContent.offline_nodes[0]?.node_id, "campus-s2");
  await runtime.close();
  await rm(root, { recursive: true, force: true });
});

test("dead execution claims are released only after evidence, and live claims stay", async () => {
  const root = await mkdtemp(join(tmpdir(), "quaymesh-claims-"));
  const ledger = new WorkLedger(root);
  try {
    const run = ledger.begin({ root, workspaceId: "ws", workItemId: "claims", runKey: "one", title: "Claims", origin });
    const projectRoot = ledger.getProject(run.project_id).root;
    const at = new Date().toISOString();
    ledger.db.prepare("insert into local_agent_sessions(id,workspace_root,profile_name,provider,control_state,status,created_at,updated_at) values(?,?,?,?,?,?,?,?)")
      .run("agent-dead", projectRoot, "default", "codex", "terminal", "idle", at, at);
    ledger.db.prepare("insert into local_agent_sessions(id,workspace_root,profile_name,provider,control_state,status,created_at,updated_at) values(?,?,?,?,?,?,?,?)")
      .run("agent-hot", projectRoot, "default", "codex", "terminal", "error", at, at);
    ledger.db.prepare("insert into local_agent_sessions(id,workspace_root,profile_name,provider,control_state,status,created_at,updated_at) values(?,?,?,?,?,?,?,?)")
      .run("agent-live", projectRoot, "default", "codex", "active", "running", at, at);
    ledger.db.prepare("insert into console_executions(id,run_id,agent_id,provider,status,created_at,finished_at) values(?,?,?,?,?,?,?)")
      .run("exec-dead", run.id, "agent-dead", "codex", "completed", at, at);
    ledger.db.prepare("insert into console_executions(id,run_id,agent_id,provider,status,created_at) values(?,?,?,?,?,?)")
      .run("exec-hot", run.id, "agent-hot", "codex", "running", at);
    const insert = ledger.db.prepare("insert into execution_claims(id,owner_id,owner_pid,kind,checkout_root,agent_id,resources,acquired_at) values(?,?,?,?,?,?,?,?)");
    insert.run("claim-dead", "owner", 2_147_483_647, "agent", projectRoot, "agent-dead", "[]", at);
    insert.run("claim-hot", "owner", 2_147_483_646, "agent", projectRoot, "agent-hot", "[]", at);
    insert.run("claim-live", "owner", process.pid, "agent", projectRoot, "agent-live", "[]", at);
    insert.run("claim-command", "owner", 2_147_483_645, "command", projectRoot, null, "[]", at);

    const hotRun = ledger.begin({ root, workspaceId: "ws", workItemId: "hot", runKey: "one", title: "Hot", origin });
    ledger.db.prepare("update console_executions set run_id=? where id=?").run(hotRun.id, "exec-hot");

    const result = ledger.reconcileDeadExecutionClaims();
    assert.equal(result.released, 3);
    assert.equal(ledger.db.prepare("select id from execution_claims where id='claim-live'").get() !== undefined, true);
    assert.equal(ledger.db.prepare("select id from execution_claims where id='claim-dead'").get(), undefined);
    const evidence = ledger.db.prepare("select claim_id, reason from execution_claim_reconciliations order by claim_id").all() as { claim_id: string; reason: string }[];
    assert.deepEqual(evidence.map((row) => row.claim_id), ["claim-command", "claim-dead", "claim-hot"]);
    assert.equal(evidence.find((row) => row.claim_id === "claim-dead")?.reason, "dead_owner_terminal_agent");
    assert.equal(ledger.run(run.id).status, "reconciliation_required", "dead command claim on this root requires reconciliation");
    assert.equal(ledger.run(hotRun.id).status, "reconciliation_required");
    assert.equal(ledger.execution("exec-dead").status, "completed");
    assert.equal(ledger.execution("exec-hot").status, "reconciliation_required");
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("startup reconciliation does not replay work, and the periodic tick leaves a live child running", async () => {
  const root = await mkdtemp(join(tmpdir(), "quaymesh-reconciler-"));
  const ledger = new WorkLedger(root);
  const reconciler = new WorkRunReconciler(root, 60_000);
  try {
    const run = ledger.begin({ root, workspaceId: "ws", workItemId: "long", runKey: "cmd", title: "Long command", origin });
    ledger.operation({ runId: run.id, requestKey: "build", kind: "command", label: "ten minute build", status: "running" });
    const past = new Date(Date.now() - 3_600_000).toISOString();
    ledger.db.prepare("update console_work_runs set lease_expires_at=?, last_activity_at=? where id=?").run(past, past, run.id);
    reconciler.tick();
    assert.equal(ledger.run(run.id).status, "running");
    const operation = ledger.db.prepare("select id from console_operations where run_id=?").get(run.id) as { id: string };
    ledger.endOperation(operation.id, "completed");
    const at = new Date().toISOString();
    ledger.db.prepare("insert into local_agent_sessions(id,workspace_root,profile_name,provider,control_state,status,created_at,updated_at) values(?,?,?,?,?,?,?,?)")
      .run("agent-restart", root, "default", "codex", "terminal", "running", at, at);
    ledger.db.prepare("insert into console_executions(id,run_id,agent_id,provider,status,created_at) values(?,?,?,?,?,?)")
      .run("exec-restart", run.id, "agent-restart", "codex", "running", at);
    reconciler.startup();
    const after = ledger.run(run.id);
    assert.equal(after.status, "reconciliation_required");
    assert.equal(ledger.execution("exec-restart").status, "reconciliation_required");
    const resumed = ledger.resume(run.id);
    assert.equal(resumed.id, run.id);
    assert.equal(resumed.status, "running");
    assert.equal(resumed.resume_count, 1);
  } finally {
    reconciler.close();
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});
