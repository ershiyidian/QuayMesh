import assert from "node:assert/strict";
import test from "node:test";
import {execFile, fork} from "node:child_process";
import {promisify} from "node:util";
import {fileURLToPath} from "node:url";
import {appendFile, mkdir, mkdtemp, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {WorkLedger} from "../work-ledger.js";
import {ExecutionCoordinator, ExecutionConflictError} from "../execution-coordinator.js";
import {WorkspaceRegistry} from "../workspaces.js";
import {SqliteWorkspaceStore} from "../workspace-store.js";
import {LocalAgentStore} from "../local-agent-store.js";
import {loadConfig} from "../config.js";
import {writeTestQuayMeshConfig} from "../test-support/config.test.js";
import {createInvocationContext, executeRecorded} from "./invocations.js";
import {SessionStore} from "./store.js";
import {SessionService, type OperationTicket} from "./service.js";
import {SessionChangeCollector} from "./changes.js";
import {SessionProjector} from "./projection.js";
import {SessionToolRecorder} from "./tool-recording.js";
import {OperationState} from "./types.js";
import {toolErrorResult} from "./outcome.js";
import {migrateDatabase, LATEST_DATABASE_VERSION} from "../db/migrations.js";
import {AgentOperationTracker} from "./agent-operations.js";
import {RecoveryService} from "./recovery.js";
import {latestActivity} from "./activity.js";
import {holdSqliteWriteLock} from "../test-support/sqlite-lock.js";

const exec = promisify(execFile);

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "qm-admission-retry-"));
  const root = join(directory, "project"), stateDir = join(directory, "state");
  await mkdir(root);
  const config = loadConfig(writeTestQuayMeshConfig(join(directory, "config"), {
    storage: {stateDir}, workspaces: {allowedRoots: [root], worktreeRoot: join(directory, "worktrees")},
  }));
  const workspaceStore = new SqliteWorkspaceStore(stateDir);
  const workspaces = new WorkspaceRegistry(config, workspaceStore), ledger = new WorkLedger(stateDir);
  const store = new SessionStore(ledger.db), execution = new ExecutionCoordinator(stateDir);
  const changes = new SessionChangeCollector(store, stateDir), projector = new SessionProjector(store, stateDir);
  const service = new SessionService(store, workspaces, ledger, undefined, changes, projector);
  const recorder = new SessionToolRecorder(store, workspaces, service, changes, projector, execution);
  const session = store.createSession("owner", "conversation", "Admission retries");
  const member = store.addMember(session.id, "local", "workspace", root, "checkout", null);
  const task = store.createTask(session.id, "Original task");
  const identity = (request: string) => ({auth: {owner_id: "owner"}, transport: {instance_id: "transport"},
    request: {id: request, tool_name: "exec_command"},
    session: {session_id: session.id, member_id: member.id, workspace_id: member.workspace_id, task_id: task.id}});
  return {directory, root, stateDir, store, ledger, execution, service, projector, recorder, session, member, task, identity,
    async close() {await recorder.close(); await service.close(); await projector.close(); await changes.close();
      execution.close(); ledger.close(); workspaceStore.close(); await rm(directory, {recursive: true, force: true});}};
}

test("写锁超过受理等待预算后，一落盘就交付回执，后台工作继续受维护 lease 保护", {timeout:10000}, async t=>{
  const f=await fixture();t.after(()=>f.close());
  let releaseWork!:()=>void, entered!:()=>void;
  const gate=new Promise<void>(resolve=>{releaseWork=resolve;});
  const started=new Promise<void>(resolve=>{entered=resolve;});
  t.after(()=>releaseWork());
  const lock=await holdSqliteWriteLock(join(f.stateDir,"quaymesh.sqlite"),250);
  t.after(()=>lock.release());
  const input={operation_key:"lock-delayed-acceptance"};
  const args={identity:{owner_id:"owner",conversation_id:"conversation",transport_instance_id:"delayed",
    request_id:"initial",task_id:f.task.id},workspace_id:f.member.workspace_id,tool_name:"exec_command",
    kind:"command" as const,label:"real file write",input,affectsFiles:false,replyWaitMs:20,
    pendingResult:(context:{operation_id?:string})=>({accepted:true,operation_id:context.operation_id}),
    operation:async(context:{operation_id?:string})=>{entered();await gate;await appendFile(join(f.root,"delayed.txt"),"once\n");
      return {accepted:false,operation_id:context.operation_id};}};
  const timeout=setTimeout(()=>releaseWork(),3000);
  try {
    const reply=await f.recorder.record(args);
    assert.equal(reply.accepted,true,"the HTTP receipt must arrive before the unfinished action");
    assert.ok(reply.operation_id);
    assert.ok(f.store.findInvocationByOperation("owner",reply.operation_id!)?.id);
    await started;
    f.execution.pause("maintenance waits for accepted command");
    assert.equal(f.execution.admissionStatus().activeWork,1);
    assert.equal(f.execution.admissionStatus().idle,false);
    releaseWork();await f.recorder.close();
    assert.equal(f.execution.admissionStatus().activeWork,0);
    assert.equal(f.store.findInvocationByOperation("owner",reply.operation_id!)?.state,"succeeded");
    assert.equal(await readFile(join(f.root,"delayed.txt"),"utf8"),"once\n");
    const replay=await f.recorder.record({...args,identity:{...args.identity,request_id:"replay"}});
    assert.equal(replay.accepted,false);
    assert.equal(await readFile(join(f.root,"delayed.txt"),"utf8"),"once\n");
  } finally {clearTimeout(timeout);releaseWork();await lock.release();}
});

test("仅发送前已确认未执行的暂时离线或繁忙可用原 key 重试一次", async t=>{
  const f=await fixture();t.after(()=>f.close());
  for (const code of ["NODE_UNAVAILABLE","PEER_BUSY"]) {
    const first=createInvocationContext(f.identity(`${code}-first`)),input={operation_key:code};
    await assert.rejects(executeRecorded(f.store,first,input,{sideEffecting:true,forwarded:true,
      invoke:async()=>{throw Object.assign(new Error("not dispatched"),{code,effect:"not_started",retryHint:"retry_later",
        details:{dispatch_state:"not_sent"}});}}),error=>{
      assert.equal((error as any).effect,"not_started");assert.equal((error as any).retryHint,"retry_later");return true;});
    const retry=createInvocationContext(f.identity(`${code}-retry`));
    const invoke=async()=>{await appendFile(join(f.root,code),"once\n");return {ok:true};};
    const completed=await executeRecorded(f.store,retry,input,{invoke,sideEffecting:true,forwarded:true});
    assert.equal(completed.replay,false);assert.equal(retry.operation_id,first.operation_id);
    const replay=await executeRecorded(f.store,createInvocationContext(f.identity(`${code}-third`)),input,{invoke});
    assert.equal(replay.replay,true);
    assert.equal(await readFile(join(f.root,code),"utf8"),"once\n");
  }
  const first=createInvocationContext(f.identity("lost-first")),input={operation_key:"lost-after-dispatch"};
  await assert.rejects(executeRecorded(f.store,first,input,{sideEffecting:true,forwarded:true,invoke:async()=>{
    await appendFile(join(f.root,"lost.txt"),"once\n");throw Object.assign(new Error("reply lost"),{code:"NODE_UNAVAILABLE"});}}));
  const replay=await executeRecorded(f.store,createInvocationContext(f.identity("lost-retry")),input,
    {invoke:async()=>{await appendFile(join(f.root,"lost.txt"),"twice\n");}});
  assert.equal(replay.replay,true);assert.equal(replay.effect,"unknown");
  assert.equal(await readFile(join(f.root,"lost.txt"),"utf8"),"once\n");
});

test("preparation refusal keeps its error and task, retries once, and fences a late previous ticket", {timeout: 15000}, async t => {
  const f = await fixture(); t.after(() => f.close());
  const blocker = f.execution.acquire({workspaceRoot: f.root, kind: "command", operationId: "blocker"});
  t.after(() => blocker.release());
  const firstContext = createInvocationContext(f.identity("first"));
  const input = {cmd: "append once", operation_key: "prepare-refusal"};
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => {entered = resolve;});
  const continueWork = new Promise<void>(resolve => {finish = resolve;});
  const options = {tool_name: "exec_command", kind: "command" as const, label: input.cmd, input, affectsFiles: true,
    beforeWrite: async () => {f.execution.acquire({workspaceRoot: f.root, kind: "command"}).release();},
    operation: async () => {entered(); await continueWork;
      await exec(process.execPath, ["-e", "require('node:fs').appendFileSync(process.argv[1], 'once\\n')", join(f.root, "once.txt")]);
      return {ok: true};}};
  const firstError = await f.recorder.recordWithContext(firstContext, options).catch(error => error);
  assert.equal(firstError.code, "EXECUTION_CONFLICT");
  const original = f.store.findInvocation("owner", "transport", "first")!;
  const event = f.store.findOperationEvent(original.operation_id!)!;
  const oldTicket: OperationTicket = {ticket_id: original.id, invocation_id: original.id, operation_id: original.operation_id!,
    session_id: f.session.id, task_id: f.task.id, member_id: f.member.id, run_id: String(event.payload.run_id),
    kind: "command", label: input.cmd, started_at: Date.parse(event.timestamp), actor: "model"};
  blocker.release();
  const secondContext = createInvocationContext(f.identity("second"));
  const retried = f.recorder.recordWithContext(secondContext, options);
  try {
    await started;
    const current = f.store.findInvocationByOperationId(original.operation_id!)!;
    assert.notEqual(current.id, original.id);
    assert.equal(current.task_id, f.task.id);
    assert.equal(current.state, "running");
    assert.equal(f.store.reconcileFinishedInvocations(), 0, "the old ledger failure cannot finish the current attempt");
    assert.equal(f.ledger.reconcileTerminalOperations(), 0);
    await f.service.operationFinished(oldTicket, {status: OperationState.failed, effect: "not_started", error_code: "EXECUTION_CONFLICT"});
    // 在新尝试获准后写入迟到的旧事件，覆盖跨进程到达顺序。
    f.store.appendEvent({...event, type: "operation_finished", source_id: "late-first-attempt", timestamp: new Date().toISOString(),
      payload: {...event.payload, status: "failed", effect: "not_started", error_code: "EXECUTION_CONFLICT"}});
    f.store.updateInvocation({ownerId: "owner", transportInstanceId: "transport", requestId: "first",
      state: OperationState.succeeded, effect: "completed", result: {late: true}, finished: true});
    assert.deepEqual(f.store.findInvocation("owner", "transport", "first"), original);
    assert.equal((f.ledger.db.prepare("SELECT status FROM console_operations WHERE id=?").get(original.operation_id) as {status: string}).status, "running");
    const snapshot = await f.projector.materialize(f.session.id, f.member.id, f.task.id);
    assert.equal(snapshot.commands.find(command => command.operation_id === original.operation_id)?.status, "run");
    assert.equal(latestActivity(f.store.eventsForTask(f.task.id))?.state, "running");
    const recovery = new RecoveryService(f.store, f.stateDir);
    assert.equal(recovery.taskDetail("owner", f.root, f.task.id, "local").facts.active_operations[0]?.operation_id, original.operation_id);
    assert.equal(recovery.detail("owner", f.root, f.session.id).operations[0]?.state, "running");
    assert.equal(f.store.recentRecoveryRows("owner", f.root).rows[0]?.commands.running, 1);
    assert.equal(f.store.hasOperationFinished(original.operation_id!), false);
  } finally {finish();}
  assert.deepEqual(await retried, {ok: true});
  assert.equal(secondContext.operation_id, firstContext.operation_id);
  const replayError = await f.recorder.recordWithContext(createInvocationContext(f.identity("first")), options).catch(error => error);
  assert.deepEqual(toolErrorResult(replayError), toolErrorResult(firstError));
  assert.deepEqual(await f.recorder.recordWithContext(createInvocationContext(f.identity("third")), options), {ok: true});
  assert.equal(await readFile(join(f.root, "once.txt"), "utf8"), "once\n");
  await assert.rejects(f.recorder.recordWithContext(createInvocationContext(f.identity("changed")), {...options, input: {...input, cmd: "different"}}), /REQUEST_ID_REUSED/);
});

test("agent tracking restores a new running attempt despite the previous refusal's finished event", async t => {
  const f = await fixture(); t.after(() => f.close());
  const agents = new LocalAgentStore(f.stateDir);
  let tracker: AgentOperationTracker | undefined;
  try {
    const input = {operation_key: "agent-retry"};
    const options = {tool_name: "spawn_agent", kind: "agent_control" as const, label: "agent launch", input, affectsFiles: false,
      operation: async () => {throw new ExecutionConflictError("held", undefined, "busy");}};
    await f.recorder.recordWithContext(createInvocationContext(f.identity("first-agent")), options).catch(() => {});
    const context = createInvocationContext(f.identity("next-agent"));
    const agent = agents.create({workspaceId: f.member.workspace_id, workspaceRoot: f.root, profileName: "test", provider: "codex"});
    agents.update(agent.id, {status: "running"});
    await f.recorder.recordWithContext(context, {...options,
      operation: async () => {
        f.store.rememberAgentOperation({operationId: context.operation_id!, agentId: agent.id, sessionId: f.session.id, memberId: f.member.id});
        return {running: true};
      }, runningResult: result => result.running,
    });
    assert.equal(f.store.hasOperationFinished(context.operation_id!), false);
    assert.equal(f.store.pendingAgentOperations()[0]?.operationId, context.operation_id);
    tracker = new AgentOperationTracker(agents, f.service, new SessionStore(f.ledger.db), {intervalMs: 5, ledger: f.ledger});
    agents.update(agent.id, {status: "idle", latestResponse: "Completed after restore"});
    tracker.restore();
    const deadline = Date.now() + 3000;
    while (f.store.findInvocationByOperationId(context.operation_id!)?.state !== "succeeded" && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(f.store.findInvocationByOperationId(context.operation_id!)?.state, "succeeded");
    assert.equal(f.store.pendingAgentOperations().length, 0);
  } finally {
    // 先停止观察者，再关闭旁路数据库；fixture 的 after 随后才能删除 Windows 文件。
    try { await tracker?.close(); } finally { agents.close(); }
  }
});

test("unknown, completed, cancelled, partial, and permanent failures never start another attempt", async t => {
  const f = await fixture(); t.after(() => f.close());
  for (const state of ["completed", "unknown", "partial", "cancelled", "permanent"] as const) {
    const input = {operation_key: state};
    const path = join(f.root, state);
    const context = createInvocationContext(f.identity(`${state}-first`));
    await executeRecorded(f.store, context, input, {
      beforeEffect: () => {if (state === "permanent") throw Object.assign(new Error("invalid command"), {code: "INVALID_ARGUMENT"});},
      invoke: async () => {
        if (state === "cancelled") return {cancelled: true};
        await appendFile(path, "once\n");
        if (state === "unknown") throw Object.assign(new Error("response lost"), {code: "REQUEST_TIMEOUT"});
        if (state === "partial") throw Object.assign(new Error("partial write"), {code: "EXECUTION_CONFLICT", effect: "partial"});
        return {ok: true};
      },
      outcome: () => state === "cancelled" ? {state: OperationState.cancelled, effect: "not_started"} : null,
      sideEffecting: true,
    }).catch(() => {});
    const original = f.store.findInvocationByOperationId(context.operation_id!)!;
    const replay = await executeRecorded(f.store, createInvocationContext(f.identity(`${state}-retry`)), input, {
      invoke: async () => {assert.fail(`${state} must not execute again`);},
    });
    assert.equal(replay.replay, true);
    assert.equal(replay.invocation_id, original.id);
    assert.deepEqual(f.store.findInvocationByOperationId(context.operation_id!), original);
    if (["completed", "unknown", "partial"].includes(state)) assert.equal(await readFile(path, "utf8"), "once\n");
  }
});

test("first preparation errors and their replay expose identical not_started semantics", async t => {
  const f = await fixture(); t.after(() => f.close());
  const options = {tool_name: "exec_command", kind: "command" as const, label: "prepare", input: {operation_key: "prepare-error"},
    affectsFiles: true, beforeWrite: async () => {throw new Error("Git preparation unavailable");},
    operation: async () => assert.fail("preparation did not finish")};
  const first = await f.recorder.recordWithContext(createInvocationContext(f.identity("first")), options).catch(error => error);
  const replay = await f.recorder.recordWithContext(createInvocationContext(f.identity("replay")), options).catch(error => error);
  assert.equal(first.effect, "not_started");
  assert.deepEqual(toolErrorResult(first, {forwarded: true, sideEffecting: true}), toolErrorResult(replay, {forwarded: true, sideEffecting: true}));
  assert.equal(f.store.findInvocationByOperationId(f.store.findInvocation("owner", "transport", "first")!.operation_id!)!.request_id, "first");
});

test("schema upgrade binds historical worker attempts using their run link and does not guess a receipt's task", async t => {
  const f = await fixture(); t.after(() => f.close());
  await f.recorder.recordWithContext(createInvocationContext(f.identity("worker")), {
    tool_name: "exec_command", kind: "command", label: "worker", input: {operation_key: "worker-key"}, affectsFiles: true,
    beforeWrite: async () => {throw new ExecutionConflictError("held", undefined, "busy");},
    operation: async () => assert.fail("must not execute"),
  }).catch(() => {});
  await executeRecorded(f.store, createInvocationContext(f.identity("receipt")), {operation_key: "receipt-key"}, {
    invoke: async () => {throw new ExecutionConflictError("held", undefined, "busy");}, forwarded: true,
  }).catch(() => {});
  const before = f.ledger.db.prepare("SELECT id,operation_id,result_json FROM qm_invocations ORDER BY rowid").all();
  const beforeRuns = f.ledger.db.prepare("SELECT * FROM console_work_runs ORDER BY id").all();
  const beforeOperations = f.ledger.db.prepare("SELECT * FROM console_operations ORDER BY id").all();
  const quiescenceObjects = f.ledger.db.prepare(`SELECT type,name,sql FROM sqlite_master
    WHERE name GLOB 'execution_quiescence*'
      OR name IN ('console_operations_maintenance_status','console_executions_maintenance_status') ORDER BY name`);
  const latestQuiescenceObjects = quiescenceObjects.all() as Array<{type:string;name:string;sql:string}>;
  const quiescenceTriggers = latestQuiescenceObjects.filter(row => row.type === "trigger");
  assert.equal(quiescenceTriggers.length, 9);
  // 用真实数据库还原版本 5，保留原始回执与运行关联后执行升级。
  // 这些触发器挂在 operation/execution/owner 表上，删证据表不会自动移除它们。
  for (const {name} of quiescenceTriggers) f.ledger.db.exec(`DROP TRIGGER "${name}"`);
  f.ledger.db.exec(`DROP TABLE execution_quiescence;
    DROP INDEX console_operations_maintenance_status;
    DROP INDEX console_executions_maintenance_status;
    DROP INDEX qm_invocations_retry_of;
    ALTER TABLE qm_invocations DROP COLUMN retry_of_invocation_id;
    ALTER TABLE qm_invocations DROP COLUMN task_id;
    ALTER TABLE qm_invocations DROP COLUMN response_json;
    DROP TABLE console_archive_steps;
    DROP TABLE console_audit;
    DROP TABLE console_audit_imports;
    DROP TABLE execution_owners;
    DROP INDEX qm_events_source_type;
    DROP INDEX qm_events_operation_type;
    DELETE FROM qm_schema_migrations WHERE version>=6;`);
  assert.equal(f.ledger.db.prepare('SELECT max(version) FROM qm_schema_migrations').pluck().get(),5);
  assert.deepEqual(quiescenceObjects.all(), []);
  assert.equal(f.ledger.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='execution_owners'").get(), undefined);
  assert.ok(!(f.ledger.db.pragma('table_info(qm_invocations)') as Array<{name:string}>)
    .some(column=>["task_id","retry_of_invocation_id","response_json"].includes(column.name)));
  assert.deepEqual(f.ledger.db.prepare("SELECT id,operation_id,result_json FROM qm_invocations ORDER BY rowid").all(), before);
  migrateDatabase(f.ledger.db); migrateDatabase(f.ledger.db);
  assert.equal(f.ledger.db.prepare('SELECT max(version) FROM qm_schema_migrations').pluck().get(),LATEST_DATABASE_VERSION);
  assert.deepEqual(quiescenceObjects.all(), latestQuiescenceObjects);
  assert.equal(f.store.findInvocation("owner", "transport", "worker")!.task_id, f.task.id);
  assert.equal(f.store.findInvocation("owner", "transport", "receipt")!.task_id, null);
  assert.equal(f.store.findInvocation("owner", "transport", "worker")!.response_json,null);
  assert.equal(f.store.findInvocation("owner", "transport", "receipt")!.response_json,null);
  assert.deepEqual(f.ledger.db.prepare("SELECT id,operation_id,result_json FROM qm_invocations ORDER BY rowid").all(), before);
  assert.deepEqual(f.ledger.db.prepare("SELECT * FROM console_work_runs ORDER BY id").all(), beforeRuns);
  assert.deepEqual(f.ledger.db.prepare("SELECT * FROM console_operations ORDER BY id").all(), beforeOperations);
  assert.equal(f.ledger.db.pragma("integrity_check", {simple:true}), "ok");
  assert.deepEqual(f.ledger.db.pragma("foreign_key_check"), []);
});

test("a refusal cannot be inherited by a new task or another session for the same workspace", async t => {
  const f = await fixture(); t.after(() => f.close());
  const input = {operation_key: "bound-task"};
  await executeRecorded(f.store, createInvocationContext(f.identity("first")), input, {
    beforeEffect: () => {throw new ExecutionConflictError("held", undefined, "busy");}, invoke: async () => assert.fail("must be refused"),
  }).catch(() => {});
  f.store.closeTask(f.task.id, "failed", "Finished before retry");
  const nextTask = f.store.createTask(f.session.id, "A new task");
  const next = createInvocationContext({...f.identity("next-task"), session: {...f.identity("unused").session, task_id: nextTask.id}});
  await assert.rejects(executeRecorded(f.store, next, input, {invoke: async () => assert.fail("old key must not move tasks")}), /OPERATION_RETRY_SCOPE_MISMATCH/);
  const otherSession = f.store.createSession("owner", "other-conversation", "Another session");
  const otherMember = f.store.addMember(otherSession.id, "local", "workspace", f.root, "checkout", null);
  const otherTask = f.store.createTask(otherSession.id, "Another task");
  const other = createInvocationContext({...f.identity("other"), session: {session_id: otherSession.id, member_id: otherMember.id,
    workspace_id: otherMember.workspace_id, task_id: otherTask.id}});
  await assert.rejects(executeRecorded(f.store, other, input, {invoke: async () => assert.fail("old key must not move sessions")}), /OPERATION_RETRY_SCOPE_MISMATCH/);
});

test("two real processes race to retry one refused key and append only once", {timeout: 15000}, async t => {
  const f = await fixture(); t.after(() => f.close());
  const input = {operation_key: "process-race"};
  const first = createInvocationContext(f.identity("first"));
  await executeRecorded(f.store, first, input, {beforeEffect: () => {throw new ExecutionConflictError("held", undefined, "busy");},
    invoke: async () => assert.fail("first attempt was not admitted")}).catch(() => {});
  const path = join(f.root, "raced.txt"), file = fileURLToPath(new URL("../../test/reliability-system/admission-racer.ts", import.meta.url));
  const racers = [1, 2].map(index => {
    const child = fork(file, [f.stateDir, JSON.stringify(f.identity(`racer-${index}`)), JSON.stringify(input), path],
      {execPath: process.execPath, execArgv: ["--import", "tsx"], stdio: ["ignore", "pipe", "pipe", "ipc"]});
    t.after(() => {if (child.exitCode === null) child.kill();});
    let stderr = ""; child.stderr!.on("data", chunk => {stderr += chunk;});
    const ready = new Promise<void>(resolve => child.once("message", () => resolve()));
    const result = new Promise<any>(resolve => child.on("message", message => {if ((message as any).result) resolve((message as any).result);}));
    const exited = new Promise<void>((resolve, reject) => child.once("exit", code => code === 0 ? resolve() : reject(new Error(stderr || `racer exited ${code}`))));
    return {child, ready, result, exited};
  });
  await Promise.all(racers.map(racer => racer.ready));
  racers.forEach(racer => racer.child.send({go: true}));
  const results = await Promise.all(racers.map(racer => racer.result));
  await Promise.all(racers.map(racer => racer.exited));
  assert.equal(results.filter(result => !result.replay).length, 1);
  assert.equal(results[0].invocation_id, results[1].invocation_id);
  assert.ok(results.every(result => result.operation_id === first.operation_id));
  assert.equal((await readFile(path, "utf8")).trim().split("\n").length, 1);
  t.diagnostic(JSON.stringify({operation_id: first.operation_id, results}));
});
