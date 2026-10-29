import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { openDatabase, type DatabaseHandle } from "../db/client.js";
import { createInvocationContext, executeRecorded, lookupStatus } from "./invocations.js";
import { SessionStore } from "./store.js";
import { OperationState } from "./types.js";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "qm-invocation-hotpath-"));
  const database = openDatabase(join(directory, "state"));
  const store = new SessionStore(database.sqlite);
  const session = store.createSession("owner", "conversation", "Invocation payload reads");
  const member = store.addMember(session.id, "local", "workspace", directory, "checkout", null);
  const task = store.createTask(session.id, "Invocation task", "invocation-task");
  t.after(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });
  const context = (requestId: string, operationId = "op-" + requestId) => createInvocationContext({
    auth: { owner_id: "owner" }, transport: { instance_id: "transport" },
    request: { id: requestId, invocation_id: "inv-" + requestId, operation_id: operationId,
      conversation_id: "conversation", actor: "model", tool_name: "write" },
    session: { session_id: session.id, task_id: task.id, member_id: member.id, workspace_id: "workspace" },
  });
  const reserve = (requestId: string, argumentsJson = "{}") => store.reserveInvocation({
    id: "inv-" + requestId, ownerId: "owner", transportInstanceId: "transport", requestId,
    sessionId: session.id, memberId: member.id, taskId: task.id, toolName: "write", argumentsJson,
    operationId: "op-" + requestId,
  });
  const update = (requestId: string) => ({ ownerId: "owner", transportInstanceId: "transport", requestId });
  return { directory, database, store, session, member, task, context, reserve, update };
}

/** Instrument rows returned by real SQLite statements; SQL still runs unchanged. */
function observeInvocationReads(database: DatabaseHandle["sqlite"]) {
  const prepare = database.prepare;
  const metrics = { reads: 0, returnedStringBytes: 0, payloadJsonBytes: 0 };
  database.prepare = function (this: DatabaseHandle["sqlite"], sql: string) {
    const statement = prepare.call(this, sql);
    if (!/\bqm_invocations\b/i.test(sql)) return statement;
    return new Proxy(statement, {
      get(target, key) {
        const member = Reflect.get(target, key, target);
        if ((key === "get" || key === "all") && typeof member === "function") return (...args: unknown[]) => {
          const result: unknown = Reflect.apply(member, target, args);
          metrics.reads++;
          for (const row of Array.isArray(result) ? result : [result]) {
            if (!row || typeof row !== "object") continue;
            for (const [name, value] of Object.entries(row)) if (typeof value === "string") {
              const bytes = Buffer.byteLength(value);
              metrics.returnedStringBytes += bytes;
              if (["arguments_json", "result_json", "response_json"].includes(name)) metrics.payloadJsonBytes += bytes;
            }
          }
          return result;
        };
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
  } as typeof database.prepare;
  return {
    read: () => ({ ...metrics }),
    reset: () => { metrics.reads = 0; metrics.returnedStringBytes = 0; metrics.payloadJsonBytes = 0; },
    restore: () => { database.prepare = prepare; },
  };
}

function assertSummary(value: object) {
  for (const column of ["arguments_json", "result_json", "response_json"]) assert.equal(column in value, false);
}

test("large SQLite receipts use one serialization; state updates and summary reads return no payload columns", async t => {
  const f = await fixture(t), reads = observeInvocationReads(f.database.sqlite);
  t.after(reads.restore);
  const argumentsJson = JSON.stringify({ text: "input".repeat(100_000) });
  assertSummary(f.reserve("large", argumentsJson));
  const text = "result".repeat(180_000);
  let serializations = 0;
  const result = { toJSON() { serializations++; return { text, serializations }; } };
  reads.reset();
  const saved = f.store.updateInvocation({ ...f.update("large"), result, responded: true,
    state: OperationState.running, effect: "started" });
  assertSummary(saved);
  assert.equal(saved.result_ready, 1);
  assert.equal(serializations, 1, "the latest result and first receipt share the same serialized value");
  assert.equal(reads.read().payloadJsonBytes, 0);

  reads.reset();
  const full = f.store.findInvocation("owner", "transport", "large")!;
  const fullRead = reads.read();
  assert.equal(full.result_json, full.response_json);
  assert.equal(JSON.parse(full.result_json!).serializations, 1);
  assert.equal(full.arguments_json, argumentsJson);
  assert.ok(fullRead.payloadJsonBytes > 2_000_000);

  reads.reset();
  const summary = f.store.findInvocationSummary("owner", "transport", "large")!;
  const summaryRead = reads.read();
  assertSummary(summary);
  assert.equal(summary.node_id, "local");
  assert.equal(summary.workspace_root, f.member.root);
  assert.equal(summary.task_id, f.task.id);
  assert.equal(summary.member_id, f.member.id);
  assert.equal(summaryRead.payloadJsonBytes, 0);
  assert.ok(summaryRead.returnedStringBytes < fullRead.returnedStringBytes / 1000);
  assert.equal(f.store.invocationMatchesInput(summary.id, "write", argumentsJson), true);
  assert.equal(f.store.invocationMatchesInput(summary.id, "write", argumentsJson + " "), false);

  reads.reset();
  const completed = f.store.updateInvocation({ ...f.update("large"), state: OperationState.succeeded,
    effect: "completed", finished: true, resultRef: "saved-result" });
  assert.equal(reads.read().payloadJsonBytes, 0);
  assertSummary(completed);
  assert.equal(completed.state, OperationState.succeeded);
  assert.equal(serializations, 1);
  const after = f.store.findInvocation("owner", "transport", "large")!;
  assert.equal(after.result_json, full.result_json);
  assert.equal(after.response_json, full.response_json);
  assert.equal(after.response_at, full.response_at);
  t.diagnostic(JSON.stringify({ fixture: "500k arguments / 1.08M result + first receipt",
    fullRead, summaryRead, firstReceiptSerializations: serializations, stateUpdatePayloadBytesReturned: 0 }));
});

test("a first response can adopt an existing result inside SQLite; latest results cannot rewrite it or regress terminal state", async t => {
  const f = await fixture(t), reads = observeInvocationReads(f.database.sqlite);
  t.after(reads.restore);
  f.reserve("receipt");
  f.store.updateInvocation({ ...f.update("receipt"), result: { text: "saved".repeat(100_000) },
    state: OperationState.unknown, effect: "unknown", finished: true });
  const initial = f.store.findInvocation("owner", "transport", "receipt")!;
  assert.equal(initial.response_at, null);
  reads.reset();
  f.store.updateInvocation({ ...f.update("receipt"), responded: true });
  assert.equal(reads.read().payloadJsonBytes, 0);
  const first = f.store.findInvocation("owner", "transport", "receipt")!;
  assert.equal(first.response_json, initial.result_json);
  assert.ok(first.response_at);

  const regression = f.store.updateInvocation({ ...f.update("receipt"), state: OperationState.running, effect: "started" });
  assert.equal(regression.state, OperationState.unknown);
  assert.equal(regression.effect, "unknown");
  const final = f.store.updateInvocation({ ...f.update("receipt"), state: OperationState.succeeded,
    effect: "completed", result: { final: true }, responded: true, finished: true });
  assert.equal(final.state, OperationState.succeeded);
  const late = f.store.updateInvocation({ ...f.update("receipt"), state: OperationState.failed,
    effect: "partial", responded: true, result: { final: true, lateReceipt: true }, finished: true });
  assert.equal(late.state, OperationState.succeeded);
  assert.equal(late.effect, "completed");
  const current = f.store.findInvocation("owner", "transport", "receipt")!;
  assert.equal(current.response_json, first.response_json);
  assert.equal(current.response_at, first.response_at);
  assert.equal(current.finished_at, initial.finished_at);
  assert.deepEqual(JSON.parse(current.result_json!), { final: true, lateReceipt: true });
  assert.equal(f.store.findInvocationResultByOperation("other-owner", "op-receipt"), null);
});

test("recorded execution keeps payloads out of control-flow reads; a duplicate loads only its latest result and writes once", async t => {
  const f = await fixture(t), reads = observeInvocationReads(f.database.sqlite);
  t.after(reads.restore);
  const path = join(f.directory, "effect.txt"), context = f.context("execute");
  const input = { text: "input".repeat(100_000) }, payload = { text: "output".repeat(180_000) };
  let executions = 0, serializations = 0;
  const result = { toJSON() { serializations++; return payload; } };
  const operation = { invoke: async () => { executions++; await appendFile(path, "once\n"); return result; } };
  reads.reset();
  const first = await executeRecorded(f.store, context, input, operation);
  const executionReads = reads.read();
  assert.equal(first.replay, false);
  assert.equal(first.state, OperationState.succeeded);
  assert.equal(serializations, 1);
  assert.equal(executionReads.payloadJsonBytes, 0);

  reads.reset();
  const duplicate = await executeRecorded(f.store, context, input, operation);
  const replayReads = reads.read();
  assert.equal(duplicate.replay, true);
  assert.deepEqual(duplicate.result, payload);
  assert.equal(replayReads.payloadJsonBytes, Buffer.byteLength(JSON.stringify(payload)));
  assert.equal(executions, 1);
  assert.equal(await readFile(path, "utf8"), "once\n");
  await assert.rejects(executeRecorded(f.store, context, { text: input.text + "different" }, operation), /REQUEST_ID_REUSED/);
  assert.equal(executions, 1);
  assert.equal(await readFile(path, "utf8"), "once\n");
  reads.reset();
  assert.equal(lookupStatus(f.store, "owner", context.operation_id!).state, OperationState.succeeded);
  assert.equal(reads.read().payloadJsonBytes, 0);
  t.diagnostic(JSON.stringify({ fixture: "large real file-writing invocation", executionReads, replayReads, executions, serializations }));
});

test("summary reservation preserves keyed admission retries and a superseded attempt cannot overwrite either receipt", async t => {
  const f = await fixture(t), previous = f.context("rejected", "op-retry"), current = f.context("retried", "op-retry");
  const input = { operation_key: "same-effect", text: "one" };
  const rejection = { kind: "error" as const, errorCode: "NODE_ADMISSION_PAUSED", message: "Admission paused",
    effect: "not_started" as const, retryHint: "retry_later" };
  await executeRecorded(f.store, previous, input, { invoke: async () => rejection,
    outcome: () => ({ state: OperationState.failed, effect: "not_started" }) });
  const before = f.store.findInvocation("owner", "transport", "rejected")!;
  const path = join(f.directory, "retry-effect.txt");
  const value = await executeRecorded(f.store, current, input, { invoke: async () => {
    await appendFile(path, "only retry\n"); return { completed: true };
  } });
  assert.equal(value.state, OperationState.succeeded);
  const successor = f.store.findInvocationSummaryByOperation("owner", "op-retry")!;
  assert.equal(successor.id, current.invocation_id);
  assert.equal(successor.retry_of_invocation_id, previous.invocation_id);
  const legacy = f.store.findKeyedInvocation("owner", f.session.id, f.member.id, "same-effect")!;
  assert.equal(legacy.id, successor.id);
  assert.deepEqual(JSON.parse(legacy.result_json!), { completed: true });
  const stale = f.store.updateInvocation({ ...f.update("rejected"), state: OperationState.succeeded,
    effect: "completed", result: { incorrect: true }, responded: true, finished: true });
  assertSummary(stale);
  assert.equal(stale.state, OperationState.failed);
  assert.equal(stale.effect, "not_started");
  const after = f.store.findInvocation("owner", "transport", "rejected")!;
  assert.equal(after.result_json, before.result_json);
  assert.equal(after.response_json, before.response_json);
  assert.equal(after.response_at, before.response_at);
  assert.equal(after.finished_at, before.finished_at);
  const replay = await executeRecorded(f.store, current, input, { invoke: async () => {
    await appendFile(path, "unexpected\n"); return { completed: false };
  } });
  assert.equal(replay.replay, true);
  assert.equal(await readFile(path, "utf8"), "only retry\n");
});
