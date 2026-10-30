import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {writeFile} from "node:fs/promises";
import {join} from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import test from "node:test";
import {databasePath,openDatabase} from "../../src/db/client.js";
import {readMaintenanceStatus} from "../../src/maintenance-status.js";
import {holdSqliteWriteLock} from "../../src/test-support/sqlite-lock.js";
import {WorkspaceRegistry} from "../../src/workspaces.js";
import {fixture,twoNodes,until} from "./fixture.js";

test("真实 MCP 上下文入口在写锁期间按观察期限返回，取消后不再保存结果",{timeout:15000},async t=>{
  const f=await fixture(t,{git:false}),db=openDatabase(f.config.stateDir);
  try {
    const command=await f.execute("console.log('saved-before-observation-lock');",{yield_time_ms:2000});
    await until(async()=>(await f.call("read_output",{...f.scope,operation_id:command.operation_id})).process_done===true);
    await f.call("workspace_context",{...f.scope,action:"capture",files:[{path:"README.md"}]});
    const count=()=>db.sqlite.prepare("SELECT COUNT(*) FROM qm_context_results").pluck().get() as number;
    const before=count(),lock=await holdSqliteWriteLock(databasePath(f.config.stateDir),2000);
    let released=false;
    void lock.done.then(()=>{released=true;});
    try {
      const outputStarted=performance.now();
      const output=await f.client.callTool({name:"read_output",arguments:{...f.scope,operation_id:command.operation_id},
        _meta:{...f.meta,"quaymesh/deadline_at":Date.now()+400}});
      assert.notEqual(output.isError,true,JSON.stringify(output));
      assert.match(String(output.structuredContent?.result),/saved-before-observation-lock/);
      assert.ok(performance.now()-outputStarted<1000);assert.equal(released,false);
      for(const arguments_ of [
        {...f.scope,action:"capture",files:[{path:"README.md"}]},
        {...f.scope,action:"list",depth:1},
      ]) {
        const started=performance.now();
        const response=await f.client.callTool({name:"workspace_context",arguments:arguments_,
          _meta:{...f.meta,"quaymesh/deadline_at":Date.now()+400}});
        assert.equal(response.isError,true,JSON.stringify(response));
        assert.match(JSON.stringify(response),/TOOL_REQUEST_EXPIRED/);
        assert.ok(performance.now()-started<1000,"HTTP 观察不能被同步 touchSession 卡住");
        assert.equal(released,false);assert.equal(count(),before);
      }
    } finally {await lock.release();}
    await until(()=>Number(db.sqlite.prepare("SELECT COUNT(*) FROM qm_runtime_work WHERE kind='resource'").pluck().get())===0);
    assert.equal(count(),before,"观察已取消，延后获取的临时资源不能再保存内容");
    const next=await f.call("workspace_context",{...f.scope,action:"capture",files:[{path:"README.md"}]});
    assert.ok(next.result_ref);assert.equal(count(),before+1);
  } finally {
    // This observer is owned by the test; close it before the fixture after hook removes its SQLite directory.
    db.close();
  }
});

test("真实双节点取消 search 后仍持有全部文件工作，收尾证明不改协调端首回执",{timeout:20000},async t=>{
  const {worker,cloud}=await twoNodes(t),meta={"openai/session":randomUUID()};
  const started=await cloud.client.callTool({name:"start_session",arguments:{title:"Cancelled search drain",request_key:randomUUID()},_meta:meta});
  assert.notEqual(started.isError,true,JSON.stringify(started));
  const taskId=String(started.structuredContent!.task_id);
  const opened=await cloud.client.callTool({name:"open_workspace",arguments:{root_id:"worker/main",task_id:taskId},_meta:meta});
  assert.notEqual(opened.isError,true,JSON.stringify(opened));
  const files=Array.from({length:8},(_,index)=>`drain-${index}.txt`);
  await Promise.all(files.map(file=>writeFile(join(worker.project,file),"needle\n")));
  const workerDb=openDatabase(worker.config.stateDir),cloudDb=openDatabase(cloud.config.stateDir);
  const releases:Array<()=>void>=[],gates=Array.from({length:4},()=>new Promise<void>(resolve=>releases.push(resolve)));
  const entered:string[]=[];
  const originalResolve=WorkspaceRegistry.prototype.resolveReadPath;
  t.mock.method(WorkspaceRegistry.prototype,"resolveReadPath",async function(this:WorkspaceRegistry,
    workspace:Parameters<WorkspaceRegistry["resolveReadPath"]>[0],path:string) {
    const resolved=await originalResolve.call(this,workspace,path);
    if(files.includes(path)) {
      entered.push(path);
      // Use the real path resolver, then hold each owned call at an explicit
      // barrier so cancellation and the concurrent drain cannot race the test.
      await gates[files.indexOf(path)];
    }
    return resolved;
  });
  const runtime=worker.running.federation!,originalHandler=runtime.handlers.get("workspace_context")!;
  let workerSignal:AbortSignal|undefined;
  runtime.handlers.set("workspace_context",(input,extra)=>{
    if(input.action==="search")workerSignal=extra.signal as AbortSignal;
    return originalHandler(input,extra);
  });
  const controller=new AbortController();
  try {
    const request=cloud.client.callTool({name:"workspace_context",arguments:{workspace_id:opened.structuredContent!.workspace_id,
      task_id:taskId,action:"search",query:"needle",files:files.map(path=>({path}))},_meta:meta},undefined,{signal:controller.signal});
    const cancelled=assert.rejects(request);
    await until(()=>entered.length===4);
    const lookup=(db:typeof workerDb)=>db.sqlite.prepare("SELECT * FROM qm_invocations WHERE task_id=? AND tool_name='workspace_context' ORDER BY rowid DESC LIMIT 1")
      .get(taskId) as {id:string;operation_id:string;state:string;effect:string;result_json:string|null;response_json:string|null;response_uses_result:number};
    const active=lookup(workerDb),operationId=active.operation_id;
    assert.equal(active.state,"running");
    controller.abort(new Error("test caller stopped waiting"));
    await cancelled; await until(()=>workerSignal?.aborted===true);
    await until(()=>lookup(cloudDb)?.state==="unknown");
    const firstReceipt=lookup(cloudDb);
    assert.equal(firstReceipt.operation_id,operationId); assert.equal(firstReceipt.effect,"unknown");
    const proofCount=()=>Number(workerDb.sqlite.prepare("SELECT COUNT(*) FROM execution_quiescence WHERE object_id=? AND invalidated_at IS NULL").pluck().get(operationId));
    releases[0]!(); await delay(50);
    assert.equal(entered.length,4,"取消后的 worker 不启动剩余文件");
    assert.equal(lookup(workerDb).state,"running","首个文件拒绝不能结束其他三个仍未完成的调用");
    assert.ok(readMaintenanceStatus(workerDb.sqlite).activeWork>0); assert.equal(proofCount(),0);
    assert.equal(readMaintenanceStatus(workerDb.sqlite).idle,false);
    for(const release of releases)release();
    await until(()=>lookup(workerDb).state==="unknown"&&proofCount()===1&&readMaintenanceStatus(workerDb.sqlite).activeWork===0);
    const final=readMaintenanceStatus(workerDb.sqlite),saved=lookup(workerDb);
    assert.equal(saved.effect,"unknown"); assert.equal(JSON.parse(saved.result_json!).errorCode,"REQUEST_TIMEOUT");
    assert.equal(final.physicalUnknown,0); assert.equal(final.reconciliationPending,true); assert.equal(final.idle,true);
    assert.equal(Number(workerDb.sqlite.prepare("SELECT COUNT(*) FROM qm_context_results").pluck().get()),0);
    assert.deepEqual(lookup(cloudDb),firstReceipt,"Worker 的物理完成不重写协调端首回执");
    assert.equal(Number(cloudDb.sqlite.prepare("SELECT COUNT(*) FROM execution_quiescence").pluck().get()),0,"转发端不能替 Worker 发物理证明");
    assert.equal(entered.length,4);
  } finally {
    controller.abort(); for(const release of releases)release();
    runtime.handlers.set("workspace_context",originalHandler);
    await until(()=>readMaintenanceStatus(workerDb.sqlite).activeWork===0);
    workerDb.close();cloudDb.close();
  }
});
