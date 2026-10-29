import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import Database from "better-sqlite3";
import { WorkLedger } from "../work-ledger.js";
import { ExecutionCoordinator } from "../execution-coordinator.js";
import type { WorkspaceRegistry } from "../workspaces.js";
import { taskExecutionEntryFromAuthInfo } from "../tasks/task-binding.js";
import { SessionService } from "./service.js";
import { SessionProjector } from "./projection.js";
import { createInvocationContext, executeRecorded } from "./invocations.js";
import { SessionStore } from "./store.js";
import { admitTaskWorkInTransaction, FinalizationDispatchError } from "./task-finalization.js";

const entry=(id:string)=>taskExecutionEntryFromAuthInfo({clientId:"client",extra:{owner_id:"owner"}},id);
async function fixture(t:TestContext) {
  const directory=await mkdtemp(join(tmpdir(),"qm-finish-fence-")), state=join(directory,"state");
  const ledger=new WorkLedger(state), store=new SessionStore(ledger.db), execution=new ExecutionCoordinator(state);
  const service=new SessionService(store,{} as WorkspaceRegistry,ledger);
  const identity={owner_id:"owner",conversation_id:"original",task_entry:entry("original")};
  const started=await service.startTask(identity,"Persistent goal","goal");
  const member=store.addMember(started.session.id,"local","workspace",directory,"checkout",null);
  store.touchTaskMember(started.task.id,member.id);
  const otherDb=new Database(join(state,"quaymesh.sqlite"));otherDb.pragma("foreign_keys=ON");otherDb.pragma("busy_timeout=0");
  const other=new SessionStore(otherDb);
  t.after(async()=>{await service.close();otherDb.close();execution.close();ledger.close();await rm(directory,{recursive:true,force:true});});
  const failSafe=async()=> {
    const intent=await store.writeAsync(()=>store.taskData.requestFinalization(started.task.id,"completed","old finish"));
    await store.writeAsync(()=>store.taskData.finishFinalization(started.task.id,"local pre-dispatch failure",intent.finalization_revision));
    return store.taskData.finalization(started.task.id)!;
  };
  return {directory,ledger,store,otherDb,other,execution,service,identity,member,task:started.task,session:started.session,failSafe};
}

test("a held background batch cannot revive a safe failed intent after another connection resumes and starts new work",async t=>{
  const f=await fixture(t), old=await f.failSafe();
  f.otherDb.exec("BEGIN IMMEDIATE");
  const retry=f.service.retryFinalizations();
  // Its already-read batch now waits for the real second connection's writer.
  await Promise.resolve();await Promise.resolve();
  f.otherDb.exec("COMMIT");
  await f.other.taskBindings.resume(entry("replacement"),f.task.id,0,"resume-explicit");
  const run=await f.service.ensureRun(f.session,f.member,{kind:"read",label:"new work"},f.task.id);
  await retry;
  const retired=f.store.taskData.finalization(f.task.id)!;
  assert.equal(retired.recovery_state,"superseded");
  assert.equal(retired.finalization_revision,old.finalization_revision+1);
  assert.equal(f.store.getTask(f.task.id).state,"active");
  assert.equal(f.ledger.run(run).status,"running");
  assert.equal(f.store.taskData.pendingFinalizations().some(value=>value.task_id===f.task.id),false);
  assert.equal(await f.store.writeAsync(()=>f.store.taskData.finishFinalization(f.task.id,"late old callback",old.finalization_revision)),false);
  assert.equal(f.store.taskData.finalization(f.task.id)!.error,old.error);
});

test("same-entry new execution also retires a safe failure; a new explicit finish requires an observed Task revision",async t=>{
  const f=await fixture(t), old=await f.failSafe();
  const run=await f.service.ensureRun(f.session,f.member,{kind:"read",label:"continue without changing chat"},f.task.id);
  assert.equal(f.store.taskData.finalization(f.task.id)!.recovery_state,"superseded");
  await assert.rejects(f.service.finishTask("owner",f.task.id,"completed","old finish"),{code:"TASK_REVISION_REQUIRED",effect:"not_started"});
  await assert.rejects(f.service.finishTask("owner",f.task.id,"completed","new final result",f.store.getTask(f.task.id).revision-1),
    {code:"TASK_REVISION_CONFLICT",effect:"not_started"});
  const revision=f.store.getTask(f.task.id).revision;
  const newer=await f.store.writeAsync(()=>f.store.taskData.requestFinalization(f.task.id,"completed","new final result",revision));
  assert.ok(newer.finalization_revision>old.finalization_revision);
  assert.equal(await f.store.writeAsync(()=>f.store.taskData.finishFinalization(f.task.id,"late error",old.finalization_revision)),false);
  await assert.rejects(f.store.writeAsync(()=>f.store.completeTaskFinalization(f.task.id,"completed","old finish",old.finalization_revision)));
  assert.equal(f.ledger.run(run).status,"running");
  await f.service.finishTask("owner",f.task.id,"completed","new final result",f.store.getTask(f.task.id).revision);
  assert.equal(f.store.getTask(f.task.id).state,"closed");
});

test("retry admission that wins first blocks resume; old resume-key replay never retires a later safe failure",async t=>{
  const f=await fixture(t), receiving=entry("receiving");
  const selected=await f.store.taskBindings.resume(receiving,f.task.id,0,"saved-resume");
  const old=await f.failSafe();
  assert.equal((await f.store.taskBindings.resume(receiving,f.task.id,0,"saved-resume")).replayed,true);
  assert.equal(f.store.taskData.finalization(f.task.id)!.finalization_revision,old.finalization_revision);
  const admitted=await f.store.writeAsync(()=>f.store.taskData.requestFinalization(f.task.id,old.status,old.summary,undefined,old.mailbox_sequence,
    {expectedFinalizationRevision:old.finalization_revision}));
  await assert.rejects(f.other.taskBindings.resume(receiving,f.task.id,selected.binding.revision,"new-resume"),{code:"TASK_FINISHING"});
  assert.equal(f.store.taskData.finalization(f.task.id)!.finalization_revision,admitted.finalization_revision);
  await assert.rejects(f.other.writeAsync(()=>f.other.taskData.requestFinalization(f.task.id,old.status,old.summary,undefined,0,
    {expectedFinalizationRevision:old.finalization_revision})),{code:"TASK_FINALIZATION_SUPERSEDED"});
});

test("legacy unknown and possibly dispatched failures block only new execution, while mailbox receipt and reply remain usable",async t=>{
  const f=await fixture(t), scope={principal:f.identity.task_entry.principal,taskId:f.task.id};
  const intent=await f.failSafe();
  f.ledger.db.prepare("UPDATE qm_task_finalizations SET recovery_state=NULL WHERE task_id=?").run(f.task.id);
  assert.equal(f.store.taskBindings.inspect(entry("replacement"),f.task.id).can_resume,false);
  await assert.rejects(f.store.taskBindings.resume(entry("replacement"),f.task.id,0,"unknown-resume"),{code:"TASK_FINISHING"});
  await assert.rejects(f.store.writeAsync(()=>admitTaskWorkInTransaction(f.ledger.db,f.task.id)),{code:"TASK_FINISHING",effect:"not_started"});
  await f.store.mailbox.enqueue(scope,{messageKey:"after-unknown",body:"先核对原操作，不要重新执行。"});
  const receiverId=await f.store.mailbox.bindReceiver(scope,{clientId:"client",correlationId:"new-entry"});
  const claim=await f.store.mailbox.claim(scope,{receiverId,requestKey:"read-after-unknown"});
  assert.equal(claim.status,"offered");if(claim.status!=="offered")throw new Error("expected delivery");
  await f.store.mailbox.acknowledge(scope,{receiverId,deliveryId:claim.deliveryId,messageIds:claim.messages.map(value=>value.id)});
  await f.store.mailbox.reply(scope,{receiverId,messageKey:"reply-after-unknown",replyTo:claim.messages.map(value=>value.id),body:"已收到；保留原结束意图供核对。"});
  assert.equal(f.store.mailbox.inspect(scope).pending,0);
  assert.equal(f.store.getTask(f.task.id).state,"active");
  assert.equal(f.store.taskData.finalization(f.task.id)!.finalization_revision,intent.finalization_revision);
  assert.equal(f.store.taskData.pendingFinalizations().some(value=>value.task_id===f.task.id),false,"a changed mailbox cutoff cannot auto-close the Task");
});

test("failure before owner dispatch is safe, but delegated Worker intent and previous uncertainty remain sticky",async t=>{
  const f=await fixture(t);
  const lease=f.execution.beginWork({kind:"tool",taskId:f.task.id});
  try {await assert.rejects(f.service.finishTask("owner",f.task.id,"completed","old finish"),/TASK_HAS_ACTIVE_EXECUTIONS/);}
  finally {lease.release();}
  assert.equal(f.store.taskData.finalization(f.task.id)!.recovery_state,"safe");
  await f.store.taskBindings.resume(entry("new-entry"),f.task.id,0,"continue");
  const remoteRoot = join(f.directory, "remote");
  await mkdir(remoteRoot);
  const remote=f.store.addMember(f.session.id,"remote","remote-workspace",remoteRoot,"checkout",null);
  f.store.touchTaskMember(f.task.id,remote.id);
  f.service.setRemoteFinalizer(async()=>{throw new FinalizationDispatchError([new Error("all local sends refused")],true);});
  await assert.rejects(f.service.finishTask("owner",f.task.id,"completed","new finish",f.store.getTask(f.task.id).revision),FinalizationDispatchError);
  assert.equal(f.store.taskData.finalization(f.task.id)!.recovery_state,"safe");
  f.ledger.db.prepare("UPDATE qm_task_finalizations SET recovery_state=NULL WHERE task_id=?").run(f.task.id);
  await assert.rejects(f.service.finishTask("owner",f.task.id,"completed","new finish"),FinalizationDispatchError);
  assert.equal(f.store.taskData.finalization(f.task.id)!.recovery_state,"reconcile","a later all-unsent attempt cannot erase an older unknown dispatch");
  await assert.rejects(f.store.taskBindings.resume(entry("another-entry"),f.task.id,0,"cannot-reopen"),{code:"TASK_FINISHING"});

  const selected=f.store.taskBindings.current(f.identity.task_entry!)!;
  const local=await f.service.startTask(f.identity,"Worker delegated goal","worker-task",undefined,
    {newGoal:true,expectedBindingRevision:selected.revision});
  const blocker=f.execution.beginWork({kind:"tool",taskId:local.task.id});
  try {await assert.rejects(f.service.finishOwnedTask("owner",local.task.id,"completed","delegated finish"),/TASK_HAS_ACTIVE_EXECUTIONS/);}
  finally {blocker.release();}
  assert.equal(f.store.taskData.finalization(local.task.id)!.recovery_state,"reconcile");
  await assert.rejects(f.store.writeAsync(()=>admitTaskWorkInTransaction(f.ledger.db,local.task.id)),{code:"TASK_FINISHING",effect:"not_started"});
  await f.service.finishOwnedTask("owner",local.task.id,"completed","delegated finish");
  assert.equal(f.store.getTask(local.task.id).state,"closed");
});

test("a not-started operation retries once under its original key after the later safe finish is retired",async t=>{
  const f=await fixture(t),file=join(f.directory,"once.txt"),input={operation_key:"original-key",patch:"one intended write"};
  const context=(id:string)=>createInvocationContext({auth:{owner_id:"owner"},transport:{instance_id:"transport"},
    request:{id,conversation_id:"original",tool_name:"apply_patch"},session:{session_id:f.session.id,task_id:f.task.id,member_id:f.member.id,workspace_id:f.member.workspace_id}});
  let effects=0;
  const write=async()=>{effects++;await appendFile(file,"once\n");return {ok:true};};
  await assert.rejects(executeRecorded(f.store,context("first"),input,{sideEffecting:true,beforeEffect:()=>{
    throw Object.assign(new Error("owner temporarily unavailable before send"),{code:"NODE_UNAVAILABLE",effect:"not_started",retryHint:"retry_later"});
  },invoke:write}),{code:"NODE_UNAVAILABLE",effect:"not_started"});
  const original=f.store.findInvocation("owner","transport","first")!;
  await f.failSafe();
  await f.store.taskBindings.resume(entry("resume-original-key"),f.task.id,0,"continue-original-intended-write");
  const operation={sideEffecting:true,beforeEffect:()=>f.store.writeAsync(()=>admitTaskWorkInTransaction(f.ledger.db,f.task.id)),invoke:write};
  const retried=await executeRecorded(f.store,context("second"),input,operation);
  assert.equal(retried.operation_id,original.operation_id);assert.equal(retried.replay,false);
  const replay=await executeRecorded(f.store,context("third"),input,operation);
  assert.equal(replay.replay,true);assert.equal(effects,1);assert.equal(await readFile(file,"utf8"),"once\n");
  assert.equal(f.store.findInvocation("owner","transport","first")!.result_json,original.result_json,"original failed receipt stays immutable");
  assert.equal(f.store.getTask(f.task.id).state,"active");
});

test("retired finish disappears from current Task notices; uncertain failed finish still blocks continuation and remains visible",async t=>{
  const f=await fixture(t),projector=new SessionProjector(f.store,join(f.directory,"state"));
  t.after(()=>projector.close());
  await f.failSafe();
  const failed=(await projector.readTask(f.task.id,-1)).snapshot!;
  assert.equal(failed.finalization?.state,"failed");
  await f.store.taskBindings.resume(entry("clear-retired-notice"),f.task.id,0,"resume");
  const resumed=(await projector.readTask(f.task.id,-1)).snapshot!;
  assert.equal(resumed.finalization,null);assert.equal(resumed.capabilities.continue,true);
  assert.equal(resumed.notices.some(value=>value.includes("任务结束尚未确认")),false);
  assert.equal(f.store.taskData.finalization(f.task.id)!.recovery_state,"superseded","history stays persisted");
  const next=await f.store.writeAsync(()=>f.store.taskData.requestFinalization(f.task.id,"completed","new uncertain finish",f.store.getTask(f.task.id).revision));
  await f.store.writeAsync(()=>f.store.taskData.markFinalizationDispatched(f.task.id,next.finalization_revision));
  await f.store.writeAsync(()=>f.store.taskData.finishFinalization(f.task.id,"owner result unknown",next.finalization_revision));
  const uncertain=(await projector.readTask(f.task.id,-1)).snapshot!;
  assert.equal(uncertain.finalization?.state,"failed");assert.equal(uncertain.capabilities.continue,false);
  assert.equal(uncertain.notices.some(value=>value.includes("任务结束尚未确认")),true);
});
