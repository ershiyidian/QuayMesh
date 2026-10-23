import assert from "node:assert/strict";
import test,{type TestContext} from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkLedger } from "./work-ledger.js";
import { WorkRunReconciler } from "./work-run-reconciler.js";
import { ExecutionCoordinator } from "./execution-coordinator.js";
import { pidAlive } from "./process-liveness.js";
import { processStartIdentity } from "./process-identity.js";

async function fixture(t:TestContext,mode="agent") {
  const directory=await mkdtemp(join(tmpdir(),"qm-live-owner-"));
  const child=spawn(process.execPath,["--import","tsx",fileURLToPath(new URL("./test-support/live-execution-owner.ts",import.meta.url)),directory,mode],
    {stdio:["ignore","ignore","pipe","ipc"]});
  let stderr="";child.stderr!.on("data",value=>{stderr+=String(value);});
  const wait=(type:string,id?:number)=>new Promise<any>((resolve,reject)=>{
    const timer=setTimeout(()=>finish(new Error(`Owner fixture timeout: ${stderr}`)),10_000);
    const onMessage=(value:any)=>{if(value.type==="error")finish(new Error(value.message));else if(value.type===type&&(id===undefined||value.id===id))finish(undefined,value);};
    const onExit=()=>finish(new Error(`Owner exited before ${type}: ${stderr}`));
    function finish(error?:Error,value?:unknown){clearTimeout(timer);child.off("message",onMessage);child.off("exit",onExit);error?reject(error):resolve(value);}
    child.on("message",onMessage);child.on("exit",onExit);
  });
  let ready:any;
  let ledger!:WorkLedger,reconciler!:WorkRunReconciler,coordinator!:ExecutionCoordinator;
  let sequence=0;
  const rpc=(action:string)=>{const id=++sequence,result=wait("reply",id);child.send({id,action});return result;};
  t.after(async()=>{
    if (child.exitCode===null && child.signalCode===null) {
      const ended=once(child,"exit");try{if(ready)await rpc("close");else child.kill();}catch{child.kill();}await ended;
    }
    if (ready?.descendantPid && pidAlive(ready.descendantPid)
      && (ready.descendantStart===null || processStartIdentity(ready.descendantPid)===ready.descendantStart)) {
      try{process.kill(ready.descendantPid,"SIGKILL");}catch{}
      for(let i=0;i<100&&pidAlive(ready.descendantPid);i++)await new Promise(resolve=>setTimeout(resolve,10));
    }
    await reconciler?.close();coordinator?.close();ledger?.close();await rm(directory,{recursive:true,force:true});
  });
  ready=await wait("ready");
  ledger=new WorkLedger(directory);reconciler=new WorkRunReconciler(directory);coordinator=new ExecutionCoordinator(directory);
  return {ready,ledger,reconciler,coordinator,rpc,child,directory};
}

test("真实存活 owner 跨 Core startup 保持执行，暂时待核对仍能收口同一执行",{timeout:20_000},async t=>{
  const f=await fixture(t),before=f.ledger.run(f.ready.runId);
  assert.notEqual(process.pid,f.ready.pid);
  f.reconciler.startup();
  assert.equal(f.ledger.execution(f.ready.executionId).status,"running");
  assert.equal(f.ledger.execution(f.ready.executionId).finished_at,null);
  assert.equal(f.ledger.db.prepare("SELECT status FROM console_operations WHERE id=?").pluck().get(f.ready.operationId),"running");
  assert.deepEqual(f.ledger.run(f.ready.runId),before);
  assert.equal((await f.rpc("ping")).start,f.ready.start);
  assert.equal(processStartIdentity(f.ready.pid),f.ready.start);
  // 保留旧版可能已经写入的待核对状态，原 owner 必须能保存真实终态。
  f.ledger.db.prepare("UPDATE console_executions SET status='reconciliation_required' WHERE id=?").run(f.ready.executionId);
  f.ledger.db.prepare("UPDATE console_operations SET status='reconciliation_required' WHERE id=?").run(f.ready.operationId);
  f.ledger.markRunReconciliationRequired(f.ready.runId);
  await f.rpc("complete");
  assert.equal(f.ledger.execution(f.ready.executionId).status,"completed");
  assert.ok(f.ledger.successfulExecution(f.ready.agentId,f.ready.runId)?.responseAvailable);
  assert.equal(f.ledger.db.prepare("SELECT status FROM console_operations WHERE id=?").pluck().get(f.ready.operationId),"completed");
  assert.equal(f.ledger.run(f.ready.runId).status,"running");
  assert.equal(f.coordinator.admissionStatus().idle,true);
});

test("旧版 live claim 保持活动；已取消终态拒绝迟到完成",{timeout:20_000},async t=>{
  const f=await fixture(t);
  f.ledger.db.exec("DELETE FROM execution_owners");
  f.reconciler.startup();
  assert.equal(f.ledger.execution(f.ready.executionId).status,"running");
  assert.equal(f.ledger.run(f.ready.runId).status,"running");
  await f.rpc("cancel");
  assert.equal(f.ledger.execution(f.ready.executionId).status,"cancelled");
  assert.equal(f.ledger.db.prepare("SELECT status FROM console_operations WHERE id=?").pluck().get(f.ready.operationId),"cancelled");
});

test("原 owner 已保存真实成功响应后退出，startup 直接收口执行并释放终态 claim",{timeout:20_000},async t=>{
  const f=await fixture(t),ended=once(f.child,"exit");
  await f.rpc("persist_completion");await ended;
  assert.equal(f.ledger.execution(f.ready.executionId).status,"running");
  f.reconciler.startup();
  assert.equal(f.ledger.execution(f.ready.executionId).status,"completed");
  assert.ok(f.ledger.successfulExecution(f.ready.agentId,f.ready.runId)?.responseAvailable);
  assert.equal(f.ledger.db.prepare("SELECT 1 FROM execution_claims WHERE id=?").get(f.ready.claimId),undefined);
  assert.equal(f.coordinator.admissionStatus().idle,true);
});

test("agent 控制操作结束不能替代该 agent 的真实执行终态来释放死 owner claim",{timeout:20_000},async t=>{
  const f=await fixture(t),ended=once(f.child,"exit");
  f.ledger.endOperation(f.ready.operationId,"completed");
  await f.rpc("abandon");await ended;
  f.reconciler.startup();
  assert.equal(f.ledger.execution(f.ready.executionId).status,"reconciliation_required");
  assert.ok(f.ledger.db.prepare("SELECT 1 FROM execution_claims WHERE id=?").get(f.ready.claimId));
  assert.equal(f.coordinator.admissionStatus().idle,false);
});

test("Core owner 退出后仍存活的真实子进程保留 claim，禁止新写入和升级空闲判定",{timeout:20_000},async t=>{
  const f=await fixture(t,"command"),ended=once(f.child,"exit");
  assert.equal(pidAlive(f.ready.descendantPid),true,"descendant must be alive before its owner exits");
  const descendantStart=processStartIdentity(f.ready.descendantPid);
  if(f.ready.descendantStart!==null)assert.equal(descendantStart,f.ready.descendantStart);
  await f.rpc("abandon");await ended;
  assert.equal(pidAlive(f.ready.pid),false);
  assert.equal(pidAlive(f.ready.descendantPid),true);
  if(descendantStart!==null)assert.equal(processStartIdentity(f.ready.descendantPid),descendantStart,
    "the same descendant generation must survive its owner");
  f.reconciler.startup();
  assert.ok(f.ledger.db.prepare("SELECT 1 FROM execution_claims WHERE id=?").get(f.ready.claimId));
  assert.equal(f.ledger.db.prepare("SELECT status FROM console_operations WHERE id=?").pluck().get(f.ready.operationId),"reconciliation_required");
  assert.equal(f.coordinator.admissionStatus().idle,false);
  assert.throws(()=>f.coordinator.acquire({workspaceRoot:join(f.directory,"project"),kind:"mutation"}),/执行资源暂时不可用/);
  const audits=f.ledger.db.prepare("SELECT count(*) FROM execution_claim_reconciliations").pluck().get();
  f.reconciler.tick();assert.equal(f.ledger.db.prepare("SELECT count(*) FROM execution_claim_reconciliations").pluck().get(),audits);
});

test("PID 相同而启动身份不同的旧执行进入待核对，未知不会写伪造完成时间",{timeout:20_000},async t=>{
  const f=await fixture(t);
  if (processStartIdentity(f.ready.pid)===null) {t.skip("当前平台或进程 namespace 未提供可读取的进程启动身份");return;}
  f.ledger.db.prepare("UPDATE execution_owners SET process_start='previous-process-generation' WHERE domain='execution' AND id=?").run(f.ready.executionId);
  f.reconciler.startup();
  assert.equal(f.ledger.execution(f.ready.executionId).status,"reconciliation_required");
  assert.equal(f.ledger.execution(f.ready.executionId).finished_at,null);
  assert.equal(pidAlive(f.ready.pid),true);
});
