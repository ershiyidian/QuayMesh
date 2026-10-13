import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage, MessageExtraInfo } from "@modelcontextprotocol/sdk/types.js";
import { Result } from "better-result";
import {
  CodexAppServerRuntime,
  CodexLocalAgentDriver,
  codexCommandEnvironment,
  isCodexAppServerSupported,
  resolveCodexCommand,
  type ResolvedCodexCommand,
} from "../../src/local-agent-codex.js";
import { localAgentProviderConfigRevision, type SubagentsConfig } from "../../src/local-agent-config.js";
import { LocalAgentDaemon } from "../../src/local-agent-daemon.js";
import { LocalAgentClient } from "../../src/local-agent-client.js";
import { LocalAgentManager } from "../../src/local-agent-manager.js";
import { LocalAgentRuntimePool } from "../../src/local-agent-runtime-pool.js";
import { LocalAgentStore } from "../../src/local-agent-store.js";
import type {
  LocalAgentRunCallbacks,
  LocalAgentRunInput,
  LocalAgentRunResult,
  LocalAgentRuntime,
  LocalAgentRuntimeContext,
} from "../../src/local-agent-runtime.js";
import type { AgentActivity } from "../../src/agent-progress.js";
import { buildLocalAgentProviderStatuses } from "../../src/local-agent-catalog.js";
import { createReviewCheckpointManager } from "../../src/review-checkpoints.js";
import { createMcpServer } from "../../src/server.js";
import { createSessionRuntime, type SessionRuntime } from "../../src/session/runtime.js";
import { WorkLedger } from "../../src/work-ledger.js";
import { ProcessSessionManager } from "../../src/process-sessions.js";
import { SqliteWorkspaceStore } from "../../src/workspace-store.js";
import { WorkspaceRegistry } from "../../src/workspaces.js";
import { loadConfig } from "../../src/config.js";
import { writeTestQuayMeshConfig } from "../../src/test-support/config.test.js";
import { ensureDesktopProject } from "../../src/codex-projects.js";

const execFileAsync = promisify(execFile);
const OWNER_ID = "owner-codex-live";
const TRANSPORT_ID = "transport-codex-live";
const CONVERSATION_ID = "codex-live-conversation";
const RESULT_FILE = "codex-live-result.txt";
const RESULT_CONTENT = "QUAYMESH_CODEX_LIVE_OK\n";
const PROJECT_ROOT_MARKER = "project";
const RECEIPT_PATH = resolve("releases", "session-acceptance", "codex-live.json");



interface CapturedRun {
  agentId: string;
  input: LocalAgentRunInput;
  threadId?: string;
  turnId?: string;
  controlReady: boolean;
  usage?: unknown;
  activities: AgentActivity[];
  finalResponse?: string;
  items: unknown[];
}

class RecordingRuntime implements LocalAgentRuntime {
  readonly provider = "codex" as const;

  constructor(
    private readonly inner: LocalAgentRuntime,
    private readonly agentId: string,
    private readonly runs: CapturedRun[],
  ) {}

  async run(input: LocalAgentRunInput, callbacks?: LocalAgentRunCallbacks) {
    const capture: CapturedRun = {
      agentId: this.agentId,
      input,
      controlReady: false,
      activities: [],
      items: [],
    };
    this.runs.push(capture);
    const result = await this.inner.run(input, {
      ...callbacks,
      onThreadInfo: async (observation) => {
        capture.threadId = observation.threadId;
        await callbacks?.onThreadInfo?.(observation);
      },
      onTurnStarted: async (turnId) => {
        capture.turnId = turnId;
        await callbacks?.onTurnStarted?.(turnId);
      },
      onControlReady: async (control) => {
        capture.controlReady = true;
        await callbacks?.onControlReady?.(control);
      },
      onUsage: (usage) => {
        capture.usage = usage;
        callbacks?.onUsage?.(usage);
      },
      onActivity: (activity) => {
        capture.activities.push(activity);
        callbacks?.onActivity?.(activity);
      },
      onProviderFinished: () => callbacks?.onProviderFinished?.(),
      onNotRequested: () => callbacks?.onNotRequested?.(),
    });
    if (result.isOk()) {
      capture.finalResponse = result.value.finalResponse;
      capture.items = result.value.items;
    }
    return result;
  }

  releaseSession(providerSessionId: string): Promise<void> {
    return this.inner.releaseSession(providerSessionId);
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  isAlive(): boolean {
    return this.inner.isAlive();
  }
}

class RecordingCodexDriver extends CodexLocalAgentDriver {
  readonly runs: CapturedRun[] = [];

  override async createRuntime(context: LocalAgentRuntimeContext) {
    const created = await super.createRuntime(context);
    if (created.isErr()) return created;
    return Result.ok(new RecordingRuntime(created.value, context.agentId, this.runs));
  }
}

class AuthenticatedInMemoryTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;

  constructor(private readonly inner: InMemoryTransport, private readonly authInfo: AuthInfo) {
    this.inner.onclose = () => this.onclose?.();
    this.inner.onerror = (error) => this.onerror?.(error);
    this.inner.onmessage = (message, extra) => this.onmessage?.(message, extra);
  }

  get sessionId(): string | undefined { return this.inner.sessionId; }
  set sessionId(value: string | undefined) { this.inner.sessionId = value; }
  start(): Promise<void> { return this.inner.start(); }
  send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    return this.inner.send(message, { ...options, authInfo: this.authInfo });
  }
  close(): Promise<void> { return this.inner.close(); }
}

interface Fixture {
  root: string;
  project: string;
  firstClient: Client;
  secondClient: Client;
  runtime: SessionRuntime;
  agents: LocalAgentStore;
  manager: LocalAgentManager;
  recording: RecordingCodexDriver;
  processSessions: ProcessSessionManager;
  stateDir: string;
  managerLogs: Array<{ level: string; event: string; fields: Record<string, unknown> }>;
  close(): Promise<void>;
}

async function connectInMemoryClient(
  server: ReturnType<typeof createMcpServer>,
  name: string,
  transportId: string,
): Promise<Client> {
  const [clientInner, serverTransport] = InMemoryTransport.createLinkedPair();
  const clientTransport = new AuthenticatedInMemoryTransport(clientInner, {
    token: "test-token",
    clientId: transportId,
    scopes: ["mcp"],
    extra: { owner_id: OWNER_ID },
  });
  const client = new Client({ name, version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

async function liveFixture(t: TestContext, command: ResolvedCodexCommand, env: NodeJS.ProcessEnv): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "quaymesh-codex-live-"));
  const project = join(root, PROJECT_ROOT_MARKER);
  const stateDir = join(root, "state");
  const configDir = join(root, "config");
  await mkdir(project, { recursive: true });
  await execFileAsync("git", ["init"], { cwd: project });
  await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd: project });
  await execFileAsync("git", ["config", "user.name", "QuayMesh Live Test"], { cwd: project });
  await writeFile(join(project, "facts.txt"), "The live test fact is: QUAYMESH_CODEX_LIVE_OK\n", "utf8");
  await execFileAsync("git", ["add", "."], { cwd: project });
  await execFileAsync("git", ["commit", "-m", "live fixture"], { cwd: project });

  const subagents: SubagentsConfig = {
    enabled: true,
    instructions: "on-demand",
    providers: [{ id: "codex", enabled: true, writeMode: "full_access" }],
    maxConcurrentAgents: 1,
    maxConcurrentReaders: 1,
    queueWaitMs: 5_000,
    maxNewSessionsPerWorkItem: 4,
  };
  const config = loadConfig(writeTestQuayMeshConfig(configDir, {
    storage: { stateDir },
    workspaces: { allowedRoots: [project], worktreeRoot: join(root, "worktrees") },
    subagents,
  }));
  const workspaceStore = new SqliteWorkspaceStore(stateDir);
  const workspaces = new WorkspaceRegistry(config, workspaceStore);
  const sessionLedger = new WorkLedger(stateDir);
  const agents = new LocalAgentStore(stateDir);
  const processSessions = new ProcessSessionManager({ stateDir });
  const runtime = createSessionRuntime({
    config,
    workspaces,
    ledger: sessionLedger,
    agents,
    execution: processSessions.executionCoordinator,
    processSessions,
  });
  const commandEnv = { ...codexCommandEnvironment(env), CODEX_COMMAND: command.executable };
  const recording = new RecordingCodexDriver(commandEnv);
  const managerLogs: Array<{ level: string; event: string; fields: Record<string, unknown> }> = [];
  const manager = new LocalAgentManager({
    store: agents,
    drivers: [recording],
    pool: new LocalAgentRuntimePool(),
    loadProfiles: async () => [],
    allowedRoots: [project],
    logger: (level, event, fields) => { managerLogs.push({ level, event, fields }); },
    subagents,
  });
  const configRevision = localAgentProviderConfigRevision(subagents);
  const daemon = new LocalAgentDaemon({ stateDir, manager, configRevision, idleShutdownMs: 60_000 });
  const agentClient = new LocalAgentClient({
    stateDir,
    configRevision,
    startupTimeoutMs: 5_000,
    requestTimeoutMs: 60_000,
    spawnDaemon: () => { void daemon.start(); },
  });
  const providerStatuses = buildLocalAgentProviderStatuses(subagents, [{ name: "codex", available: true }]);
  const registerProject = (roots: string[], threadIds: string[] = []) => ensureDesktopProject(roots, threadIds, commandEnv);
  const createLiveServer = () => createMcpServer(
    config,
    workspaces,
    createReviewCheckpointManager(),
    processSessions,
    () => providerStatuses,
    [],
    undefined,
    registerProject,
    runtime,
    agentClient,
  );
  const firstServer = createLiveServer();
  const secondServer = createLiveServer();
  const firstClient = await connectInMemoryClient(firstServer, "codex-live-test-client", `${TRANSPORT_ID}-first`);
  const secondClient = await connectInMemoryClient(secondServer, "codex-live-second-client", `${TRANSPORT_ID}-second`);

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await firstClient.close();
    await secondClient.close();
    await firstServer.close();
    await secondServer.close();
    await runtime.close();
    await daemon.close();
    processSessions.shutdown();
    workspaceStore.close();
    sessionLedger.close();
    agents.close();
  };
  t.after(async () => {
    await close();
    await removeTemporaryDirectory(root);
  });
  return { root, project, firstClient, secondClient, runtime, agents, manager, recording, processSessions, stateDir, managerLogs, close };
}

async function callTool(client: Client, name: string, args: Record<string, unknown>, conversationId: string) {
  return client.callTool({ name, arguments: args, _meta: { "openai/session": conversationId } } as Parameters<Client["callTool"]>[0]);
}

function structured(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  assert.ok(result.structuredContent, JSON.stringify(result));
  return result.structuredContent as Record<string, unknown>;
}

async function openSession(client: Client, project: string) {
  const opened = structured(await callTool(client, "open_workspace", { path: project }, CONVERSATION_ID));
  return {
    workspaceId: String(opened.workspace_id),
    sessionId: String(opened.session_id),
    memberId: String(opened.member_id),
  };
}

async function removeTemporaryDirectory(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
async function waitFor(predicate: () => boolean | Promise<boolean>, message: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(message);
}

async function probeRealCodex(env: NodeJS.ProcessEnv): Promise<{ command: ResolvedCodexCommand; control: CodexAppServerRuntime; account: unknown }> {
  const command = resolveCodexCommand(env);
  assert.ok(command, "CODEX_LIVE_ACCOUNT_UNAVAILABLE: a real installed Codex executable is required");
  assert.ok(isCodexAppServerSupported(command.executable, env), "CODEX_LIVE_ACCOUNT_UNAVAILABLE: app-server support is required");
  const reference = JSON.parse(await readFile(resolve("tools", "codex-reference.json"), "utf8")) as { codexVersion: string };
  assert.equal(command.version, reference.codexVersion, "CODEX_LIVE_PROTOCOL_MISMATCH: installed version differs from tools/codex-reference.json");
  const control = new CodexAppServerRuntime({
    command: command.executable,
    env: codexCommandEnvironment(env),
    version: command.version,
  });
  try {
    await control.initialize();
    const account = await control.control("account/read", { refreshToken: false });
    return { command, control, account };
  } catch (error) {
    await control.close();
    throw new Error("CODEX_LIVE_ACCOUNT_UNAVAILABLE: real Codex account check failed.", { cause: error });
  }
}

function itemTypes(turns: unknown[]): string[] {
  const types: string[] = [];
  for (const turn of turns) {
    const record = turn as Record<string, unknown>;
    const items = Array.isArray(record.items) ? record.items : [];
    for (const item of items) {
      const type = (item as Record<string, unknown>).type;
      if (typeof type === "string") types.push(type);
    }
  }
  return [...new Set(types)];
}

test("real Codex spawn, wait, steer, interrupt, follow-up, result persistence, and queued cancellation", { timeout: 600_000 }, async (t) => {
  const sourceCodexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const isolatedCodexRoot = await mkdtemp(join(tmpdir(), "quaymesh-codex-live-home-"));
  const isolatedCodexHome = join(isolatedCodexRoot, ".codex");
  await mkdir(isolatedCodexHome, { recursive: true });
  await copyFile(join(sourceCodexHome, "auth.json"), join(isolatedCodexHome, "auth.json"));
  await copyFile(join(sourceCodexHome, "config.toml"), join(isolatedCodexHome, "config.toml"));
  await copyFile(join(sourceCodexHome, "cc-switch-model-catalog.json"), join(isolatedCodexHome, "cc-switch-model-catalog.json"));
  const codexEnv = { ...process.env, CODEX_HOME: isolatedCodexHome };
  const { command, control, account } = await probeRealCodex(codexEnv);
  t.after(async () => {
    await control.close();
  });
  await assert.doesNotReject(async () => {
    const script = join("scripts", "generate-codex-protocol.ts");
    await execFileAsync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["exec", "tsx", script, "--check"], {
      cwd: process.cwd(), windowsHide: true, shell: process.platform === "win32", timeout: 180_000,
    });
  }, "CODEX_LIVE_PROTOCOL_MISMATCH: generated protocol check failed");

  const fixture = await liveFixture(t, command, codexEnv);
  t.after(async () => {
    await removeTemporaryDirectory(isolatedCodexRoot);
  });
  const desktopRegistration = await ensureDesktopProject([fixture.project], [], codexEnv);
  assert.equal(desktopRegistration.status, "not_applicable", JSON.stringify(desktopRegistration));
  const session = await openSession(fixture.firstClient, fixture.project);
  const spawn = structured(await callTool(fixture.firstClient, "spawn_agent", {
    workspace_id: session.workspaceId,
    name: "live factual and command task",
    message: "Read facts.txt, then run this exact command and wait for it to finish: node -e \"setTimeout(() => {}, 20000)\". Do not skip the command. After it finishes, reply with the exact line from facts.txt.",
  }, CONVERSATION_ID));
  const agentId = String(spawn.agent_id);
  assert.equal(typeof agentId, "string", JSON.stringify(spawn));
  await waitFor(
    () => fixture.agents.getById(agentId)?.controlState === "qm_active"
      || !["starting", "queued", "running"].includes(fixture.agents.getById(agentId)?.status ?? "starting"),
    "real Codex turn did not become controllable",
    180_000,
  );
  const active = fixture.agents.getById(agentId)!;
  const firstTurnId = active.providerTurnId;
  const firstThreadId = active.providerSessionId;
  assert.ok(firstTurnId, JSON.stringify(active));
  assert.ok(firstThreadId, JSON.stringify(active));

  await waitFor(() => fixture.recording.runs.some((run) => run.agentId === agentId
    && run.activities.some((activity) => activity.phase === "tool" && activity.toolCategory === "command")),
    "real Codex command activity did not start before control", 180_000);
  const observed = structured(await callTool(fixture.firstClient, "wait_agent", {
    workspace_id: session.workspaceId,
    agent_ids: [agentId],
    timeout_ms: 0,
  }, CONVERSATION_ID));
  assert.equal((observed.results as Array<Record<string, unknown>>)[0]?.state, "running");

  const steered = structured(await callTool(fixture.firstClient, "send_message", {
    workspace_id: session.workspaceId,
    agent_id: agentId,
    message: "Keep the original facts.txt and command instruction exactly. Do not create files in this turn.",
  }, CONVERSATION_ID));
  assert.equal(steered.accepted, true, JSON.stringify(steered));
  assert.equal(steered.action, "steer");

  const interrupted = structured(await callTool(fixture.firstClient, "interrupt_agent", {
    workspace_id: session.workspaceId,
    agent_id: agentId,
  }, CONVERSATION_ID));
  assert.equal(
    interrupted.accepted,
    true,
    JSON.stringify({ interrupted, managerLogs: fixture.managerLogs }),
  );
  assert.equal(interrupted.action, "interrupt");
  await waitFor(() => fixture.agents.getById(agentId)?.status !== "running", "real Codex interruption did not settle", 60_000);

  const followed = structured(await callTool(fixture.firstClient, "followup_agent", {
    workspace_id: session.workspaceId,
    agent_id: agentId,
    message: [
      `Call exec_command exactly once to create ${RESULT_FILE} in the workspace root.`,
      "Set cmd to exactly this string and set yield_time_ms to 5000:",
      "apply_patch <<'PATCH'",
      "*** Begin Patch",
      `*** Add File: ${RESULT_FILE}`,
      `+${RESULT_CONTENT.trimEnd()}`,
      "*** End Patch",
      "PATCH",
      "Do not use any other tool and do not change the command. After it succeeds, reply with exactly the content of the new file.",
    ].join("\n"),
  }, CONVERSATION_ID));
  assert.equal(followed.state, "running", JSON.stringify(followed));
  await waitFor(() => fixture.agents.getById(agentId)?.status === "idle", "real Codex follow-up did not complete", 180_000);
  const completed = fixture.agents.getById(agentId)!;
  assert.equal(completed.providerSessionId, firstThreadId, "follow-up created a different provider thread");
  let resultContent: string;
  try {
    resultContent = await readFile(join(fixture.project, RESULT_FILE), "utf8");
  } catch (error) {
    throw new Error(JSON.stringify({
      message: "real Codex follow-up did not create the requested file",
      agent: completed,
      runs: fixture.recording.runs.filter((run) => run.agentId === agentId),
      providerHistory: await control.control("thread/read", { threadId: firstThreadId, includeTurns: true }),
      managerLogs: fixture.managerLogs,
    }, null, 2), { cause: error });
  }
  assert.equal(resultContent, RESULT_CONTENT);

  await openSession(fixture.secondClient, fixture.project);
  const persisted = structured(await callTool(fixture.secondClient, "wait_agent", {
    workspace_id: session.workspaceId,
    agent_ids: [agentId],
    timeout_ms: 0,
  }, CONVERSATION_ID));
  const persistedResult = (persisted.results as Array<Record<string, unknown>>)[0]!;
  assert.equal(persistedResult.state, "completed");
  assert.match(String(persisted.response_text), /QUAYMESH_CODEX_LIVE_OK/);

  const history = await control.control("thread/read", { threadId: firstThreadId, includeTurns: true }) as Record<string, unknown>;
  const thread = history.thread as Record<string, unknown>;
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const types = itemTypes(turns);
  assert.ok(types.includes("commandExecution"), `real command event missing: ${types.join(",")}`);
  assert.ok(types.includes("fileChange"), `real file event missing: ${types.join(",")}`);

  const fixtureProcess = structured(await callTool(fixture.firstClient, "exec_command", {
    workspace_id: session.workspaceId,
    cmd: `"${process.execPath}" "${join(process.cwd(), "test", "session-card", "process-worker.mjs")}" wait "${join(fixture.root, "fixture-done.txt")}"`,
    yield_time_ms: 1_000,
  }, CONVERSATION_ID));
  assert.equal(fixtureProcess.running, true, JSON.stringify(fixtureProcess));
  const fixtureProcessId = Number(fixtureProcess.session_id);

  const queuedSpawn = structured(await callTool(fixture.firstClient, "spawn_agent", {
    workspace_id: session.workspaceId,
    name: "queued cancellation task",
    message: "Reply with exactly QUEUED_TASK_SHOULD_NOT_RUN.",
  }, CONVERSATION_ID));
  const queuedAgentId = String(queuedSpawn.agent_id);
  assert.equal(queuedSpawn.state, "queued", JSON.stringify(queuedSpawn));
  await waitFor(() => fixture.agents.getById(queuedAgentId)?.status === "queued", "agent did not enter the real execution queue");
  const queuedCancel = structured(await callTool(fixture.firstClient, "interrupt_agent", {
    workspace_id: session.workspaceId,
    agent_id: queuedAgentId,
  }, CONVERSATION_ID));
  assert.equal(queuedCancel.action, "cancel_queued", JSON.stringify(queuedCancel));
  assert.equal(queuedCancel.state, "stopped");
  assert.equal(fixture.recording.runs.some((run) => run.agentId === queuedAgentId), false, "queued task reached the provider");

  await callTool(fixture.firstClient, "write_stdin", {
    workspace_id: session.workspaceId,
    session_id: fixtureProcessId,
    chars: "GO\n",
    yield_time_ms: 5_000,
  }, CONVERSATION_ID);
  await waitFor(() => fixture.processSessions.executionCoordinator?.inspect(fixture.project)
    .every((entry) => entry.state !== "active") ?? true, "fixture process did not release admission", 20_000);

  const ledger = tableSnapshot(fixture.stateDir, agentId);
  const usage = fixture.agents.usage(agentId);
  const usageStatus = usage.status === "observed" ? "reported" : "unavailable";
  const receipt = {
    status: "passed",
    completedAt: new Date().toISOString(),
    codex: {
      command: command.executable,
      version: command.version,
      account: account,
      protocolCheck: "passed",
    },
    workspace: {
      root: fixture.project,
      git: true,
      codxHome: process.env.CODEX_HOME ?? null,
    },
    agent: {
      id: agentId,
      firstThreadId,
      secondThreadId: completed.providerSessionId,
      sameThread: completed.providerSessionId === firstThreadId,
      firstTurnId,
      secondTurnId: fixture.recording.runs.find((run) => run.agentId === agentId && run.turnId !== firstTurnId)?.turnId ?? null,
      completionStatus: completed.status,
      userAcceptance: "not_evaluated",
      responseFailureNewThread: false,
    },
    controls: {
      sendMessage: { invoked: true, accepted: true },
      interrupt: { invoked: true, accepted: true },
      queuedCancel: { invoked: true, agentId: queuedAgentId, providerInvoked: false },
      takeover: { invoked: false },
      returnControl: { invoked: false },
    },
    events: {
      itemTypes: types,
      activities: fixture.recording.runs.filter((run) => run.agentId === agentId).flatMap((run) => run.activities),
      executions: ledger.executions,
      workRunIds: ledger.workRunIds,
    },
    result: {
      path: RESULT_FILE,
      content: RESULT_CONTENT,
      sha256: createHash("sha256").update(RESULT_CONTENT).digest("hex"),
      persistedAcrossNewClient: true,
    },
    usage: {
      status: usageStatus,
      observations: usage.observations,
    },
  };
  await mkdir(resolve("releases", "session-acceptance"), { recursive: true });
  await writeFile(RECEIPT_PATH, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
});

function tableSnapshot(stateDir: string, agentId: string): {
  workRunIds: string[];
  executions: Array<Record<string, unknown>>;
} {
  const ledger = new WorkLedger(stateDir);
  try {
    const executions = ledger.db.prepare(`select id,run_id,provider_turn_id,status,usage_quality,requested,provider_finished,finished_at
      from console_executions where agent_id=? order by rowid asc`).all(agentId) as Array<Record<string, unknown>>;
    return {
      workRunIds: [...new Set(executions.map((row) => String(row.run_id)))],
      executions,
    };
  } finally {
    ledger.close();
  }
}
