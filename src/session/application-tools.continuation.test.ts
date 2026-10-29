import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import * as z from "zod/v4";
import { openDatabase } from "../db/client.js";
import { registerSessionAppTools, type SessionAppToolDependencies } from "./application-tools.js";
import { SessionStore } from "./store.js";
import { taskExecutionEntryFromAuthInfo } from "../tasks/task-binding.js";

interface ContinuationResult {
  task_id: string;
  session_id: string;
  message: string;
  agent_id?: string;
  result_ref?: string;
}

interface CapturedTool {
  inputSchema: z.ZodType;
  outputSchema: z.ZodType;
  handler: (input: unknown, extra: unknown) => Promise<{ structuredContent?: unknown }>;
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "qm-task-continuation-"));
  const database = openDatabase(join(directory, "state"));
  const store = new SessionStore(database.sqlite);
  t.after(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });
  await Promise.all([mkdir(join(directory, "a")), mkdir(join(directory, "b"))]);
  const session = store.createSession("owner-a", "chat-a", "Task continuation");
  const member = store.addMember(session.id, "desktop", "workspace-a", join(directory, "a"), "checkout", null);
  const otherMember = store.addMember(session.id, "desktop", "workspace-b", join(directory, "b"), "checkout", null);
  const otherTask = store.createTask(session.id, "Other goal", "other");
  store.touchTaskMember(otherTask.id, member.id);
  store.touchTaskMember(otherTask.id, otherMember.id);
  const task = store.createTask(session.id, "Current goal", "current");
  store.touchTaskMember(task.id, member.id);
  const entry = taskExecutionEntryFromAuthInfo({ clientId: "client", extra: { owner_id: "owner-a" } }, "chat-a");
  await store.taskBindings.initializeLegacy(entry, task.id);

  const tools = new Map<string, CapturedTool>();
  const target = {
    registerTool(name: string, definition: CapturedTool, handler: CapturedTool["handler"]) {
      if (name === "qm_session_continue") tools.set(name, { ...definition, handler });
      return {};
    },
  } as unknown as Parameters<typeof registerSessionAppTools>[0];
  registerSessionAppTools(target, { store, config: { federation: { enabled: false } } } as SessionAppToolDependencies);
  const registered = tools.get("qm_session_continue");
  assert.ok(registered);
  const invoke = async (input: Record<string, unknown>, ownerId = "owner-a") => {
    const result = await registered.handler(registered.inputSchema.parse(input), {
      authInfo: { clientId: "client", extra: { owner_id: ownerId } }, _meta: { "openai/session": "chat-a" },
    });
    return registered.outputSchema.parse(result.structuredContent) as ContinuationResult;
  };
  let sequence = 0;
  const agentEvent = (taskId: string, memberId: string, agentId: string, resultRef: string | null, state = "completed", available?: boolean) => {
    store.appendEvent({
      session_id: session.id, task_id: taskId, member_id: memberId,
      type: "agent_changed", source_id: `agent-observation-${++sequence}`, timestamp: new Date().toISOString(),
      payload: { agent_id: agentId, state, result_ref: resultRef,
        ...(available === undefined ? {} : { result_available: available }) },
    });
  };
  return { database, store, session, member, otherMember, task, otherTask, entry, invoke, agentEvent };
}

test("continuation is fixed to the explicit Task and member despite newer results elsewhere", async t => {
  const f = await fixture(t);
  f.agentEvent(f.task.id, f.member.id, "agent-a", "result-a");
  f.agentEvent(f.otherTask.id, f.member.id, "agent-b", "wrong-task-result");
  f.agentEvent(f.task.id, f.otherMember.id, "agent-c", "wrong-member-result");
  const before = f.store.tasksForSession(f.session.id).map(task => [task.id, task.state]);
  const result = await f.invoke({ session_id: f.session.id, task_id: f.task.id, member_id: f.member.id });
  assert.equal(result.task_id, f.task.id);
  assert.equal(result.session_id, f.session.id);
  assert.equal(result.agent_id, "agent-a");
  assert.equal(result.result_ref, "result-a");
  assert.ok(result.message.includes(f.task.id));
  assert.ok(result.message.includes('"task_id":"' + f.task.id + '"'));
  assert.ok(result.message.includes("workspace_context"));
  assert.ok(result.message.includes('task_resume({"action":"inspect","task_id":"' + f.task.id + '"})'));
  assert.ok(!result.message.includes("wrong-task-result"));
  assert.ok(!result.message.includes("wrong-member-result"));
  assert.deepEqual(f.store.tasksForSession(f.session.id).map(task => [task.id, task.state]), before);
  assert.equal(f.store.currentTask(f.session.id)?.id, f.task.id);
});

test("an explicit agent must have a current result in the selected Task and member", async t => {
  const f = await fixture(t);
  f.agentEvent(f.otherTask.id, f.member.id, "other-task-agent", "other-result");
  f.agentEvent(f.task.id, f.otherMember.id, "other-member-agent", "other-member-result");
  for (const agent_id of ["other-task-agent", "other-member-agent", "missing-agent"]) {
    await assert.rejects(f.invoke({ session_id: f.session.id, task_id: f.task.id, member_id: f.member.id, agent_id }),
      /AGENT_RESULT_NOT_FOUND_IN_TASK/);
  }
});

test("agent continuation uses its latest observation and does not resurrect an old result", async t => {
  const f = await fixture(t);
  f.agentEvent(f.task.id, f.member.id, "agent", "old-result");
  f.agentEvent(f.task.id, f.member.id, "agent", "new-result");
  const input = { session_id: f.session.id, task_id: f.task.id, member_id: f.member.id, agent_id: "agent" };
  assert.equal((await f.invoke(input)).result_ref, "new-result");
  f.agentEvent(f.task.id, f.member.id, "agent", null, "running");
  await assert.rejects(f.invoke(input), /AGENT_RESULT_NOT_FOUND_IN_TASK/);
  const generic = await f.invoke({ session_id: f.session.id, task_id: f.task.id, member_id: f.member.id });
  assert.equal(generic.task_id, f.task.id);
  assert.equal(generic.result_ref, undefined);
});

test("an active Task can continue without a Session-wide disconnected or agent-result signal", async t => {
  const f = await fixture(t);
  const result = await f.invoke({ session_id: f.session.id, task_id: f.task.id });
  assert.equal(result.task_id, f.task.id);
  assert.equal(result.agent_id, undefined);
  assert.ok(result.message.includes(f.task.id));
});

test("an explicit Task agent locates its own member; ambiguous membership requires an explicit member", async t => {
  const f = await fixture(t);
  f.agentEvent(f.task.id, f.otherMember.id, "agent", "member-b-result");
  const input = { session_id: f.session.id, task_id: f.task.id, agent_id: "agent" };
  const result = await f.invoke(input);
  assert.equal(result.result_ref, "member-b-result");
  assert.ok(result.message.includes("workspace-b"));
  f.agentEvent(f.task.id, f.member.id, "agent", "member-a-result");
  await assert.rejects(f.invoke(input), /AGENT_MEMBER_REQUIRED/);
  assert.equal((await f.invoke({ ...input, member_id: f.member.id })).result_ref, "member-a-result");
});

test("explicit result_available false suppresses a retained old result reference", async t => {
  const f = await fixture(t);
  f.agentEvent(f.task.id, f.member.id, "agent", "old-result");
  f.agentEvent(f.task.id, f.member.id, "agent", "old-result", "running", false);
  const input = { session_id: f.session.id, task_id: f.task.id, member_id: f.member.id };
  await assert.rejects(f.invoke({ ...input, agent_id: "agent" }), /AGENT_RESULT_NOT_FOUND_IN_TASK/);
  assert.equal((await f.invoke(input)).result_ref, undefined);
});

test("continuation requires an explicit Task, its owner and its actual workspace member", async t => {
  const f = await fixture(t);
  await assert.rejects(f.invoke({ session_id: f.session.id }));
  await assert.rejects(f.invoke({ session_id: f.session.id, task_id: f.task.id }, "owner-b"), /SESSION_NOT_FOUND/);
  await assert.rejects(f.invoke({ session_id: f.session.id, task_id: f.task.id, member_id: f.otherMember.id }),
    /MEMBER_NOT_IN_TASK/);
  const differentSession = f.store.createSession("owner-a", "chat-b", "Other entry");
  const differentTask = f.store.createTask(differentSession.id, "Different task");
  await assert.rejects(f.invoke({ session_id: f.session.id, task_id: differentTask.id }), /TASK_SESSION_MISMATCH/);
});

test("continuation does not reopen closed Tasks or silently replace the active execution binding", async t => {
  const f = await fixture(t);
  await assert.rejects(f.invoke({ session_id: f.session.id, task_id: f.otherTask.id }),
    { code: "TASK_CONTINUATION_BINDING_REQUIRED" });
  assert.equal(f.store.currentTask(f.session.id)?.id, f.task.id);
  f.store.closeTask(f.task.id, "completed", "done");
  await assert.rejects(f.invoke({ session_id: f.session.id, task_id: f.task.id }), { code: "TASK_NOT_ACTIVE" });
  assert.equal(f.store.getTask(f.task.id).state, "closed");
});

test("explicitly resuming an older open Task makes continuation use that Task while the legacy current pointer stays unchanged", async t => {
  const f = await fixture(t);
  await f.store.taskBindings.resume(f.entry, f.otherTask.id, 1, "resume-earlier-goal");
  const result = await f.invoke({ session_id: f.session.id, task_id: f.otherTask.id });
  assert.equal(result.task_id, f.otherTask.id);
  assert.equal(f.store.currentTask(f.session.id)?.id, f.task.id);
  await assert.rejects(f.invoke({ session_id: f.session.id, task_id: f.task.id }), { code: "TASK_CONTINUATION_BINDING_REQUIRED" });
});
