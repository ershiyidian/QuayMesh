import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage, MessageExtraInfo } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "../config.js";
import { ConsoleOperations } from "../federation/console-dispatch.js";
import { workspaceHandle } from "../federation/routing.js";
import { git } from "../git.js";
import { LocalAgentStore } from "../local-agent-store.js";
import { createSessionRuntime } from "../session/runtime.js";
import { readRunCheckpoint } from "../session/run-checkpoints.js";
import { writeTestQuayMeshConfig } from "../test-support/config.test.js";
import { WorkLedger } from "../work-ledger.js";
import { SqliteWorkspaceStore } from "../workspace-store.js";
import { WorkspaceRegistry } from "../workspaces.js";
import type { readRunDetail } from "./detail.js";
import { mountConsoleWorkbench } from "./router.js";
import { taskReference } from "./task-aggregation.js";
// @ts-expect-error Shared Node test fixtures are maintained as ESM scripts.
import { freePort } from "../../node/test/helpers.mjs";

type Detail = Awaited<ReturnType<typeof readRunDetail>>;
type AppPatchPage = { patch: string; cursor: string | null; done: boolean };

// Use the real SDK transport and tool registration, with the fixture's known
// owner supplied at the same transport boundary as an authenticated request.
class OwnerTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;
  constructor(private readonly inner: InMemoryTransport) {
    inner.onclose = () => this.onclose?.();
    inner.onerror = error => this.onerror?.(error);
    inner.onmessage = (message, extra) => this.onmessage?.(message, extra);
  }
  get sessionId(): string | undefined { return this.inner.sessionId; }
  set sessionId(value: string | undefined) { this.inner.sessionId = value; }
  start(): Promise<void> { return this.inner.start(); }
  close(): Promise<void> { return this.inner.close(); }
  send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    return this.inner.send(message, { ...options, authInfo: {
      token: "capture-test-token", clientId: "capture-test-client", scopes: ["mcp"], extra: { owner_id: "owner" },
    } });
  }
}

function appPatchPage(result: Awaited<ReturnType<Client["callTool"]>>): AppPatchPage {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  const page = result.structuredContent as AppPatchPage | undefined;
  assert.ok(page && typeof page.patch === "string" && typeof page.done === "boolean");
  assert.equal(page.cursor === null, page.done);
  return page;
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "qm-capture-observation-"));
  const root = join(directory, "project"), stateDir = join(directory, "state");
  await mkdir(root);
  await writeFile(join(root, "tracked.txt"), "base\n");
  for (const args of [["init"], ["config", "user.email", "test@example.invalid"],
    ["config", "user.name", "Capture observation"], ["add", "."], ["commit", "-m", "baseline"]]) await git(root, args);
  const config = loadConfig(writeTestQuayMeshConfig(join(directory, "config"), {
    storage: { stateDir }, workspaces: { allowedRoots: [root], worktreeRoot: join(directory, "worktrees") },
    subagents: { enabled: false, instructions: "on-demand", providers: [] },
    logging: { level: "silent", requests: false, assets: false, toolCalls: false },
  }));
  if (config.federation) config.federation.nodeId = "local";
  const ledger = new WorkLedger(stateDir), agents = new LocalAgentStore(stateDir);
  const workspaceStore = new SqliteWorkspaceStore(stateDir), workspaces = new WorkspaceRegistry(config, workspaceStore);
  const runtime = createSessionRuntime({ config, workspaces, ledger, agents });
  const { store, changes } = runtime;
  const closeClients: Array<() => Promise<void>> = [];
  const cardClient = async () => {
    const server = new McpServer({ name: "capture-app-test", version: "1" });
    const client = new Client({ name: "capture-app-client", version: "1" });
    runtime.registerAppTools(server);
    closeClients.push(async () => { await client.close(); await server.close(); });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(new OwnerTransport(clientTransport))]);
    await client.listTools();
    return client;
  };
  const session = store.createSession("owner", "capture-observation", "Capture observation");
  const member = store.addMember(session.id, "local", "workspace", root, "checkout", null);
  const task = store.createTask(session.id, "Capture task");
  store.touchTaskMember(task.id, member.id);
  const newRun = () => runtime.service.ensureRun(session, member, { kind: "patch", label: "Capture phase" }, task.id);
  const runId = await newRun();
  const app = express(), router = express.Router();
  app.use(express.json());
  mountConsoleWorkbench(router, new ConsoleOperations(router), config, undefined, runtime);
  app.use(router);
  const server = app.listen(await freePort(), "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}/api/v4/runs/`;
  const releases = new Set<() => void>();
  const blockPublication = () => {
    let reached!: () => void, resume!: () => void, fail!: (error: Error) => void;
    const entered = new Promise<void>(resolve => { reached = resolve; });
    const held = new Promise<void>((resolve, reject) => { resume = resolve; fail = reject; });
    const release = (error?: Error) => { if (error) fail(error); else resume(); releases.delete(release); };
    releases.add(release);
    // The real capture still reads Git, persists files and publishes its event.
    // Hold only its existing completion listener to observe a deterministic
    // in-flight boundary; no capture results or database rows are fabricated.
    changes.setCaptureListener(async (sessionId, memberId, taskId) => {
      reached(); await held;
      runtime.service.refreshMember(sessionId, memberId, taskId);
    });
    return { entered, release };
  };
  const reference = (id: string) => workspaceHandle("local", id);
  const detail = async (id: string): Promise<Detail> => {
    const response = await fetch(baseUrl + encodeURIComponent(id));
    assert.equal(response.status, 200, await response.clone().text());
    return response.json() as Promise<Detail>;
  };
  const patch = async (id: string, status = 200) => {
    const response = await fetch(baseUrl + encodeURIComponent(id) + "/patch");
    assert.equal(response.status, status, await response.clone().text());
    return response.json() as Promise<{ patch?: string; code?: string; effect?: string }>;
  };
  const write = async (content: string) => {
    const evidence = await changes.prepareWrite(member, ["tracked.txt"], root, task.id);
    await writeFile(join(root, "tracked.txt"), content);
    const recording = changes.recordWrite(member, evidence, task.id);
    assert.equal(changes.captureObservation(member.id, task.id).state, "pending", "ownership metadata is observed while writing");
    await recording;
  };
  t.after(async () => {
    for (const release of releases) release();
    for (const close of closeClients) await close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await runtime.close(); agents.close(); ledger.close(); workspaceStore.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { root, ledger, runtime, store, changes, session, member, task, runId, newRun, reference, detail, patch, write, blockPublication, cardClient };
}

test("live detail observes metadata and queued/direct capture without waiting, and patch rejects until capture settles", { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  assert.deepEqual(f.changes.captureObservation(f.member.id, f.task.id), { state: "idle", error: null });
  const baseline = f.changes.ensureBaseline(f.member, ["tracked.txt"], f.root, f.task.id);
  assert.equal(f.changes.captureObservation(f.member.id, f.task.id).state, "pending");
  await baseline;
  assert.equal(f.changes.captureObservation(f.member.id, f.task.id).state, "idle");
  assert.deepEqual(f.store.fileSummaries(f.session.id, f.member.id, f.task.id), []);
  await f.write("base\nfirst change\n");
  let publication = f.blockPublication();
  f.changes.markDirty(f.member.id, ["tracked.txt"], f.task.id);
  assert.equal(f.changes.captureObservation(f.member.id, f.task.id).state, "pending");
  await publication.entered;
  let flushed = false;
  const flush = f.changes.flushTask(f.member.id, f.task.id).then(() => { flushed = true; });
  const raw = await f.detail(f.reference(f.runId));
  assert.equal(flushed, false);
  assert.deepEqual(raw.files.map(file => file.path), ["tracked.txt"]);
  assert.deepEqual(raw.changeCaptures.map(capture => [capture.runId, capture.state]), [[f.reference(f.runId), "pending"]]);
  assert.match(raw.warnings.join("\n"), /文件改动正在整理/);
  assert.equal(raw.run.actions.patch, false);
  assert.equal(raw.run.actions.review, false);
  assert.equal(raw.run.actions.revert, false);
  assert.deepEqual(await f.patch(f.reference(f.runId), 409), {
    code: "change_capture_pending", message: "文件改动仍在整理，请稍后刷新再导出补丁", effect: "none",
  });
  const aggregated = await f.detail(taskReference(f.task.id));
  assert.deepEqual(aggregated.changeCaptures.map(capture => [capture.runId, capture.state]), [[f.reference(f.runId), "pending"]]);
  publication.release(); await flush;
  assert.equal(f.changes.captureObservation(f.member.id, f.task.id).state, "idle");
  assert.match((await f.patch(f.reference(f.runId))).patch!, /\+first change/);

  await f.write("base\nsecond change\n");
  publication = f.blockPublication();
  const direct = f.changes.capture(f.member.id, f.task.id, ["tracked.txt"]);
  assert.equal(f.changes.captureObservation(f.member.id, f.task.id).state, "pending", "direct captures use the same scope observation");
  await publication.entered;
  flushed = false;
  const directFlush = f.changes.flushTask(f.member.id, f.task.id).then(() => { flushed = true; });
  const duringDirect = await f.detail(f.reference(f.runId));
  assert.equal(duringDirect.changeCaptures[0]?.state, "pending");
  assert.equal(flushed, false, "flushTask also waits for a directly invoked capture");
  publication.release(); await Promise.all([direct, directFlush]);
  assert.deepEqual(f.changes.captureObservation(f.member.id, f.task.id), { state: "idle", error: null });
  assert.match((await f.patch(f.reference(f.runId))).patch!, /\+second change/);
});

test("a real Git capture failure is visible and blocks live patch export until a successful recapture", { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  await f.write("base\nkept on disk\n");
  const baseline = f.store.getChangeBaseline(f.session.id, f.member.id, f.root, f.task.id)!;
  f.store.putChangeBaseline({ ...baseline, latest_ref: "missing-capture-commit" }, f.task.id);
  await assert.rejects(f.changes.capture(f.member.id, f.task.id, ["tracked.txt"]));
  const observed = f.changes.captureObservation(f.member.id, f.task.id);
  assert.equal(observed.state, "failed");
  assert.match(observed.error!, /missing-capture-commit/);
  await assert.rejects(f.changes.flushTask(f.member.id, f.task.id));
  const raw = await f.detail(f.reference(f.runId));
  assert.deepEqual(raw.changeCaptures.map(capture => capture.state), ["failed"]);
  assert.match(raw.warnings.join("\n"), /文件改动整理失败/);
  assert.equal(raw.run.actions.patch, false);
  assert.equal(raw.run.actions.review, false);
  assert.equal((await f.patch(f.reference(f.runId), 409)).code, "change_capture_failed");
  assert.equal(await readFile(join(f.root, "tracked.txt"), "utf8"), "base\nkept on disk\n");
  f.store.putChangeBaseline(baseline, f.task.id);
  f.changes.markDirty(f.member.id, ["tracked.txt"], f.task.id);
  await f.changes.flushTask(f.member.id, f.task.id);
  assert.deepEqual(f.changes.captureObservation(f.member.id, f.task.id), { state: "idle", error: null });
  assert.match((await f.patch(f.reference(f.runId))).patch!, /\+kept on disk/);
});

test("an older queued capture success cannot clear a newer direct capture failure", { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  await f.write("base\nolder capture\n");
  const publication = f.blockPublication();
  f.changes.markDirty(f.member.id, ["tracked.txt"], f.task.id);
  await publication.entered;
  const baseline = f.store.getChangeBaseline(f.session.id, f.member.id, f.root, f.task.id)!;
  f.store.putChangeBaseline({ ...baseline, latest_ref: "newer-missing-capture-commit" }, f.task.id);
  await assert.rejects(f.changes.capture(f.member.id, f.task.id, ["tracked.txt"]), /newer-missing-capture-commit/);
  const pending = f.changes.captureObservation(f.member.id, f.task.id);
  assert.equal(pending.state, "pending", "the older publication is still observed in flight");
  assert.match(pending.error!, /newer-missing-capture-commit/);
  f.store.putChangeBaseline(baseline, f.task.id);
  publication.release();
  await assert.rejects(f.changes.flushTask(f.member.id, f.task.id), /newer-missing-capture-commit/);
  const failed = f.changes.captureObservation(f.member.id, f.task.id);
  assert.equal(failed.state, "failed", "neither the older capture nor its queue clears the newer failure");
  assert.match(failed.error!, /newer-missing-capture-commit/);
  assert.equal((await f.patch(f.reference(f.runId), 409)).code, "change_capture_failed");
  await f.changes.capture(f.member.id, f.task.id, ["tracked.txt"]);
  await f.changes.flushTask(f.member.id, f.task.id);
  assert.deepEqual(f.changes.captureObservation(f.member.id, f.task.id), { state: "idle", error: null });
});

test("an older queued publication failure cannot overwrite a newer successful direct capture", { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  await f.write("base\nolder capture\n");
  const publication = f.blockPublication();
  f.changes.markDirty(f.member.id, ["tracked.txt"], f.task.id);
  await publication.entered;
  // The old caller still receives its own failure even if a newer capture
  // has already recovered the scope's current observation.
  const olderFailure = assert.rejects(f.changes.flushTask(f.member.id, f.task.id), /older publication failed/);
  f.changes.setCaptureListener((sessionId, memberId, taskId) => f.runtime.service.refreshMember(sessionId, memberId, taskId));
  await f.write("base\nnewer successful capture\n");
  await f.changes.capture(f.member.id, f.task.id, ["tracked.txt"]);
  assert.deepEqual(f.changes.captureObservation(f.member.id, f.task.id), { state: "pending", error: null });
  publication.release(new Error("older publication failed"));
  await olderFailure;
  await f.changes.flushTask(f.member.id, f.task.id);
  assert.deepEqual(f.changes.captureObservation(f.member.id, f.task.id), { state: "idle", error: null });
  assert.match((await f.patch(f.reference(f.runId))).patch!, /\+newer successful capture/);
});

test("frozen phase files and patch stay independent while only the current phase exposes capture state", { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  await f.write("base\nreviewed phase\n");
  f.changes.markDirty(f.member.id, ["tracked.txt"], f.task.id);
  await f.changes.flushTask(f.member.id, f.task.id);
  f.ledger.finish(f.runId, { status: "completed", acceptance: "not_applicable", summary: "phase A", evidence: [] });
  await f.runtime.service.checkpointRun(f.runId, f.session.id, f.member.id, f.task.id);
  const checkpoint = readRunCheckpoint(f.ledger.db, f.runId)!;
  const before = await f.detail(f.reference(f.runId));
  const savedPatch = await f.patch(f.reference(f.runId));
  const warmed = await f.detail(taskReference(f.task.id));
  assert.deepEqual(warmed.run.currentPhaseRefs, [f.reference(f.runId)], "warm the Task feed while only phase A exists");
  const nextRun = await f.newRun();
  assert.notEqual(nextRun, f.runId);
  await f.write("base\ncontinued phase\n");
  const publication = f.blockPublication();
  f.changes.markDirty(f.member.id, ["tracked.txt"], f.task.id);
  await publication.entered;
  const history = await f.detail(f.reference(f.runId));
  assert.deepEqual(history.changeCaptures, []);
  assert.deepEqual(history.files.map(({ revertible: _currentEligibility, ...file }) => file),
    before.files.map(({ revertible: _currentEligibility, ...file }) => file));
  assert.deepEqual(await f.patch(f.reference(f.runId)), savedPatch);
  assert.deepEqual(readRunCheckpoint(f.ledger.db, f.runId), checkpoint);
  assert.equal((await f.patch(f.reference(nextRun), 409)).code, "change_capture_pending");
  assert.equal((await f.patch(taskReference(f.task.id), 409)).code, "change_capture_pending",
    "Task export must refresh its phase list instead of returning cached phase A's frozen patch");
  const task = await f.detail(taskReference(f.task.id));
  assert.equal(task.phases.length, 2);
  assert.deepEqual(task.changeCaptures.map(capture => [capture.runId, capture.state]), [[f.reference(nextRun), "pending"]]);
  const other = f.store.createTask(f.session.id, "Another task");
  f.store.touchTaskMember(other.id, f.member.id);
  assert.deepEqual(f.changes.captureObservation(f.member.id, other.id), { state: "idle", error: null }, "Task scope does not inherit another task's in-flight capture");
  publication.release(); await f.changes.flushTask(f.member.id, f.task.id);
  assert.deepEqual(await f.patch(f.reference(f.runId)), savedPatch);
});

test("the registered qm_patch MCP tool rejects pending and failed live capture and recovers after real recapture", { timeout: 60_000 }, async t => {
  const f = await fixture(t), client = await f.cardClient();
  const args = { session_id: f.session.id, task_id: f.task.id, member_id: f.member.id };
  const call = () => client.callTool({ name: "qm_patch", arguments: args });
  await f.write("base\nMCP captured change\n");
  const publication = f.blockPublication();
  f.changes.markDirty(f.member.id, ["tracked.txt"], f.task.id);
  await publication.entered;
  const pending = await call();
  assert.equal(pending.isError, true);
  assert.match(JSON.stringify(pending.content), /FILE_CAPTURE_PENDING/);
  publication.release(); await f.changes.flushTask(f.member.id, f.task.id);
  assert.match(appPatchPage(await call()).patch, /\+MCP captured change/);

  const baseline = f.store.getChangeBaseline(f.session.id, f.member.id, f.root, f.task.id)!;
  f.store.putChangeBaseline({ ...baseline, latest_ref: "missing-mcp-capture-commit" }, f.task.id);
  await assert.rejects(f.changes.capture(f.member.id, f.task.id, ["tracked.txt"]), /missing-mcp-capture-commit/);
  const failed = await call();
  assert.equal(failed.isError, true);
  assert.match(JSON.stringify(failed.content), /FILE_CAPTURE_FAILED.*missing-mcp-capture-commit/);
  f.store.putChangeBaseline(baseline, f.task.id);
  await f.changes.capture(f.member.id, f.task.id, ["tracked.txt"]);
  await f.changes.flushTask(f.member.id, f.task.id);
  assert.deepEqual(f.changes.captureObservation(f.member.id, f.task.id), { state: "idle", error: null });
  assert.match(appPatchPage(await call()).patch, /\+MCP captured change/);
});

test("qm_patch cursors bind live revisions and frozen Task identity across real Unicode patch pages", { timeout: 90_000 }, async t => {
  const f = await fixture(t), client = await f.cardClient();
  const args = { session_id: f.session.id, task_id: f.task.id, member_id: f.member.id };
  const call = (cursor?: string, taskId = f.task.id) => client.callTool({ name: "qm_patch",
    arguments: { ...args, task_id: taskId, ...(cursor === undefined ? {} : { cursor }) } });
  const collect = async (first: AppPatchPage) => {
    let page = first, combined = page.patch, count = 1;
    while (page.cursor !== null) {
      assert.ok(count < 20, "bounded patch pages must make progress");
      assert.match(page.cursor, /^qmpatch:/);
      page = appPatchPage(await call(page.cursor));
      combined += page.patch; count++;
    }
    assert.ok(count > 1, "the fixture must exercise pagination");
    return combined;
  };
  const contents = "base\n" + Array.from({ length: 900 }, (_, index) => `line-${index}: 中文😀 bounded patch evidence ${index}\n`).join("");
  await f.write(contents);
  f.changes.markDirty(f.member.id, ["tracked.txt"], f.task.id);
  await f.changes.flushTask(f.member.id, f.task.id);
  const saved = f.store.fileSummaries(f.session.id, f.member.id, f.task.id)[0]!;
  const expected = `# ${saved.path}\n${await readFile(saved.patchRef, "utf8")}`;
  assert.ok(Buffer.byteLength(expected) > 32 * 1024);
  const first = appPatchPage(await call());
  assert.equal(first.done, false);
  assert.deepEqual(await collect(first), expected, "all Unicode pages reproduce the saved patch exactly");

  await f.write(contents + "new revision after page one\n");
  f.changes.markDirty(f.member.id, ["tracked.txt"], f.task.id);
  await f.changes.flushTask(f.member.id, f.task.id);
  assert.equal(f.changes.captureObservation(f.member.id, f.task.id).state, "idle");
  const changed = await call(first.cursor!);
  assert.equal(changed.isError, true);
  assert.match(JSON.stringify(changed.content), /PATCH_REVISION_CHANGED/);
  const malformed = await call("12");
  assert.equal(malformed.isError, true);
  assert.match(JSON.stringify(malformed.content), /PATCH_CURSOR_INVALID/);

  const live = appPatchPage(await call());
  await f.runtime.service.finishTask("owner", f.task.id, "completed", "Frozen patch evidence");
  const switched = await call(live.cursor!);
  assert.equal(switched.isError, true);
  assert.match(JSON.stringify(switched.content), /PATCH_REVISION_CHANGED/, "live-to-frozen pagination must restart");
  const frozen = appPatchPage(await call());
  const snapshot = f.store.getTaskSnapshot(f.task.id, f.member.id)!;
  const frozenExpected = (await Promise.all(snapshot.files.map(async file => `# ${file.path}\n${await readFile(file.patchRef, "utf8")}`))).join("\n");

  const next = f.store.createTask(f.session.id, "New live task");
  f.store.touchTaskMember(next.id, f.member.id);
  const retargeted = await call(frozen.cursor!, next.id);
  assert.equal(retargeted.isError, true);
  assert.match(JSON.stringify(retargeted.content), /PATCH_REVISION_CHANGED/);
  const evidence = await f.changes.prepareWrite(f.member, ["tracked.txt"], f.root, next.id);
  await writeFile(join(f.root, "tracked.txt"), contents + "unfrozen next task\n");
  await f.changes.recordWrite(f.member, evidence, next.id);
  const publication = f.blockPublication();
  f.changes.markDirty(f.member.id, ["tracked.txt"], next.id);
  await publication.entered;
  const nextPending = await call(undefined, next.id);
  assert.equal(nextPending.isError, true);
  assert.match(JSON.stringify(nextPending.content), /FILE_CAPTURE_PENDING/);
  assert.deepEqual(await collect(frozen), frozenExpected,
    "frozen pages keep their saved revision while another Task changes the same member");
  publication.release(); await f.changes.flushTask(f.member.id, next.id);
});
