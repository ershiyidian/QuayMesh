import assert from "node:assert/strict";
import {mkdir, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test, {type TestContext} from "node:test";
import {loadConfig} from "../config.js";
import {ExecutionCoordinator} from "../execution-coordinator.js";
import {writeTestQuayMeshConfig} from "../test-support/config.test.js";
import {WorkLedger} from "../work-ledger.js";
import {SqliteWorkspaceStore} from "../workspace-store.js";
import {WorkspaceRegistry} from "../workspaces.js";
import {SessionChangeCollector} from "./changes.js";
import {createInvocationContext} from "./invocations.js";
import {SessionProjector} from "./projection.js";
import {SessionService, type OperationTicket} from "./service.js";
import {SessionStore} from "./store.js";
import {SessionToolRecorder, type RecordModelToolInput} from "./tool-recording.js";
import {OperationState} from "./types.js";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "qm-local-completion-"));
  const root = join(directory, "project"), stateDir = join(directory, "state");
  await mkdir(root);
  await writeFile(join(root, "input.txt"), "real file observation\n");
  const config = loadConfig(writeTestQuayMeshConfig(join(directory, "config"), {
    storage: {stateDir}, workspaces: {allowedRoots: [root], worktreeRoot: join(directory, "worktrees")},
  }));
  const workspaceStore = new SqliteWorkspaceStore(stateDir), workspaces = new WorkspaceRegistry(config, workspaceStore);
  const ledger = new WorkLedger(stateDir), store = new SessionStore(ledger.db), execution = new ExecutionCoordinator(stateDir);
  const changes = new SessionChangeCollector(store, stateDir), projector = new SessionProjector(store, stateDir);
  const service = new SessionService(store, workspaces, ledger, undefined, changes, projector);
  const recorder = new SessionToolRecorder(store, workspaces, service, changes, projector, execution);
  const session = store.createSession("owner", "completion-entry", "Local completion");
  const member = store.addMember(session.id, "local", "workspace", root, "checkout", null);
  const task = store.createTask(session.id, "Original task");
  store.touchTaskMember(task.id, member.id);
  const identity = (requestId: string) => ({owner_id: session.owner_id, conversation_id: session.conversation_id,
    transport_instance_id: "completion-transport", request_id: requestId, task_id: task.id});
  const input = (requestId: string, operation: RecordModelToolInput<never>["operation"]): RecordModelToolInput<never> => ({
    identity: identity(requestId), workspace_id: member.workspace_id, tool_name: "workspace_context",
    kind: "search", label: "workspace_context", input: {action: "search", query: "observation"}, operation,
  });
  const context = (requestId: string) => createInvocationContext({auth: {owner_id: session.owner_id},
    transport: {instance_id: "completion-transport"}, request: {id: requestId},
    session: {session_id: session.id, task_id: task.id, member_id: member.id, workspace_id: member.workspace_id}});
  const proofCount = () => Number(ledger.db.prepare("SELECT COUNT(*) FROM execution_quiescence WHERE invalidated_at IS NULL").pluck().get());
  const business = (operationId: string) => ({
    operation: ledger.db.prepare("SELECT * FROM console_operations WHERE id=?").get(operationId),
    owner: ledger.db.prepare("SELECT * FROM execution_owners WHERE domain='operation' AND id=?").get(operationId),
    invocation: ledger.db.prepare("SELECT * FROM qm_invocations WHERE operation_id=? ORDER BY id").all(operationId),
    events: store.eventsForTask(task.id).filter(event => event.payload.operation_id === operationId),
  });
  t.after(async () => {
    await recorder.close(); await service.close(); await projector.close(); await changes.close();
    execution.close(); ledger.close(); workspaceStore.close(); await rm(directory, {recursive: true, force: true});
  });
  return {root, stateDir, ledger, store, service, recorder, execution, session, member, task, input, identity, context, proofCount, business};
}

test("joined local terminal handlers record proof after the durable result and release only their claim", async t => {
  const f = await fixture(t);
  const otherTask = f.store.createTask(f.session.id, "Other task");
  f.store.touchTaskMember(otherTask.id, f.member.id);
  const otherRun = f.ledger.begin({root: f.root, workspaceId: f.member.workspace_id, workItemId: "other-item", runKey: "other-run",
    title: "Other task", origin: {entryPoint: "console", evidence: "server_entry"}});
  f.store.linkRun(f.session.id, f.member.id, otherRun.id, otherTask.id);
  const otherOperation = f.ledger.operation({runId: otherRun.id, requestKey: "other-invocation", kind: "search", label: "other", status: "running"});
  const otherClaim = f.execution.acquire({workspaceRoot: f.root, kind: "read", access: "read", operationId: otherOperation, taskId: otherTask.id});
  const otherRow = f.ledger.db.prepare("SELECT * FROM execution_claims WHERE id=?").get(otherClaim.id);
  const save = f.service.recordLocalOperationCompletion.bind(f.service);
  t.mock.method(f.service, "recordLocalOperationCompletion", async (...args: Parameters<typeof save>) => {
    const before = f.business(args[1].operation_id);
    await save(...args);
    assert.deepEqual(f.business(args[1].operation_id), before, "completion does not rewrite business receipts or events");
  });
  let proofs = 0;
  for (const state of [OperationState.succeeded, OperationState.failed, OperationState.cancelled]) {
    let calls = 0, claimId = "", operationId = "";
    const args: RecordModelToolInput<string> = {
      identity: f.identity("terminal-" + state), workspace_id: f.member.workspace_id, tool_name: "workspace_context",
      kind: "search", label: "workspace_context", input: {action: "search", query: state}, localCompletion: "handler_settled",
      operation: async context => {
        calls++; operationId = context.operation_id!;
        claimId = f.execution.acquire({workspaceRoot: f.root, kind: "read", access: "read",
          operationId, taskId: f.task.id}).id;
        return readFile(join(f.root, "input.txt"), "utf8");
      },
      operationStatus: () => ({state, effect: state === OperationState.succeeded ? "completed" : "not_started"}),
      afterResult: () => {
        assert.equal(f.proofCount(), proofs, "no proof before post-result work joins");
        assert.ok(f.ledger.db.prepare("SELECT id FROM execution_claims WHERE id=?").get(claimId));
      },
    };
    assert.equal(await f.recorder.record(args), "real file observation\n");
    proofs++;
    assert.equal(f.proofCount(), proofs);
    assert.equal(f.ledger.db.prepare("SELECT id FROM execution_claims WHERE id=?").get(claimId), undefined);
    assert.equal(f.store.findInvocationByOperation(f.session.owner_id, operationId)?.state, state);
    assert.equal(f.ledger.db.prepare("SELECT reason FROM execution_claim_reconciliations WHERE claim_id=?").pluck().get(claimId),
      "execution_physical_completion");
    const beforeReplay = f.business(operationId);
    assert.equal(await f.recorder.record(args), "real file observation\n");
    assert.equal(calls, 1); assert.equal(f.proofCount(), proofs);
    assert.deepEqual(f.business(operationId), beforeReplay);
    assert.deepEqual(f.ledger.db.prepare("SELECT * FROM execution_claims WHERE id=?").get(otherClaim.id), otherRow);
    assert.equal(f.store.getTask(f.task.id).state, "active");
    assert.equal(f.store.getTask(otherTask.id).state, "active");
  }
});

test("terminal local completion rejects a changed generation, foreign Task and mismatched business result", async t => {
  const f = await fixture(t), context = f.context("terminal-identity");
  const input: RecordModelToolInput<string> = {
    identity: f.identity("terminal-identity"), workspace_id: f.member.workspace_id, tool_name: "workspace_context",
    kind: "search", label: "workspace_context", input: {action: "search", query: "saved"},
    operation: () => readFile(join(f.root, "input.txt"), "utf8"),
  };
  await f.recorder.recordWithContext(context, input);
  const ticket: OperationTicket = {ticket_id: "terminal-ticket", invocation_id: context.invocation_id,
    operation_id: context.operation_id!, session_id: context.session_id, task_id: context.task_id!, member_id: context.member_id,
    run_id: context.run_id!, kind: "search", label: "workspace_context", started_at: Date.now(), actor: "model"};
  const settledAt = new Date().toISOString();
  assert.equal(f.proofCount(), 0, "a normal terminal row without the internal handshake is not a proof");
  const otherTask = f.store.createTask(f.session.id, "Foreign task");
  f.store.touchTaskMember(otherTask.id, f.member.id);
  await assert.rejects(f.service.recordLocalOperationCompletion({...context, task_id: otherTask.id},
    {...ticket, task_id: otherTask.id}, settledAt), /LOCAL_COMPLETION_IDENTITY_MISMATCH/);
  const owner = f.business(ticket.operation_id).owner as {generation: string};
  f.ledger.db.prepare("UPDATE execution_owners SET generation='next-attempt' WHERE domain='operation' AND id=?").run(ticket.operation_id);
  await assert.rejects(f.service.recordLocalOperationCompletion(context, ticket, settledAt), /LOCAL_COMPLETION_IDENTITY_MISMATCH/);
  f.ledger.db.prepare("UPDATE execution_owners SET generation=? WHERE domain='operation' AND id=?").run(owner.generation, ticket.operation_id);
  f.ledger.db.prepare("UPDATE qm_invocations SET state='failed' WHERE id=?").run(ticket.invocation_id);
  await assert.rejects(f.service.recordLocalOperationCompletion(context, ticket, settledAt), /LOCAL_COMPLETION_RECEIPT_NOT_READY/);
  f.ledger.db.prepare("UPDATE qm_invocations SET state='succeeded' WHERE id=?").run(ticket.invocation_id);
  assert.equal(f.proofCount(), 0);
  const before = f.business(ticket.operation_id);
  await f.service.recordLocalOperationCompletion(context, ticket, settledAt);
  assert.equal(f.proofCount(), 1); assert.deepEqual(f.business(ticket.operation_id), before);
});

test("failed terminal proof persistence keeps the original result and does not replay the handler", async t => {
  const f = await fixture(t), errors: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => {errors.push(args);});
  f.ledger.db.exec(`CREATE TRIGGER reject_terminal_completion BEFORE INSERT ON execution_quiescence
    BEGIN SELECT RAISE(ABORT,'test terminal proof failure'); END`);
  let calls = 0, operationId = "";
  const args: RecordModelToolInput<string> = {
    identity: f.identity("proof-failed"), workspace_id: f.member.workspace_id, tool_name: "workspace_context",
    kind: "search", label: "workspace_context", input: {action: "search", query: "saved"}, localCompletion: "handler_settled",
    operation: async context => {calls++; operationId = context.operation_id!; return readFile(join(f.root, "input.txt"), "utf8");},
  };
  assert.equal(await f.recorder.record(args), "real file observation\n");
  assert.equal(f.store.findInvocationByOperation(f.session.owner_id, operationId)?.state, "succeeded");
  assert.equal(f.proofCount(), 0); assert.equal(errors.length, 1);
  const before = f.business(operationId);
  f.ledger.db.exec("DROP TRIGGER reject_terminal_completion");
  assert.equal(await f.recorder.record(args), "real file observation\n");
  assert.equal(calls, 1); assert.equal(f.proofCount(), 0); assert.deepEqual(f.business(operationId), before);
});

