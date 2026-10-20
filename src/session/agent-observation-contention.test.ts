import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Result } from "better-result";
import { loadConfig } from "../config.js";
import { databasePath, openDatabase } from "../db/client.js";
import type { LocalAgentWaitResult } from "../local-agent-manager.js";
import { LocalAgentStore, type LocalAgentRecord } from "../local-agent-store.js";
import { ProcessSessionManager } from "../process-sessions.js";
import { writeTestQuayMeshConfig } from "../test-support/config.test.js";
import { holdSqliteWriteLock } from "../test-support/sqlite-lock.js";
import { registerSubagentTools, type AgentClient } from "../tool-surfaces/subagents.js";
import { WorkLedger } from "../work-ledger.js";
import { SqliteWorkspaceStore } from "../workspace-store.js";
import { WorkspaceRegistry } from "../workspaces.js";
import { createInvocationContext, requestContextStorage } from "./invocations.js";
import { createSessionRuntime } from "./runtime.js";
import { SessionStore } from "./store.js";

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;
interface Observation {
  status: "saved" | "observe_again";
  provider_turn_id: string | null;
  control_revision: number;
  error_code?: string;
}
function body(result: ToolResult): Record<string, unknown> {
  assert.ok(result.structuredContent);
  return result.structuredContent as Record<string, unknown>;
}
function observations(result: ToolResult, key: "agents" | "results"): Observation[] {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  const rows = body(result)[key] as Array<{control_observation: Observation}>;
  assert.ok(Array.isArray(rows));
  return rows.map(row => row.control_observation);
}

async function fixture(count = 1) {
  const root = await mkdtemp(join(tmpdir(), "qm-agent-observation-"));
  const stateDir = join(root, "state"), project = join(root, "project"), effects = join(root, "effects.txt");
  await mkdir(project);
  const config = loadConfig(writeTestQuayMeshConfig(join(root, "config"), {
    storage: {stateDir}, workspaces: {allowedRoots: [root], worktreeRoot: join(root, "worktrees")},
    subagents: {enabled: true, instructions: "on-demand", providers: [{id: "codex", enabled: true}],
      maxConcurrentAgents: 4, maxConcurrentReaders: 4, queueWaitMs: 0, maxNewSessionsPerWorkItem: 16},
  }));
  const workspaceStore = new SqliteWorkspaceStore(stateDir);
  const workspaces = new WorkspaceRegistry(config, workspaceStore);
  const {workspace} = await workspaces.openWorkspace(project);
  const ledger = new WorkLedger(stateDir), agents = new LocalAgentStore(stateDir);
  const processSessions = new ProcessSessionManager({stateDir});
  const runtime = createSessionRuntime({config, workspaces, ledger, agents, processSessions,
    execution: processSessions.executionCoordinator});
  const session = runtime.store.createSession("fixture-owner", "fixture-conversation", "Agent observations");
  const member = runtime.store.addMember(session.id, "local", workspace.id, workspace.root, "checkout", null);
  const task = runtime.store.createTask(session.id, "Agent observations");
  const run = ledger.begin({root: workspace.root, workspaceId: workspace.id, workItemId: task.id,
    runKey: "fixture-run", title: task.title, origin: {entryPoint: "chatgpt_mcp", evidence: "server_entry"}});
  runtime.store.linkRun(session.id, member.id, run.id, task.id);
  const records: LocalAgentRecord[] = [];
  for (let index = 0; index < count; index += 1) {
    const record = agents.create({workspaceId: workspace.id, workspaceRoot: workspace.root,
      profileName: "codex", provider: "codex", taskName: `Agent ${index}`});
    agents.update(record.id, {status: "running", providerSessionId: `thread-${index}`});
    records.push(agents.setControlState(record.id, "qm_active", `turn-${index}`, "fixture_started"));
    ledger.beginExecution({runId: run.id, agentId: record.id, provider: "codex"});
  }
  let controlCalls = 0;
  const getRecord = (id: string): LocalAgentRecord => {
    const record = agents.getById(id);
    assert.ok(record);
    return record;
  };
  // 仅 provider 端由夹具控制；工具、SDK、会话账本、版本门槛和效果文件均为真实资源。
  const agentClient: AgentClient = {
    start: async () => {throw new Error("Unexpected start");},
    continue: async () => {throw new Error("Unexpected continue");},
    cancelQueued: async () => {throw new Error("Unexpected queued cancellation");},
    get: async (id, scope) => {
      const record = getRecord(id);
      assert.equal(record.workspaceId, scope.workspaceId);
      assert.equal(record.workspaceRoot, scope.workspaceRoot);
      return Result.ok(record);
    },
    list: async scope => Result.ok(agents.list(scope)),
    wait: async ids => Result.ok(ids.map((id): LocalAgentWaitResult => {
      const record = getRecord(id);
      if (record.status === "idle") return {id, status: "completed", response: record.latestResponse};
      if (record.status === "stopped") return {id, status: "stopped"};
      if (record.status === "error") return {id, status: "failed", error: {code: "FIXTURE_ERROR", message: "Fixture error", retryable: false}};
      return {id, status: "running", wait: "timeout"};
    })),
    control: async input => {
      const record = getRecord(input.agentId);
      assert.equal(input.expectedTurnId, record.providerTurnId);
      assert.equal(input.workRunId, ledger.latestExecution(record.id)?.run_id);
      assert.ok(input.action === "steer" || input.action === "interrupt");
      controlCalls += 1;
      await appendFile(effects, `${input.action}\n`);
      let updated: LocalAgentRecord;
      if (input.action === "steer") {
        updated = agents.setControlState(record.id, "qm_active", record.providerTurnId!, "fixture_steer");
      } else {
        agents.setControlState(record.id, "interrupting", record.providerTurnId!, "fixture_interrupt_requested");
        agents.update(record.id, {status: "stopped"});
        updated = agents.setControlState(record.id, "terminal", null, "fixture_interrupt_completed");
      }
      // 与真实 manager 一致：中断回执保留动作目标 turn，当前记录则已清空。
      return Result.ok({agentId: record.id, action: input.action, accepted: true as const,
        providerThreadId: record.providerSessionId!, providerTurnId: record.providerTurnId,
        controlState: updated.controlState, controlRevision: updated.controlRevision});
    },
  };
  const server = new McpServer({name: "agent-observation-fixture", version: "1"});
  const client = new Client({name: "agent-observation-client", version: "1"});
  registerSubagentTools({server, config, workspaces, processSessions, sessionRuntime: runtime}, agentClient);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  await client.listTools();
  let requestId = 0;
  const call = (name: string, args: Record<string, unknown> = {}) => {
    requestId += 1;
    return requestContextStorage.run(createInvocationContext({
      auth: {owner_id: session.owner_id}, transport: {instance_id: "fixture-transport"},
      request: {id: requestId, tool_name: name, operation_id: `fixture-operation-${requestId}`},
      session: {session_id: session.id, task_id: task.id, member_id: member.id, workspace_id: workspace.id},
    }), () => client.callTool({name, arguments: {workspace_id: workspace.id, ...args}}));
  };
  return {root, stateDir, effects, ledger, agents, runtime, session, records, call, config, workspace, workspaceStore,
    controlCalls: () => controlCalls,
    async close() {
      await client.close();
      await server.close();
      await runtime.close();
      await processSessions.shutdown();
      agents.close();
      ledger.close();
      workspaceStore.close();
      await rm(root, {recursive: true, force: true});
    }};
}

test("50 个 agent 的观察共享短写入预算，真实锁期间仍响应且未保存的控制门槛不刷新", {timeout: 15_000}, async t => {
  const f = await fixture(50);
  let lock: Awaited<ReturnType<typeof holdSqliteWriteLock>> | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    assert.equal(f.ledger.db.pragma("busy_timeout", {simple: true}), 5_000);
    const ids = f.records.map(record => record.id), times: Record<string, number> = {};
    lock = await holdSqliteWriteLock(databasePath(f.stateDir), 4_000);
    let released = false, ticks = 0, maxGapMs = 0, previous = performance.now();
    void lock.done.then(() => {released = true;});
    const workspaceBefore = f.workspaceStore.getSession(f.workspace.id);
    const cold = new WorkspaceRegistry(f.config, f.workspaceStore);
    assert.equal((await cold.getWorkspace(f.workspace.id, {touch: false})).id, f.workspace.id);
    assert.equal(released, false, "冷启动工作区验证也不应等待 writer");
    timer = setInterval(() => {
      const now = performance.now(); maxGapMs = Math.max(maxGapMs, now - previous); previous = now;
      assert.equal(f.ledger.db.prepare("SELECT COUNT(*) FROM qm_agent_observations").pluck().get(), 0);
      ticks += 1;
    }, 10);
    for (const name of ["list_agents", "wait_agent"] as const) {
      const started = performance.now();
      const result = await f.call(name, name === "list_agents" ? {limit: 50} : {agent_ids: ids, timeout_ms: 0});
      times[name] = performance.now() - started;
      const items = observations(result, name === "list_agents" ? "agents" : "results");
      t.diagnostic(JSON.stringify({tool: name, observation_elapsed_ms: times[name],
        writer_released_at_return: released, saved_observations: items.filter(item => item.status === "saved").length,
        observe_again: items.filter(item => item.status === "observe_again").length}));
      assert.equal(items.length, 50);
      assert.ok(items.every(item => item.status === "observe_again" && item.error_code === "CONTROL_OBSERVATION_BUSY"));
      assert.equal(released, false, "观察必须在独立 writer 仍持锁时返回");
      assert.ok(times[name]! < 1_500, `整次 ${name} 耗时 ${times[name]} ms，不能逐 agent 累积预算`);
    }
    clearInterval(timer); timer = undefined;
    assert.ok(ticks >= 5);
    assert.ok(maxGapMs < 800, `事件循环最大间隔 ${maxGapMs} ms`);
    assert.deepEqual(f.workspaceStore.getSession(f.workspace.id), workspaceBefore, "冷查询和已缓存观察都不更新时间戳");
    await lock.release(); lock = undefined;
    await delay(60);
    assert.equal(f.ledger.db.prepare("SELECT COUNT(*) FROM qm_agent_observations").pluck().get(), 0, "返回后不得后台补写控制门槛");
    for (const name of ["send_message", "interrupt_agent"]) {
      const refused = await f.call(name, {agent_id: ids[0], ...(name === "send_message" ? {message: "Do not execute"} : {})});
      assert.equal(refused.isError, true);
      assert.equal(body(refused).code, "AGENT_STATE_CHANGED");
    }
    assert.equal(f.controlCalls(), 0);
    assert.ok(observations(await f.call("wait_agent", {agent_ids: ids, timeout_ms: 0}), "results").every(item => item.status === "saved"));
    const store = new SessionStore(f.ledger.db);
    const before = f.records.map(record => store.lastAgentObservation(f.session.id, record.id));
    const totalChanges = f.ledger.db.prepare("SELECT total_changes()").pluck().get();
    lock = await holdSqliteWriteLock(databasePath(f.stateDir), 4_000);
    const started = performance.now();
    assert.ok((await store.rememberAgentObservationsAsync(f.session.id, f.records.map(record => ({
      agentId: record.id, providerTurnId: record.providerTurnId!, controlRevision: record.controlRevision,
    })))).every(Boolean));
    const unchangedMs = performance.now() - started;
    assert.ok(unchangedMs < 300, `相同 tuple 快路径耗时 ${unchangedMs} ms`);
    assert.equal(f.ledger.db.prepare("SELECT total_changes()").pluck().get(), totalChanges);
    assert.deepEqual(f.records.map(record => store.lastAgentObservation(f.session.id, record.id)), before);
    assert.ok(observations(await f.call("list_agents", {limit: 50}), "agents").every(item => item.status === "saved"));
    t.diagnostic(JSON.stringify({scope: "SDK in-memory transport + real SQLite Worker", batch_size: 50,
      shared_write_budget_ms: 150, default_busy_timeout_ms: 5_000, elapsed_ms: times,
      eventloop_max_gap_ms: maxGapMs, timer_reads: ticks, saved_while_locked: 0,
      workspace_cached_and_cold_unchanged: true,
      unchanged_elapsed_ms: unchangedMs, unchanged_connection_writes: 0, control_refusals: 2, external_actions: f.controlCalls()}));
  } finally {
    if (timer) clearInterval(timer);
    await lock?.release();
    await f.close();
  }
});

test("迟到观察不回退版本，旧 interrupt 目标仅由同版本真实终态单向修复", {timeout: 10_000}, async t => {
  const f = await fixture();
  const writer = openDatabase(f.stateDir);
  try {
    const store = f.runtime.store, sessionId = f.session.id, agentId = f.records[0]!.id;
    store.rememberAgentObservation(sessionId, agentId, "turn-eight", 8);
    writer.sqlite.exec("BEGIN IMMEDIATE");
    const pending = store.rememberAgentObservationsAsync(sessionId, [{agentId, providerTurnId: "turn-nine", controlRevision: 9}]);
    await delay(25);
    writer.sqlite.prepare("UPDATE qm_agent_observations SET provider_turn_id='turn-ten', control_revision=10 WHERE session_id=? AND agent_id=?")
      .run(sessionId, agentId);
    writer.sqlite.exec("COMMIT");
    assert.deepEqual(await pending, [false]);
    for (const tuple of [{providerTurnId: "old-turn", controlRevision: 7}, {providerTurnId: "other-ten", controlRevision: 10},
      {providerTurnId: null, controlRevision: 10}]) {
      assert.deepEqual(await store.rememberAgentObservationsAsync(sessionId, [{agentId, ...tuple}]), [false]);
    }
    assert.equal(store.lastAgentObservation(sessionId, agentId)?.providerTurnId, "turn-ten");
    assert.equal(store.lastAgentObservation(sessionId, agentId)?.controlRevision, 10);

    // 旧部署可能把 interrupt 动作目标 turn 写在终态 revision；修复必须核对真实 agent 行。
    for (const status of ["starting", "queued", "running", "idle", "error", "stopped"] as const) {
      f.agents.update(agentId, {status, controlState: "terminal", providerTurnId: undefined, controlRevision: 10});
      writer.sqlite.prepare("UPDATE qm_agent_observations SET provider_turn_id='turn-ten' WHERE session_id=? AND agent_id=?").run(sessionId, agentId);
      const expected = ["idle", "error", "stopped"].includes(status);
      assert.deepEqual(await store.rememberAgentObservationsAsync(sessionId, [{agentId, providerTurnId: null, controlRevision: 10}]), [expected], status);
      if (expected) {
        assert.deepEqual(await store.rememberAgentObservationsAsync(sessionId, [{agentId, providerTurnId: "turn-ten", controlRevision: 10}]), [false]);
        assert.equal(store.lastAgentObservation(sessionId, agentId)?.providerTurnId, null);
      }
    }
    for (const authority of [{controlState: "terminal" as const, controlRevision: 11, providerTurnId: undefined},
      {controlState: "qm_active" as const, controlRevision: 10, providerTurnId: undefined},
      {controlState: "terminal" as const, controlRevision: 10, providerTurnId: "other-authoritative-turn"}]) {
      f.agents.update(agentId, {status: "stopped", ...authority});
      writer.sqlite.prepare("UPDATE qm_agent_observations SET provider_turn_id='turn-ten' WHERE session_id=? AND agent_id=?").run(sessionId, agentId);
      assert.deepEqual(await store.rememberAgentObservationsAsync(sessionId, [{agentId, providerTurnId: null, controlRevision: 10}]), [false]);
    }
    store.rememberAgentObservation(sessionId, "missing-agent", "missing-turn", 10);
    assert.deepEqual(await store.rememberAgentObservationsAsync(sessionId, [{agentId: "missing-agent", providerTurnId: null, controlRevision: 10}]), [false]);
    t.diagnostic(JSON.stringify({late_revision_rejected: true, revision_after_race: 10,
      legacy_terminal_statuses_repaired: ["idle", "error", "stopped"], active_statuses_refused: ["starting", "queued", "running"],
      newer_authority_refused: true, missing_authority_refused: true, old_turn_restored: false}));
  } finally {
    if (writer.sqlite.inTransaction) writer.sqlite.exec("ROLLBACK");
    writer.close();
    await f.close();
  }
});

test("真实观察触发器失败保留已成功动作且不重放，中断目标 turn 不污染当前控制门槛", {timeout: 10_000}, async t => {
  const f = await fixture();
  try {
    const record = f.records[0]!, agentId = record.id;
    assert.equal(observations(await f.call("wait_agent", {agent_ids: [agentId], timeout_ms: 0}), "results")[0]?.status, "saved");
    const previous = f.runtime.store.lastAgentObservation(f.session.id, agentId);
    f.ledger.db.exec("CREATE TRIGGER refuse_auxiliary_observation BEFORE UPDATE ON qm_agent_observations BEGIN SELECT RAISE(ABORT,'private fixture database detail'); END");
    const sent = await f.call("send_message", {agent_id: agentId, message: "One real fixture effect"});
    assert.notEqual(sent.isError, true);
    assert.equal(body(sent).accepted, true);
    assert.equal(body(sent).action, "steer");
    assert.equal(body(sent).providerTurnId, record.providerTurnId);
    assert.deepEqual(body(sent).control_observation, {status: "observe_again", provider_turn_id: record.providerTurnId,
      control_revision: record.controlRevision + 1, error_code: "CONTROL_OBSERVATION_PERSISTENCE_FAILED"});
    assert.ok(!JSON.stringify(sent).includes("private fixture database detail"));
    assert.deepEqual(f.runtime.store.lastAgentObservation(f.session.id, agentId), previous);
    for (const name of ["send_message", "interrupt_agent"]) {
      const refused = await f.call(name, {agent_id: agentId, ...(name === "send_message" ? {message: "Do not repeat"} : {})});
      assert.equal(refused.isError, true);
      assert.equal(body(refused).code, "AGENT_STATE_CHANGED");
    }
    assert.equal(f.controlCalls(), 1);
    assert.equal(await readFile(f.effects, "utf8"), "steer\n");
    f.ledger.db.exec("DROP TRIGGER refuse_auxiliary_observation");
    assert.equal(observations(await f.call("wait_agent", {agent_ids: [agentId], timeout_ms: 0}), "results")[0]?.status, "saved");
    const interrupted = await f.call("interrupt_agent", {agent_id: agentId});
    assert.notEqual(interrupted.isError, true);
    assert.equal(body(interrupted).accepted, true);
    assert.equal(body(interrupted).action, "interrupt");
    assert.equal(body(interrupted).providerTurnId, record.providerTurnId, "动作回执保留原目标 turn");
    const current = f.agents.getById(agentId)!;
    assert.equal(current.providerTurnId, undefined);
    assert.deepEqual(body(interrupted).control_observation, {status: "saved", provider_turn_id: null, control_revision: current.controlRevision});
    assert.equal(f.runtime.store.lastAgentObservation(f.session.id, agentId)?.providerTurnId, null);
    assert.equal(observations(await f.call("list_agents"), "agents")[0]?.status, "saved");
    assert.equal(await readFile(f.effects, "utf8"), "steer\ninterrupt\n");
    assert.equal(f.controlCalls(), 2);
    t.diagnostic(JSON.stringify({auxiliary_sql_failure: "SQLITE_CONSTRAINT_TRIGGER", successful_action_preserved: true,
      control_refusals: 2, external_actions: f.controlCalls(), automatic_replays: 0,
      interrupt_target_turn: record.providerTurnId, current_turn: null, refreshed_observation: "saved"}));
  } finally {await f.close();}
});
