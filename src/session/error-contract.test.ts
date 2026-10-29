import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test, { type TestContext } from "node:test";
import { downloadIncomingArtifact } from "../artifact-tools.js";
import { ArtifactError } from "../artifact-error.js";
import { compatibleToolReceipt } from "../bounded-reply.js";
import { openDatabase } from "../db/client.js";
import { ExecutionCoordinator } from "../execution-coordinator.js";
import { createOpenAIIncomingArtifactAdapter, IncomingArtifactAdapterRegistry } from "../incoming-artifacts.js";
import type { McpRegistrationTarget } from "../mcp-modern-server.js";
import { admittedTools } from "../tool-admission.js";
import { createInvocationContext, executeRecorded } from "./invocations.js";
import { classifyError, classifyToolResultError, recordedToolErrorResult, toolErrorResult } from "./outcome.js";
import { SessionStore } from "./store.js";
import { OperationState } from "./types.js";

type Failure = Error & { code?: string; effect?: string; retryHint?: string; details?: unknown };
async function rejected(promise: Promise<unknown>): Promise<Failure> {
  let failure: unknown;
  try { await promise; } catch (error) { failure = error; }
  assert.ok(failure instanceof Error, "the operation must reject");
  return failure as Failure;
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "qm-error-contract-")), workspace = join(directory, "workspace");
  await mkdir(workspace);
  const database = openDatabase(join(directory, "state")), store = new SessionStore(database.sqlite);
  const execution = new ExecutionCoordinator(join(directory, "state"));
  const session = store.createSession("owner", "conversation", "Error phases");
  const member = store.addMember(session.id, "local", "workspace", workspace, "checkout", null);
  const task = store.createTask(session.id, "Preserve execution evidence", "phase-task");
  t.after(async () => { await execution.closeAsync(); database.close(); await rm(directory, { recursive: true, force: true }); });
  const context = (requestId: string, operationId = "op-" + requestId) => createInvocationContext({
    auth: { owner_id: "owner" }, transport: { instance_id: "transport" },
    request: { id: requestId, invocation_id: "inv-" + requestId, operation_id: operationId,
      conversation_id: "conversation", tool_name: "write" },
    session: { session_id: session.id, task_id: task.id, member_id: member.id, workspace_id: "workspace" },
  });
  return { directory, workspace, database, store, execution, context };
}

// Only registration is captured. Admission, claims, SQLite, and file effects are real.
function admittedHandler(execution: ExecutionCoordinator, handler: () => Promise<unknown>) {
  let call: ((input: Record<string, unknown>, extra: Record<string, unknown>) => Promise<any>) | undefined;
  const target = {
    registerResource() {},
    registerTool(_name: string, _definition: unknown, registered: typeof call) { call = registered; },
  } as unknown as McpRegistrationTarget;
  (admittedTools(target, execution).registerTool as any)("contract_write", { annotations: { readOnlyHint: false } }, handler);
  assert.ok(call);
  return () => call!({}, {});
}

test("a real write followed by ENOENT is persisted as partial and a repeated key cannot repeat its effect", async t => {
  const f = await fixture(t), path = join(f.workspace, "effect.txt");
  let executions = 0;
  const operation = { sideEffecting: true, invoke: async () => {
    executions++;
    await appendFile(path, "written once\n");
    await readFile(join(f.workspace, "missing.txt"));
  } };
  const input = { operation_key: "partial-write" };
  const error = await rejected(executeRecorded(f.store, f.context("partial-first", "op-partial"), input, operation));
  assert.equal(error.code, "ENOENT");
  assert.equal(error.effect, "partial");
  assert.equal(error.retryHint, "do_not_retry");
  const row = f.store.findInvocation("owner", "transport", "partial-first")!;
  assert.equal(row.state, OperationState.failed);
  assert.equal(row.effect, "partial");
  assert.equal(JSON.parse(row.result_json!).effect, "partial");
  const forwarded = toolErrorResult(error, { sideEffecting: true, forwarded: true });
  assert.equal(forwarded.structuredContent.operation_id, "op-partial");
  assert.match(forwarded.content[0].text, /; operation_id=op-partial\]$/);
  assert.equal(forwarded.structuredContent.effect, "partial");
  assert.equal(forwarded.structuredContent.retry_hint, "do_not_retry");
  const replay = await executeRecorded(f.store, f.context("partial-repeat", "op-partial"), input, operation);
  assert.equal(replay.replay, true);
  assert.equal(replay.invocation_id, row.id);
  assert.equal(replay.operation_id, "op-partial");
  assert.equal(replay.state, OperationState.failed);
  assert.deepEqual(replay.result, JSON.parse(row.result_json!), "the recorder returns the saved error envelope on replay");
  assert.equal(replay.effect, "partial");
  assert.equal(executions, 1);
  assert.equal(await readFile(path, "utf8"), "written once\n");
  assert.equal(f.store.findInvocation("owner", "transport", "partial-repeat"), null);

  for (const code of ["ENOENT", "EACCES", "EPERM", "EINVAL"]) {
    const osError = Object.assign(new Error("Operating system rejected a later step."), { code });
    assert.equal(classifyError(osError, { sideEffecting: true, effectStarted: true }).effect, "partial");
    assert.equal(classifyError(osError, { sideEffecting: true, effectStarted: true, forwarded: true }).effect, "unknown");
    assert.equal(classifyError(Object.assign(osError, { effect: "not_started" }),
      { sideEffecting: true, effectStarted: true, forwarded: true }).effect, "not_started");
  }
});

test("a real missing-file failure in beforeEffect keeps the invocation not_started", async t => {
  const f = await fixture(t);
  let invoked = false;
  const error = await rejected(executeRecorded(f.store, f.context("preflight"), {}, {
    sideEffecting: true,
    beforeEffect: () => readFile(join(f.workspace, "required-input.txt")).then(() => undefined),
    invoke: async () => { invoked = true; await writeFile(join(f.workspace, "must-not-exist"), "effect"); },
  }));
  assert.equal(invoked, false);
  assert.equal(error.code, "ENOENT");
  assert.equal(error.effect, "not_started");
  assert.equal(toolErrorResult(error).structuredContent.operation_id, "op-preflight");
  assert.equal(f.store.findInvocation("owner", "transport", "preflight")!.effect, "not_started");
  assert.deepEqual(await readdir(f.workspace), []);
});

test("real lock rejection retains its standard contract, legacy shapes and safe retry hint", async t => {
  const f = await fixture(t), path = join(f.workspace, "admitted.txt");
  const held = await f.execution.acquireAsync({ workspaceRoot: f.workspace, kind: "mutation" });
  let original: Failure | undefined, executions = 0;
  const call = admittedHandler(f.execution, async () => {
    let claim;
    try { claim = await f.execution.acquireAsync({ workspaceRoot: f.workspace, kind: "mutation" }); }
    catch (error) { original = error as Failure; throw error; }
    try { executions++; await writeFile(path, "admitted"); return { content: [{ type: "text", text: "done" }] }; }
    finally { await claim.releaseAsync(); }
  });
  const denied = await call();
  assert.equal(denied.isError, true);
  assert.equal(denied.structuredContent.error_code, "EXECUTION_CONFLICT");
  assert.equal(denied.structuredContent.effect, "not_started");
  assert.equal(denied.structuredContent.retry_hint, "retry_later");
  assert.equal(denied._meta.quaymesh.error.started, false);
  assert.equal(executions, 0);
  assert.deepEqual(await readdir(f.workspace), []);
  assert.ok(original);
  assert.equal(original.effect, "not_started", "the actual acquire boundary supplies the phase");
  const legacyError = { code: original.code, details: original.details, started: false };
  const body = { isError: true, content: [{ type: "text" as const, text: original.message }], structuredContent: { error: legacyError } };
  const metadata = { isError: true, content: body.content, _meta: { quaymesh: { error: legacyError } } };
  for (const response of [body, metadata, compatibleToolReceipt(body)]) {
    const outcome = classifyToolResultError(response, { sideEffecting: true, forwarded: true });
    assert.equal(outcome.code, "EXECUTION_CONFLICT");
    assert.equal(outcome.effect, "not_started");
    assert.equal(outcome.retryHint, "retry_later");
    assert.deepEqual(outcome.details, original.details);
  }
  await held.releaseAsync();
  await call();
  assert.equal(executions, 1);
  assert.equal(await readFile(path, "utf8"), "admitted");
});

test("admission cannot erase explicit partial or unknown evidence from a real later lock conflict", async t => {
  const f = await fixture(t);
  const held = await f.execution.acquireAsync({ workspaceRoot: f.workspace, kind: "mutation" });
  try {
    for (const effect of ["partial", "unknown"] as const) {
      const path = join(f.workspace, effect + ".txt");
      const call = admittedHandler(f.execution, async () => {
        await writeFile(path, "effect already happened");
        try { await f.execution.acquireAsync({ workspaceRoot: f.workspace, kind: "mutation" }); }
        catch (error) { throw Object.assign(error as Error, { effect }); }
      });
      const response = await call();
      assert.equal((await stat(path)).isFile(), true);
      assert.equal(response.structuredContent.error_code, "EXECUTION_CONFLICT");
      assert.equal(response.structuredContent.effect, effect);
      assert.notEqual(response._meta.quaymesh.error.started, false);
      const outcome = classifyToolResultError(response, { sideEffecting: true, forwarded: true });
      assert.equal(outcome.effect, effect);
      assert.equal(outcome.retryHint, effect === "unknown" ? "query_original" : "do_not_retry");
    }
  } finally { await held.releaseAsync(); }
});

test("canonical error identity and explicit phase win without borrowing another error's non-execution evidence", () => {
  const metadata = { quaymesh: { error: { code: "EXECUTION_CONFLICT", started: false, retryHint: "retry_later", details: "legacy" } } };
  const outcome = classifyToolResultError({ isError: true, content: [], _meta: metadata,
    structuredContent: { error_code: "REQUEST_TIMEOUT", effect: "unknown", details: "canonical" } }, { sideEffecting: true, forwarded: true });
  assert.equal(outcome.code, "REQUEST_TIMEOUT");
  assert.equal(outcome.effect, "unknown");
  assert.equal(outcome.details, "canonical");
  const noPhase = classifyToolResultError({ isError: true, content: [], _meta: metadata,
    structuredContent: { error_code: "REQUEST_TIMEOUT" } }, { sideEffecting: true, forwarded: true });
  assert.equal(noPhase.effect, "unknown");
  const distinct = classifyToolResultError({ isError: true, content: [], _meta: metadata,
    structuredContent: { error: { code: "unsafe_openai_file_reference", effect: "not_started", retry_hint: "fix_input", details: "preflight" } } },
    { sideEffecting: true, forwarded: true });
  assert.equal(distinct.code, "unsafe_openai_file_reference");
  assert.equal(distinct.effect, "not_started");
  assert.equal(distinct.retryHint, "fix_input");
  assert.equal(distinct.details, "preflight");
});

test("returned error delivery preserves evidence and replaces a Worker's foreign operation identity without mutating its receipt", () => {
  const original = {isError: true, content: [
    {type: "text" as const, text: "Worker evidence\n[QuayMesh recovery: error_code=EXECUTION_CONFLICT; effect=partial; retry_hint=do_not_retry; operation_id=foreign]"},
    {type: "resource" as const, resource: {uri: "quaymesh://test/evidence", mimeType: "text/plain", text: "original resource"}},
  ], structuredContent: {error_code: "EXECUTION_CONFLICT", effect: "partial", retry_hint: "do_not_retry", operation_id: "foreign"},
  _meta: {evidence: "kept", quaymesh: {error: {code: "EXECUTION_CONFLICT", effect: "not_started", started: false}}}};
  const saved = JSON.stringify(original);
  const delivered = recordedToolErrorResult(original, "verified-operation", {sideEffecting: true, forwarded: true});
  assert.equal(JSON.stringify(original), saved);
  assert.equal(delivered.structuredContent?.operation_id, "verified-operation");
  assert.equal(delivered.structuredContent?.effect, "partial");
  assert.equal(delivered.structuredContent?.retry_hint, "do_not_retry");
  assert.deepEqual(delivered.content[1], original.content[1]);
  assert.match(JSON.stringify(delivered.content[0]), /operation_id=verified-operation/);
  assert.doesNotMatch(JSON.stringify(delivered.content[0]), /operation_id=foreign/);
  assert.equal(delivered._meta?.evidence, "kept");
  assert.deepEqual((delivered._meta?.quaymesh as {error: unknown}).error,
    {code: "EXECUTION_CONFLICT", effect: "partial", started: true});
  assert.equal(recordedToolErrorResult(original, undefined, {sideEffecting: true}), original,
    "a request without an authorized durable reservation must not acquire an operation identity");
  const unrecorded = Object.assign(new Error("Unrecorded rejection"), {operationId: "foreign", details: {operation_id: "foreign"}});
  assert.equal(toolErrorResult(unrecorded).structuredContent.operation_id, undefined);
});

test("rejected artifact URLs leave real workspace paths untouched and retain not_started across recording", async t => {
  const f = await fixture(t), listener = createServer((_request, response) => response.end("must not be fetched"));
  let connections = 0;
  listener.on("connection", () => { connections++; });
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve())));
  const address = listener.address();
  assert.ok(address && typeof address === "object");
  const registry = new IncomingArtifactAdapterRegistry([createOpenAIIncomingArtifactAdapter()]);
  const urls = ["not-a-url", `http://127.0.0.1:${address.port}/blocked`,
    "https://files.oaiusercontent.com.example.invalid/file", "https://files.oaiusercontent.com/file#fragment"];
  for (const [index, url] of urls.entries()) {
    const requestId = "artifact-preflight-" + index;
    const error = await rejected(executeRecorded(f.store, f.context(requestId), { url }, {
      sideEffecting: true, forwarded: true,
      invoke: () => downloadIncomingArtifact({ registry, workspaceId: "workspace", workspaceRoot: f.workspace,
        maxFileBytes: 1024, file: { download_url: url, file_id: "file_phase" }, path: "new-directory/file.bin" }),
    }));
    assert.equal(error.code, "unsafe_openai_file_reference");
    assert.equal(error.effect, "not_started");
    const row = f.store.findInvocation("owner", "transport", requestId)!;
    assert.equal(row.state, OperationState.failed);
    assert.equal(row.effect, "not_started");
    const reply = toolErrorResult(error, { sideEffecting: true, forwarded: true });
    assert.equal(reply.structuredContent.error_code, "unsafe_openai_file_reference");
    assert.equal(reply.structuredContent.effect, "not_started");
    assert.equal(reply.structuredContent.retry_hint, "fix_input");
  }
  assert.equal(connections, 0);
  assert.deepEqual(await readdir(f.workspace), []);
});

test("artifact preflight preserves adapter evidence, while a later real partial-file failure is never marked not_started", async t => {
  const f = await fixture(t);
  const explicitRegistry = new IncomingArtifactAdapterRegistry([{ id: "explicit-source", canHandle: () => true,
    open: async () => { throw Object.assign(new ArtifactError("source_failed", "Source supplied its execution evidence."), { effect: "unknown" }); } }]);
  const explicit = await rejected(downloadIncomingArtifact({ registry: explicitRegistry, workspaceId: "workspace", workspaceRoot: f.workspace,
    maxFileBytes: 1024, file: {}, path: "explicit.bin" }));
  assert.equal(explicit.effect, "unknown");
  let partialObserved = false;
  const registry = new IncomingArtifactAdapterRegistry([{ id: "stream-source", canHandle: () => true, open: async () => ({
    name: "source.bin", stream: Readable.from((async function* () {
      yield Buffer.from("partial bytes");
      const directory = join(f.workspace, "download");
      const partial = (await readdir(directory)).find(name => name.endsWith(".partial"));
      assert.ok(partial);
      // The exclusive destination handle may deny a second reader on Windows.
      // Resuming the generator means writeAll completed, and the real entry exists.
      partialObserved = true;
      await readFile(join(f.workspace, "missing-stream-input"));
    })()),
  }) }]);
  const error = await rejected(executeRecorded(f.store, f.context("artifact-partial"), {}, { sideEffecting: true,
    invoke: () => downloadIncomingArtifact({ registry, workspaceId: "workspace", workspaceRoot: f.workspace,
      maxFileBytes: 1024, file: {}, path: "download/result.bin" }),
  }));
  assert.equal(partialObserved, true);
  assert.equal(error.code, "ENOENT");
  assert.equal(error.effect, "partial");
  assert.equal(f.store.findInvocation("owner", "transport", "artifact-partial")!.effect, "partial");
  assert.deepEqual(await readdir(join(f.workspace, "download")), [], "the partial file is cleaned up without publishing a result");
});


test("a real write followed by provider-thread binding conflict is partial and cannot repeat its effect", async t => {
  const f = await fixture(t), otherWorkspace = join(f.directory, "other-workspace");
  await mkdir(otherWorkspace);
  const held = await f.execution.acquireAsync({ workspaceRoot: otherWorkspace, kind: "mutation", threadKey: "provider:shared-thread" });
  const claimed = await f.execution.acquireAsync({ workspaceRoot: f.workspace, kind: "mutation" });
  const path = join(f.workspace, "provider-effect.txt");
  let executions = 0, original: Failure | undefined;
  const input = { operation_key: "late-thread-conflict" };
  const operation = { sideEffecting: true, invoke: async () => {
    executions++;
    await appendFile(path, "provider effect already happened\n");
    try { claimed.bindThread("provider:shared-thread"); }
    catch (error) { original = error as Failure; throw error; }
  } };
  try {
    const error = await rejected(executeRecorded(f.store, f.context("thread-first", "op-thread"), input, operation));
    assert.ok(original);
    assert.equal(original.code, "EXECUTION_CONFLICT");
    assert.equal(original.effect, undefined, "bindThread cannot prove the provider did not execute");
    assert.doesNotMatch(original.message, /操作尚未开始/);
    assert.equal(error.effect, "partial");
    assert.equal(error.retryHint, "do_not_retry");
    const row = f.store.findInvocation("owner", "transport", "thread-first")!;
    assert.equal(row.state, OperationState.failed);
    assert.equal(row.effect, "partial");
    assert.equal(JSON.parse(row.result_json!).effect, "partial");
    assert.equal(classifyError(original, { sideEffecting: true, forwarded: true, effectStarted: true }).effect, "unknown");
    const response = await admittedHandler(f.execution, async () => { throw original; })();
    assert.equal(response.structuredContent.error_code, "EXECUTION_CONFLICT");
    assert.equal(response.structuredContent.effect, "partial");
    assert.equal(response.structuredContent.retry_hint, "do_not_retry");
    assert.notEqual(response._meta.quaymesh.error.started, false);
    const replay = await executeRecorded(f.store, f.context("thread-repeat", "op-thread"), input, operation);
    assert.equal(replay.replay, true);
    assert.equal(replay.invocation_id, row.id);
    assert.equal(replay.operation_id, "op-thread");
    assert.equal(replay.state, OperationState.failed);
    assert.deepEqual(replay.result, JSON.parse(row.result_json!), "the recorder returns the saved error envelope on replay");
    assert.equal(replay.effect, "partial");
    assert.equal(executions, 1);
    assert.equal(await readFile(path, "utf8"), "provider effect already happened\n");
    assert.equal(f.store.findInvocation("owner", "transport", "thread-repeat"), null);
  } finally {
    await claimed.releaseAsync();
    await held.releaseAsync();
  }
});

test("actual queue capacity rejection supplies not_started before any protected action is invoked", async t => {
  const f = await fixture(t);
  const tickets = Array.from({ length: 64 }, () => f.execution.enqueue({ workspaceRoot: f.workspace, kind: "mutation" }, 60_000));
  try {
    let original: Failure | undefined;
    assert.throws(() => f.execution.enqueue({ workspaceRoot: f.workspace, kind: "mutation" }, 60_000), error => {
      original = error as Failure;
      return original.code === "EXECUTION_CONFLICT";
    });
    assert.ok(original);
    assert.equal(original.effect, "not_started");
    assert.match(original.message, /操作尚未开始/);
    const outcome = classifyError(original, { sideEffecting: true, effectStarted: true, forwarded: true });
    assert.equal(outcome.effect, "not_started");
    assert.equal(outcome.retryHint, "retry_later");
    assert.equal((f.database.sqlite.prepare("SELECT COUNT(*) AS count FROM execution_waiters").get() as { count: number }).count, 64);
    assert.equal((f.database.sqlite.prepare("SELECT COUNT(*) AS count FROM execution_claims").get() as { count: number }).count, 0);
    assert.deepEqual(await readdir(f.workspace), []);
  } finally {
    for (const ticket of tickets) ticket.cancel();
  }
});
