import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "../../src/db/client.js";
import { SessionChangeCollector } from "../../src/session/changes.js";
import { classifyToolResultError } from "../../src/session/outcome.js";
import { SessionStore } from "../../src/session/store.js";
import { structured, type RealTestServer } from "../session-card/server-fixture.js";
import { fixture, twoNodes } from "./fixture.js";

type ToolResult = Awaited<ReturnType<RealTestServer["client"]["callTool"]>>;
type Database = ReturnType<typeof openDatabase>;
interface SavedInvocation {
  id: string;
  operation_id: string;
  task_id: string;
  session_id: string;
  member_id: string;
  state: string;
  effect: string;
  result_json: string;
  response_json: string;
}
interface FailureReceipt {
  operation_id: string;
  error_code: string;
  effect: string;
  retry_hint: string;
}

interface SavedIdentity { owner_id: string; transport_instance_id: string; request_id: string; }
const columns = "owner_id,transport_instance_id,request_id";
const missingPatch = "*** Begin Patch\n*** Update File: absent-target.txt\n@@\n-before\n+after\n*** End Patch";
function savedInvocation(db: Database, identity: SavedIdentity | undefined): SavedInvocation {
  assert.ok(identity, "the actual invocation must be persisted before its failure is delivered");
  const saved = new SessionStore(db.sqlite).findInvocation(identity.owner_id, identity.transport_instance_id, identity.request_id);
  assert.ok(saved?.operation_id);
  assert.ok(saved.task_id);
  assert.ok(saved.result_json);
  assert.ok(saved.response_json);
  return {id: saved.id, operation_id: saved.operation_id, task_id: saved.task_id,
    session_id: saved.session_id, member_id: saved.member_id, state: saved.state, effect: saved.effect,
    result_json: saved.result_json, response_json: saved.response_json};
}
function byKey(db: Database, taskId: string, key: string): SavedInvocation {
  const row = db.sqlite.prepare(`SELECT ${columns} FROM qm_invocations
    WHERE task_id=? AND json_extract(arguments_json,'$.operation_key')=? ORDER BY rowid DESC LIMIT 1`)
    .get(taskId, key) as SavedIdentity | undefined;
  return savedInvocation(db, row);
}
function failure(result: ToolResult, expectedId: string): FailureReceipt {
  assert.equal(result.isError, true, JSON.stringify(result));
  const body = result.structuredContent;
  assert.ok(body, "the persisted failure must expose a structured receipt: " + JSON.stringify(result));
  assert.equal(body.operation_id, expectedId, "the public failure must identify the authorized persisted invocation");
  for (const field of ["error_code", "effect", "retry_hint"])
    assert.equal(typeof body[field], "string", JSON.stringify(result));
  const content = result.content as Array<{ type: string; text?: string }>;
  const texts = content.filter(item => item.type === "text").map(item => item.text ?? "");
  const text = texts.join("\n");
  assert.ok(texts.some(value => value.endsWith(`; operation_id=${expectedId}]`)), text);
  assert.ok(text.includes(`error_code=${body.error_code}; effect=${body.effect}; retry_hint=${body.retry_hint}`), text);
  return body as unknown as FailureReceipt;
}
function success(result: ToolResult): Record<string, unknown> {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return structured(result);
}

test("standalone MCP: fast patch failure and its replay expose the persisted ID without changing the first receipt", { timeout: 30_000 }, async t => {
  const f = await fixture(t, { git: false, uiEnabled: false });
  const db = openDatabase(f.config.stateDir);
  try {
    const args = { ...f.scope, patch: missingPatch, operation_key: "fast-failed-patch" };
    const first = await f.raw("apply_patch", args);
    const saved = byKey(db, f.task.task_id, args.operation_key);
    const body = failure(first, saved.operation_id);
    assert.equal(body.error_code, "TOOL_EXECUTION_ERROR");
    assert.equal(body.effect, "partial");
    assert.equal(body.retry_hint, "do_not_retry");
    assert.equal(saved.state, "failed");
    assert.equal(saved.effect, body.effect);
    assert.equal(JSON.parse(saved.result_json).kind, "error");
    assert.equal(JSON.parse(saved.result_json).operation_id, undefined, "delivery decoration does not rewrite the stored envelope");
    assert.equal(existsSync(join(f.project, "absent-target.txt")), false);

    const repeated = failure(await f.raw("apply_patch", args), saved.operation_id);
    assert.deepEqual(repeated, body);
    assert.deepEqual(byKey(db, f.task.task_id, args.operation_key), saved);
    assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS n FROM qm_invocations WHERE operation_id=?")
      .get(saved.operation_id) as { n: number }).n, 1);
    const status = await f.call("workspace_context", { ...f.scope, action: "status", operation_id: saved.operation_id });
    assert.equal(status.operation_id, saved.operation_id);
    assert.equal(status.task_id, f.task.task_id);
    assert.equal(status.operation_state, "failed");
    assert.equal(status.effect, "partial");
  } finally { db.close(); }
});

test("standalone MCP: a real read tool's returned isError is decorated after persistence", { timeout: 30_000 }, async t => {
  const f = await fixture(t, { git: false, uiEnabled: false });
  await mkdir(join(f.project, "directory-not-file"));
  const db = openDatabase(f.config.stateDir);
  try {
    const reply = await f.raw("read", { ...f.scope, path: "directory-not-file" });
    const saved = savedInvocation(db, db.sqlite.prepare(`SELECT ${columns} FROM qm_invocations
      WHERE task_id=? AND tool_name='read' ORDER BY rowid DESC LIMIT 1`).get(f.task.task_id) as SavedIdentity | undefined);
    const original = JSON.parse(saved.result_json);
    assert.equal(original.kind, "result", "Pi's real filesystem failure is returned as isError, not thrown by the recorder");
    assert.equal(original.value.isError, true);
    const expected = classifyToolResultError(original.value, { sideEffecting: false });
    const body = failure(reply, saved.operation_id);
    assert.equal(body.error_code, expected.code);
    assert.equal(body.effect, "not_started");
    assert.equal(body.retry_hint, expected.retryHint);
    assert.equal(saved.state, "failed");
    assert.equal(saved.effect, body.effect);
    assert.equal(original.value.structuredContent?.operation_id, undefined);
    assert.equal(JSON.parse(saved.response_json).value.structuredContent?.operation_id, undefined);
    const status = await f.call("workspace_context", { ...f.scope, action: "status", operation_id: body.operation_id });
    assert.equal(status.task_id, f.task.task_id);
    assert.equal(status.operation_state, "failed");
  } finally { db.close(); }
});

test("standalone MCP: a real before-effect filesystem failure keeps not_started and exposes its reservation", { timeout: 30_000 }, async t => {
  const f = await fixture(t, { git: false, uiEnabled: false });
  // 只注入准备阶段故障；HTTP、持久记录、文件异常和执行阶段分类均走真实路径。
  t.mock.method(SessionChangeCollector.prototype, "prepareWrite", async () => {
    await readFile(join(f.root, "missing-required-baseline"));
    return [];
  });
  const db = openDatabase(f.config.stateDir);
  try {
    const args = { ...f.scope, operation_key: "failed-preparation",
      patch: "*** Begin Patch\n*** Add File: must-not-run.txt\n+must not be written\n*** End Patch" };
    const reply = await f.raw("apply_patch", args);
    const saved = byKey(db, f.task.task_id, args.operation_key);
    const body = failure(reply, saved.operation_id);
    assert.equal(body.error_code, "ENOENT");
    assert.equal(body.effect, "not_started");
    assert.equal(body.retry_hint, "fix_input");
    assert.equal(saved.effect, "not_started");
    assert.equal(existsSync(join(f.project, "must-not-run.txt")), false);
    failure(await f.raw("apply_patch", args), saved.operation_id);
    assert.deepEqual(byKey(db, f.task.task_id, args.operation_key), saved);
  } finally { db.close(); }
});

test("standalone MCP: real resource admission keeps the legacy conflict metadata with the persisted ID", { timeout: 30_000 }, async t => {
  const f = await fixture(t, { git: false, uiEnabled: false });
  const held = await f.running.execution.acquireAsync({ workspaceRoot: f.project, kind: "mutation" });
  const db = openDatabase(f.config.stateDir);
  try {
    const args = { ...f.scope, operation_key: "real-resource-conflict",
      patch: "*** Begin Patch\n*** Add File: conflict-must-not-run.txt\n+must not be written\n*** End Patch" };
    const reply = await f.raw("apply_patch", args);
    const saved = byKey(db, f.task.task_id, args.operation_key);
    const body = failure(reply, saved.operation_id);
    assert.equal(body.error_code, "EXECUTION_CONFLICT");
    assert.equal(body.effect, "not_started");
    assert.equal(body.retry_hint, "retry_later");
    const metadata = reply._meta as { quaymesh?: { error?: { code?: string; started?: boolean; effect?: string } } } | undefined;
    assert.equal(metadata?.quaymesh?.error?.code, "EXECUTION_CONFLICT");
    assert.equal(metadata?.quaymesh?.error?.started, false);
    assert.equal(metadata?.quaymesh?.error?.effect, "not_started");
    assert.equal(existsSync(join(f.project, "conflict-must-not-run.txt")), false);
  } finally { db.close(); await held.releaseAsync(); }
});

test("standalone MCP: admission before reservation does not invent an operation identity", { timeout: 30_000 }, async t => {
  const f = await fixture(t, { git: false, uiEnabled: false });
  const db = openDatabase(f.config.stateDir);
  await f.running.execution.pauseAsync("test rejection before recording");
  try {
    const key = "never-reserved";
    const reply = await f.raw("apply_patch", { ...f.scope, operation_key: key,
      patch: "*** Begin Patch\n*** Add File: never-admitted.txt\n+must not be written\n*** End Patch" });
    assert.equal(reply.isError, true, JSON.stringify(reply));
    assert.match(JSON.stringify(reply), /NODE_ADMISSION_PAUSED/);
    assert.equal((reply.structuredContent as Record<string, unknown> | undefined)?.operation_id, undefined);
    assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS n FROM qm_invocations WHERE json_extract(arguments_json,'$.operation_key')=?")
      .get(key) as { n: number }).n, 0);
    assert.equal(existsSync(join(f.project, "never-admitted.txt")), false);
  } finally { f.running.execution.resume(); db.close(); }
});

test("standalone MCP: a cross-Task key rejection never borrows the other Task's operation identity", { timeout: 30_000 }, async t => {
  const f = await fixture(t, { git: false, uiEnabled: false });
  const db = openDatabase(f.config.stateDir);
  try {
    const args = { ...f.scope, patch: missingPatch, operation_key: "belongs-to-original-task" };
    const originalReply = await f.raw("apply_patch", args);
    const saved = byKey(db, f.task.task_id, args.operation_key);
    failure(originalReply, saved.operation_id);
    const observed = await f.call("task_resume", { action: "inspect", task_id: f.task.task_id });
    const next = await f.call("start_session", { title: "Explicitly independent goal", request_key: "next-goal",
      new_goal: true, expected_binding_revision: observed.binding.binding_revision });
    assert.notEqual(next.task_id, saved.task_id);

    const denied = await f.raw("apply_patch", args);
    assert.equal(denied.isError, true, JSON.stringify(denied));
    assert.match(JSON.stringify(denied), /OPERATION_RETRY_SCOPE_MISMATCH/);
    assert.equal((denied.structuredContent as Record<string, unknown> | undefined)?.operation_id, undefined);
    assert.deepEqual(byKey(db, saved.task_id, args.operation_key), saved);
    assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS n FROM qm_invocations WHERE task_id=? AND tool_name='apply_patch'")
      .get(next.task_id) as { n: number }).n, 0);
    const status = await f.call("workspace_context", { ...f.scope, action: "status", operation_id: saved.operation_id });
    assert.equal(status.task_id, saved.task_id, "explicit observation of the authorized old operation remains allowed");
    assert.equal(existsSync(join(f.project, "absent-target.txt")), false);
  } finally { db.close(); }
});

test("federated MCP: real Worker failure and returned foreign IDs use the Coordinator's verified receipt identity", { timeout: 60_000 }, async t => {
  const { worker, cloud } = await twoNodes(t, { git: false });
  const meta = { "openai/session": "recorded-error-federation" };
  const raw = (name: string, args: Record<string, unknown>) => cloud.client.callTool({ name, arguments: args, _meta: meta });
  const task = success(await raw("start_session", { title: "Recorded error identity", request_key: "original" }));
  const opened = success(await raw("open_workspace", { root_id: "worker/main" }));
  const scope = { workspace_id: opened.workspace_id };
  const db = openDatabase(cloud.config.stateDir), workerDb = openDatabase(worker.config.stateDir);
  const transport = worker.running.federation!.transport, originalHandler = transport.handler;
  try {
    const args = { ...scope, patch: missingPatch, operation_key: "real-worker-error" };
    const reply = await raw("apply_patch", args);
    const saved = byKey(db, String(task.task_id), args.operation_key);
    const owned = byKey(workerDb, String(task.task_id), args.operation_key);
    const body = failure(reply, saved.operation_id);
    assert.equal(owned.operation_id, saved.operation_id);
    assert.equal(body.error_code, "TOOL_EXECUTION_ERROR");
    assert.equal(body.effect, "partial");
    assert.equal(body.retry_hint, "do_not_retry");
    assert.equal(owned.state, "failed");
    failure(await raw("apply_patch", args), saved.operation_id);
    assert.deepEqual(byKey(db, String(task.task_id), args.operation_key), saved);
    assert.deepEqual(byKey(workerDb, String(task.task_id), args.operation_key), owned);

    const cases = [
      { key: "returned-unknown", code: "REQUEST_TIMEOUT", effect: "unknown", retry: "query_original" },
      { key: "returned-partial", code: "EXECUTION_CONFLICT", effect: "partial", retry: "do_not_retry" },
    ] as const;
    const calls = new Map<string, number>();
    // 让旧 Worker 回包携带另一条真实记录的 ID，Peer、协调端、SDK 和数据库均走真实路径。
    const withReturnedError: typeof transport.handler = async (method, params, peer, context) => {
      const fault = method === "tool" && params.name === "apply_patch"
        ? cases.find(item => item.key === params.input?.operation_key) : undefined;
      if (fault) {
        calls.set(fault.key, (calls.get(fault.key) ?? 0) + 1);
        return { isError: true,
          content: [
            { type: "text", text: "The Worker reported an error.\n[QuayMesh recovery: error_code=" + fault.code
              + "; effect=" + fault.effect + "; retry_hint=" + fault.retry + "; operation_id=" + saved.operation_id + "]" },
            { type: "resource", resource: { uri: "quaymesh://test/worker-error", mimeType: "text/plain", text: "worker diagnostic evidence" } },
          ],
          structuredContent: { error_code: fault.code, effect: fault.effect, retry_hint: fault.retry, operation_id: saved.operation_id },
          _meta: { "test-error-evidence": "retained", quaymesh: { test_marker: "retained",
            ...(fault.code === "EXECUTION_CONFLICT" ? { error: { code: fault.code, started: false, effect: "not_started",
              details: { blocker_operation_id: saved.operation_id } } } : {}) } } };
      }
      return originalHandler(method, params, peer, context);
    };
    Reflect.set(transport, "handler", withReturnedError);
    for (const fault of cases) {
      const returnedArgs = { ...args, operation_key: fault.key };
      const returned = await raw("apply_patch", returnedArgs);
      const current = byKey(db, String(task.task_id), returnedArgs.operation_key);
      assert.notEqual(current.operation_id, saved.operation_id);
      const currentBody = failure(returned, current.operation_id);
      assert.equal(currentBody.error_code, fault.code);
      assert.equal(currentBody.effect, fault.effect);
      assert.equal(currentBody.retry_hint, fault.retry);
      assert.equal(current.state, fault.effect === "unknown" ? "unknown" : "failed");
      assert.equal(current.effect, fault.effect);
      assert.equal(returned._meta?.["test-error-evidence"], "retained");
      const meta = returned._meta as { quaymesh: { test_marker: string; error?: { started?: boolean; effect?: string } } };
      assert.equal(meta.quaymesh.test_marker, "retained");
      if (fault.code === "EXECUTION_CONFLICT") {
        assert.equal(meta.quaymesh.error?.started, true, "canonical partial evidence also wins in the legacy projection");
        assert.equal(meta.quaymesh.error?.effect, "partial");
      }
      assert.ok((returned.content as Array<{ type: string }>).some(item => item.type === "resource"));
      assert.match(JSON.stringify(returned.content), /worker diagnostic evidence/);
      assert.equal(JSON.parse(current.result_json).value.structuredContent.operation_id, saved.operation_id,
        "the original Worker receipt remains immutable; only public delivery uses the verified local identity");
      failure(await raw("apply_patch", returnedArgs), current.operation_id);
      assert.equal(calls.get(fault.key), 1);
      assert.deepEqual(byKey(db, String(task.task_id), returnedArgs.operation_key), current);
      const status = success(await raw("workspace_context", { ...scope, action: "status", operation_id: current.operation_id }));
      assert.equal(status.operation_id, current.operation_id);
      assert.equal(status.task_id, task.task_id);
    }
  } finally {
    Reflect.set(transport, "handler", originalHandler);
    db.close();
    workerDb.close();
  }
});
