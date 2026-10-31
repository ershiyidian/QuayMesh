import assert from "node:assert/strict";
import {mkdir, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import test, {type TestContext} from "node:test";
import {loadConfig} from "../config.js";
import {openDatabase} from "../db/client.js";
import {ExecutionCoordinator} from "../execution-coordinator.js";
import {observeWithSignal} from "../observation-budget.js";
import {processOwner} from "../process-identity.js";
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
import type {InvocationContext} from "./types.js";
import {isReadOnlyObservation} from "../tool-admission.js";
import {cancelManagedCommand} from "../managed-command-control.js";
import {recoverUnstartedCommandControl} from "../execution-control-recovery.js";
import {requestClaimStop} from "../execution-claim-control.js";
import type {SessionRuntime} from "./runtime.js";
import type {ProcessSessionManager} from "../process-sessions.js";
import {workspaceContextInputSchema} from "../tool-surfaces/workspace-context.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {resolve = done;});
  return {promise, resolve};
}

function timeout() {
  return Object.assign(new Error("REQUEST_TIMEOUT: caller stopped waiting"), {code: "REQUEST_TIMEOUT"});
}

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

test("本机读取完整收尾后保存物理边界，客户端超时与原 unknown 回执保持不变", async t => {
  const f = await fixture(t), entered = deferred(), release = deferred(), controller = new AbortController();
  t.after(() => release.resolve());
  let calls = 0, operationId = "";
  const save = f.service.recordLocalOperationCompletion.bind(f.service);
  t.mock.method(f.service, "recordLocalOperationCompletion", async (...args: Parameters<typeof save>) => {
    const guardedBusiness = f.business(args[1].operation_id);
    await save(...args);
    assert.deepEqual(f.business(args[1].operation_id), guardedBusiness, "物理收据不修改任何原业务行或事件");
  });
  const args = {...f.input("cancelled", async context => {
    calls++; operationId = context.operation_id!;
    assert.match(await readFile(join(f.root, "input.txt"), "utf8"), /real file/);
    entered.resolve(); await release.promise; controller.signal.throwIfAborted();
    throw new Error("expected cancellation");
  }), localCompletion: "handler_settled" as const};
  const work = f.recorder.record(args);
  const recorded = assert.rejects(work, {code: "REQUEST_TIMEOUT"});
  const observed = assert.rejects(observeWithSignal(work, controller.signal), {code: "REQUEST_TIMEOUT"});
  try {
    await entered.promise;
    controller.abort(timeout()); await observed;
    f.execution.pause("wait for owned read");
    const active = f.execution.admissionStatus();
    assert.equal(active.activeWork, 1); assert.equal(active.idle, false); assert.equal(f.proofCount(), 0);
    assert.deepEqual(f.recorder.activeOperationIds(), [operationId]);
    const lease = f.ledger.db.prepare("SELECT operation_id,task_id,blocking FROM qm_runtime_work").get();
    assert.deepEqual(lease, {operation_id: operationId, task_id: f.task.id, blocking: 1});
    let closed = false;
    const closing = f.recorder.close().then(() => {closed = true;});
    await delay(10); assert.equal(closed, false, "shutdown still owns the unfinished local handler");
    release.resolve(); await recorded; await closing;
    const final = f.execution.admissionStatus();
    assert.equal(final.activeWork, 0); assert.equal(final.physicalUnknown, 0); assert.equal(final.idle, true);
    assert.equal(final.reconciliationPending, true); assert.equal(f.proofCount(), 1);
    const receipt = f.store.findInvocationByOperation(f.session.owner_id, operationId)!;
    assert.equal(receipt.state, "unknown"); assert.equal(receipt.effect, "unknown"); assert.equal(receipt.result_ref, null);
    assert.equal((f.business(operationId).operation as {finished_at: null}).finished_at, null);
    const beforeReplay = f.business(operationId);
    await assert.rejects(f.recorder.record(args), {code: "REQUEST_TIMEOUT"});
    assert.equal(calls, 1); assert.equal(f.proofCount(), 1); assert.deepEqual(f.business(operationId), beforeReplay);
    const evidence = JSON.parse((f.ledger.db.prepare("SELECT evidence_json FROM execution_quiescence").get() as {evidence_json:string}).evidence_json);
    assert.equal(evidence.boundary, "local_handler_settled"); assert.equal(evidence.invocationId, receipt.id);
    assert.equal(evidence.processStart, processOwner.start); assert.equal(evidence.taskId, f.task.id);
  } finally {controller.abort(timeout()); release.resolve(); await work.catch(() => {});}
});

test("普通 read 分类和 forwarded handler 不产生本机物理证明", async t => {
  const f = await fixture(t);
  const operation = async () => {await readFile(join(f.root, "input.txt")); throw timeout();};
  await assert.rejects(f.recorder.record({...f.input("uncontracted", operation), kind: "read", tool_name: "cancel_command"}), {code: "REQUEST_TIMEOUT"});
  assert.equal(f.execution.admissionStatus().physicalUnknown, 1); assert.equal(f.proofCount(), 0);
  const before = Number(f.ledger.db.prepare("SELECT COUNT(*) FROM console_operations").pluck().get());
  // Even an internal caller accidentally forwarding this marker cannot certify
  // the remote operation: recordForwarded has no local completion path.
  await assert.rejects(f.recorder.recordForwarded({...f.input("forwarded", operation), localCompletion: "handler_settled"}), {code: "REQUEST_TIMEOUT"});
  assert.equal(Number(f.ledger.db.prepare("SELECT COUNT(*) FROM console_operations").pluck().get()), before);
  assert.equal(f.proofCount(), 0); assert.equal(f.execution.admissionStatus().physicalUnknown, 1);
});

test("已关闭 Task 的本机读取仍持有阻塞租约且不新建业务操作", async t => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  t.after(() => release.resolve());
  const task = f.store.closeTask(f.task.id, "completed", "original goal finished");
  f.execution.pause("maintenance observation");
  const work = f.recorder.record({...f.input("closed-task", async () => {
    entered.resolve(); await release.promise; await readFile(join(f.root, "input.txt")); throw timeout();
  }), localCompletion: "handler_settled"});
  const done = assert.rejects(work, {code: "REQUEST_TIMEOUT"});
  try {
    await entered.promise;
    assert.equal(f.execution.admissionStatus().activeWork, 1); assert.equal(f.execution.admissionStatus().idle, false);
    assert.equal(Number(f.ledger.db.prepare("SELECT COUNT(*) FROM console_operations").pluck().get()), 0);
    release.resolve(); await done;
    assert.equal(f.execution.admissionStatus().activeWork, 0); assert.equal(f.proofCount(), 0);
    assert.deepEqual(f.store.getTask(f.task.id), task);
  } finally {release.resolve(); await work.catch(() => {});}
});

async function completedUnknown(f: Awaited<ReturnType<typeof fixture>>) {
  const context = f.context("owned-unknown");
  await assert.rejects(f.recorder.recordWithContext(context, f.input("owned-unknown", async () => {
    await readFile(join(f.root, "input.txt")); throw timeout();
  })), {code: "REQUEST_TIMEOUT"});
  const ticket: OperationTicket = {ticket_id: "test-owned-ticket", invocation_id: context.invocation_id,
    operation_id: context.operation_id!, session_id: context.session_id, task_id: context.task_id!, member_id: context.member_id,
    run_id: context.run_id!, kind: "search", label: "workspace_context", started_at: Date.now(), actor: "model"};
  return {context, ticket, settledAt: new Date().toISOString()};
}

test("物理完成必须绑定原 Task/member/run/调用与本机进程代次", async t => {
  const f = await fixture(t), {context, ticket, settledAt} = await completedUnknown(f);
  for (const field of ["owner_id", "session_id", "task_id", "member_id", "workspace_id", "operation_id", "invocation_id", "run_id"] as const) {
    const before = f.business(ticket.operation_id);
    await assert.rejects(f.service.recordLocalOperationCompletion({...context, [field]: "different"}, ticket, settledAt), /LOCAL_COMPLETION_IDENTITY_MISMATCH/);
    assert.equal(f.proofCount(), 0); assert.deepEqual(f.business(ticket.operation_id), before);
  }
  for (const column of ["generation", "owner_token", "owner_pid", "process_start"] as const) {
    const row = f.business(ticket.operation_id).owner as Record<string, unknown>;
    f.ledger.db.prepare(`UPDATE execution_owners SET ${column}=? WHERE domain='operation' AND id=?`).run(column === "owner_pid" ? -1 : "different", ticket.operation_id);
    await assert.rejects(f.service.recordLocalOperationCompletion(context, ticket, settledAt), /LOCAL_COMPLETION_IDENTITY_MISMATCH/);
    assert.equal(f.proofCount(), 0);
    f.ledger.db.prepare(`UPDATE execution_owners SET ${column}=? WHERE domain='operation' AND id=?`).run(row[column], ticket.operation_id);
  }
  f.ledger.db.prepare("UPDATE console_operations SET request_key='next-attempt' WHERE id=?").run(ticket.operation_id);
  await assert.rejects(f.service.recordLocalOperationCompletion(context, ticket, settledAt), /LOCAL_COMPLETION_IDENTITY_MISMATCH/);
  f.ledger.db.prepare("UPDATE console_operations SET request_key=? WHERE id=?").run(ticket.invocation_id, ticket.operation_id);
  f.ledger.db.prepare("UPDATE qm_session_members SET node_id='remote' WHERE id=?").run(f.member.id);
  await assert.rejects(f.service.recordLocalOperationCompletion(context, ticket, settledAt), /LOCAL_COMPLETION_IDENTITY_MISMATCH/);
  f.ledger.db.prepare("UPDATE qm_session_members SET node_id='local' WHERE id=?").run(f.member.id);
  assert.equal(f.proofCount(), 0);
  const before = f.business(ticket.operation_id);
  await f.service.recordLocalOperationCompletion(context, ticket, settledAt);
  await f.service.recordLocalOperationCompletion(context, ticket, settledAt);
  assert.equal(f.proofCount(), 1); assert.deepEqual(f.business(ticket.operation_id), before);
});

test("等 SQLite 锁期间原操作指纹变化，旧完成回调拒绝写物理证明", async t => {
  const f = await fixture(t), {context, ticket, settledAt} = await completedUnknown(f);
  const writer = openDatabase(f.stateDir);
  writer.sqlite.exec("BEGIN IMMEDIATE");
  writer.sqlite.prepare("UPDATE console_operations SET evidence=? WHERE id=?").run('[{"label":"later observation"}]', ticket.operation_id);
  const pending = assert.rejects(f.service.recordLocalOperationCompletion(context, ticket, settledAt), /Execution changed after physical review/);
  try {await delay(30); writer.sqlite.exec("COMMIT"); await pending;}
  finally {if(writer.sqlite.inTransaction)writer.sqlite.exec("ROLLBACK"); writer.close();}
  assert.equal(f.proofCount(), 0); assert.equal(f.execution.admissionStatus().physicalUnknown, 1);
  assert.equal(f.store.findInvocationByOperation(f.session.owner_id, ticket.operation_id)?.state, "unknown");
});

test("真实 SQLite 拒绝物理收据时保留原 unknown 错误且不重跑读取", async t => {
  const f = await fixture(t), errors: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => {errors.push(args);});
  f.ledger.db.exec(`CREATE TRIGGER reject_local_completion BEFORE INSERT ON execution_quiescence
    BEGIN SELECT RAISE(ABORT,'test physical receipt write rejected'); END`);
  let calls = 0, operationId = "";
  const args = {...f.input("proof-write-failed", async context => {
    calls++; operationId = context.operation_id!;
    await readFile(join(f.root, "input.txt")); throw timeout();
  }), localCompletion: "handler_settled" as const};
  await assert.rejects(f.recorder.record(args), {code: "REQUEST_TIMEOUT"});
  assert.equal(errors.length, 1); assert.equal(errors[0]?.[1], operationId);
  assert.match(String(errors[0]?.[2]), /test physical receipt write rejected/);
  assert.equal(f.proofCount(), 0); assert.equal(f.execution.admissionStatus().activeWork, 0);
  assert.equal(f.execution.admissionStatus().physicalUnknown, 1); assert.equal(f.execution.admissionStatus().idle, false);
  const before = f.business(operationId);
  f.ledger.db.exec("DROP TRIGGER reject_local_completion");
  await assert.rejects(f.recorder.record(args), {code: "REQUEST_TIMEOUT"});
  assert.equal(calls, 1); assert.equal(f.proofCount(), 0); assert.deepEqual(f.business(operationId), before);
});

test("ordinary file reads keep context evidence without creating an execution or a maintenance lease", async t=>{
  const f=await fixture(t);let observed="";
  f.execution.pause("maintenance may continue during a file observation");
  const result=await f.recorder.record<string>({identity:f.identity("plain-read"),workspace_id:f.member.workspace_id,
    tool_name:"read",kind:"read",label:"read",input:{path:"input.txt"},
    operation:()=>readFile(join(f.root,"input.txt"),"utf8"),contextRead:value=>{observed=value;}});
  assert.equal(result,"real file observation\n");assert.equal(observed,result);
  await assert.rejects(f.recorder.record({identity:f.identity("plain-read-timeout"),workspace_id:f.member.workspace_id,
    tool_name:"read",kind:"read",label:"read",input:{path:"input.txt"},
    operation:async()=>{await readFile(join(f.root,"input.txt"));throw timeout();}}),{code:"REQUEST_TIMEOUT"});
  assert.equal(f.ledger.db.prepare("SELECT COUNT(*) FROM console_operations").pluck().get(),0);
  assert.equal(f.ledger.db.prepare("SELECT COUNT(*) FROM qm_runtime_work").pluck().get(),0);
  assert.equal(f.execution.admissionStatus().physicalUnknown,0);
  assert.equal(f.execution.admissionStatus().quiescent,true);
  assert.equal(isReadOnlyObservation("cancel_command",{}),false,"a read-kind cancellation is still an operation");
});

test("explicit claim recovery is recorded once; inspection remains a read-only observation", async t=>{
  const f=await fixture(t);let calls=0;
  assert.equal(isReadOnlyObservation("workspace_context",{action:"recovery",claim_id:"claim",recovery_action:"inspect"}),true);
  assert.equal(isReadOnlyObservation("workspace_context",{action:"recovery",claim_id:"claim",recovery_action:"stop"}),false);
  const input:RecordModelToolInput<string>={identity:f.identity("recover-one"),workspace_id:f.member.workspace_id,
    tool_name:"workspace_context",kind:"read",label:"recover claim",
    input:{action:"recovery",claim_id:"claim",recovery_action:"release"},operation:async()=>{calls++;return "released";}};
  assert.equal(await f.recorder.record(input),"released");
  assert.equal(await f.recorder.record(input),"released");
  assert.equal(calls,1);
  assert.equal(f.ledger.db.prepare("SELECT COUNT(*) FROM qm_invocations WHERE tool_name='workspace_context'").pluck().get(),1);
});

async function rejectedCancellation(t:TestContext,f:Awaited<ReturnType<typeof fixture>>) {
  const command=f.context("detached-command");
  await f.recorder.recordWithContext(command,{tool_name:"exec_command",kind:"command",label:"old command",
    input:{cmd:"long-running job"},operation:async()=>({running:true}),runningResult:()=>true});
  const claim=f.execution.acquire({workspaceRoot:f.root,kind:"command",operationId:command.operation_id,
    scopes:[{kind:"file",path:join(f.root,"output.txt"),access:"write"}]});
  t.after(()=>claim.release());
  const terminate=t.mock.fn(()=>{throw new Error("must not send a signal without the exact attached command");});
  const processSessions={findOperation:()=>undefined,terminate} as unknown as ProcessSessionManager;
  const context=f.context("cancel-detached");
  await assert.rejects(f.recorder.recordWithContext(context,{tool_name:"cancel_command",kind:"read",label:"cancel command",
    input:{operation_id:command.operation_id},operation:()=>cancelManagedCommand({
      runtime:{store:f.store,service:f.service} as SessionRuntime,processSessions,ownerId:f.session.owner_id,
      nodeId:"local",workspaceRoot:f.root,operationId:command.operation_id!,
    })}),{code:"COMMAND_NOT_ATTACHED",effect:"unknown"});
  assert.equal(terminate.mock.callCount(),0,"the actual production guard rejects before signal delivery");
  return {context,command,claim,input:{operationId:context.operation_id!,ownerId:f.session.owner_id,nodeId:"local",workspaceRoot:f.root}};
}

test("a saved local cancellation guard recovers only its own physical subject on a v16 database",{timeout:10_000},async t=>{
  const f=await fixture(t),r=await rejectedCancellation(t,f);
  // Restore the actual v16 shape in this isolated fixture. The public recovery
  // accepts this connection; it must not open a WorkLedger or migrate it.
  f.ledger.db.exec(`DROP INDEX execution_claims_execution;
    ALTER TABLE execution_claims DROP COLUMN execution_id;
    ALTER TABLE execution_claims DROP COLUMN execution_generation;
    ALTER TABLE execution_claims DROP COLUMN owner_process_start;
    ALTER TABLE execution_waiters DROP COLUMN execution_id;
    ALTER TABLE execution_waiters DROP COLUMN execution_generation;
    ALTER TABLE execution_waiters DROP COLUMN owner_process_start;
    DROP INDEX qm_events_task_diagnostic_time;
    DROP INDEX qm_invocations_task_diagnostic_time;
    DROP INDEX qm_invocations_pending_state;
    DELETE FROM qm_schema_migrations WHERE version>16;`);
  const control=f.business(r.context.operation_id!),command=f.business(r.command.operation_id!);
  const claims=f.ledger.db.prepare("SELECT * FROM execution_claims ORDER BY id").all(),task=f.store.getTask(f.task.id);
  assert.equal(recoverUnstartedCommandControl(f.ledger.db,r.input).state,"recoverable");
  assert.equal(f.proofCount(),0);
  assert.equal(recoverUnstartedCommandControl(f.ledger.db,{...r.input,apply:true}).state,"quiescent");
  assert.equal(recoverUnstartedCommandControl(f.ledger.db,{...r.input,apply:true}).state,"quiescent");
  assert.equal(f.proofCount(),1,"recovery is idempotent");
  assert.equal(f.ledger.db.prepare("SELECT max(version) FROM qm_schema_migrations").pluck().get(),16);
  assert.deepEqual(f.business(r.context.operation_id!),control);
  assert.deepEqual(f.business(r.command.operation_id!),command);
  assert.deepEqual(f.ledger.db.prepare("SELECT * FROM execution_claims ORDER BY id").all(),claims);
  assert.deepEqual(f.store.getTask(f.task.id),task);
  const proof=f.ledger.db.prepare("SELECT object_id,evidence_json FROM execution_quiescence").get() as {object_id:string;evidence_json:string};
  assert.equal(proof.object_id,r.context.operation_id);
  assert.equal(JSON.parse(proof.evidence_json).targetOperationId,r.command.operation_id);
});

test("cancellation recovery rejects other errors, forwarded or missing finishes, generations and scopes",{timeout:10_000},async t=>{
  const f=await fixture(t),r=await rejectedCancellation(t,f),db=f.ledger.db;
  const saved=f.store.findInvocationByOperation(f.session.owner_id,r.context.operation_id!)!;
  const envelope=JSON.parse(saved.result_json!);
  const attempt=(sql:string,value:string|null,restore:string|null)=>{
    db.prepare(sql).run(value,saved.id);
    assert.equal(recoverUnstartedCommandControl(db,{...r.input,apply:true}).state,"unknown");
    assert.equal(f.proofCount(),0);
    db.prepare(sql).run(restore,saved.id);
  };
  attempt("UPDATE qm_invocations SET result_json=? WHERE id=?",JSON.stringify({...envelope,errorCode:"REQUEST_TIMEOUT"}),saved.result_json);
  attempt("UPDATE qm_invocations SET tool_name=? WHERE id=?","read","cancel_command");
  attempt("UPDATE qm_invocations SET task_id=? WHERE id=?",null,f.task.id);
  db.prepare("UPDATE execution_owners SET generation='next-attempt' WHERE domain='operation' AND id=?").run(r.context.operation_id!);
  assert.equal(recoverUnstartedCommandControl(db,{...r.input,apply:true}).state,"unknown");
  db.prepare("UPDATE execution_owners SET generation=? WHERE domain='operation' AND id=?").run(saved.id,r.context.operation_id!);
  for(const changed of [{ownerId:"other"},{nodeId:"remote"},{workspaceRoot:join(f.root,"elsewhere")}])
    assert.throws(()=>recoverUnstartedCommandControl(db,{...r.input,...changed,apply:true}),/OPERATION_SCOPE_MISMATCH/);
  db.prepare("DELETE FROM qm_events WHERE event_type='operation_finished' AND json_extract(data_json,'$.operation_id')=?").run(r.context.operation_id!);
  assert.equal(recoverUnstartedCommandControl(db,{...r.input,apply:true}).state,"unknown");
  assert.equal(f.proofCount(),0);
  assert.equal(f.store.findInvocationByOperation(f.session.owner_id,r.context.operation_id!)?.effect,"unknown");
  const base={workspace_id:"workspace",action:"recovery",operation_id:r.context.operation_id};
  assert.equal(workspaceContextInputSchema.safeParse({...base,recovery_action:"release"}).success,true);
  assert.equal(workspaceContextInputSchema.safeParse({...base,recovery_action:"stop"}).success,false);
  assert.equal(workspaceContextInputSchema.safeParse({...base,claim_id:"claim"}).success,false);
  assert.equal(isReadOnlyObservation("workspace_context",{...base,recovery_action:"release"}),false);
});

test("an unconfirmed dispatched agent stop stays unknown and replays without another interrupt",{timeout:10_000},async t=>{
  const f=await fixture(t);let interrupts=0;
  const input:RecordModelToolInput<never>={identity:f.identity("stop-unknown"),workspace_id:f.member.workspace_id,
    tool_name:"workspace_context",kind:"read",label:"stop exact claim",
    input:{action:"recovery",claim_id:"claim",recovery_action:"stop"},operation:()=>requestClaimStop(async()=>{
      interrupts++;
      throw Object.assign(new Error("Control result is unconfirmed. Reconcile the exact provider turn before further writes."),
        {code:"AGENT_CONFLICT"});
    })};
  await assert.rejects(f.recorder.record(input),{code:"AGENT_CONFLICT",effect:"unknown",retryHint:"query_original"});
  await assert.rejects(f.recorder.record(input),{code:"AGENT_CONFLICT",effect:"unknown",retryHint:"query_original"});
  assert.equal(interrupts,1);
  const saved=f.ledger.db.prepare("SELECT state,effect,result_json FROM qm_invocations WHERE tool_name='workspace_context'")
    .get() as {state:string;effect:string;result_json:string};
  assert.equal(saved.state,"unknown");assert.equal(saved.effect,"unknown");
  assert.equal(JSON.parse(saved.result_json).retryHint,"query_original");
});
