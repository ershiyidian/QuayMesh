import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { openDatabase } from "../db/client.js";
import { migrateDatabase } from "../db/migrations.js";
import { createInvocationContext, executeRecorded } from "./invocations.js";
import { SessionStore } from "./store.js";
import { OperationState } from "./types.js";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "qm-invocation-payload-"));
  const database = openDatabase(join(directory, "state")), store = new SessionStore(database.sqlite);
  const session = store.createSession("owner", "entry", "Payload sharing");
  const member = store.addMember(session.id, "local", "workspace", directory, "checkout", null);
  const task = store.createTask(session.id, "Payload sharing", "goal");
  const reserve = (requestId: string) => store.reserveInvocation({
    id: `inv-${requestId}`, ownerId: "owner", transportInstanceId: "transport", requestId,
    sessionId: session.id, memberId: member.id, taskId: task.id, toolName: "exec_command",
    argumentsJson: "{}", operationId: `op-${requestId}`, operationKey: `key-${requestId}`,
  });
  const update = (requestId: string) => ({ ownerId: "owner", transportInstanceId: "transport", requestId });
  const raw = (requestId: string) => database.sqlite.prepare(`SELECT result_json,response_json,response_uses_result,response_at
    FROM qm_invocations WHERE id=?`).get(`inv-${requestId}`) as {
      result_json: string | null; response_json: string | null; response_uses_result: number; response_at: string | null;
    };
  t.after(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, database, store, session, member, task, reserve, update, raw };
}

test("首次大回包只落一份正文，所有内容读取仍返回完整首回执", async t => {
  const f = await fixture(t), result = { kind: "result", value: { result: "汉字".repeat(256_000) } };
  f.reserve("large");
  const summary = f.store.updateInvocation({ ...f.update("large"), result, responded: true, state: OperationState.running });
  const row = f.raw("large"), serialized = JSON.stringify(result);
  assert.equal(row.result_json, serialized);
  assert.equal(row.response_json, null);
  assert.equal(row.response_uses_result, 1);
  for (const receipt of [
    f.store.findInvocation("owner", "transport", "large"),
    f.store.findInvocationByOperation("owner", "op-large"),
    f.store.findInvocationByOperationId("op-large"),
    f.store.findKeyedInvocation("owner", f.session.id, f.member.id, "key-large"),
  ]) {
    assert.equal(receipt?.response_json, serialized);
    assert.equal(receipt?.result_json, serialized);
    assert.equal("response_uses_result" in receipt!, false);
  }
  for (const column of ["arguments_json", "result_json", "response_json"]) assert.equal(column in summary, false);
  f.store.updateInvocation({ ...f.update("large"), result });
  assert.equal(f.raw("large").response_uses_result, 1, "相同结果的重复保存不物化第二份正文");
  const bytes = Buffer.byteLength(serialized);
  t.diagnostic(JSON.stringify({ resultBytes: bytes, previousPayloadBytes: bytes * 2, storedPayloadBytes: bytes, savedBytes: bytes }));
});

test("后续终态变化原子物化原首回执，重放不会执行第二次副作用", async t => {
  const f = await fixture(t), file = join(f.directory, "once.txt"), first = { running: true, operation_id: "op-replay" };
  const context = () => createInvocationContext({ auth: { owner_id: "owner" }, transport: { instance_id: "transport" },
    request: { id: "replay", invocation_id: "inv-replay", operation_id: "op-replay", actor: "model", tool_name: "exec_command" },
    session: { session_id: f.session.id, task_id: f.task.id, member_id: f.member.id, workspace_id: "workspace" } });
  const invoke = async () => { await appendFile(file, "once\n"); return first; };
  await executeRecorded(f.store, context(), { operation_key: "replay" }, { invoke, runningResult: () => true });
  const initial = f.store.findInvocation("owner", "transport", "replay")!;
  assert.equal(f.raw("replay").response_uses_result, 1);
  const final = { running: false, result: "finished" };
  f.store.updateInvocation({ ...f.update("replay"), result: final, state: OperationState.succeeded, finished: true, responded: true });
  const current = f.store.findInvocation("owner", "transport", "replay")!;
  assert.equal(current.response_json, initial.response_json);
  assert.equal(current.response_at, initial.response_at);
  assert.equal(current.result_json, JSON.stringify(final));
  assert.equal(f.raw("replay").response_uses_result, 0);
  const replay = await executeRecorded(f.store, context(), { operation_key: "replay" }, { invoke, runningResult: () => true });
  assert.equal(replay.replay, true);
  assert.equal(await readFile(file, "utf8"), "once\n");
  assert.equal(f.store.findInvocation("owner", "transport", "replay")!.response_json, initial.response_json);
});

test("首回执正文未知时保持未知，真实 JSON null 仍可共享", async t => {
  const f = await fixture(t);
  f.reserve("unknown");
  f.store.updateInvocation({ ...f.update("unknown"), responded: true });
  assert.equal(f.raw("unknown").response_uses_result, 0);
  const at = f.raw("unknown").response_at;
  f.store.updateInvocation({ ...f.update("unknown"), result: { later: true }, responded: true });
  assert.equal(f.store.findInvocation("owner", "transport", "unknown")!.response_json, null);
  assert.equal(f.raw("unknown").response_at, at);
  f.reserve("json-null");
  f.store.updateInvocation({ ...f.update("json-null"), result: null, responded: true });
  assert.equal(f.raw("json-null").response_uses_result, 1);
  assert.equal(f.store.findInvocation("owner", "transport", "json-null")!.response_json, "null");
});

test("结果更新失败会同时回滚别名拆分与正文变更", async t => {
  const f = await fixture(t);
  f.reserve("rollback");
  f.store.updateInvocation({ ...f.update("rollback"), result: { first: true }, responded: true });
  const before = f.raw("rollback");
  f.database.sqlite.exec("CREATE TRIGGER reject_payload_update BEFORE UPDATE ON qm_invocations BEGIN SELECT RAISE(ABORT,'result rejected'); END");
  assert.throws(() => f.store.updateInvocation({ ...f.update("rollback"), result: { later: true } }), /result rejected/);
  assert.deepEqual(f.raw("rollback"), before);
});

test("v15 只折叠已确认相同的首回执，不填造旧版缺失回执", async t => {
  const f = await fixture(t), first = JSON.stringify({ accepted: true }), later = JSON.stringify({ finished: true });
  for (const id of ["same", "different", "unknown", "unrecorded"]) f.reserve(id);
  f.database.sqlite.exec("DROP TABLE qm_task_creation_receipts; ALTER TABLE qm_invocations DROP COLUMN response_uses_result; DELETE FROM qm_schema_migrations WHERE version>=15");
  const write = f.database.sqlite.prepare("UPDATE qm_invocations SET result_json=?,response_json=?,response_at=? WHERE id=?");
  const at = "2026-10-28T12:00:00.000Z";
  write.run(first, first, at, "inv-same");
  write.run(later, first, at, "inv-different");
  write.run(later, null, at, "inv-unknown");
  write.run(first, first, null, "inv-unrecorded");
  migrateDatabase(f.database.sqlite);
  assert.deepEqual(f.raw("same"), { result_json: first, response_json: null, response_uses_result: 1, response_at: at });
  assert.deepEqual(f.raw("different"), { result_json: later, response_json: first, response_uses_result: 0, response_at: at });
  assert.deepEqual(f.raw("unknown"), { result_json: later, response_json: null, response_uses_result: 0, response_at: at });
  assert.deepEqual(f.raw("unrecorded"), { result_json: first, response_json: first, response_uses_result: 0, response_at: null });
  assert.equal(f.store.findInvocation("owner", "transport", "same")!.response_json, first);
  assert.equal(f.store.findInvocation("owner", "transport", "unknown")!.response_json, null);
  const before = f.database.sqlite.prepare("SELECT total_changes() n").get();
  migrateDatabase(f.database.sqlite);
  assert.deepEqual(f.database.sqlite.prepare("SELECT total_changes() n").get(), before);
  assert.equal(f.database.sqlite.pragma("integrity_check", { simple: true }), "ok");
});
