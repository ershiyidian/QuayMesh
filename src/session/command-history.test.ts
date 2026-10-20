import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "../config.js";
import { LocalAgentStore } from "../local-agent-store.js";
import { executionContract } from "../process-platform.js";
import { ProcessSessionManager } from "../process-sessions.js";
import { writeTestQuayMeshConfig } from "../test-support/config.test.js";
import { registerCodexTools } from "../tool-surfaces/codex.js";
import { registerOperationTools } from "../tool-surfaces/operations.js";
import { WorkLedger } from "../work-ledger.js";
import { WorkspaceRegistry } from "../workspaces.js";
import { createInvocationContext, requestContextStorage } from "./invocations.js";
import { SessionOutputStore } from "./output.js";
import { createSessionRuntime } from "./runtime.js";
import { SessionStore } from "./store.js";
import { OperationState } from "./types.js";

test("deleted workspace command history retains output and enforces owner, node, root and operation", async t => {
  const directory = await mkdtemp(join(tmpdir(), "quaymesh-command-history-"));
  const root = join(directory, "project"), otherRoot = join(directory, "other-project");
  await mkdir(root);
  await mkdir(otherRoot);
  const stateDir = join(directory, "state");
  const ledger = new WorkLedger(stateDir);
  const store = new SessionStore(ledger.db);
  const output = new SessionOutputStore(stateDir);
  t.after(async () => {
    await output.close();
    ledger.close();
    await rm(directory, { recursive: true, force: true });
  });
  const session = store.createSession("owner", "history", "Completed command");
  const member = store.addMember(session.id, "worker", "workspace", root, "checkout", null);
  const task = store.createTask(session.id, "Original task");
  store.touchTaskMember(task.id, member.id);
  const run = ledger.begin({ root, workspaceId: member.workspace_id, workItemId: "history", runKey: "first",
    title: "Original task", origin: { entryPoint: "chatgpt_mcp", evidence: "server_entry" } });
  store.linkRun(session.id, member.id, run.id, task.id);
  const operationId = ledger.operation({ runId: run.id, requestKey: "command", kind: "command",
    label: "Completed command", status: "completed" });
  store.reserveInvocation({ id: "history-invocation", ownerId: "owner", transportInstanceId: "transport",
    requestId: "command", sessionId: session.id, memberId: member.id, toolName: "exec_command",
    argumentsJson: "{}", operationId, taskId: task.id });
  store.updateInvocation({ ownerId: "owner", transportInstanceId: "transport", requestId: "command",
    state: OperationState.succeeded, effect: "completed", finished: true, responded: true });
  store.closeTask(task.id, "completed", "Saved command evidence");
  await output.open(session.id, operationId, operationId);
  await output.append(operationId, "retained output 中文\n");
  await output.finish(operationId, 0, null);

  // 对照查询使用真实 SQLite 中已经保存的身份，再删除实际目录。
  const before = store.requireCommand("owner", "worker", member.root, operationId);
  assert.equal(before.task_id, task.id);
  assert.ok(before.retained_until);
  await rm(root, { recursive: true });
  await assert.rejects(stat(root), { code: "ENOENT" });
  const saved = store.requireCommand("owner", "worker", member.root, operationId);
  assert.deepEqual(saved, before);
  const page = await output.modelRead(saved.session_id, operationId, 0, 1024);
  assert.equal(page.chunk, "retained output 中文\n");
  assert.equal(page.done, true);
  assert.equal(page.exitCode, 0);

  // 同一 owner 的另一个有效根目录也不能冒领这个命令。
  const otherSession = store.createSession("owner", "other-history", "Another root");
  const otherMember = store.addMember(otherSession.id, "worker", "other-workspace", otherRoot, "checkout", null);
  store.createSession("another-owner", "history", "Another owner");
  assert.throws(() => store.requireCommand("owner", "worker", otherMember.root, operationId), /COMMAND_WORKSPACE_MISMATCH/);
  assert.throws(() => store.requireCommand("owner", "another-node", member.root, operationId), /COMMAND_WORKSPACE_MISMATCH/);
  assert.throws(() => store.requireCommand("another-owner", "worker", member.root, operationId), /COMMAND_NOT_FOUND/);
  assert.throws(() => store.requireCommand("owner", "worker", member.root, "missing-operation"), /COMMAND_NOT_FOUND/);
  await assert.rejects(stat(root), { code: "ENOENT" });
});

test("command replay and cancellation accept a valid workspace alias and reject a retargeted alias", async t => {
  const directory = await mkdtemp(join(tmpdir(), "quaymesh-command-alias-"));
  const root = join(directory, "project"), alias = join(directory, "alias"), otherRoot = join(directory, "other-project");
  await mkdir(root);
  await mkdir(otherRoot);
  await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
  const config = loadConfig(writeTestQuayMeshConfig(join(directory, "config"), {
    storage: { stateDir: join(directory, "state") },
    workspaces: { allowedRoots: [directory], worktreeRoot: join(directory, "worktrees") },
  }));
  const workspaces = new WorkspaceRegistry(config);
  const { workspace } = await workspaces.openWorkspace(alias);
  assert.notEqual(workspace.root, workspace.canonicalRoot);
  const ledger = new WorkLedger(config.stateDir);
  const agents = new LocalAgentStore(config.stateDir);
  const processSessions = new ProcessSessionManager({ stateDir: config.stateDir });
  const runtime = createSessionRuntime({ config, workspaces, ledger, agents, processSessions,
    execution: processSessions.executionCoordinator });
  const server = new McpServer({ name: "command-alias-test", version: "1" });
  const client = new Client({ name: "command-alias-client", version: "1" });
  t.after(async () => {
    await client.close();
    await server.close();
    await runtime.close();
    await processSessions.shutdown();
    agents.close();
    ledger.close();
    await rm(directory, { recursive: true, force: true });
  });
  const context = { server, config, workspaces, processSessions, sessionRuntime: runtime };
  registerCodexTools(context);
  registerOperationTools(context);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const session = runtime.store.createSession("owner", "alias", "Alias command");
  const member = runtime.store.addMember(session.id, config.federation?.nodeId ?? "local", workspace.id, workspace.root, "checkout", null);
  const task = runtime.store.createTask(session.id, "Alias task");
  const run = ledger.begin({ root: member.root, workspaceId: workspace.id, workItemId: "alias", runKey: "first",
    title: "Alias task", origin: { entryPoint: "chatgpt_mcp", evidence: "server_entry" } });
  runtime.store.linkRun(session.id, member.id, run.id, task.id);
  const operationId = ledger.operation({ runId: run.id, requestKey: "alias-command", kind: "command",
    label: "Saved alias command", status: "completed" });
  runtime.store.reserveInvocation({ id: "alias-invocation", ownerId: "owner", transportInstanceId: "transport",
    requestId: "alias-command", sessionId: session.id, memberId: member.id, toolName: "exec_command",
    argumentsJson: "{}", operationId, taskId: task.id });
  runtime.store.updateInvocation({ ownerId: "owner", transportInstanceId: "transport", requestId: "alias-command",
    state: OperationState.succeeded, effect: "completed", finished: true, responded: true,
    result: { kind: "result", value: { structuredContent: { execution: executionContract() } } } });
  await runtime.output.open(session.id, operationId, operationId);
  await runtime.output.append(operationId, "alias output\n");
  await runtime.output.finish(operationId, 0, null);

  // 使用真实 SDK 内存传输调用两个生产 handler，不绑定 TCP；SQLite 和目录均为真实临时资源。
  const call = (name: string) => requestContextStorage.run(createInvocationContext({
    auth: { owner_id: "owner" }, transport: { instance_id: "transport" },
    request: { id: name, tool_name: name },
    session: { session_id: session.id, task_id: task.id, member_id: member.id, workspace_id: workspace.id },
  }), () => client.callTool({ name, arguments: { workspace_id: workspace.id, operation_id: operationId } }));
  const replay = await call("write_stdin");
  assert.notEqual(replay.isError, true, JSON.stringify(replay.content));
  assert.equal((replay.structuredContent as Record<string, unknown> | undefined)?.result, "alias output\n");
  const cancelled = await call("cancel_command");
  assert.notEqual(cancelled.isError, true, JSON.stringify(cancelled.content));
  assert.equal((cancelled.structuredContent as Record<string, unknown> | undefined)?.cancel_requested, false);

  // 逻辑根被改指向另一个现存目录后，两个活跃入口都仍由 getWorkspace 拒绝。
  await rm(alias);
  await symlink(otherRoot, alias, process.platform === "win32" ? "junction" : "dir");
  for (const name of ["write_stdin", "cancel_command"]) {
    const rejected = await call(name);
    assert.equal(rejected.isError, true);
    assert.match(JSON.stringify(rejected.content), /root changed after it was opened/);
  }
});
