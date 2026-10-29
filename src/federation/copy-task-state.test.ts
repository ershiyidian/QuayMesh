import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { loadConfig } from "../config.js";
import { SessionChangeCollector } from "../session/changes.js";
import { SessionProjector } from "../session/projection.js";
import type { SessionRuntime } from "../session/runtime.js";
import { SessionService } from "../session/service.js";
import { SessionStore } from "../session/store.js";
import { SessionToolRecorder } from "../session/tool-recording.js";
import { writeTestQuayMeshConfig } from "../test-support/config.test.js";
import { WorkLedger } from "../work-ledger.js";
import { SqliteWorkspaceStore } from "../workspace-store.js";
import { WorkspaceRegistry } from "../workspaces.js";
import { createFederation } from "./integration.js";
import { federationConfigSchema } from "./schema.js";
import { PeerApplicationError } from "./transport.js";
import type { TransferView } from "./transfer-store.js";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "qm-copy-task-state-")), root = join(directory, "project");
  await mkdir(root);
  const tokenFile = join(directory, "cluster.token");
  await writeFile(tokenFile, "temporary-copy-regression-token-long-enough");
  const base = loadConfig(writeTestQuayMeshConfig(join(directory, "config"), {
    storage: { stateDir: join(directory, "worker") },
    workspaces: { allowedRoots: [root], worktreeRoot: join(directory, "worktrees") },
  }));
  const workspaceStore = new SqliteWorkspaceStore(base.stateDir), registry = new WorkspaceRegistry(base, workspaceStore);
  const { workspace } = await registry.openWorkspace(root);
  const nodes = ["cloud", "worker"].map(node => {
    const config = { ...base, stateDir: join(directory, node), federation: federationConfigSchema.parse({
      enabled: true, nodeId: node, nickname: node, tokenFile,
      capabilities: { coordinator: node === "cloud", worker: node === "worker" },
      roots: [{ id: "main", nickname: "main", path: root }], egress: { enabled: false },
    }) };
    const ledger = new WorkLedger(config.stateDir), store = new SessionStore(ledger.db);
    const changes = new SessionChangeCollector(store, config.stateDir), projector = new SessionProjector(store, config.stateDir, null, undefined, node);
    const service = new SessionService(store, registry, ledger, undefined, changes, projector, undefined, node);
    const recorder = new SessionToolRecorder(store, registry, service, changes, projector);
    const session = { store, changes, projector, service, recorder };
    const runtime = createFederation(config, registry, () => [], async () => ({ status: 200, body: {} }), session as SessionRuntime)!;
    return { ...session, config, ledger, runtime };
  });
  const [cloud, worker] = nodes;
  t.after(async () => {
    for (const node of nodes) await node.runtime.close();
    for (const node of nodes) {
      await node.recorder.close(); await node.service.close(); await node.projector.close(); await node.changes.close();
      node.ledger.close();
    }
    workspaceStore.close(); await rm(directory, { recursive: true, force: true });
  });
  const methods: string[] = [];
  let legacy = false;
  // 两份真实数据库和生产复制 hooks；只将节点 RPC 直接接到本机处理器，不开启监听。
  cloud.runtime.request = async <T>(node: string, method: string, params: unknown): Promise<T> => {
    assert.equal(node, "worker"); methods.push(method);
    if (legacy && method === "artifact.lookup") throw new PeerApplicationError(node, `未知节点方法 ${method}`);
    const receiver = worker.runtime as unknown as { receive(method: string, params: unknown, peer: string): Promise<T> };
    return receiver.receive(method, params, "cloud");
  };
  const session = cloud.store.createSession("owner", "conversation", "Copy state");
  worker.store.adoptRemoteSession({ id: session.id, ownerId: "owner", conversationId: "conversation", title: session.title });
  const member = worker.store.addMember(session.id, "worker", workspace.id, root, "checkout", null);
  cloud.store.upsertRemoteMember({ id: member.id, sessionId: session.id, nodeId: "worker", workspaceId: workspace.id,
    root: member.root, sourceRoot: null, mode: "checkout", online: true, revision: 0 });
  const task = cloud.store.createTask(session.id, "Original task");
  const input = { action: "start", request_key: "original-key", source_workspace_id: `qm:worker:${workspace.id}`,
    destination_workspace_id: `qm:worker:${workspace.id}`, source_path: "source.txt", destination_path: "copied.txt", overwrite: true };
  let requestId = 0;
  const copy = (changes: Record<string, unknown> = {}) => cloud.runtime.copyArtifact({ ...input, ...changes }, {
    authInfo: { clientId: "transport", extra: { owner_id: "owner" } }, requestId: ++requestId, _meta: { "openai/session": "conversation" },
  }) as Promise<TransferView>;
  const settled = async (receipt: TransferView): Promise<TransferView> => {
    const end = Date.now() + 5000;
    while (Date.now() < end) {
      const view = await worker.runtime.request<TransferView>("worker", "artifact.observe", { id: receipt.id });
      if (view.status !== "running") return view;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error("Copy did not settle");
  };
  await writeFile(join(root, "source.txt"), "original-source\n");
  return { root, cloud, worker, session, member, task, input, copy, settled, methods, legacy: () => { legacy = true; } };
}

test("closed task replays its completed copy without rewriting and rejects a new first-mirror copy", async t => {
  const f = await fixture(t);
  const first = await f.settled(await f.copy());
  assert.equal(first.status, "completed", first.error);
  assert.deepEqual(f.methods, ["artifact.lookup", "artifact.copy"], "the owner receipt is checked before the first copy dispatch");
  const transfer = f.worker.ledger.db.prepare("SELECT * FROM qm_transfers WHERE id=?").get(first.id);
  const invocation = f.worker.store.findInvocationByOperationId(first.operationId);
  assert.equal(invocation?.id, first.operationId);
  assert.equal(invocation?.operation_id, first.operationId);
  assert.equal(invocation?.task_id, f.task.id);
  assert.equal(invocation?.state, "succeeded");
  f.cloud.store.closeTask(f.task.id, "completed", "Done");
  f.worker.store.closeTask(f.task.id, "completed", "Done");
  const closed = f.worker.store.getTask(f.task.id), replayStart = f.methods.length;
  await writeFile(join(f.root, "source.txt"), "changed-source\n");
  const replay = await f.copy();
  assert.deepEqual(replay, first);
  assert.deepEqual(f.methods.slice(replayStart), ["artifact.lookup"], "closed-task replay reads the saved receipt without another copy dispatch");
  assert.equal(await readFile(join(f.root, "copied.txt"), "utf8"), "original-source\n");
  await assert.rejects(f.copy({ destination_path: "changed-target.txt" }), { code: "COPY_REQUEST_KEY_REUSED", effect: "not_started" });
  const unseen = (await f.cloud.service.startTask({ owner_id: "owner", conversation_id: "conversation" }, "Coordinator-only task", "unseen")).task;
  f.cloud.store.closeTask(unseen.id, "completed", "No worker work needed");
  assert.equal(f.worker.store.findTask(unseen.id), null);
  await assert.rejects(f.copy({ request_key: "new-closed-key", destination_path: "after-closed.txt" }), { code: "TASK_NOT_ACTIVE", effect: "not_started" });
  assert.equal(f.worker.store.findTask(unseen.id), null);
  assert.equal(f.methods.filter(method => method === "artifact.copy").length, 1);
  assert.ok(f.methods.slice(2).every(method => method === "artifact.lookup"));
  assert.deepEqual(f.worker.ledger.db.prepare("SELECT * FROM qm_transfers WHERE id=?").get(first.id), transfer);
  assert.deepEqual(f.worker.store.findInvocationByOperationId(first.operationId), invocation);
  assert.deepEqual(f.worker.store.getTask(f.task.id), closed);
  await assert.rejects(stat(join(f.root, "after-closed.txt")), { code: "ENOENT" });
  assert.equal((await f.worker.runtime.request<TransferView[]>("worker", "transfers.list", {})).length, 1);
});

test("a finalizing task only permits lookup of its existing copy receipt", async t => {
  const f = await fixture(t);
  const first = await f.settled(await f.copy());
  assert.equal(first.status, "completed", first.error);
  assert.deepEqual(f.methods, ["artifact.lookup", "artifact.copy"]);
  const transfer = f.worker.ledger.db.prepare("SELECT * FROM qm_transfers WHERE id=?").get(first.id);
  const invocation = f.worker.store.findInvocationByOperationId(first.operationId);
  f.cloud.store.taskData.requestFinalization(f.task.id, "completed", "Finishing");
  const intent = f.cloud.store.taskData.finalization(f.task.id), replayStart = f.methods.length;
  assert.deepEqual(await f.copy(), first);
  assert.deepEqual(f.methods.slice(replayStart), ["artifact.lookup"], "receipt replay does not retire the pending finish or dispatch copy work");
  await assert.rejects(f.copy({ request_key: "new-finishing-key", destination_path: "while-finishing.txt" }), { code: "TASK_FINISHING", effect: "not_started" });
  assert.equal(f.methods.filter(method => method === "artifact.copy").length, 1);
  assert.ok(f.methods.slice(2).every(method => method === "artifact.lookup"));
  assert.deepEqual(f.cloud.store.taskData.finalization(f.task.id), intent);
  assert.deepEqual(f.worker.ledger.db.prepare("SELECT * FROM qm_transfers WHERE id=?").get(first.id), transfer);
  assert.deepEqual(f.worker.store.findInvocationByOperationId(first.operationId), invocation);
  assert.equal((await f.worker.runtime.request<TransferView[]>("worker", "transfers.list", {})).length, 1);
  await assert.rejects(stat(join(f.root, "while-finishing.txt")), { code: "ENOENT" });
});

test("a task that only copies a file still finalizes the destination task and keeps its receipt replayable", async t => {
  const f = await fixture(t);
  const receipt = await f.settled(await f.copy());
  assert.equal(receipt.status, "completed", receipt.error);
  await f.cloud.service.finishTask("owner", f.task.id, "completed", "Copy completed");
  assert.equal(f.cloud.store.getTask(f.task.id).state, "closed");
  assert.equal(f.worker.store.getTask(f.task.id).state, "closed");
  assert.equal((await f.copy()).id, receipt.id);
});

test("a destination task finalized before its coordinator leaves a terminal failed copy receipt", async t => {
  const f = await fixture(t);
  await f.worker.service.adoptTask(f.session.id, f.task.id, f.task.title, f.task.created_at);
  f.worker.store.touchTaskMember(f.task.id, f.member.id);
  await f.worker.service.finishOwnedTask("owner", f.task.id, "completed", "Worker finalized before coordinator confirmation");
  assert.equal(f.cloud.store.getTask(f.task.id).state, "active");
  assert.equal(f.worker.store.getTask(f.task.id).state, "closed");

  const receipt = await f.settled(await f.copy());
  assert.equal(receipt.status, "failed");
  assert.deepEqual(f.methods, ["artifact.lookup", "artifact.copy"]);
  assert.match(receipt.error ?? "", /^TASK_NOT_ACTIVE:/u);
  await assert.rejects(stat(join(f.root, "copied.txt")), { code: "ENOENT" });
  const invocation = f.worker.store.findInvocationByOperationId(receipt.operationId);
  assert.ok(invocation);
  assert.equal(invocation.id, receipt.operationId);
  assert.equal(invocation.task_id, f.task.id);
  assert.equal(invocation.state, "failed");
  assert.equal(invocation.effect, "not_started");
  assert.ok(invocation.finished_at);
  assert.deepEqual(JSON.parse(invocation.result_json!), {
    kind: "error", message: receipt.error, errorCode: "TASK_NOT_ACTIVE", effect: "not_started", retryHint: "fix_input",
  });
  assert.equal(f.worker.store.findOperationEvent(receipt.operationId), null);
  assert.equal((f.worker.ledger.db.prepare("SELECT count(*) AS count FROM execution_claims").get() as {count: number}).count, 0);
  const transfer = f.worker.ledger.db.prepare("SELECT * FROM qm_transfers WHERE id=?").get(receipt.id);
  const closed = f.worker.store.getTask(f.task.id), replayStart = f.methods.length;

  await writeFile(join(f.root, "source.txt"), "changed-after-failure\n");
  assert.deepEqual(await f.copy(), receipt);
  assert.deepEqual(f.methods.slice(replayStart), ["artifact.lookup"], "an active coordinator also replays a saved failure without another copy dispatch");
  f.cloud.store.closeTask(f.task.id, "completed", "Coordinator confirmation");
  assert.deepEqual(await f.copy(), receipt);
  assert.deepEqual(f.worker.store.findInvocationByOperationId(receipt.operationId), invocation);
  assert.equal((f.worker.ledger.db.prepare("SELECT count(*) AS count FROM qm_invocations").get() as {count: number}).count, 1);
  assert.equal((await f.worker.runtime.request<TransferView[]>("worker", "transfers.list", {})).length, 1);
  assert.deepEqual(f.methods.slice(replayStart), ["artifact.lookup", "artifact.lookup"]);
  assert.equal(f.methods.filter(method => method === "artifact.copy").length, 1);
  assert.deepEqual(f.worker.ledger.db.prepare("SELECT * FROM qm_transfers WHERE id=?").get(receipt.id), transfer);
  assert.deepEqual(f.worker.store.getTask(f.task.id), closed);
  await assert.rejects(stat(join(f.root, "copied.txt")), { code: "ENOENT" });
});

test("an old-style peer that rejects copy lookup cannot cause fallback to a new copy", async t => {
  const f = await fixture(t);
  f.cloud.store.closeTask(f.task.id, "completed", "No worker work needed");
  f.legacy();
  await assert.rejects(f.copy(), { code: "COPY_RECEIPT_LOOKUP_FAILED", effect: "not_started" });
  assert.deepEqual(f.methods, ["artifact.lookup"]);
  assert.equal(f.worker.store.findTask(f.task.id), null);
  assert.equal((await f.worker.runtime.request<TransferView[]>("worker", "transfers.list", {})).length, 0);
  await assert.rejects(stat(join(f.root, "copied.txt")), { code: "ENOENT" });
});

test("copy receipt lookup checks owner, task, session, member and complete transfer parameters without writes", async t => {
  const f = await fixture(t);
  const receipt = await f.settled(await f.copy());
  assert.equal(receipt.status, "completed", receipt.error);
  const row = f.worker.ledger.db.prepare("SELECT * FROM qm_transfers WHERE id=?").get(receipt.id) as Record<string, unknown>;
  const request = { requestKey: f.input.request_key, sourceNode: "worker", sourceWorkspace: f.member.workspace_id,
    sourcePath: f.input.source_path, destinationWorkspace: f.member.workspace_id, destinationPath: f.input.destination_path,
    overwrite: true, context: { owner_id: "owner", task_id: f.task.id, session_id: f.session.id, member_id: f.member.id } };
  const lookup = (changes: Record<string, unknown>) => f.worker.runtime.request<TransferView | null>("worker", "artifact.lookup", { ...request, ...changes });
  assert.equal((await lookup({}))?.id, receipt.id);
  assert.equal(await lookup({ context: { ...request.context, owner_id: "other-owner" } }), null);
  for (const field of ["task_id", "session_id", "member_id"]) {
    await assert.rejects(lookup({ context: { ...request.context, [field]: "another" } }), { code: "COPY_REQUEST_KEY_REUSED", effect: "not_started" });
  }
  for (const field of ["sourceNode", "sourceWorkspace", "sourcePath", "destinationWorkspace", "destinationPath"]) {
    await assert.rejects(lookup({ [field]: "another" }), { code: "COPY_REQUEST_KEY_REUSED", effect: "not_started" });
  }
  await assert.rejects(lookup({ overwrite: false }), { code: "COPY_REQUEST_KEY_REUSED", effect: "not_started" });
  assert.deepEqual(f.worker.ledger.db.prepare("SELECT * FROM qm_transfers WHERE id=?").get(receipt.id), row);
  assert.equal((await f.worker.runtime.request<TransferView[]>("worker", "transfers.list", {})).length, 1);
});
