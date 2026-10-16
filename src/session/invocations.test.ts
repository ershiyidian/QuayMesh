import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "../db/client.js";
import { WorkLedger } from "../work-ledger.js";
import { createInvocationContext, executeRecorded } from "./invocations.js";
import { SessionStore } from "./store.js";
import { OperationState } from "./types.js";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "quaymesh-invocations-"));
  const database = openDatabase(join(directory, "state"));
  const store = new SessionStore(database.sqlite);
  const session = store.createSession("owner-a", "conversation-1", "invocations");
  const member = store.addMember(session.id, "desktop", "workspace-a", directory, "checkout", null);
  return {
    directory,
    database,
    store,
    identity: {
      auth: { owner_id: "owner-a" },
      transport: { instance_id: "transport-1" },
      request: { id: 1, conversation_id: "conversation-1", actor: "model" as const, tool_name: "append" },
      session: { session_id: session.id, member_id: member.id, workspace_id: "workspace-a" },
    },
    async close() {
      database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("one transport request executes once and a new request can repeat the same operation", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const path = join(f.directory, "writes.txt");
  const context = createInvocationContext(f.identity);
  const invoke = () => appendFile(path, "line\n", "utf8");

  let calls = 0;
  const first = await executeRecorded(f.store, context, { text: "line" }, {
    invoke: async () => { calls += 1; await invoke(); return { operation_id: "op-1" }; },
  });
  const duplicate = await executeRecorded(f.store, context, { text: "line" }, {
    invoke: async () => { calls += 1; await invoke(); return { operation_id: "op-2" }; },
  });

  assert.equal(first.replay, false);
  assert.equal(duplicate.replay, true);
  assert.deepEqual(duplicate.result, { operation_id: "op-1" });
  assert.equal(calls, 1);
  assert.equal(await readFile(path, "utf8"), "line\n");

  await assert.rejects(
    executeRecorded(f.store, context, { text: "different" }, { invoke () { calls += 1; return invoke(); } }),
    /REQUEST_ID_REUSED/,
  );
  assert.equal(calls, 1);
  assert.equal(await readFile(path, "utf8"), "line\n");

  const next = createInvocationContext({ ...f.identity, request: { ...f.identity.request, id: 2 } });
  await executeRecorded(f.store, next, { text: "line" }, {
    invoke: async () => { calls += 1; await invoke(); return { operation_id: "op-3" }; },
  });
  assert.equal(calls, 2);
  assert.equal(await readFile(path, "utf8"), "line\nline\n");
});

test("concurrent replay returns the recorded result instead of executing twice", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const path = join(f.directory, "concurrent.txt");
  const context = createInvocationContext(f.identity);
  let calls = 0;
  const operation = {
    invoke: async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
      await appendFile(path, "once\n", "utf8");
      return { value: "done" };
    },
  };

  const [first, replay] = await Promise.all([
    executeRecorded(f.store, context, { text: "once" }, operation),
    executeRecorded(f.store, context, { text: "once" }, operation),
  ]);

  // 同一 transport 实例和 request id 只执行一次；重复请求读取已记录的结果。
  assert.equal(first.replay, false);
  assert.equal(first.state, OperationState.succeeded);
  assert.deepEqual(first.result, { value: "done" });
  assert.equal(replay.replay, true);
  assert.deepEqual(replay.result, { value: "done" });
  assert.equal(replay.state, OperationState.succeeded);
  assert.equal(replay.effect, "completed");
  // 关键不变式：副作用只发生一次，文件只追加一行。
  assert.equal(calls, 1);
  assert.equal(await readFile(path, "utf8"), "once\n");
});

test("missing stable request identity fails before a write has any effect", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const path = join(f.directory, "missing-identity.txt");
  assert.throws(
    () => createInvocationContext({
      ...f.identity,
      request: { ...f.identity.request, id: "" },
    }),
    /MISSING_REQUEST_ID/,
  );
  assert.equal(await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => error.code), "ENOENT");
});

test("a fast terminal callback cannot be overwritten by the earlier running tool result", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const context = createInvocationContext(f.identity);
  const recorded = await executeRecorded(f.store, context, { command: "fast" }, {
    invoke: async () => {
      const current = f.store.findInvocation("owner-a", "transport-1", "1")!;
      f.store.updateInvocation({
        ownerId: current.owner_id,
        transportInstanceId: current.transport_instance_id,
        requestId: current.request_id,
        state: OperationState.succeeded,
        effect: "completed",
        finished: true,
      });
      return { running: true, output: "finished before the handler returned" };
    },
    runningResult: (result) => result.running,
  });
  assert.equal(recorded.state, OperationState.succeeded);
  assert.equal(recorded.effect, "completed");
  assert.deepEqual(recorded.result, { running: true, output: "finished before the handler returned" });
  const saved = f.store.findInvocation("owner-a", "transport-1", "1")!;
  assert.equal(saved.state, OperationState.succeeded);
  assert.ok(saved.finished_at);
  assert.match(saved.result_json ?? "", /finished before the handler returned/);
});

for (const precedingStatus of [undefined, OperationState.running]) {
test(`startup reconciliation repairs a finished operation after ${precedingStatus ?? "no prior event"}`, async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const context = createInvocationContext(f.identity);
  const recorded = await executeRecorded(f.store, context, { command: "recorded" }, {
    invoke: async () => ({ running: true }),
    runningResult: (result) => result.running,
  });
  assert.equal(recorded.state, OperationState.running);

  const ledger = new WorkLedger(join(f.directory, "state"));
  try {
    const run = ledger.begin({
      root: f.directory,
      workspaceId: "workspace-a",
      workItemId: "reconcile-invocation",
      runKey: "reconcile-invocation",
      title: "Reconcile invocation",
      origin: { entryPoint: "chatgpt_mcp", evidence: "client_reported", modelLabel: "test" },
    });
    ledger.operation({
      id: recorded.operation_id!,
      runId: run.id,
      requestKey: "command",
      kind: "command",
      label: "Recorded command",
      status: "running",
    });
    if (precedingStatus) f.store.appendEvent({
      session_id: f.identity.session.session_id,
      member_id: f.identity.session.member_id,
      type: "operation_finished",
      source_id: "initial-running-receipt",
      timestamp: new Date().toISOString(),
      payload: {operation_id: recorded.operation_id!, status: precedingStatus},
    });
    ledger.endOperation(recorded.operation_id!, "completed");
  } finally {
    ledger.close();
  }

  assert.equal(f.store.reconcileFinishedInvocations(), 1);
  const repaired = f.store.findInvocation("owner-a", "transport-1", "1")!;
  assert.equal(repaired.state, OperationState.succeeded);
  assert.equal(repaired.effect, "completed");
  assert.ok(repaired.finished_at);
  assert.equal(f.store.reconcileFinishedInvocations(), 0);
});
}

