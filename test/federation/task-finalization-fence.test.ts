import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { openDatabase } from "../../src/db/client.js";
import { SessionStore } from "../../src/session/store.js";
import type { TaskBindingView } from "../../src/tasks/task-binding.js";
import { createRealTestServer, freePort, structured, waitForFixture, waitForRecordedTool,
  type RealTestServer } from "../session-card/server-fixture.js";

const token = "task-finalization-real-federation-test-cluster-secret";
const coordinatorId = "finish-coordinator", workerId = "finish-worker";
const capabilities = (coordinator: boolean, worker: boolean) => ({ coordinator, worker, discovery: false,
  egress: false, meshRelay: coordinator, desktopUi: false, consoleRelay: false });
type ToolResult = Awaited<ReturnType<RealTestServer["client"]["callTool"]>>;
interface TaskReply { task_id: string; session_id: string }
interface OpenReply extends TaskReply { workspace_id: string }
interface ResumeReply extends TaskReply { binding: TaskBindingView; task_revision:number; finalization:{status:string;summary:string;recovery_state:string|null;revision:number}|null }
function value<T>(result: ToolResult): T {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return structured(result) as unknown as T;
}

async function fixture(t: TestContext) {
  const workerPort = await freePort(), coordinatorPort = await freePort();
  const configure = async (config: RealTestServer["config"]) => {
    const tokenFile = join(config.stateDir, "task-binding-test-cluster-token");
    await writeFile(tokenFile, token);
    return { ...config, federation: { ...config.federation, coordinatorId, tokenFile,
      tokenEnv: "QUAYMESH_TASK_BINDING_TEST_UNUSED_TOKEN" } };
  };
  const worker = await createRealTestServer({ git: false, prefix: "qm-task-binding-worker-", configure,
    federation: { nodeId: workerId, nickname: "Task binding worker", capabilities: capabilities(false, true), priority: 0,
      port: workerPort, ingressPort: await freePort(), peers: [{ id: coordinatorId, url: "" }] } });
  let coordinatorForCleanup: RealTestServer | undefined, closeReaders = () => {};
  t.after(async () => { closeReaders(); await coordinatorForCleanup?.dispose(); await worker.dispose(); });
  const coordinator = await createRealTestServer({ git: false, prefix: "qm-task-binding-coordinator-", configure,
    federation: { nodeId: coordinatorId, nickname: "Task binding authority", capabilities: capabilities(true, false), priority: 100,
      port: coordinatorPort, ingressPort: await freePort(), peers: [{ id: workerId, url: `http://127.0.0.1:${workerPort}` }] } });
  coordinatorForCleanup = coordinator;
  const db = openDatabase(coordinator.config.stateDir), workerDb = openDatabase(worker.config.stateDir);
  const store = new SessionStore(db.sqlite), workerStore = new SessionStore(workerDb.sqlite);
  closeReaders = () => { if (db.sqlite.open) db.close(); if (workerDb.sqlite.open) workerDb.close(); };
  const call = (entry: string, name: string, args: Record<string, unknown>) => coordinator.client.callTool({
    name, arguments: args, _meta: { "openai/session": entry },
  });
  const select = async (entry: string, taskId: string, key: string) => {
    const state = value<ResumeReply>(await call(entry, "task_resume", { action: "inspect", task_id: taskId }));
    return value<ResumeReply>(await call(entry, "task_resume", { action: "resume", task_id: taskId,
      expected_binding_revision: state.binding.binding_revision, request_key: key }));
  };
  await waitForFixture(coordinator, { sessionId: "not-created" }, "actual Worker peer connects", async () =>
    Boolean(coordinator.running.federation?.transport.links.get(workerId)?.connected), Boolean);
  const started = value<TaskReply>(await call("original", "start_session", { title: "Federated original goal", request_key: "original" }));
  const opened = value<OpenReply>(await call("original", "open_workspace", { root_id: `${workerId}/main` }));
  await select("replacement", started.task_id, "same-task-new-entry");
  return { worker, coordinator, db, workerDb, store, workerStore, call, select, started, opened, coordinatorPort };
}

test("real MCP: resume retires only an unsent finish; inspect exposes the revision needed for a new explicit finish",{timeout:60000},async t=>{
  const f=await fixture(t);
  const old=await f.store.writeAsync(()=>f.store.taskData.requestFinalization(f.started.task_id,"completed","old finish"));
  await f.store.writeAsync(()=>f.store.taskData.finishFinalization(f.started.task_id,"local pre-dispatch failure",old.finalization_revision));
  const inspected=value<ResumeReply>(await f.call("replacement","task_resume",{action:"inspect",task_id:f.started.task_id}));
  assert.equal(inspected.finalization?.recovery_state,"safe");
  await f.select("replacement",f.started.task_id,"explicitly-continue-after-failed-finish");
  assert.equal(f.store.taskData.finalization(f.started.task_id)!.recovery_state,"superseded");
  const stale=await f.call("replacement","finish_task",{task_id:f.started.task_id,status:"completed",summary:"old finish"});
  assert.equal(stale.isError,true,JSON.stringify(stale));assert.match(JSON.stringify(stale),/TASK_REVISION_REQUIRED/);
  assert.equal(structured(stale).effect,"not_started");
  assert.equal(f.workerStore.getTask(f.started.task_id).state,"active");
  const current=value<ResumeReply>(await f.call("replacement","task_resume",{action:"inspect",task_id:f.started.task_id}));
  assert.equal(current.task_revision,f.store.getTask(f.started.task_id).revision);
  const response=await f.call("replacement","finish_task",{task_id:f.started.task_id,status:"completed",summary:"reviewed final result",
    expected_task_revision:current.task_revision});
  assert.notEqual(response.isError,true,JSON.stringify(response));
  await waitForFixture(f.coordinator,{sessionId:f.started.session_id},"explicit current finish closes the original Task",async()=>f.store.getTask(f.started.task_id).state,state=>state==="closed");
  assert.equal(f.workerStore.getTask(f.started.task_id).state,"closed");
});

test("one real Worker has closed while another is offline: no resume/new directory/write, but original output and messages stay usable",{timeout:90000},async t=>{
  const f=await fixture(t),script=join(f.worker.project,"history-before-finalize.cjs");
  await writeFile(script,"console.log('original accepted output');\n");
  const command=await f.call("replacement","exec_command",{workspace_id:f.opened.workspace_id,cmd:`"${process.execPath}" "${script}"`,yield_time_ms:100,operation_key:"before-finish"});
  const operationId=value<{operation_id:string}>(command).operation_id;
  await waitForRecordedTool(f.coordinator,{sessionId:f.started.session_id,workspaceId:f.opened.workspace_id,conversationId:"replacement"},command);
  const offline=f.store.addMember(f.started.session_id,"offline-owner","offline-workspace",f.coordinator.project,"checkout",null);
  f.store.touchTaskMember(f.started.task_id,offline.id);
  await f.call("replacement","finish_task",{task_id:f.started.task_id,status:"completed",summary:"original requested result"}).catch(()=>null);
  const intent=await waitForFixture(f.coordinator,{sessionId:f.started.session_id},"whole owner fan-out records uncertainty",async()=>f.store.taskData.finalization(f.started.task_id),value=>Boolean(value?.error));
  assert.equal(intent?.recovery_state,"reconcile");
  assert.equal(f.workerStore.getTask(f.started.task_id).state,"closed","the reachable owner really completed before the other owner failed");
  assert.equal(f.store.getTask(f.started.task_id).state,"active");
  const observed=value<ResumeReply>(await f.call("new-entry","task_resume",{action:"inspect",task_id:f.started.task_id}));
  assert.equal(observed.binding.can_resume,false);assert.equal(observed.finalization?.summary,"original requested result");
  const resumed=await f.call("new-entry","task_resume",{action:"resume",task_id:f.started.task_id,expected_binding_revision:0,request_key:"cannot-undo-partial-close"});
  assert.equal(resumed.isError,true,JSON.stringify(resumed));assert.match(JSON.stringify(resumed),/TASK_FINISHING/);
  const deniedDirectory=join(f.worker.project,"must-not-create-after-unknown");
  const opened=await f.call("replacement","attach_workspace",{session_id:f.started.session_id,root_id:`${workerId}/main`,subdirectory:"must-not-create-after-unknown",create_directory:true});
  assert.equal(opened.isError,true,JSON.stringify(opened));assert.match(JSON.stringify(opened),/TASK_FINISHING/);assert.equal(existsSync(deniedDirectory),false);
  const written=await f.call("replacement","apply_patch",{workspace_id:f.opened.workspace_id,operation_key:"must-not-write-after-unknown",patch:"*** Begin Patch\n*** Add File: after-unknown.txt\n+forbidden new work\n*** End Patch"});
  const rejected=await waitForFixture(f.coordinator,{sessionId:f.started.session_id},"new remote write is rejected before dispatch",async()=>
    f.db.sqlite.prepare("SELECT state,effect FROM qm_invocations WHERE task_id=? AND tool_name='apply_patch' AND json_extract(arguments_json,'$.operation_key')=?")
      .get(f.started.task_id,"must-not-write-after-unknown") as {state:string;effect:string}|undefined,value=>value?.state==="failed");
  assert.equal(rejected?.effect,"not_started",JSON.stringify(written));
  assert.equal(existsSync(join(f.worker.project,"after-unknown.txt")),false);
  const output=value<{result:string}>(await f.call("replacement","read_output",{workspace_id:f.opened.workspace_id,operation_id:operationId,cursor:0}));
  assert.match(output.result,/original accepted output/);
  const saved=value<{message:{id:string}}>(await f.call("replacement","qm_task_message_enqueue",{task_id:f.started.task_id,message_key:"after-partial-close",body:"请核对已完成的节点结果。"}));
  const delivery=value<{delivery_id:string}>(await f.call("replacement","task_messages",{action:"receive",task_id:f.started.task_id,request_key:"read-after-partial-close"}));
  value(await f.call("replacement","task_messages",{action:"ack",task_id:f.started.task_id,delivery_id:delivery.delivery_id,message_ids:[saved.message.id]}));
  value(await f.call("replacement","task_messages",{action:"reply",task_id:f.started.task_id,message_key:"explain-partial-close",reply_to:[saved.message.id],body:"已收到；保留原Task及结束意图，等待离线节点核对。"}));
  assert.equal(f.store.getTask(f.started.task_id).state,"active");
  assert.equal(f.workerStore.getTask(f.started.task_id).state,"closed");
});

test("actual remote application error claiming not_started is never local whole-round unsent proof",{timeout:60000},async t=>{
  const f=await fixture(t),transport=f.worker.running.federation!.transport,original=transport.handler;
  let received=0;
  const controlled:typeof transport.handler=async(method,params,peer,context)=>{
    if(method==="session.feed" && params.kind==="finalize") {
      received++;
      throw Object.assign(new Error("remote claims request not sent"),{code:"NODE_UNAVAILABLE",effect:"not_started",retryHint:"retry_later",details:{dispatch_state:"not_sent"}});
    }
    return original(method,params,peer,context);
  };
  Reflect.set(transport,"handler",controlled);t.after(()=>Reflect.set(transport,"handler",original));
  await f.call("replacement","finish_task",{task_id:f.started.task_id,status:"completed",summary:"keep uncertain intent"}).catch(()=>null);
  const intent=await waitForFixture(f.coordinator,{sessionId:f.started.session_id},"remote refusal persists conservative recovery",async()=>f.store.taskData.finalization(f.started.task_id),value=>Boolean(value?.error));
  assert.equal(received,1);assert.equal(intent?.recovery_state,"reconcile");
  assert.match(intent?.error ?? "",/finish-worker:NODE_UNAVAILABLE/);
  assert.equal(value<ResumeReply>(await f.call("replacement","task_resume",{action:"inspect",task_id:f.started.task_id})).binding.can_resume,false);
});

test("copy receipt replay leaves a later failed finish intact; a genuinely new copy holds authority Task admission through its owner receipt",{timeout:90000},async t=>{
  const f=await fixture(t);
  await writeFile(join(f.worker.project,"copy-source.txt"),"stable copy contents\n");
  const args={action:"start",source_workspace_id:f.opened.workspace_id,destination_workspace_id:f.opened.workspace_id,
    source_path:"copy-source.txt",destination_path:"copy-once.txt",request_key:"old-copy"};
  const first=value<{id:string}>(await f.call("replacement","copy_artifact",args));
  await waitForFixture(f.coordinator,{sessionId:f.started.session_id},"original copy completes",async()=>
    value<{status:string}>(await f.call("replacement","copy_artifact",{action:"observe",copy_id:first.id})),value=>value.status==="completed");
  const intent=await f.store.writeAsync(()=>f.store.taskData.requestFinalization(f.started.task_id,"completed","failed before any dispatch"));
  await f.store.writeAsync(()=>f.store.taskData.finishFinalization(f.started.task_id,"local pre-dispatch failure",intent.finalization_revision));
  const before=f.store.taskData.finalization(f.started.task_id)!;
  const replay=value<{id:string}>(await f.call("replacement","copy_artifact",args));
  assert.equal(replay.id,first.id);assert.deepEqual(f.store.taskData.finalization(f.started.task_id),before);
  assert.equal(await readFile(join(f.worker.project,"copy-once.txt"),"utf8"),"stable copy contents\n");

  const transport=f.worker.running.federation!.transport,original=transport.handler;
  let enter!:()=>void,release!:()=>void,finalizes=0;
  const entered=new Promise<void>(resolve=>{enter=resolve;}),hold=new Promise<void>(resolve=>{release=resolve;});
  const controlled:typeof transport.handler=async(method,params,peer,context)=>{
    if(method==="artifact.copy" && params.requestKey==="new-copy") {enter();await hold;}
    if(method==="session.feed" && params.kind==="finalize")finalizes++;
    return original(method,params,peer,context);
  };
  Reflect.set(transport,"handler",controlled);t.after(()=>{release();Reflect.set(transport,"handler",original);});
  const work=f.call("replacement","copy_artifact",{...args,request_key:"new-copy",destination_path:"copy-new.txt"});
  await Promise.race([entered,work.then(()=>{throw new Error("copy returned before its actual peer handler boundary");})]);
  try {
    assert.ok(f.store.taskData.activeWork(f.started.task_id)>0,"authority lease spans admission and RPC, before Worker starts its own transfer lease");
    assert.equal(f.store.taskData.finalization(f.started.task_id)!.recovery_state,"superseded");
    await f.call("replacement","finish_task",{task_id:f.started.task_id,status:"completed",summary:"finish after this copy",
      expected_task_revision:f.store.getTask(f.started.task_id).revision}).catch(()=>null);
    const blocked=await waitForFixture(f.coordinator,{sessionId:f.started.session_id},"finish observes the pending authority copy lease",async()=>f.store.taskData.finalization(f.started.task_id),value=>Boolean(value?.error));
    assert.match(blocked?.error ?? "",/TASK_HAS_ACTIVE_EXECUTIONS/);assert.equal(blocked?.recovery_state,"safe");assert.equal(finalizes,0);
  } finally {release();}
  const created=value<{id:string}>(await work);
  await waitForFixture(f.coordinator,{sessionId:f.started.session_id},"new copy completes under the original Task",async()=>
    value<{status:string}>(await f.call("replacement","copy_artifact",{action:"observe",copy_id:created.id})),value=>value.status==="completed");
  assert.equal(await readFile(join(f.worker.project,"copy-new.txt"),"utf8"),"stable copy contents\n");
});
