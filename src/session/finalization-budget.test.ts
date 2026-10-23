import assert from "node:assert/strict";
import test,{type TestContext} from "node:test";
import {createServer} from "node:http";
import {once} from "node:events";
import type {AddressInfo} from "node:net";
import {mkdir,mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {loadConfig} from "../config.js";
import {writeTestQuayMeshConfig} from "../test-support/config.test.js";
import {holdSqliteWriteLock} from "../test-support/sqlite-lock.js";
import {WorkLedger} from "../work-ledger.js";
import {ExecutionCoordinator} from "../execution-coordinator.js";
import {SqliteWorkspaceStore} from "../workspace-store.js";
import {WorkspaceRegistry} from "../workspaces.js";
import {SessionStore} from "./store.js";
import {SessionService} from "./service.js";
import {SessionProjector} from "./projection.js";
import {SessionChangeCollector} from "./changes.js";

async function fixture(t:TestContext){
  const directory=await mkdtemp(join(tmpdir(),"qm-finalization-budget-")),root=join(directory,"project"),stateDir=join(directory,"state");
  await mkdir(root);
  const config=loadConfig(writeTestQuayMeshConfig(join(directory,"config"),{
    storage:{stateDir},workspaces:{allowedRoots:[root],worktreeRoot:join(directory,"worktrees")},
  }));
  const workspaceStore=new SqliteWorkspaceStore(stateDir),workspaces=new WorkspaceRegistry(config,workspaceStore);
  const {workspace}=await workspaces.openWorkspace(root);
  const ledger=new WorkLedger(stateDir),store=new SessionStore(ledger.db),execution=new ExecutionCoordinator(stateDir);
  let entered!:()=>void,requests=0,activeRequests=0,maxActiveRequests=0,releasedAll=false;
  const started=new Promise<void>(resolve=>{entered=resolve;});
  const requestsByTask=new Map<string,number>(),releasedTasks=new Set<string>(),gates=new Map<string,Set<()=>void>>();
  const release=(taskId?:string)=>{
    if(taskId){releasedTasks.add(taskId);for(const open of gates.get(taskId)??[])open();gates.delete(taskId);}
    else {releasedAll=true;for(const waiting of gates.values())for(const open of waiting)open();gates.clear();}
  };
  // 真正的 HTTP 证据读取保持未完成，完整 projector 和 SQLite 归档继续运行。
  const server=createServer(async(req,res)=>{
    const taskId=new URL(req.url??"/","http://fixture").searchParams.get("task_id")??"unknown";
    requests++;requestsByTask.set(taskId,(requestsByTask.get(taskId)??0)+1);
    activeRequests++;maxActiveRequests=Math.max(maxActiveRequests,activeRequests);entered();
    try {
      if(!releasedAll&&!releasedTasks.has(taskId))await new Promise<void>(resolve=>{
        const waiting=gates.get(taskId)??new Set<()=>void>();waiting.add(resolve);gates.set(taskId,waiting);
      });
      res.setHeader("content-type","application/json");res.end(JSON.stringify({allowed:false,reason:"fixture",revision:0}));
    } finally {activeRequests--;}
  });
  server.listen(0,"127.0.0.1");await once(server,"listening");
  const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}/eligibility`;
  const changes=new SessionChangeCollector(store,stateDir);
  const projector=new SessionProjector(store,stateDir,null,async(_sessionId,_memberId,taskId)=>{
    const response=await fetch(`${url}?task_id=${encodeURIComponent(taskId??"unknown")}`);return response.json();
  },"local");
  const service=new SessionService(store,workspaces,ledger,undefined,changes,projector,undefined,"local",execution);
  const session=store.createSession("owner","finalization-budget","Real archive"),
    member=store.addMember(session.id,"local",workspace.id,root,"checkout",null),task=store.createTask(session.id,"Finalize once");
  store.touchTaskMember(task.id,member.id);
  const run=ledger.begin({root,workspaceId:workspace.id,workItemId:task.id,runKey:"one",title:task.title,
    origin:{entryPoint:"chatgpt_mcp",evidence:"server_entry"}});
  store.linkRun(session.id,member.id,run.id,task.id);
  t.after(async()=>{
    release();await service.close();await projector.close();await changes.close();
    server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
    await execution.close();ledger.close();workspaceStore.close();await rm(directory,{recursive:true,force:true});
  });
  return {stateDir,store,execution,service,session,member,task,run,ledger,started,release,requests:()=>requests,
    requestsFor:(taskId:string)=>requestsByTask.get(taskId)??0,maxActiveRequests:()=>maxActiveRequests};
}

test("finalization 写锁晚于预算时在 intent 落盘后立即受理，归档只执行一次且保护维护",{timeout:15000},async t=>{
  const f=await fixture(t),lock=await holdSqliteWriteLock(join(f.stateDir,"quaymesh.sqlite"),250);
  const escape=setTimeout(()=>f.release(),4000);
  try {
    const first=f.service.finishTaskWithinBudget("owner",f.task.id,"completed","Done",20);
    const same=f.service.finishTaskWithinBudget("owner",f.task.id,"completed","Done",20);
    assert.equal(f.store.taskData.finalization(f.task.id),null);
    await assert.rejects(f.service.finishTask("owner",f.task.id,"failed","Conflicting"),/TASK_FINALIZATION_CONFLICT/);
    const [receipt,duplicate]=await Promise.all([first,same]);
    assert.equal(receipt.accepted,true);assert.equal(duplicate.accepted,true);
    assert.equal(f.store.taskData.finalization(f.task.id)?.summary,"Done");
    assert.equal(f.store.getTask(f.task.id).state,"active");
    await f.started;assert.equal(f.requests(),1);
    f.execution.pause("maintenance waits for archive");
    assert.equal(f.execution.admissionStatus().activeWork,1);assert.equal(f.execution.admissionStatus().idle,false);
    await assert.rejects(f.service.finishTask("owner",f.task.id,"completed","Changed summary"),/TASK_FINALIZATION_CONFLICT/);
    const work=f.service.finishTask("owner",f.task.id,"completed","Done");
    f.release();const completed=await work;
    assert.equal(completed.state,"closed");assert.equal(completed.result_status,"completed");
    assert.equal(f.ledger.run(f.run.id).status,"completed");
    assert.equal(f.execution.admissionStatus().idle,true);assert.equal(f.requests(),1);
    const finalization=f.store.taskData.finalization(f.task.id)!;
    assert.ok(finalization.completed_at);assert.equal(finalization.error,null);
    assert.deepEqual(await f.service.finishTask("owner",f.task.id,"completed","Done"),completed);
    assert.equal(f.requests(),1);
    await assert.rejects(f.service.finishTask("owner",f.task.id,"completed","Changed summary"),/TASK_FINALIZATION_ALREADY_CONFIRMED/);
    assert.deepEqual(f.store.taskData.finalization(f.task.id),finalization);
  } finally {clearTimeout(escape);f.release();await lock.release();}
});

test("owner 收尾在维护中继续归档，独立 lease 保持到终态提交后再释放",{timeout:15000},async t=>{
  const f=await fixture(t);f.execution.pause("owner maintenance");
  const escape=setTimeout(()=>f.release(),4000);
  try {
    const work=f.service.finishOwnedTask("owner",f.task.id,"completed","Owner done");
    await f.started;
    assert.equal(f.execution.admissionStatus().accepting,false);
    assert.equal(f.execution.admissionStatus().activeWork,1);assert.equal(f.execution.admissionStatus().idle,false);
    await assert.rejects(f.service.finishOwnedTask("owner",f.task.id,"cancelled","Conflict"),/TASK_FINALIZATION_CONFLICT/);
    const same=f.service.finishOwnedTask("owner",f.task.id,"completed","Owner done");
    f.release();const [receipt,duplicate]=await Promise.all([work,same]);
    assert.deepEqual(duplicate,receipt);assert.equal(receipt.snapshots.length,1);
    assert.equal(f.store.getTask(f.task.id).state,"closed");assert.equal(f.requests(),1);
    assert.equal(f.execution.admissionStatus().idle,true);
  } finally {clearTimeout(escape);f.release();}
});

test("恢复归档跨轮次最多四个 flight，挂起的 HTTP 不阻塞下一批或释放其维护占用",{timeout:15000},async t=>{
  const f=await fixture(t),tasks=[f.task],summary="Recovered archive",mirrorIds=new Set<string>();
  for(let index=1;index<7;index++) {
    const task=f.store.createTask(f.session.id,`Archive ${index}`);
    f.store.touchTaskMember(task.id,f.member.id);tasks.push(task);
    if(index===1||index===3) {
      mirrorIds.add(task.id);
      f.ledger.db.prepare("UPDATE qm_tasks SET source_kind='federation_mirror' WHERE id=?").run(task.id);
    }
  }
  for(const [index,task] of tasks.entries()) {
    f.store.taskData.requestFinalization(task.id,"completed",summary);
    f.ledger.db.prepare("UPDATE qm_task_finalizations SET requested_at=? WHERE task_id=?")
      .run(new Date(Date.UTC(2026,0,1,0,0,index)).toISOString(),task.id);
  }
  const finish=(taskId:string)=>mirrorIds.has(taskId)
    ? f.service.finishOwnedTask("owner",taskId,"completed",summary)
    : f.service.finishTask("owner",taskId,"completed",summary);
  const escape=setTimeout(()=>f.release(),10000);
  try {
    const started=performance.now(),first=f.service.retryFinalizations();
    assert.equal(f.service.retryFinalizations(),first,"同一调度轮次共享观察 promise");
    await first;
    assert.ok(performance.now()-started>=1800);assert.ok(performance.now()-started<3500,"只观察两秒，不等挂起 HTTP 完成");
    assert.equal(f.requests(),4);assert.equal(f.execution.admissionStatus().activeWork,4);
    for(const task of tasks) {
      assert.equal(f.store.getTask(task.id).state,"active");
      assert.equal(f.store.taskData.finalization(task.id)?.completed_at,null);
    }
    const full=performance.now();await f.service.retryFinalizations();
    assert.ok(performance.now()-full<500,"四个既有 flight 占满时不重新等待或追加任务");
    assert.equal(f.requests(),4);assert.equal(f.execution.admissionStatus().activeWork,4);

    f.execution.pause("Keep the unresolved archive protected");
    for(const task of tasks.slice(1,4))f.release(task.id);
    await Promise.all(tasks.slice(1,4).map(task=>finish(task.id)));
    assert.equal(f.execution.admissionStatus().activeWork,1);
    for(const task of tasks.slice(4))f.release(task.id);
    await f.service.retryFinalizations();
    for(const task of tasks.slice(1)) {
      assert.equal(f.store.getTask(task.id).state,"closed");
      assert.equal(f.store.getTask(task.id).result_status,"completed");
      assert.equal(f.requestsFor(task.id),1);
    }
    assert.equal(f.store.getTask(tasks[0]!.id).state,"active");
    assert.equal(f.store.taskData.finalization(tasks[0]!.id)?.completed_at,null);
    assert.equal(f.store.taskData.finalization(tasks[0]!.id)?.error,null);
    assert.equal(f.execution.admissionStatus().activeWork,1);assert.equal(f.execution.admissionStatus().idle,false);
    for(let round=0;round<3;round++)await f.service.retryFinalizations();
    assert.equal(f.requests(),7,"游标绕回后，挂起原任务仍不重复发起 HTTP");
    assert.equal(f.maxActiveRequests(),4,"跨入口和 owner flight 的 HTTP 并发总数有界");

    f.release(tasks[0]!.id);await finish(tasks[0]!.id);
    assert.equal(f.store.getTask(tasks[0]!.id).result_status,"completed");
    assert.equal(f.execution.admissionStatus().idle,true);assert.equal(f.requestsFor(tasks[0]!.id),1);
  } finally {clearTimeout(escape);f.release();}
});
