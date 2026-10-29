import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { openDatabase } from "../../src/db/client.js";
import { PeerTransport } from "../../src/federation/transport.js";
import { TransferStore } from "../../src/federation/transfer-store.js";
import { SessionStore } from "../../src/session/store.js";
import type { TaskBindingState, TaskBindingView } from "../../src/tasks/task-binding.js";
import { createRealTestServer, freePort, structured, waitForFixture, waitForRecordedTool,
  type RealTestServer } from "../session-card/server-fixture.js";

const token = "task-binding-real-federation-test-cluster-secret";
const coordinatorId = "resume-coordinator", workerId = "resume-worker";
const capabilities = (coordinator: boolean, worker: boolean) => ({ coordinator, worker, discovery: false,
  egress: false, meshRelay: coordinator, desktopUi: false, consoleRelay: false });
type ToolResult = Awaited<ReturnType<RealTestServer["client"]["callTool"]>>;
interface TaskReply { task_id: string; session_id: string }
interface OpenReply extends TaskReply { workspace_id: string }
interface ResumeReply extends TaskReply { binding: TaskBindingView }
function value<T>(result: ToolResult): T {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return structured(result) as unknown as T;
}
function binding(result: ToolResult): TaskBindingState {
  const metadata = result._meta as { quaymesh?: { task_binding?: TaskBindingState } } | undefined;
  assert.ok(metadata?.quaymesh?.task_binding, "the Coordinator must supply this entry's binding sideband");
  return metadata.quaymesh.task_binding;
}

async function fixture(t: TestContext) {
  const workerPort = await freePort(), coordinatorPort = await freePort();
  const configure = async (config: RealTestServer["config"]) => {
    const tokenFile = join(config.stateDir, "task-binding-test-cluster-token");
    await writeFile(tokenFile, token);
    return { ...config, federation: { ...config.federation, coordinatorId, tokenFile,
      tokenEnv: "QUAYMESH_TASK_BINDING_TEST_UNUSED_TOKEN" } };
  };
  const worker = await createRealTestServer({ git: false, prefix: "qm-task-binding-worker-", configure,
    federation: { nodeId: workerId, nickname: "Task binding worker", capabilities: capabilities(false, true), priority: 0,
      port: workerPort, ingressPort: await freePort(), peers: [{ id: coordinatorId, url: "" }] } });
  let coordinatorForCleanup: RealTestServer | undefined, closeReaders = () => {};
  t.after(async () => { closeReaders(); await coordinatorForCleanup?.dispose(); await worker.dispose(); });
  const coordinator = await createRealTestServer({ git: false, prefix: "qm-task-binding-coordinator-", configure,
    federation: { nodeId: coordinatorId, nickname: "Task binding authority", capabilities: capabilities(true, false), priority: 100,
      port: coordinatorPort, ingressPort: await freePort(), peers: [{ id: workerId, url: `http://127.0.0.1:${workerPort}` }] } });
  coordinatorForCleanup = coordinator;
  const db = openDatabase(coordinator.config.stateDir), workerDb = openDatabase(worker.config.stateDir);
  const store = new SessionStore(db.sqlite), workerStore = new SessionStore(workerDb.sqlite);
  closeReaders = () => { if (db.sqlite.open) db.close(); if (workerDb.sqlite.open) workerDb.close(); };
  const call = (entry: string, name: string, args: Record<string, unknown>) => coordinator.client.callTool({
    name, arguments: args, _meta: { "openai/session": entry },
  });
  const select = async (entry: string, taskId: string, key: string) => {
    const state = value<ResumeReply>(await call(entry, "task_resume", { action: "inspect", task_id: taskId }));
    return value<ResumeReply>(await call(entry, "task_resume", { action: "resume", task_id: taskId,
      expected_binding_revision: state.binding.binding_revision, request_key: key }));
  };
  await waitForFixture(coordinator, { sessionId: "not-created" }, "actual Worker peer connects", async () =>
    Boolean(coordinator.running.federation?.transport.links.get(workerId)?.connected), Boolean);
  const started = value<TaskReply>(await call("original", "start_session", { title: "Federated original goal", request_key: "original" }));
  const opened = value<OpenReply>(await call("original", "open_workspace", { root_id: `${workerId}/main` }));
  await select("replacement", started.task_id, "same-task-new-entry");
  return { worker, coordinator, db, workerDb, store, workerStore, call, select, started, opened, coordinatorPort };
}

test("real MCP and peer RPC: resumed execution and copy use the original Task/member even after the original entry starts a new goal", { timeout: 90_000 }, async t => {
  const f = await fixture(t);
  const repeatedReply = await f.call("replacement", "open_workspace", { root_id: `${workerId}/main` });
  const repeated = value<OpenReply>(repeatedReply);
  assert.equal(binding(repeatedReply).can_continue, true, "entry selection comes from the authority, not the Worker's empty binding table");
  assert.equal((f.workerDb.sqlite.prepare("SELECT COUNT(*) AS n FROM qm_task_bindings").get() as { n: number }).n, 0);
  for (const [name, args] of [
    ["start_session", { title: "Must use the authority", request_key: "no-worker-binding" }],
    ["open_workspace", { path: f.worker.project }],
  ] as const) {
    const denied = await f.worker.client.callTool({ name, arguments: args, _meta: { "openai/session": "worker-direct-entry" } });
    assert.equal(denied.isError, true, JSON.stringify(denied));
    assert.match(JSON.stringify(denied), /TASK_BINDING_AUTHORITY_REQUIRED/);
    assert.equal(structured(denied).effect, "not_started");
  }
  assert.equal((f.workerDb.sqlite.prepare("SELECT COUNT(*) AS n FROM qm_task_bindings").get() as { n: number }).n, 0);
  assert.equal(repeated.workspace_id, f.opened.workspace_id);
  assert.equal(f.store.taskMemberIds(f.started.task_id).length, 1);
  await mkdir(join(f.worker.project, "additional-root"));
  const attached = value<OpenReply>(await f.call("replacement", "attach_workspace", {
    session_id: f.started.session_id, root_id: `${workerId}/main`, subdirectory: "additional-root",
  }));
  assert.equal(attached.task_id, f.started.task_id);
  assert.equal(attached.session_id, f.started.session_id);
  const script = join(f.worker.project, "task-a-history.cjs");
  await writeFile(script, "console.log('output owned by Task A');\n");
  const command = await f.call("replacement", "exec_command", { workspace_id: f.opened.workspace_id,
    cmd: `"${process.execPath}" "${script}"`, yield_time_ms: 100, operation_key: "original-history" });
  const operationId = value<{ operation_id: string }>(command).operation_id;
  await waitForRecordedTool(f.coordinator, { sessionId: f.started.session_id, workspaceId: f.opened.workspace_id,
    conversationId: "replacement" }, command);
  const originalSelection = value<ResumeReply>(await f.call("original", "task_resume", { action: "inspect", task_id: f.started.task_id }));
  const newer = value<TaskReply>(await f.call("original", "start_session", { title: "Another goal", request_key: "new-goal",
    new_goal: true, expected_binding_revision: originalSelection.binding.binding_revision }));
  assert.equal(f.workerStore.findTask(newer.task_id), null);
  await f.select("replacement", newer.task_id, "observe-new-goal-before-worker-use");
  const missingHistory = await f.call("replacement", "workspace_context", { workspace_id: f.opened.workspace_id, action: "recovery" });
  assert.equal(missingHistory.isError, true, JSON.stringify(missingHistory));
  assert.match(JSON.stringify(missingHistory), /TASK_REMOTE_HISTORY_UNAVAILABLE/);
  const oldOutput = value<{ task_id: string; result: string }>(await f.call("replacement", "read_output", {
    workspace_id: f.opened.workspace_id, operation_id: operationId, cursor: 0,
  }));
  assert.equal(oldOutput.task_id, f.started.task_id);
  assert.match(oldOutput.result, /output owned by Task A/);
  const oldStatus = value<{ task_id: string }>(await f.call("replacement", "workspace_context", {
    workspace_id: f.opened.workspace_id, action: "status", operation_id: operationId,
  }));
  assert.equal(oldStatus.task_id, f.started.task_id);
  const oldPoll = value<{ result: string }>(await f.call("replacement", "write_stdin", {
    workspace_id: f.opened.workspace_id, operation_id: operationId, cursor: 0, yield_time_ms: 0,
  }));
  assert.match(oldPoll.result, /output owned by Task A/);
  assert.equal(f.workerStore.findTask(newer.task_id), null, "history observation does not create the unrelated Task mirror");
  assert.equal(value<ResumeReply>(await f.call("replacement", "task_resume", { action: "inspect", task_id: newer.task_id }))
    .binding.selected_task_id, newer.task_id, "observing an old operation does not switch entry selection");
  await f.select("replacement", f.started.task_id, "return-to-original-work");
  value(await f.call("original", "open_workspace", { root_id: `${workerId}/main` }));
  assert.equal(f.store.currentTask(f.started.session_id)?.id, newer.task_id);
  assert.equal(f.workerStore.currentTask(f.started.session_id)?.id, newer.task_id);
  const patch = await f.call("replacement", "apply_patch", { workspace_id: f.opened.workspace_id,
    operation_key: "resumed-remote-write", patch: "*** Begin Patch\n*** Add File: resumed-task-a.txt\n+belongs to original Task\n*** End Patch" });
  await waitForRecordedTool(f.coordinator, { sessionId: f.started.session_id, workspaceId: f.opened.workspace_id,
    conversationId: "replacement" }, patch);
  assert.equal(await readFile(join(f.worker.project, "resumed-task-a.txt"), "utf8"), "belongs to original Task\n");
  const actual = f.workerDb.sqlite.prepare("SELECT task_id,session_id,member_id FROM qm_invocations WHERE tool_name='apply_patch' ORDER BY rowid DESC LIMIT 1")
    .get() as { task_id: string; session_id: string; member_id: string };
  assert.equal(actual.task_id, f.started.task_id);
  assert.equal(actual.session_id, f.started.session_id);
  assert.ok(f.store.taskMemberIds(f.started.task_id).includes(actual.member_id));
  assert.equal(f.workerStore.getSession(f.started.session_id).conversation_id, "original",
    "the new authenticated entry must not overwrite the canonical legacy storage identifier");
  assert.equal((f.workerDb.sqlite.prepare("SELECT COUNT(*) AS n FROM qm_tasks WHERE id=?").get(f.started.task_id) as { n: number }).n, 1);

  const copyArgs = {
    action: "start", request_key: "resume-copy", source_workspace_id: f.opened.workspace_id,
    destination_workspace_id: attached.workspace_id, source_path: "resumed-task-a.txt", destination_path: "copied-task-a.txt",
  };
  const copy = value<{ id: string; status: string }>(await f.call("replacement", "copy_artifact", copyArgs));
  assert.equal(typeof copy.id, "string");
  await waitForFixture(f.coordinator, { sessionId: f.started.session_id }, "Task-bound remote copy completes", async () =>
    value<{ status: string; error?: string }>(await f.call("replacement", "copy_artifact", { action: "observe", copy_id: copy.id })),
  result => {
    if (["failed", "cancelled"].includes(result.status)) assert.fail(JSON.stringify(result));
    return result.status === "completed";
  });
  assert.equal(await readFile(join(f.worker.project, "additional-root", "copied-task-a.txt"), "utf8"), "belongs to original Task\n");
  const copied = f.workerDb.sqlite.prepare("SELECT task_id,session_id FROM qm_invocations WHERE tool_name='copy_artifact' ORDER BY rowid DESC LIMIT 1")
    .get() as { task_id: string; session_id: string };
  assert.deepEqual(copied, { task_id: f.started.task_id, session_id: f.started.session_id });
  await f.select("original", f.started.task_id, "resume-copy-owner-task");
  assert.equal(value<{ id: string }>(await f.call("original", "copy_artifact", copyArgs)).id, copy.id,
    "a different external entry can replay the same Task's completed copy");
  await f.select("original", newer.task_id, "return-to-new-goal");
  const foreignRetry = await f.call("original", "copy_artifact", copyArgs);
  assert.equal(foreignRetry.isError, true, JSON.stringify(foreignRetry));
  assert.match(JSON.stringify(foreignRetry), /COPY_REQUEST_KEY_REUSED|OPERATION_RETRY_SCOPE_MISMATCH/);
  assert.equal(await readFile(join(f.worker.project, "additional-root", "copied-task-a.txt"), "utf8"), "belongs to original Task\n");
});

test("real peer wire: delayed and conflicting open results preserve accepted Task identity and use the Coordinator's live entry state", { timeout: 60_000 }, async t => {
  const f = await fixture(t), transport = f.worker.running.federation!.transport;
  const originalHandler = transport.handler;
  let mode: "hold" | "conflict" | "missing" | undefined = "hold";
  let workerFinished = false, release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const controlled: typeof transport.handler = async (method, params, peer, context) => {
    const result = await originalHandler(method, params, peer, context);
    if (method !== "tool" || params.name !== "open_workspace") return result;
    if (mode === "hold") { workerFinished = true; await released; }
    const reply = result as Record<string, unknown>;
    if (mode === "conflict") return { ...reply, structuredContent: { ...(reply.structuredContent as Record<string, unknown>),
      task_id: "wrong-task-from-worker", session_id: "wrong-session-from-worker" } };
    if (mode === "missing") { const { structuredContent: _omitted, ...rest } = reply; return rest; }
    return result;
  };
  Reflect.set(transport, "handler", controlled);
  t.after(() => { release(); Reflect.set(transport, "handler", originalHandler); });
  const pending = f.call("replacement", "open_workspace", { root_id: `${workerId}/main`,
    subdirectory: "delayed-open-a", create_directory: true });
  void pending.catch(() => {});
  try {
    await waitForFixture(f.coordinator, { sessionId: f.started.session_id }, "Worker completes the captured Task A open", async () => workerFinished, Boolean);
    assert.ok(f.store.taskData.activeWork(f.started.task_id) > 0, "the authority retains the captured Task's lease until remote identity is validated");
    const selection = value<ResumeReply>(await f.call("replacement", "task_resume", { action: "inspect", task_id: f.started.task_id }));
    const next = value<TaskReply>(await f.call("replacement", "start_session", { title: "Goal selected while A opens", request_key: "during-open",
      new_goal: true, expected_binding_revision: selection.binding.binding_revision }));
    release();
    const delayed = await pending;
    assert.equal(value<OpenReply>(delayed).task_id, f.started.task_id);
    assert.equal(binding(delayed).selected_task_id, next.task_id);
    assert.equal(binding(delayed).can_continue, false);
    const metadata = delayed._meta as { quaymesh: { capabilities: { continue: boolean }; snapshot: { capabilities: { continue: boolean } } } };
    assert.equal(metadata.quaymesh.capabilities.continue, false);
    assert.equal(metadata.quaymesh.snapshot.capabilities.continue, false);
    assert.ok(existsSync(join(f.worker.project, "delayed-open-a")));
    assert.ok(!f.store.taskMemberIds(next.task_id).length, "a completed open never migrates to the later selected Task");
    await f.select("replacement", f.started.task_id, "return-after-delayed-open");
    const membersBeforeConflict = f.store.taskMemberIds(f.started.task_id);
    for (const response of ["conflict", "missing"] as const) {
      mode = response;
      const directory = `created-before-${response}-reply`;
      const conflict = await f.call("replacement", "open_workspace", { root_id: `${workerId}/main`, subdirectory: directory, create_directory: true });
      assert.equal(conflict.isError, true, JSON.stringify(conflict));
      assert.match(JSON.stringify(conflict), /TASK_REMOTE_SCOPE_MISMATCH/);
      assert.equal(structured(conflict).effect, "unknown", "the remote directory already exists, so the result cannot claim not_started");
      assert.equal(structured(conflict).retry_hint, "query_original");
      assert.ok(existsSync(join(f.worker.project, directory)));
      assert.deepEqual(f.store.taskMemberIds(f.started.task_id), membersBeforeConflict, "identity checks precede local mirror adoption");
    }
    assert.equal(f.store.findTask("wrong-task-from-worker"), null);
    assert.equal((f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM qm_sessions WHERE id='wrong-session-from-worker'").get() as { n: number }).n, 0);
  } finally { release(); await pending.catch(() => {}); }
});

test("real peer wire: malformed binding envelopes are rejected before effects; an explicit null canonical correlation remains valid", { timeout: 60_000 }, async t => {
  const f = await fixture(t), transport = f.worker.running.federation!.transport;
  const originalHandler = transport.handler;
  let alter: ((envelope: Record<string, unknown>) => Record<string, unknown>) | undefined;
  const controlled: typeof transport.handler = async (method, params, peer, context) => {
    if (method === "tool" && params.name === "open_workspace" && alter) {
      params = { ...params, extra: { ...params.extra, trustedInvocation: alter({ ...params.extra.trustedInvocation }) } };
    }
    return originalHandler(method, params, peer, context);
  };
  Reflect.set(transport, "handler", controlled);
  t.after(() => { Reflect.set(transport, "handler", originalHandler); });
  const cases: Array<{ name: string; code: string; alter: NonNullable<typeof alter> }> = [
    { name: "missing-canonical", code: "TASK_BINDING_SCOPE_REQUIRED", alter: envelope => {
      const { canonical_conversation_id: _omitted, ...rest } = envelope; return rest;
    } },
    { name: "missing-task", code: "TASK_BINDING_SCOPE_REQUIRED", alter: envelope => {
      const { task_id: _omitted, ...rest } = envelope; return rest;
    } },
    { name: "unknown-version", code: "TASK_BINDING_VERSION_UNSUPPORTED", alter: envelope => ({ ...envelope, task_binding_version: 2 }) },
    { name: "wrong-canonical-session", code: "TASK_SESSION_MISMATCH", alter: envelope => ({ ...envelope, session_id: "another-canonical-session" }) },
  ];
  for (const item of cases) {
    alter = item.alter;
    const result = await f.call("replacement", "open_workspace", { root_id: `${workerId}/main`, subdirectory: item.name, create_directory: true });
    assert.equal(result.isError, true, JSON.stringify(result));
    assert.match(JSON.stringify(result), new RegExp(item.code));
    assert.equal(structured(result).effect, "not_started");
    assert.ok(!existsSync(join(f.worker.project, item.name)));
  }
  assert.equal((f.workerDb.sqlite.prepare("SELECT COUNT(*) AS n FROM qm_sessions WHERE id='another-canonical-session'").get() as { n: number }).n, 0);
  alter = undefined;
  const noCorrelation = value<TaskReply>(await f.coordinator.client.callTool({ name: "start_session",
    arguments: { title: "Legacy Task without host correlation", request_key: "no-host-correlation" } }));
  assert.equal(f.store.getSession(noCorrelation.session_id).conversation_id, null);
  await f.select("replacement", noCorrelation.task_id, "resume-legacy-null-correlation");
  const valid = await f.call("replacement", "open_workspace", { root_id: `${workerId}/main`, subdirectory: "valid-null-correlation", create_directory: true });
  assert.equal(value<OpenReply>(valid).task_id, noCorrelation.task_id);
  assert.equal(binding(valid).can_continue, true);
  assert.equal(f.workerStore.getSession(noCorrelation.session_id).conversation_id, null);
});

test("real peer wire: cached node metadata never sends resumed mutations or copies to an unsupported replacement connection", { timeout: 60_000 }, async t => {
  const f = await fixture(t), runtime = f.coordinator.running.federation!;
  const oldLink = runtime.transport.links.get(workerId)!;
  const previous = runtime.nodes().find(node => node.id === workerId)!;
  // Simulate a peer reconnecting on an older protocol while a directory still
  // contains its previous release metadata. This is a real authenticated PeerTransport,
  // not a fake successful tool response or a weakened output validator.
  const staleManifest = { ...previous, updatedAt: Date.now() };
  f.workerDb.close();
  await f.worker.dispose();
  const methods: string[] = [];
  const oldPeerPort = await freePort();
  const oldStateDir = await mkdtemp(join(tmpdir(), "qm-legacy-binding-peer-"));
  const oldTransfers = new TransferStore(oldStateDir, workerId);
  const oldPeer = new PeerTransport({ ...f.worker.config.federation, port: oldPeerPort,
    peers: [{ id: coordinatorId, url: `http://127.0.0.1:${f.coordinatorPort}` }] }, token,
  async (method, params) => {
    methods.push(method);
    if (method === "hello") return { manifest: staleManifest };
    if (method === "manifest") return null;
    // Published legacy peers already expose this read-only, scope-checked lookup.
    if (method === "artifact.lookup") return oldTransfers.lookup(params);
    throw Object.assign(new Error("unsupported protocol method"), { code: "METHOD_NOT_FOUND" });
  }, () => {});
  t.after(async () => {
    await oldPeer.close();
    oldTransfers.close();
    await rm(oldStateDir, { recursive: true, force: true });
  });
  await oldPeer.start();
  await waitForFixture(f.coordinator, { sessionId: f.started.session_id }, "older protocol reconnects", async () => {
    const current = runtime.transport.links.get(workerId);
    return Boolean(current?.connected && current !== oldLink);
  }, Boolean);
  for (const [name, args] of [
    ["apply_patch", { workspace_id: f.opened.workspace_id, operation_key: "must-not-send",
      patch: "*** Begin Patch\n*** Add File: must-not-exist.txt\n+unsafe if sent\n*** End Patch" }],
    ["copy_artifact", { action: "start", request_key: "must-not-copy", source_workspace_id: f.opened.workspace_id,
      destination_workspace_id: f.opened.workspace_id, source_path: "README.md", destination_path: "must-not-copy.txt" }],
  ] as const) {
    const reply = await f.call("replacement", name, args);
    assert.equal(reply.isError, true, JSON.stringify(reply));
    assert.match(JSON.stringify(reply), /TASK_BINDING_PEER_UPGRADE_REQUIRED/);
    assert.equal(structured(reply).effect, "not_started");
  }
  assert.ok(methods.includes("session.binding-capabilities"));
  assert.ok(methods.includes("artifact.lookup"), "existing receipts are checked before admitting a new copy");
  assert.ok(!methods.includes("tool"));
  assert.ok(!methods.includes("artifact.copy"));
  assert.deepEqual(oldTransfers.list(), [], "read-only lookup must not reserve a new transfer");
});

test("real peer wire: busy and timed-out capability probes retain original receipts while the same operation key executes once after recovery", { timeout: 60_000 }, async t => {
  const f = await fixture(t), transport = f.worker.running.federation!.transport;
  const originalHandler = transport.handler;
  let probes = 0, executedWrites = 0;
  // Fault injection is limited to the read-only capability RPC. The successful
  // mutation still runs through the real Worker recorder, filesystem and SDK.
  const withFaults: typeof transport.handler = async (method, params, peer, context) => {
    if (method === "session.binding-capabilities") {
      probes++;
      if (probes === 1) throw Object.assign(new Error("test peer queue full"), {
        code: "PEER_BUSY", effect: "not_started", retryHint: "retry_later",
      });
      if (probes === 2) await delay(2250);
    }
    if (method === "tool" && params.name === "apply_patch") executedWrites++;
    return originalHandler(method, params, peer, context);
  };
  Reflect.set(transport, "handler", withFaults);
  t.after(() => { Reflect.set(transport, "handler", originalHandler); });
  const args = { workspace_id: f.opened.workspace_id, operation_key: "same-intended-write",
    patch: "*** Begin Patch\n*** Add File: recovered-capability.txt\n+written once after admission\n*** End Patch" };
  const receipts = () => f.db.sqlite.prepare(`SELECT id,request_id,operation_id,state,effect,result_json FROM qm_invocations
    WHERE task_id=? AND tool_name='apply_patch' AND json_extract(arguments_json,'$.operation_key')=? ORDER BY rowid`)
    .all(f.started.task_id, args.operation_key) as Array<{ id: string; request_id: string; operation_id: string;
      state: string; effect: string; result_json: string }>;
  const failed: ReturnType<typeof receipts> = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    await f.call("replacement", "apply_patch", args);
    const rows = await waitForFixture(f.coordinator, { sessionId: f.started.session_id }, `probe attempt ${attempt} records no dispatched work`,
      async () => receipts(), rows => rows.length === attempt && rows.at(-1)?.state === "failed");
    const latest = rows.at(-1)!;
    assert.equal(latest.effect, "not_started");
    assert.match(latest.result_json, /NODE_UNAVAILABLE/);
    assert.match(latest.result_json, /retry_later/);
    assert.match(latest.result_json, /task_binding_negotiation/);
    assert.ok(!latest.result_json.includes("TASK_BINDING_PEER_UPGRADE_REQUIRED"), "busy and timeout do not imply an unsupported version");
    failed.push(latest);
    assert.equal(executedWrites, 0);
  }
  const accepted = await f.call("replacement", "apply_patch", args);
  await waitForRecordedTool(f.coordinator, { sessionId: f.started.session_id, workspaceId: f.opened.workspace_id,
    conversationId: "replacement" }, accepted);
  assert.equal(await readFile(join(f.worker.project, "recovered-capability.txt"), "utf8"), "written once after admission\n");
  assert.equal(executedWrites, 1);
  assert.equal(probes, 3);
  const rows = receipts();
  assert.equal(rows.length, 3);
  assert.equal(rows[2].state, "succeeded");
  assert.equal(new Set(rows.map(row => row.operation_id)).size, 1);
  assert.deepEqual(rows.slice(0, 2), failed, "new attempts never rewrite the earlier request receipts");
  value(await f.call("replacement", "apply_patch", args));
  assert.equal(executedWrites, 1, "completed-key replay must not dispatch another mutation");
});
