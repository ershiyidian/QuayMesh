import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { openDatabase } from "../db/client.js";
import { createInvocationContext, executeRecorded } from "./invocations.js";
import { SessionStore } from "./store.js";
import { OperationState, type InvocationContext } from "./types.js";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "qm-invocation-scope-"));
  const database = openDatabase(join(directory, "state"));
  const store = new SessionStore(database.sqlite);
  const session = store.createSession("owner", "entry-a", "Task scope");
  const member = store.addMember(session.id, "local", "workspace", directory, "checkout", null);
  const task = store.createTask(session.id, "Original Task", "task-a");
  const file = join(directory, "writes.txt");
  t.after(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });
  const context = (requestId: string, overrides: Partial<InvocationContext> = {}) => ({
    ...createInvocationContext({
      auth: { owner_id: "owner" }, transport: { instance_id: "transport" },
      request: { id: requestId, conversation_id: "entry-a", actor: "model", tool_name: "write" },
      session: { session_id: session.id, task_id: task.id, member_id: member.id, workspace_id: member.workspace_id },
    }), ...overrides,
  });
  let effects = 0;
  const operation = { invoke: async () => {
    effects++; await appendFile(file, "once\n"); return { receipt: "original" };
  } };
  const input = { operation_key: "one-intended-write", text: "once" };
  return { directory, database, store, session, member, task, context, operation, input,
    effects: () => effects, bytes: () => readFile(file, "utf8") };
}

function scopeMismatch(error: unknown): boolean {
  assert.equal((error as { code: string }).code, "OPERATION_RETRY_SCOPE_MISMATCH");
  assert.equal((error as { effect: string }).effect, "not_started");
  return true;
}

test("a keyed completed receipt cannot be replayed under another Task in the same storage session", async t => {
  const f = await fixture(t), original = f.context("original");
  await executeRecorded(f.store, original, f.input, f.operation);
  const before = f.store.findInvocation("owner", "transport", "original")!;
  const other = f.store.createTask(f.session.id, "Other Task", "task-b");
  const context = f.context("other", { task_id: other.id });
  await assert.rejects(executeRecorded(f.store, context, f.input, f.operation), scopeMismatch);
  assert.equal(context.operation_id, undefined, "a rejected retry must not adopt the original operation identity");
  assert.equal(f.store.findInvocation("owner", "transport", "other"), null);
  assert.deepEqual(f.store.findInvocation("owner", "transport", "original"), before);
  assert.equal(f.store.findKeyedInvocation("owner", f.session.id, f.member.id, f.input.operation_key)?.id, before.id);
  assert.equal(f.effects(), 1);
  assert.equal(await f.bytes(), "once\n");
});

test("global owner/node/root keys reject a different storage session instead of relabelling its receipt", async t => {
  const f = await fixture(t);
  await executeRecorded(f.store, f.context("original"), f.input, f.operation);
  const otherSession = f.store.createSession("owner", "entry-b", "Other storage");
  const otherMember = f.store.addMember(otherSession.id, "local", "workspace-b", f.directory, "checkout", null);
  const otherTask = f.store.createTask(otherSession.id, "Other Task", "other-task");
  await assert.rejects(executeRecorded(f.store, f.context("other", {
    session_id: otherSession.id, task_id: otherTask.id, member_id: otherMember.id,
    workspace_id: otherMember.workspace_id, conversation_id: "entry-b",
  }), f.input, f.operation), scopeMismatch);
  assert.equal(f.store.findInvocation("owner", "transport", "other"), null);
  assert.equal(f.effects(), 1);
});

test("same transport request identity cannot bypass the Task or member scope check", async t => {
  const f = await fixture(t);
  await executeRecorded(f.store, f.context("same-request"), f.input, f.operation);
  const otherTask = f.store.createTask(f.session.id, "Other Task", "task-b");
  await assert.rejects(executeRecorded(f.store, f.context("same-request", { task_id: otherTask.id }), f.input, f.operation), scopeMismatch);
  const otherMember = f.store.addMember(f.session.id, "other-node", "other-workspace", f.directory, "checkout", null);
  await assert.rejects(executeRecorded(f.store, f.context("same-request", {
    member_id: otherMember.id, workspace_id: otherMember.workspace_id,
  }), f.input, f.operation), scopeMismatch);
  await assert.rejects(executeRecorded(f.store, f.context("same-request", { workspace_id: "wrong-workspace" }), f.input, f.operation), scopeMismatch);
  assert.equal(f.effects(), 1);
});

test("same Task and canonical member can replay from another external conversation and transport", async t => {
  const f = await fixture(t);
  const original = await executeRecorded(f.store, f.context("original"), f.input, f.operation);
  const replay = await executeRecorded(f.store, f.context("new-entry", {
    conversation_id: "entry-b", transport_instance_id: "another-transport",
  }), f.input, f.operation);
  assert.equal(replay.replay, true);
  assert.equal(replay.operation_id, original.operation_id);
  assert.deepEqual(replay.result, { receipt: "original" });
  assert.equal(f.effects(), 1);
});

test("legacy unscoped receipts still replay only within their original member and never become a Task receipt", async t => {
  const f = await fixture(t);
  await executeRecorded(f.store, f.context("legacy", { task_id: undefined }), f.input, f.operation);
  const replay = await executeRecorded(f.store, f.context("legacy-retry", { task_id: undefined }), f.input, f.operation);
  assert.equal(replay.replay, true);
  await assert.rejects(executeRecorded(f.store, f.context("scoped"), f.input, f.operation), scopeMismatch);
  assert.equal(f.effects(), 1);
});

test("a retry from another Task fails while the original operation remains in progress", async t => {
  const f = await fixture(t);
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  const original = executeRecorded(f.store, f.context("running"), f.input, {
    invoke: async () => { entered(); await pending; return f.operation.invoke(); },
  });
  await ready;
  try {
    const otherTask = f.store.createTask(f.session.id, "Other Task", "task-b");
    await assert.rejects(executeRecorded(f.store, f.context("other", { task_id: otherTask.id }), f.input, f.operation), scopeMismatch);
    assert.equal(f.store.findInvocationSummary("owner", "transport", "running")?.state, OperationState.running);
    assert.equal(f.store.findInvocation("owner", "transport", "other"), null);
  } finally { release(); await original; }
  assert.equal(f.effects(), 1);
});

test("cross-Task admission retry cannot supersede a failed not-started attempt", async t => {
  const f = await fixture(t);
  await executeRecorded(f.store, f.context("paused"), f.input, {
    invoke: async () => ({ kind: "error", errorCode: "NODE_ADMISSION_PAUSED", message: "Paused",
      effect: "not_started", retryHint: "retry_later" }),
    outcome: () => ({ state: OperationState.failed, effect: "not_started" }),
  });
  const before = f.store.findInvocation("owner", "transport", "paused")!;
  const otherTask = f.store.createTask(f.session.id, "Other Task", "task-b");
  await assert.rejects(executeRecorded(f.store, f.context("retry", { task_id: otherTask.id }), f.input, f.operation), scopeMismatch);
  assert.deepEqual(f.store.findInvocation("owner", "transport", "paused"), before);
  assert.equal(f.store.findInvocation("owner", "transport", "retry"), null);
  assert.equal(f.store.findKeyedInvocation("owner", f.session.id, f.member.id, f.input.operation_key)?.id, before.id);
  assert.equal(f.effects(), 0);
});

test("Task closure does not prevent retrieving an already completed receipt in its original scope", async t => {
  const f = await fixture(t);
  await executeRecorded(f.store, f.context("original"), f.input, f.operation);
  f.store.closeTask(f.task.id, "completed", "Done");
  const replay = await executeRecorded(f.store, f.context("after-close", { conversation_id: "entry-b" }), f.input, f.operation);
  assert.equal(replay.replay, true);
  assert.deepEqual(replay.result, { receipt: "original" });
  assert.equal(f.effects(), 1);
});
