import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import test, { type TestContext } from "node:test";
import { openDatabase } from "../../src/db/client.js";
import { SessionStore } from "../../src/session/store.js";
import { canonicalWorkspaceRoot } from "../../src/roots.js";
import type { TaskBindingState, TaskBindingView } from "../../src/tasks/task-binding.js";
import { createRealTestServer, structured, waitForFixture,
  type RealTestServer, type RealTestServerOptions } from "./server-fixture.js";

type ToolResult = Awaited<ReturnType<RealTestServer["client"]["callTool"]>>;
interface TaskReply { task_id: string; session_id: string }
interface OpenReply extends TaskReply { workspace_id: string }
interface ResumeReply extends TaskReply { binding: TaskBindingView; replayed?: boolean;
  workspaces: Array<{ member_id: string; workspace_id: string; node_id: string }> }

function value<T>(result: ToolResult): T {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return structured(result) as unknown as T;
}
async function rejected(result: Promise<ToolResult>, code: RegExp): Promise<void> {
  let reply: ToolResult;
  try { reply = await result; } catch (error) { assert.match(String(error), code); return; }
  assert.equal(reply.isError, true, JSON.stringify(reply));
  assert.match(JSON.stringify(reply), code);
}
function binding(result: ToolResult): TaskBindingState {
  const meta = result._meta as { quaymesh?: { task_binding?: TaskBindingState } } | undefined;
  assert.ok(meta?.quaymesh?.task_binding, "the private binding sideband must accompany unchanged replies too");
  return meta.quaymesh.task_binding;
}
async function fixture(t: TestContext, options: RealTestServerOptions = {}) {
  const server = await createRealTestServer({ prefix: "qm-task-resume-", git: false, ...options });
  const database = openDatabase(server.config.stateDir), store = new SessionStore(database.sqlite);
  t.after(async () => { database.close(); await server.dispose(); });
  const call = (entry: string | null, name: string, args: Record<string, unknown>) => server.client.callTool({
    name, arguments: args, ...(entry ? { _meta: { "openai/session": entry } } : {}),
  });
  const start = async (entry: string, title: string, key: string,
    intent?: { new_goal: true; expected_binding_revision: number }) =>
    value<TaskReply>(await call(entry, "start_session", { title, request_key: key, ...intent }));
  const inspect = async (entry: string, taskId: string) => value<ResumeReply>(await call(entry, "task_resume", { action: "inspect", task_id: taskId }));
  const resume = async (entry: string, taskId: string, requestKey: string) => {
    const state = await inspect(entry, taskId);
    return value<ResumeReply>(await call(entry, "task_resume", { action: "resume", task_id: taskId,
      expected_binding_revision: state.binding.binding_revision, request_key: requestKey }));
  };
  return { server, database, store, call, start, inspect, resume };
}

test("real MCP: two entries keep one Task through resume, workspace attachment and interleaved command completion", { timeout: 60_000 }, async t => {
  const f = await fixture(t), firstEntry = "original-conversation", nextEntry = "replacement-conversation";
  const first = await f.start(firstEntry, "Goal A", "goal-a");
  const opened = value<OpenReply>(await f.call(firstEntry, "open_workspace", { path: f.server.project }));
  const second = await f.start(nextEntry, "Goal B", "goal-b");
  const secondOpened = value<OpenReply>(await f.call(nextEntry, "open_workspace", { path: f.server.secondRoot }));
  assert.notEqual(first.session_id, second.session_id);
  const resumed = await f.resume(nextEntry, first.task_id, "resume-a");
  assert.equal(resumed.task_id, first.task_id);
  assert.equal(resumed.session_id, first.session_id);
  assert.equal(resumed.binding.can_continue, true);
  assert.equal(resumed.workspaces[0].workspace_id, opened.workspace_id, "standalone handles remain valid without a federation prefix");
  const repeatedOpen = value<OpenReply>(await f.call(nextEntry, "open_workspace", { path: f.server.project }));
  assert.equal(repeatedOpen.workspace_id, opened.workspace_id, "same Task and root reuse the canonical handle across entry changes");
  assert.equal(f.store.taskMemberIds(first.task_id).length, 1, "resume must not duplicate the original workspace member");
  assert.equal((f.database.sqlite.prepare("SELECT COUNT(*) AS n FROM qm_tasks").get() as { n: number }).n, 2);

  const attachedRoot = join(f.server.project, "attached-after-resume");
  await mkdir(attachedRoot);
  const attached = value<OpenReply>(await f.call(nextEntry, "attach_workspace", {
    session_id: first.session_id, path: attachedRoot,
  }));
  assert.equal(attached.task_id, first.task_id);
  assert.equal(attached.session_id, first.session_id);
  const taskMemberRoots = f.store.taskMemberIds(first.task_id).map(id => f.store.getMember(first.session_id, id).root);
  assert.ok(taskMemberRoots.includes(canonicalWorkspaceRoot(attachedRoot)));
  assert.ok(!f.store.taskMemberIds(second.task_id).some(id => f.store.getMember(second.session_id, id).root === canonicalWorkspaceRoot(attachedRoot)));

  const release = join(f.server.project, "release-a"), started = join(f.server.project, "started-a");
  const script = join(f.server.project, "pending-a.cjs"), resultFile = join(f.server.project, "finished-a.txt");
  await writeFile(script, `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(started)},'started');
    const deadline=Date.now()+20000;const timer=setInterval(()=>{
      if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);fs.writeFileSync(${JSON.stringify(resultFile)},'Task A');console.log('Task A finished');}
      else if(Date.now()>deadline){clearInterval(timer);process.exitCode=3;}
    },20);`);
  const command = { workspace_id: opened.workspace_id, cmd: `"${process.execPath}" "${script}"`,
    yield_time_ms: 100, operation_key: "accepted-for-a" };
  try {
    const pending = value<{ operation_id: string }>(await f.call(nextEntry, "exec_command", command));
    assert.equal(typeof pending.operation_id, "string");
    await waitForFixture(f.server, { sessionId: first.session_id }, "Task A process starts", async () => existsSync(started), Boolean);
    const firstSelection = await f.inspect(firstEntry, first.task_id);
    const third = await f.start(firstEntry, "Goal C", "goal-c", {
      new_goal: true, expected_binding_revision: firstSelection.binding.binding_revision,
    });
    assert.equal(f.store.currentTask(first.session_id)?.id, third.task_id, "the old storage pointer can move without rebinding the second entry");
    assert.equal((await f.inspect(nextEntry, first.task_id)).binding.can_continue, true);
    value(await f.call(nextEntry, "read", { workspace_id: opened.workspace_id, path: "README.md" }));
    const aRead = f.database.sqlite.prepare("SELECT task_id,session_id FROM qm_invocations WHERE tool_name='read' ORDER BY rowid DESC LIMIT 1")
      .get() as { task_id: string; session_id: string };
    assert.deepEqual(aRead, { task_id: first.task_id, session_id: first.session_id });
    const checkpoint = value<{ task_id: string; saved: boolean }>(await f.call(nextEntry, "checkpoint_task", {
      workspace_id: opened.workspace_id, goal: "Continue the original Task A", decisions: ["The accepted command still belongs to A"],
      next_action: "Inspect A's original operation result", evidence_refs: [pending.operation_id],
    }));
    assert.equal(checkpoint.task_id, first.task_id);
    assert.equal(checkpoint.saved, true);
    assert.equal(f.store.checkpoints(first.task_id, f.store.taskMemberIds(first.task_id))[0]?.goal, "Continue the original Task A");
    for (const otherTask of [second.task_id, third.task_id])
      assert.deepEqual(f.store.checkpoints(otherTask, f.store.taskMemberIds(otherTask)), []);
    assert.equal(f.store.currentTask(first.session_id)?.id, third.task_id, "saving A's checkpoint never repurposes the legacy pointer");

    await f.resume(nextEntry, second.task_id, "back-to-b");
    await writeFile(join(f.server.secondRoot, "second.txt"), "Task B");
    value(await f.call(nextEntry, "read", { workspace_id: secondOpened.workspace_id, path: "second.txt" }));
    // Same owner/root/key cannot reinterpret the accepted write as another Task.
    await rejected(f.call(nextEntry, "exec_command", command), /OPERATION_RETRY_SCOPE_MISMATCH/);
    await writeFile(release, "release");
    await waitForFixture(f.server, { sessionId: first.session_id }, "accepted Task A terminates under its original identity", async () => {
      return f.store.eventsForTask(first.task_id).filter(event => event.type === "operation_finished"
        && event.payload.operation_id === pending.operation_id);
    }, events => events.some(event => event.payload.status === "succeeded") && f.store.taskData.activeWork(first.task_id) === 0);
    assert.equal(await readFile(resultFile, "utf8"), "Task A");
    const saved = f.store.findInvocationSummaryByOperationId(pending.operation_id)!;
    assert.equal(saved.task_id, first.task_id);
    assert.equal(saved.session_id, first.session_id);
    for (const taskId of [second.task_id, third.task_id]) assert.ok(!f.store.eventsForTask(taskId)
      .some(event => event.payload.operation_id === pending.operation_id), "a later selection must not own an earlier command event");
    const retriedStart = await f.start(firstEntry, "Goal A", "goal-a");
    assert.equal(retriedStart.task_id, first.task_id);
    assert.equal((await f.inspect(firstEntry, third.task_id)).binding.can_continue, true, "historical start retries do not switch selection");
    value(await f.call(firstEntry, "finish_task", { task_id: first.task_id, status: "completed", summary: "A delivered", message_sequence: 0 }));
    await waitForFixture(f.server, { sessionId: first.session_id }, "Task A finishes explicitly", async () => f.store.getTask(first.task_id).state,
      state => state === "closed");
    assert.equal(f.store.getTask(second.task_id).state, "active");
    assert.equal(f.store.getTask(third.task_id).state, "active");
    await rejected(f.call(nextEntry, "task_resume", { action: "resume", task_id: first.task_id,
      expected_binding_revision: (await f.inspect(nextEntry, first.task_id)).binding.binding_revision, request_key: "no-implicit-reopen" }), /TASK_NOT_ACTIVE/);
  } finally { await writeFile(release, "release"); }
});

test("real MCP: binding sideband is entry-specific even for unchanged Task projections; resume requires observed revision and verified owner", { timeout: 60_000 }, async t => {
  const f = await fixture(t), entryA = "entry-a", entryB = "entry-b";
  const first = await f.start(entryA, "Open goal A", "a"), second = await f.start(entryB, "Open goal B", "b");
  const args = { task_id: first.task_id, session_id: first.session_id, since_rev: -1, resource_version: "task-card-v9" };
  const aView = await f.call(entryA, "qm_session", args), bView = await f.call(entryB, "qm_session", args);
  const revision = value<{ rev: number }>(aView).rev;
  assert.equal(binding(aView).can_continue, true);
  assert.equal(binding(bView).can_continue, false);
  assert.equal(f.store.getTask(first.task_id).revision, revision, "reading entry state does not mutate the Task revision");
  const inspected = await f.inspect(entryB, first.task_id);
  const resumeInput = { action: "resume", task_id: first.task_id, expected_binding_revision: inspected.binding.binding_revision,
    request_key: "same-resume-intent" };
  value(await f.call(entryB, "task_resume", resumeInput));
  assert.equal(value<ResumeReply>(await f.call(entryB, "task_resume", resumeInput)).replayed, true);
  const unchanged = await f.call(entryB, "qm_session", { ...args, since_rev: revision });
  assert.equal(value<{ unchanged: boolean }>(unchanged).unchanged, true);
  assert.equal(binding(unchanged).can_continue, true);
  const continued = value<{ task_id: string; message: string }>(await f.call(entryB, "qm_session_continue", {
    session_id: first.session_id, task_id: first.task_id,
  }));
  assert.equal(continued.task_id, first.task_id);
  assert.ok(continued.message.includes(first.task_id));
  assert.equal(f.store.currentTask(second.session_id)?.id, second.task_id, "another entry's legacy storage is not repurposed");
  await f.resume(entryB, second.task_id, "select-b-again");
  await rejected(f.call(entryB, "task_resume", resumeInput), /TASK_BINDING_REPLAY_SUPERSEDED/);
  await rejected(f.call(entryB, "task_resume", { ...resumeInput, request_key: "stale-version" }), /TASK_BINDING_CHANGED/);
  const persistedState = () => Object.fromEntries([
    "qm_sessions", "qm_tasks", "qm_session_members", "qm_task_members", "qm_task_bindings",
    "qm_task_binding_requests", "qm_task_creation_receipts", "qm_task_finalizations", "qm_invocations", "qm_events",
  ].map(table => [table, f.database.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  const beforeInspection = persistedState(), originalTask = f.store.getTask(first.task_id);
  const withoutEntry = value<TaskReply & { title: string; task_revision: number; binding: TaskBindingState }>(
    await f.call(null, "task_resume", { action: "inspect", task_id: first.task_id }));
  assert.equal(withoutEntry.task_id, first.task_id);
  assert.equal(withoutEntry.session_id, first.session_id);
  assert.equal(withoutEntry.title, originalTask.title);
  assert.equal(withoutEntry.task_revision, originalTask.revision);
  assert.ok(withoutEntry.binding.entry_available === false);
  assert.deepEqual(withoutEntry.binding, {
    task_id: first.task_id, entry_available: false, binding_revision: null, selected_task_id: null,
    status: "entry_unavailable", can_resume: false, can_continue: false, reason: withoutEntry.binding.reason,
  });
  assert.match(withoutEntry.binding.reason, /task_id/);
  assert.deepEqual(persistedState(), beforeInspection,
    "owner-authorized inspection without conversation metadata must not create, select or modify a Task or entry");
  await rejected(f.call(null, "task_resume", { ...resumeInput, request_key: "missing-entry-resume" }), /TASK_ENTRY_REQUIRED/);
  assert.deepEqual(persistedState(), beforeInspection, "a rejected resume must not write a binding or replay receipt");
  assert.equal(binding(await f.call(null, "qm_session", args)).entry_available, false);
  const privateTitle = "Private Task contents must remain undisclosed";
  const foreignSession = f.store.createSession("other-owner", "unrelated", privateTitle);
  const foreign = f.store.createTask(foreignSession.id, privateTitle), unknownTask = "task_unknown_resume_fixture";
  const beforeDenied = persistedState(), deniedBodies = new Set<string>();
  for (const entry of [entryA, null]) for (const taskId of [foreign.id, unknownTask]) for (const action of ["inspect", "resume"]) {
    const denied = await f.call(entry, "task_resume", { action, task_id: taskId,
      ...(action === "resume" ? { expected_binding_revision: 1, request_key: "unauthorized" } : {}) });
    assert.equal(denied.isError, true, JSON.stringify(denied));
    const serialized = JSON.stringify(denied);
    assert.match(serialized, /\bTASK_ACCESS_DENIED\b/);
    for (const privateValue of [foreignSession.id, foreign.id, privateTitle, unknownTask])
      assert.ok(!serialized.includes(privateValue), `a denied ${action} must not disclose ${privateValue}`);
    deniedBodies.add(JSON.stringify({ content: denied.content, structuredContent: denied.structuredContent }));
    assert.deepEqual(persistedState(), beforeDenied, "unknown or foreign Tasks cannot modify an entry, Task or receipt");
  }
  assert.equal(deniedBodies.size, 1, "unknown and foreign Tasks have indistinguishable failures with or without an entry");
  await rejected(f.call(entryA, "task_resume", { action: "inspect", task_id: first.task_id, entry_id: "forged" }), /invalid|unrecognized|entry_id|unexpected/i);
  await rejected(f.call(entryA, "task_resume", { action: "handoff", task_id: first.task_id }), /invalid|handoff|action/i);
  const originalEndpoint = f.server.baseUrl, originalClient = f.server.client;
  await f.server.restart();
  assert.equal(f.server.baseUrl, originalEndpoint, "reconnect uses the same endpoint after a real server restart");
  assert.notEqual(f.server.client, originalClient, "the new MCP transport belongs to the new server generation");
  assert.equal((await f.inspect(entryA, first.task_id)).binding.can_continue, true);
  assert.equal((await f.inspect(entryB, second.task_id)).binding.can_continue, true);
});

test("real MCP: opening the first workspace binds one implicit Task and resume to a fresh entry reuses it", { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  const opened = value<OpenReply>(await f.call("initial-entry", "open_workspace", { path: f.server.project }));
  assert.equal((await f.inspect("initial-entry", opened.task_id)).binding.can_continue, true);
  // Existing installations have canonical Tasks/members but no v12 bindings.
  // Normal recorded work must establish that one-time mapping too; reopening a
  // workspace is not a required migration ritual.
  f.database.sqlite.prepare("DELETE FROM qm_task_bindings").run();
  assert.equal((await f.inspect("initial-entry", opened.task_id)).binding.status, "unbound");
  value(await f.call("initial-entry", "read", { workspace_id: opened.workspace_id, path: "README.md" }));
  assert.equal((await f.inspect("initial-entry", opened.task_id)).binding.can_continue, true);
  const inspected = await f.inspect("fresh-entry", opened.task_id);
  assert.equal(inspected.binding.status, "unbound");
  const resumed = await f.resume("fresh-entry", opened.task_id, "continue-original-goal");
  assert.equal(resumed.session_id, opened.session_id);
  assert.equal(value<OpenReply>(await f.call("fresh-entry", "open_workspace", { path: f.server.project })).workspace_id, opened.workspace_id);
  value(await f.call("fresh-entry", "read", { workspace_id: resumed.workspaces[0].workspace_id, path: "README.md" }));
  assert.equal((f.database.sqlite.prepare("SELECT COUNT(*) AS n FROM qm_tasks").get() as { n: number }).n, 1);
  assert.equal((f.database.sqlite.prepare("SELECT COUNT(*) AS n FROM qm_sessions").get() as { n: number }).n, 1,
    "a new conversation binding does not create a new business Session or copy its Task");
});

test("real MCP: an attached-file write captures its resumed Task and keeps the public download response schema", { timeout: 60_000 }, async t => {
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; }), inside = new Promise<void>(resolve => { entered = resolve; });
  const bytes = Buffer.from("attachment owned by original Task");
  const f = await fixture(t, {
    configure: async config => ({ ...config, artifactsEnabled: true }),
    incomingArtifactAdapters: [{ id: "task-resume-fixture", canHandle: () => true,
      async open() { entered(); await blocked; return { name: "attachment.txt", size: bytes.length,
        mimeType: "text/plain", stream: Readable.from([bytes]) }; } }],
  });
  const first = await f.start("origin", "Attachment goal", "attachment-a");
  const opened = value<OpenReply>(await f.call("origin", "open_workspace", { path: f.server.project }));
  await f.resume("new-entry", first.task_id, "resume-attachment");
  const args = { workspace_id: opened.workspace_id, path: "attachment.txt", operation_key: "download-once",
    file: { file_id: "file_resume_fixture", file_name: "attachment.txt", mime_type: "text/plain",
      download_url: "https://files.oaiusercontent.com/task-resume-test" } };
  const pending = f.call("new-entry", "download_artifact", args);
  try {
    await Promise.race([inside, pending.then(result => { throw new Error(`download returned before its stream boundary: ${JSON.stringify(result)}`); })]);
    const current = await f.inspect("new-entry", first.task_id);
    const second = await f.start("new-entry", "Another goal", "attachment-b", {
      new_goal: true, expected_binding_revision: current.binding.binding_revision,
    });
    release();
    const result = await pending;
    assert.deepEqual(Object.keys(value<Record<string, unknown>>(result)).sort(), ["path"], "do not replace the existing response with an incompatible accepted envelope");
    assert.equal(await readFile(join(f.server.project, "attachment.txt"), "utf8"), bytes.toString());
    const row = f.database.sqlite.prepare("SELECT task_id,session_id,effect,state,arguments_json FROM qm_invocations WHERE tool_name='download_artifact'")
      .get() as { task_id: string; session_id: string; effect: string; state: string; arguments_json: string };
    assert.equal(row.task_id, first.task_id);
    assert.equal(row.session_id, first.session_id);
    assert.equal(row.effect, "completed");
    assert.equal(row.state, "succeeded");
    assert.ok(!row.arguments_json.includes(args.file.download_url), "signed attachment URLs do not enter durable replay arguments");
    assert.equal(typeof JSON.parse(row.arguments_json).file.download_url_sha256, "string");
    await rejected(f.call("new-entry", "download_artifact", args), /OPERATION_RETRY_SCOPE_MISMATCH/);
    assert.equal((await f.inspect("new-entry", second.task_id)).binding.can_continue, true);
    await f.resume("new-entry", first.task_id, "retry-original-download");
    value(await f.call("new-entry", "download_artifact", args));
    assert.equal((f.database.sqlite.prepare("SELECT COUNT(*) AS n FROM qm_invocations WHERE tool_name='download_artifact' AND task_id=?")
      .get(first.task_id) as { n: number }).n, 1, "same intended attachment write replays its receipt");
  } finally { release(); await pending.catch(() => undefined); }
});

function creationState(db: ReturnType<typeof openDatabase>["sqlite"]): unknown {
  return Object.fromEntries([
    "qm_sessions", "qm_tasks", "qm_task_bindings", "qm_task_binding_requests",
  ].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()]));
}

interface CreationConflict {
  error_code: string;
  effect: string;
  retry_hint: string;
  details: {
    binding_revision: number;
    selection_source: "entry" | "legacy";
    existing_task: { task_id: string; title: string; state: "active" | "closed" };
    next_action: { tool: string; arguments: { action: string; task_id: string } };
  };
}

function creationConflict(result: ToolResult, code = "TASK_START_SELECTION_REQUIRED"): CreationConflict {
  assert.equal(result.isError, true, JSON.stringify(result));
  const error = structured(result) as unknown as CreationConflict;
  assert.equal(error.error_code, code);
  assert.equal(error.effect, "not_started");
  assert.equal(error.retry_hint, "fix_input");
  assert.match(JSON.stringify(result.content), new RegExp(code));
  return error;
}

test("real MCP: default starts cannot split a selected goal; explicit new goals use CAS and old receipts never reselect", { timeout: 60_000 }, async t => {
  const f = await fixture(t), entry = "start-policy";
  const first = await f.start(entry, "One long-lived goal", "original");
  const before = creationState(f.database.sqlite);
  const conflict = creationConflict(await f.call(entry, "start_session", { title: "A follow-up message", request_key: "fresh-key" }));
  assert.deepEqual(conflict.details.existing_task, { task_id: first.task_id, title: "One long-lived goal", state: "active" });
  assert.equal(conflict.details.selection_source, "entry");
  assert.deepEqual(conflict.details.next_action, { tool: "task_resume", arguments: { action: "inspect", task_id: first.task_id } });
  assert.deepEqual(creationState(f.database.sqlite), before, "a rejected default start persists no Task, Session, binding or receipt");
  creationConflict(await f.call(entry, "start_session", { title: "An independent goal", request_key: "missing-revision", new_goal: true }),
    "TASK_BINDING_REVISION_REQUIRED");
  creationConflict(await f.call(entry, "start_session", { title: "An independent goal", request_key: "stale-revision",
    new_goal: true, expected_binding_revision: 0 }), "TASK_BINDING_CHANGED");
  assert.deepEqual(creationState(f.database.sqlite), before);

  const intent = { new_goal: true as const, expected_binding_revision: conflict.details.binding_revision };
  const second = await f.start(entry, "An independent goal", "explicit-next", intent);
  assert.notEqual(second.task_id, first.task_id);
  assert.equal(f.store.getTask(first.task_id).state, "active");
  assert.equal((await f.inspect(entry, second.task_id)).binding.can_continue, true);
  assert.equal((await f.start(entry, "One long-lived goal", "original")).task_id, first.task_id);
  assert.equal((await f.inspect(entry, second.task_id)).binding.can_continue, true, "historical receipt replay does not move selection");
  await f.server.restart();
  assert.equal((await f.start(entry, "An independent goal", "explicit-next", intent)).task_id, second.task_id);
  await rejected(f.call(entry, "start_session", { title: "An independent goal", request_key: "explicit-next",
    new_goal: true, expected_binding_revision: intent.expected_binding_revision + 1 }), /TASK_BINDING_KEY_CONFLICT/);

  const sameKey = await Promise.all([
    f.start("same-key-requests", "One creation", "same"), f.start("same-key-requests", "One creation", "same"),
  ]);
  assert.equal(sameKey[0].task_id, sameKey[1].task_id);
  const differentKeys = await Promise.all(["first", "second"].map(request_key => f.call("different-key-requests", "start_session", {
    title: "Concurrent messages", request_key,
  })));
  assert.equal(differentKeys.filter(reply => reply.isError !== true).length, 1);
  creationConflict(differentKeys.find(reply => reply.isError === true)!);
});

test("real MCP: legacy current goals require an explicit choice, closed goals stay closed, and generic clients keep their existing entryless path", { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  const seed = await f.start("owner-lookup", "Owner lookup", "owner");
  const ownerId = f.store.getSession(seed.session_id).owner_id;
  const session = f.store.createSession(ownerId, "legacy-goal-entry", "A pre-binding Session");
  const legacy = f.store.createTask(session.id, "Existing legacy goal", "legacy-start-key");
  const before = creationState(f.database.sqlite);
  const conflict = creationConflict(await f.call("legacy-goal-entry", "start_session", { title: "Next message", request_key: "new-key" }));
  assert.equal(conflict.details.existing_task.task_id, legacy.id);
  assert.equal(conflict.details.selection_source, "legacy");
  assert.equal(conflict.details.binding_revision, 0);
  assert.deepEqual(creationState(f.database.sqlite), before);
  assert.equal((await f.inspect("legacy-goal-entry", legacy.id)).binding.status, "unbound", "a candidate is not a selection");
  const original = await f.start("legacy-goal-entry", "Ignored retry title", "legacy-start-key");
  assert.equal(original.task_id, legacy.id);
  assert.equal((await f.inspect("legacy-goal-entry", legacy.id)).binding.status, "unbound");
  await f.resume("legacy-goal-entry", legacy.id, "explicitly-continue-legacy");
  value(await f.call("legacy-goal-entry", "finish_task", { task_id: legacy.id, status: "completed", summary: "Legacy goal delivered" }));
  assert.equal(f.store.getTask(legacy.id).state, "closed");
  const afterFinish = creationState(f.database.sqlite);
  const closed = creationConflict(await f.call("legacy-goal-entry", "start_session", { title: "A new message after closing", request_key: "closed-default" }));
  assert.equal(closed.details.existing_task.state, "closed");
  assert.deepEqual(creationState(f.database.sqlite), afterFinish);
  const next = await f.start("legacy-goal-entry", "A new independent goal", "after-closed", {
    new_goal: true, expected_binding_revision: closed.details.binding_revision,
  });
  assert.equal(f.store.getTask(legacy.id).state, "closed");
  assert.equal((await f.start("legacy-goal-entry", "Another ignored retry title", "legacy-start-key")).task_id, legacy.id);
  assert.equal((await f.inspect("legacy-goal-entry", next.task_id)).binding.can_continue, true);

  const entryless = value<TaskReply>(await f.call(null, "start_session", { title: "Generic MCP client", request_key: "generic-first" }));
  assert.equal(f.store.getSession(entryless.session_id).conversation_id, null);
  const beforeUnsupportedCas = creationState(f.database.sqlite);
  const unsupported = await f.call(null, "start_session", { title: "Cannot invent an entry version", request_key: "generic-cas",
    new_goal: true, expected_binding_revision: 0 });
  assert.equal(unsupported.isError, true);
  assert.equal(structured(unsupported).error_code, "TASK_ENTRY_REQUIRED");
  assert.equal(structured(unsupported).effect, "not_started");
  assert.deepEqual(creationState(f.database.sqlite), beforeUnsupportedCas);
});
