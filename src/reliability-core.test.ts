import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { WorkLedger, WORK_RUN_LEASE_MS } from "./work-ledger.js";
import { mapConcurrent } from "./concurrency.js";
import { catalog, rootHandle } from "./federation/routing.js";
import { isTransientPeerFailure, isIdempotentPeerRequest, FederationRuntime } from "./federation/runtime.js";
import { NodeUnavailableError, RpcInterruptedError } from "./federation/transport.js";
import type { NodeView, FederationConfig } from "./federation/types.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { writeTestQuayMeshConfig } from "./test-support/config.test.js";
import type { ensureDesktopProject } from "./codex-projects.js";

const registerProject: typeof ensureDesktopProject = async (roots) => ({
  protocol: "fixture", status: "persisted_registration", roots, createdDirectories: [], projectId: "fixture-project", uiStatus: "unverified",
});

test("work run interrupted, lease tracking and resume on begin", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "quaymesh-work-run-"));
  const ledger = new WorkLedger(root);
  t.after(async () => {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  });

  const origin = { entryPoint: "chatgpt_mcp" as const, evidence: "server_entry" as const };
  const run = ledger.begin({
    root,
    workspaceId: "ws1",
    workItemId: "task-interrupted",
    runKey: "run-key-1",
    title: "Test Interruption",
    origin,
  });

  assert.equal(run.status, "running");
  assert.ok(run.last_activity_at);
  assert.ok(run.lease_expires_at);
  assert.equal(run.resume_count, 0);

  // 1. 没有活动执行时，租约到期只代表暂时没有服务器操作，用户工作继续等待下一步。
  const pastTime = new Date(Date.now() - 3600_000).toISOString();
  ledger.db.prepare("update console_work_runs set last_activity_at=?, lease_expires_at=? where id=?")
    .run(pastTime, pastTime, run.id);

  assert.equal(ledger.hasActiveChild(run.id), false);
  const checked = ledger.run(run.id);
  assert.equal(checked.status, "running");
  assert.equal(checked.interrupted_at, null);

  // 2. 同一 workItemId 和 runKey 继续复用当前工作。
  const resumed = ledger.begin({
    root,
    workspaceId: "ws1",
    workItemId: "task-interrupted",
    runKey: "run-key-1",
    title: "Test Interruption",
    origin,
  });

  assert.equal(resumed.id, run.id);
  assert.equal(resumed.status, "running");
  assert.equal(resumed.resume_count, 0);
  assert.equal(resumed.interrupted_at, null);
  assert.ok(Date.parse(resumed.lease_expires_at!) > Date.now());

  // 3. Terminal status does NOT resume
  ledger.finish(run.id, {
    status: "completed",
    acceptance: "not_applicable",
    summary: "Task finished",
    evidence: [],
  });

  const finished = ledger.run(run.id);
  assert.equal(finished.status, "completed");

  const terminalBegin = ledger.begin({
    root,
    workspaceId: "ws1",
    workItemId: "task-interrupted",
    runKey: "run-key-1",
    title: "Test Interruption",
    origin,
  });
  assert.equal(terminalBegin.id, run.id);
  assert.equal(terminalBegin.status, "completed");
});

test("run with active child is NOT marked interrupted even when lease expires", async (t) => {
  // 活动命令继续刷新资源租约；用户工作只由真实执行终态结束。
  const root = await mkdtemp(join(tmpdir(), "quaymesh-active-child-"));
  const ledger = new WorkLedger(root);
  t.after(async () => {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  });

  const origin = { entryPoint: "chatgpt_mcp" as const, evidence: "server_entry" as const };
  const run = ledger.begin({
    root,
    workspaceId: "ws2",
    workItemId: "task-with-child",
    runKey: "run-key-2",
    title: "Active Child Run",
    origin,
  });

  // Start an active operation
  const opId = ledger.operation({
    runId: run.id,
    requestKey: "build-step",
    kind: "build",
    label: "Running Build",
    status: "running",
  });

  assert.equal(ledger.hasActiveChild(run.id), true);

  // Expire the lease
  const pastTime = new Date(Date.now() - 3600_000).toISOString();
  ledger.db.prepare("update console_work_runs set last_activity_at=?, lease_expires_at=? where id=?")
    .run(pastTime, pastTime, run.id);

  // Reconcile must NOT interrupt active child
  const reconciled = ledger.reconcileRun(run.id);
  assert.equal(reconciled, false);

  const stillRunning = ledger.run(run.id);
  assert.equal(stillRunning.status, "running");
  assert.ok(Date.parse(stillRunning.lease_expires_at!) > Date.now());

  // 命令结束后，用户工作进入等待下一步；过期租约不能把它改写成中断。
  ledger.endOperation(opId, "completed");
  assert.equal(ledger.hasActiveChild(run.id), false);

  ledger.db.prepare("update console_work_runs set last_activity_at=?, lease_expires_at=? where id=?")
    .run(pastTime, pastTime, run.id);

  const waiting = ledger.run(run.id);
  assert.equal(waiting.status, "running");
  assert.equal(waiting.interrupted_at, null);
});

test("reconciliation_required semantics are preserved and not auto-resumed on begin", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "quaymesh-reconciliation-"));
  const ledger = new WorkLedger(root);
  t.after(async () => {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  });

  const origin = { entryPoint: "chatgpt_mcp" as const, evidence: "server_entry" as const };
  const run = ledger.begin({
    root,
    workspaceId: "ws3",
    workItemId: "task-recon",
    runKey: "run-key-3",
    title: "Reconcile Run",
    origin,
  });

  // Create an execution
  const createdAt = new Date().toISOString();
  ledger.db.prepare(`insert into local_agent_sessions(id,workspace_root,profile_name,provider,control_state,status,created_at,updated_at)
    values(?,?,?,?,?,?,?,?)`).run("agent_1", root, "default", "codex", "terminal", "idle", createdAt, createdAt);
  ledger.db.prepare("insert into console_executions(id,run_id,agent_id,provider,status,created_at) values(?,?,?,?,?,?)")
    .run("exec_1", run.id, "agent_1", "codex", "running", createdAt);

  assert.equal(ledger.reconcileInterruptedExecutions(), 1);
  assert.equal(ledger.run(run.id).status, "reconciliation_required");

  // Calling begin with same key must keep reconciliation_required
  const beginResult = ledger.begin({
    root,
    workspaceId: "ws3",
    workItemId: "task-recon",
    runKey: "run-key-3",
    title: "Reconcile Run",
    origin,
  });

  assert.equal(beginResult.id, run.id);
  assert.equal(beginResult.status, "reconciliation_required");
});

test("federation transient failure retry for reads and no retry for writes", async () => {
  // 1. Error classification
  assert.equal(isTransientPeerFailure(new NodeUnavailableError("s2")), true);
  assert.equal(isTransientPeerFailure(new RpcInterruptedError("s2", "req-1", "连接中断")), true);
  assert.equal(isTransientPeerFailure({ code: "REQUEST_TIMEOUT", message: "ignored" }), true);
  assert.equal(isTransientPeerFailure({ code: "ECONNRESET", message: "socket hang up" }), true);
  assert.equal(isTransientPeerFailure({ status: 502, message: "Bad Gateway" }), true);
  assert.equal(isTransientPeerFailure({ status: 503, message: "Service Unavailable" }), true);
  assert.equal(isTransientPeerFailure({ status: 504, message: "Gateway Timeout" }), true);
  assert.equal(isTransientPeerFailure({ code: "ECONNREFUSED", message: "connect failed" }), true);
  assert.equal(isTransientPeerFailure(new Error("connect ECONNREFUSED 127.0.0.1:7676")), false);
  assert.equal(isTransientPeerFailure({ status: 400, message: "Bad Request" }), false);
  assert.equal(isTransientPeerFailure({ status: 404, message: "Not Found" }), false);

  // 2. Request classification
  assert.equal(isIdempotentPeerRequest("settings.get", {}), true);
  assert.equal(isIdempotentPeerRequest("mihomo.read", {}), true);
  assert.equal(isIdempotentPeerRequest("transfers.list", {}), true);
  assert.equal(isIdempotentPeerRequest("artifact.stat", {}), true);
  assert.equal(isIdempotentPeerRequest("hello", {}), true);
  assert.equal(isIdempotentPeerRequest("console", { method: "GET" }), true);
  assert.equal(isIdempotentPeerRequest("console", { method: "POST" }), false);
  assert.equal(isIdempotentPeerRequest("settings.update", {}), false);
  assert.equal(isIdempotentPeerRequest("artifact.copy", {}), false);
  assert.equal(isIdempotentPeerRequest("tool", { name: "read" }), true);
  assert.equal(isIdempotentPeerRequest("tool", { name: "workspace_catalog" }), true);
  assert.equal(isIdempotentPeerRequest("tool", { name: "open_workspace", input: { root_id: "campus-s2/data" } }), true);
  assert.equal(isIdempotentPeerRequest("tool", { name: "open_workspace", input: { path: "/new", create_directory: true } }), false);
  assert.equal(isIdempotentPeerRequest("tool", { name: "open_workspace", input: { path: "/repo", mode: "worktree" } }), false);
  assert.equal(isIdempotentPeerRequest("tool", { name: "apply_patch" }), false);
  assert.equal(isIdempotentPeerRequest("tool", { name: "spawn_agent" }), false);
  assert.equal(isIdempotentPeerRequest("tool", { name: "wait_agent" }), true);
  assert.equal(isIdempotentPeerRequest("tool", { name: "followup_agent" }), false);
});

test("workspace catalog continues with surviving nodes and structured offline status", () => {
  const nodes: NodeView[] = [
    {
      id: "local-node",
      nickname: "Local Machine",
      capabilities: {coordinator:true,worker:false,discovery:false,egress:false,meshRelay:true,desktopUi:false,consoleRelay:false},
      priority: 100,
      roots: [{ id: "proj", nickname: "Project", path: "/proj", description: "Local project", tags: ["dev"], enabled: true }],
      platform: "linux",
      tools: ["read_file"],
      providers: [],
      egress: { enabled: false, healthy: true },
      health: { cpuCount: 8, load: [0.1], memoryFree: 1000, memoryTotal: 4000, uptime: 100, gpus: [], activeCalls: 0 },
      online: true,
      updatedAt: Date.now(),
    },
    {
      id: "remote-s2",
      nickname: "Server S2",
      capabilities: {coordinator:false,worker:true,discovery:false,egress:false,meshRelay:false,desktopUi:false,consoleRelay:false},
      priority: 50,
      roots: [{ id: "data", nickname: "Data Store", path: "/data", description: "S2 data", tags: ["data"], enabled: true }],
      platform: "linux",
      tools: ["read_file"],
      providers: [],
      egress: { enabled: false, healthy: false },
      health: { cpuCount: 16, load: [1.2], memoryFree: 2000, memoryTotal: 8000, uptime: 500, gpus: [], activeCalls: 0 },
      online: false,
      lastSeen: Date.now() - 60_000,
      updatedAt: Date.now() - 60_000,
    },
  ];

  // 1. With includeOffline = true, roots from both nodes are included, but s2 root has online = false
  const full = catalog(nodes, "", true);
  const workspaces = full.workspaces as Array<{ node_id: string; online: boolean }>;
  assert.equal(workspaces.length, 2);
  assert.equal(workspaces.find((w) => w.node_id === "local-node")?.online, true);
  assert.equal(workspaces.find((w) => w.node_id === "remote-s2")?.online, false);

  const offlineNodes = full.offline_nodes as Array<{ node_id: string; online: boolean; status: string }>;
  assert.equal(offlineNodes.length, 1);
  assert.equal(offlineNodes[0]?.node_id, "remote-s2");
  assert.equal(offlineNodes[0]?.online, false);
  assert.equal(offlineNodes[0]?.status, "offline");

  // 2. With includeOffline = false, only online roots are returned, and offline_nodes is still present
  const onlineOnly = catalog(nodes, "", false);
  const onlineWorkspaces = onlineOnly.workspaces as Array<{ node_id: string; online: boolean }>;
  assert.equal(onlineWorkspaces.length, 1);
  assert.equal(onlineWorkspaces[0]?.node_id, "local-node");
  assert.equal((onlineOnly.offline_nodes as any[]).length, 1);
});

test("mapConcurrent bounds concurrency and preserves order", async () => {
  const items = Array.from({ length: 10 }, (_, i) => i);
  let active = 0;
  let maxActive = 0;

  const results = await mapConcurrent(items, 3, async (item) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 10));
    active--;
    return item * 2;
  });

  assert.equal(maxActive <= 3, true);
  assert.deepEqual(results, [0, 2, 4, 6, 8, 10, 12, 14, 16, 18]);
});

test("healthz checks local process only; readyz checks database health", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "quaymesh-healthz-test-"));
  const config = loadConfig(writeTestQuayMeshConfig(join(root, "config"), {
    storage: { stateDir: join(root, "state") },
    workspaces: { allowedRoots: [root], worktreeRoot: join(root, "worktrees") },
    subagents: { enabled: false, instructions: "on-demand", providers: [] },
  }));
  const server = createServer(config, { registerProject });
  const http = server.app.listen(0, "127.0.0.1");
  t.after(async () => {
    await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
    await server.close();
    await rm(root, { recursive: true, force: true });
  });
  await once(http, "listening");
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;

  // 1. healthz returns 200 without checking external peers or db
  const healthRes = await fetch(`${base}/healthz`);
  assert.equal(healthRes.status, 200);
  const healthBody = await healthRes.json() as any;
  assert.equal(healthBody.ok, true);
  assert.equal(healthBody.name, "quaymesh");
  assert.equal(healthBody.status, "healthy");
  assert.equal(typeof healthBody.pid, "number");
  assert.equal(typeof healthBody.uptimeSec, "number");

  // 2. readyz returns 200 when database is healthy
  const readyRes = await fetch(`${base}/readyz`);
  assert.equal(readyRes.status, 200);
  const readyBody = await readyRes.json() as any;
  assert.equal(readyBody.ok, true);
  assert.equal(readyBody.database, "ok");

  // 3. readyz returns 503 when database fails
  const originalCheck = server.workspaceStore.checkDatabase;
  server.workspaceStore.checkDatabase = () => false;

  const failedReadyRes = await fetch(`${base}/readyz`);
  assert.equal(failedReadyRes.status, 503);
  const failedBody = await failedReadyRes.json() as any;
  assert.equal(failedBody.ok, false);
  assert.equal(failedBody.status, "unhealthy");
  assert.equal(failedBody.database, "error");

  // But healthz remains 200 healthy!
  const healthStillOk = await fetch(`${base}/healthz`);
  assert.equal(healthStillOk.status, 200);

  // Restore checkDatabase
  server.workspaceStore.checkDatabase = originalCheck;
});
