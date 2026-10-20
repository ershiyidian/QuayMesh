import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import Database from "better-sqlite3";
import { loadConfig } from "../config.js";
import { LocalAgentStore } from "../local-agent-store.js";
import { WorkLedger } from "../work-ledger.js";
import { SqliteWorkspaceStore } from "../workspace-store.js";
import { WorkspaceRegistry } from "../workspaces.js";
import { AgentOperationTracker } from "../session/agent-operations.js";
import { createInvocationContext, executeRecorded } from "../session/invocations.js";
import { openSessionStore } from "../session/runtime.js";
import { SessionService } from "../session/service.js";
import { OperationState } from "../session/types.js";
import { writeTestQuayMeshConfig } from "./config.test.js";

// 独立 Node 子进程验证真实定时器边界，确保旧实现的未处理拒绝会退出进程。
const [root, mode] = process.argv.slice(2);
if (!root || !["locked", "post-commit"].includes(mode ?? "")) throw new Error("Invalid lock worker arguments");
const stateDir = join(root, "state"), project = join(root, "project");
await mkdir(project, { recursive: true });
const config = loadConfig(writeTestQuayMeshConfig(join(root, "config"), {
  storage: { stateDir },
  workspaces: { allowedRoots: [root], worktreeRoot: join(root, "worktrees") },
  subagents: { enabled: false, instructions: "on-demand", providers: [] },
}));
const workspaceStore = new SqliteWorkspaceStore(stateDir);
const workspaces = new WorkspaceRegistry(config, workspaceStore);
const ledger = new WorkLedger(stateDir), agents = new LocalAgentStore(stateDir);
const { store, database } = openSessionStore(stateDir);
// 只缩短监听器中的同步写入等待；异步事务仍使用正式五秒取锁预算。
database.pragma("busy_timeout = 25");
const service = new SessionService(store, workspaces, ledger, agents);
const opened = await workspaces.openWorkspace({ path: project }, { conversationScopeId: "lock-conversation" });
const { session, member } = await service.open({ owner_id: "lock-owner", conversation_id: "lock-conversation" }, {
  id: opened.workspace.id, node: "local", root: project, mode: "checkout", sourceRoot: null,
}, "Recover an agent operation after SQLite contention");
const context = createInvocationContext({
  auth: { owner_id: "lock-owner" }, transport: { instance_id: "lock-transport" },
  request: { id: "lock-request", tool_name: "spawn_agent" },
  session: { session_id: session.id, task_id: service.ensureCurrentTask(session).id,
    member_id: member.id, workspace_id: opened.workspace.id },
});
await executeRecorded(store, context, {}, {
  beforeEffect: async () => { await service.beforeOperation(context, "agent_control", "spawn_agent"); },
  invoke: async () => ({ state: "running" }),
  runningResult: () => true,
  outcome: () => ({ state: OperationState.running, effect: "started" }),
});
const agent = agents.create({ workspaceId: opened.workspace.id, workspaceRoot: project, profileName: "reviewer", provider: "codex" });
agents.update(agent.id, { status: "idle", latestResponse: "Durable provider result" });
const identity = { operationId: context.operation_id!, agentId: agent.id, sessionId: session.id, memberId: member.id };
const blocker = new Database(join(stateDir, "quaymesh.sqlite"));
const lock = () => {
  blocker.exec("BEGIN IMMEDIATE");
  blocker.prepare("UPDATE qm_agent_operations SET updated_at=updated_at WHERE operation_id=?").run(identity.operationId);
};
const options = {
  intervalMs: 25,
  onError: (error: unknown) => process.send?.({ type: "poll-error", code: (error as { code?: string }).code }),
};
let tracker = new AgentOperationTracker(agents, service, store, options);
let afterCommit = false;
const dispose = store.onChange(change => {
  const event = database.prepare("SELECT event_type FROM qm_events WHERE sequence=?").get(change.sequence) as { event_type: string };
  if (mode !== "post-commit" || afterCommit || event.event_type !== "agent_changed") return;
  afterCommit = true;
  lock();
  // 事件已经提交，订阅者的真实 SQLite 写入此时因争锁失败。
  database.prepare("UPDATE qm_sessions SET revision=revision WHERE id=?").run(session.id);
});
tracker.track(identity);
// 首个定时器触发前，另一 SQLite 连接同步取得写锁。
if (mode === "locked") lock();
process.send?.({ type: "ready", ...identity, pid: process.pid, stateDir });

let sentComplete = false, closing = false;
const monitor = setInterval(() => {
  if (sentComplete || !store.hasOperationFinished(identity.operationId)) return;
  sentComplete = true;
  process.send?.({ type: "completed", invocation: store.findInvocationByOperationId(identity.operationId),
    pending: store.pendingAgentOperations(), agent: agents.getById(agent.id) });
}, 10);
async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  clearInterval(monitor);
  if (blocker.inTransaction) blocker.exec("ROLLBACK");
  await tracker.close();
  dispose();
  await service.close();
  blocker.close(); database.close(); agents.close(); ledger.close(); workspaceStore.close();
  process.disconnect?.();
}
process.on("message", message => {
  void (async () => {
    const type = (message as { type: string }).type;
    if (type === "release") { blocker.exec("ROLLBACK"); process.send?.({ type: "released" }); }
    else if (type === "ping") process.send?.({ type: "pong", pid: process.pid });
    else if (type === "stop-tracker") { await tracker.close(); process.send?.({ type: "tracker-stopped" }); }
    else if (type === "restore-tracker") {
      tracker = new AgentOperationTracker(agents, service, store, options);
      tracker.restore();
      process.send?.({ type: "tracker-restored" });
    } else if (type === "close") await close();
  })().catch(error => { console.error(error); process.exitCode = 2; void close(); });
});
process.on("SIGTERM", () => { void close(); });
