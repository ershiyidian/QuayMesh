import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { loadConfig } from "../config.js";
import { SessionFeed } from "../federation/session-feed.js";
import { writeTestQuayMeshConfig } from "../test-support/config.test.js";
import { WorkLedger } from "../work-ledger.js";
import { SqliteWorkspaceStore } from "../workspace-store.js";
import { WorkspaceRegistry } from "../workspaces.js";
import { SessionChangeCollector } from "./changes.js";
import { SessionProjector } from "./projection.js";
import { SessionService } from "./service.js";
import { SessionStore } from "./store.js";
import { SessionToolRecorder } from "./tool-recording.js";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "qm-federated-task-state-"));
  const root = join(directory, "project");
  await mkdir(root);
  const config = loadConfig(writeTestQuayMeshConfig(join(directory, "config"), {
    storage: { stateDir: join(directory, "worker") },
    workspaces: { allowedRoots: [root], worktreeRoot: join(directory, "worktrees") },
  }));
  const workspaceStore = new SqliteWorkspaceStore(config.stateDir);
  const registry = new WorkspaceRegistry(config, workspaceStore);
  const { workspace } = await registry.openWorkspace(root);
  const nodes = ["cloud", "worker"].map(node => {
    const stateDir = join(directory, node), ledger = new WorkLedger(stateDir);
    const store = new SessionStore(ledger.db), changes = new SessionChangeCollector(store, stateDir);
    const projector = new SessionProjector(store, stateDir, null, undefined, node);
    const service = new SessionService(store, registry, ledger, undefined, changes, projector, undefined, node);
    const recorder = new SessionToolRecorder(store, registry, service, changes, projector);
    return { store, ledger, changes, projector, service, recorder };
  });
  const [cloud, worker] = nodes;
  t.after(async () => {
    for (const node of nodes) {
      await node.recorder.close(); await node.service.close(); await node.projector.close(); await node.changes.close();
      node.ledger.close();
    }
    workspaceStore.close();
    await rm(directory, { recursive: true, force: true });
  });
  const session = cloud.store.createSession("owner", "conversation", "Federated task state");
  worker.store.adoptRemoteSession({ id: session.id, ownerId: "owner", conversationId: "conversation", title: session.title });
  const member = worker.store.addMember(session.id, "worker", workspace.id, root, "checkout", null);
  cloud.store.upsertRemoteMember({ id: member.id, sessionId: session.id, nodeId: "worker", workspaceId: workspace.id,
    root: member.root, sourceRoot: null, mode: "checkout", online: true, revision: 0 });
  const previous = cloud.store.createTask(session.id, "Original task with worker");
  await worker.service.adoptTask(session.id, previous.id, previous.title, previous.created_at);
  cloud.store.touchTaskMember(previous.id, member.id); worker.store.touchTaskMember(previous.id, member.id);
  cloud.store.closeTask(previous.id, "completed", "Previous task complete");
  worker.store.closeTask(previous.id, "completed", "Previous task complete");
  const task = (await cloud.service.startTask({ owner_id: "owner", conversation_id: "conversation" }, "Next task", "next")).task;
  const marker = join(root, "writes.txt");
  let forwarded = 0;
  const forward = async (name: string, requestId: string, input: Record<string, unknown>, observe = false) => {
    const remoteInput = { ...input, workspace_id: `qm:worker:${workspace.id}` };
    const extra = { authInfo: { clientId: "transport", extra: { owner_id: "owner" } }, requestId, _meta: { "openai/session": "conversation" } };
    const trusted = SessionFeed.prototype.trustedInvocation.call({ store: cloud.store } as unknown as SessionFeed, name, remoteInput, extra)!;
    const options = { tool_name: name, kind: "patch" as const, label: name, affectsFiles: !observe };
    return cloud.recorder.recordForwarded({ ...options, input: remoteInput, workspace_id: remoteInput.workspace_id,
      identity: { owner_id: "owner", conversation_id: "conversation", transport_instance_id: "transport", request_id: requestId, task_id: trusted.task_id },
      operation: async context => {
        forwarded++;
        const envelope = { ...trusted, invocation_id: context.invocation_id, operation_id: context.operation_id };
        const localInput = { ...input, workspace_id: workspace.id };
        // 复用生产信封生成、worker 镜像和两端 recorder，只有网络传输由同进程直连代替。
        const prepared = await SessionFeed.prototype.prepareLocalTool.call({ store: worker.store, service: worker.service,
          runtime: { localId: "worker" } } as unknown as SessionFeed,
          name, localInput, envelope);
        return worker.recorder.record({ ...options, input: localInput, identity: prepared ?? envelope, workspace_id: workspace.id,
          operation: async () => {
            if (!observe) await appendFile(marker, "once\n");
            return { result: observe ? await readFile(marker, "utf8") : "written", operation_id: context.operation_id };
          } });
      } });
  };
  return { root, marker, cloud, worker, session, member, task, forward, forwarded: () => forwarded };
}

test("closed coordinator task rejects new remote mutations before a first worker mirror or file write", async t => {
  const f = await fixture(t);
  await f.cloud.service.finishTask("owner", f.task.id, "completed", "Completed without visiting worker");
  assert.equal(f.worker.store.findTask(f.task.id), null);
  for (const name of ["exec_command", "bash", "write", "edit", "apply_patch", "spawn_agent", "followup_agent", "send_message"]) {
    await assert.rejects(f.forward(name, `closed-${name}`, { operation_key: `new-${name}` }),
      { code: "TASK_NOT_ACTIVE", effect: "not_started" }, name);
    assert.equal(f.worker.store.findTask(f.task.id), null, name);
    assert.equal(f.cloud.store.getTask(f.task.id).state, "closed", name);
  }
  assert.equal(f.forwarded(), 0);
  await assert.rejects(stat(f.marker), { code: "ENOENT" });
});

test("completed remote receipt replay and accepted-work observations remain available after task closure", async t => {
  const f = await fixture(t);
  const input = { operation_key: "completed-write" };
  const first = await f.forward("write", "write-original", input);
  f.cloud.store.closeTask(f.task.id, "completed", "Completed");
  f.worker.store.closeTask(f.task.id, "completed", "Completed");
  assert.deepEqual(await f.forward("write", "receipt-retry", input), first);
  assert.equal(f.forwarded(), 1, "已完成的同 key 回执在入口直接重放，不再次发送写入");
  for (const name of ["read", "read_output", "workspace_context", "wait_agent", "list_agents", "cancel_command", "interrupt_agent", "write_stdin"]) {
    const observed = await f.forward(name, `observe-${name}`, { action: "status", operation_id: first.operation_id }, true);
    assert.equal(observed.result, "once\n", name);
    assert.equal(f.worker.store.getTask(f.task.id).state, "closed", name);
  }
  assert.equal(await readFile(f.marker, "utf8"), "once\n");
});

test("a task already finalizing rejects new remote work before its first worker mirror", async t => {
  const f = await fixture(t);
  f.cloud.store.taskData.requestFinalization(f.task.id, "completed", "Finishing now");
  await assert.rejects(f.forward("write", "during-finalization", { operation_key: "new-while-finishing" }),
    { code: "TASK_FINISHING", effect: "not_started" });
  assert.equal(f.forwarded(), 0);
  assert.equal(f.worker.store.findTask(f.task.id), null);
  await assert.rejects(stat(f.marker), { code: "ENOENT" });
});
