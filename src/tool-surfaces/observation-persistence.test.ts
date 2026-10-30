import assert from "node:assert/strict";
import test,{type TestContext} from "node:test";
import fs,{mkdir,mkdtemp,rm,writeFile} from "node:fs/promises";
import {syncBuiltinESMExports} from "node:module";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {InMemoryTransport} from "@modelcontextprotocol/sdk/inMemory.js";
import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import {REPLY_BYTES} from "../bounded-reply.js";
import {loadConfig} from "../config.js";
import {databasePath} from "../db/client.js";
import {LocalAgentStore} from "../local-agent-store.js";
import {ProcessSessionManager} from "../process-sessions.js";
import {createInvocationContext,requestContextStorage} from "../session/invocations.js";
import {createSessionRuntime} from "../session/runtime.js";
import {OperationState} from "../session/types.js";
import {writeTestQuayMeshConfig} from "../test-support/config.test.js";
import {holdSqliteWriteLock} from "../test-support/sqlite-lock.js";
import {WorkLedger} from "../work-ledger.js";
import {SqliteWorkspaceStore} from "../workspace-store.js";
import {WorkspaceRegistry} from "../workspaces.js";
import {contextPage,type ContextSelection} from "./context-pages.js";
import {registerOperationTools} from "./operations.js";
import {registerWorkspaceContextTool} from "./workspace-context.js";

async function fixture(t:TestContext) {
  const root=await mkdtemp(join(tmpdir(),"qm-observation-persistence-")),project=join(root,"project"),stateDir=join(root,"state");
  await mkdir(project);
  await writeFile(join(project,"a.txt"),"first needle\n");
  await writeFile(join(project,"b.txt"),"second needle\n");
  const config=loadConfig(writeTestQuayMeshConfig(join(root,"config"),{
    storage:{stateDir},workspaces:{allowedRoots:[root],worktreeRoot:join(root,"worktrees")},
    subagents:{enabled:false,instructions:"on-demand",providers:[]},
    logging:{level:"silent"},
  }));
  const workspaceStore=new SqliteWorkspaceStore(stateDir),workspaces=new WorkspaceRegistry(config,workspaceStore);
  const {workspace}=await workspaces.openWorkspace(project);
  const ledger=new WorkLedger(stateDir),agents=new LocalAgentStore(stateDir),processSessions=new ProcessSessionManager({stateDir});
  const runtime=createSessionRuntime({config,workspaces,ledger,agents,processSessions,execution:processSessions.executionCoordinator});
  const session=runtime.store.createSession("owner","observation-persistence","Observation budgets");
  const member=runtime.store.addMember(session.id,config.federation?.nodeId??"local",workspace.id,workspace.root,"checkout",null);
  const task=runtime.store.createTask(session.id,"Observation budgets");
  const run=ledger.begin({root:workspace.root,workspaceId:workspace.id,workItemId:task.id,runKey:"one",title:task.title,
    origin:{entryPoint:"chatgpt_mcp",evidence:"server_entry"}});
  runtime.store.linkRun(session.id,member.id,run.id,task.id);
  const server=new McpServer({name:"observation-persistence",version:"1"}),client=new Client({name:"observation-client",version:"1"});
  const context={server,config,workspaces,processSessions,sessionRuntime:runtime};
  registerOperationTools(context);
  registerWorkspaceContextTool(context);
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport),client.connect(clientTransport)]);
  await client.listTools();
  let requestId=0;
  const observed=<T>(toolName:string,read:()=>T)=>requestContextStorage.run(createInvocationContext({
    auth:{owner_id:session.owner_id},transport:{instance_id:"observation-transport"},
    request:{id:++requestId,tool_name:toolName},
    session:{session_id:session.id,member_id:member.id,task_id:task.id,workspace_id:workspace.id},
  }),read);
  t.after(async()=>{
    await client.close();await server.close();await runtime.close();await processSessions.shutdown();
    agents.close();ledger.close();workspaceStore.close();await rm(root,{recursive:true,force:true});
  });
  return {root,stateDir,workspace,ledger,runtime,session,member,task,run,
    capture:(input:ContextSelection,signal?:AbortSignal)=>observed("workspace_context",()=>contextPage(context,workspace,input,signal)),
    read:(input:Record<string,unknown>)=>observed("read_output",()=>client.callTool({name:"read_output",arguments:{workspace_id:workspace.id,...input}})),
    status:(input:Record<string,unknown>)=>observed("workspace_context",()=>client.callTool({name:"workspace_context",arguments:{workspace_id:workspace.id,action:"status",...input}})),
  };
}

test("上下文首批和文件续批在真实 SQLite 写锁下取消，不阻塞事件循环或延后落盘",{timeout:15000},async t=>{
  const f=await fixture(t);
  const first=await f.capture({action:"search",query:"needle",patterns:["*.txt"],max_files:1});
  assert.equal(first.scope.next_file_offset,1);
  const count=()=>f.ledger.db.prepare("SELECT COUNT(*) FROM qm_context_results").pluck().get() as number;
  assert.equal(count(),1);
  const selections:ContextSelection[]=[
    {action:"capture",files:[{path:"a.txt"}]},
    {action:"search",result_ref:first.result_ref,file_offset:1},
  ];
  for(const selection of selections) {
    const lock=await holdSqliteWriteLock(databasePath(f.stateDir),2000),controller=new AbortController();
    let released=false,ticks=0;
    void lock.done.then(()=>{released=true;});
    const timer=setInterval(()=>{ticks++;},10),abort=setTimeout(()=>controller.abort(new Error("CAPTURE_OBSERVATION_CANCELLED")),100);
    const started=performance.now();
    try {
      await assert.rejects(f.capture(selection,controller.signal),/CAPTURE_OBSERVATION_CANCELLED/);
      assert.ok(performance.now()-started<1000,"取消不等待数据库写锁释放");
      assert.equal(released,false);assert.ok(ticks>=3,"SQLite 等待期间事件循环保持响应");
      assert.equal(count(),1,"被取消的观察不能写入结果引用");
    } finally {clearInterval(timer);clearTimeout(abort);await lock.release();}
    assert.equal(count(),1,"解锁不能恢复已经取消的保存");
  }
  const second=await f.capture(selections[1]!);
  assert.notEqual(second.result_ref,first.result_ref);assert.equal(count(),2);
  assert.equal(second.entries[0]?.path,"b.txt");
});

test("等待枚举清理期间重新启用的已发布续页不会被过期快照删除",{timeout:10000},async t=>{
  const f=await fixture(t);
  const deferred=()=>{
    let resolve!:()=>void;
    const promise=new Promise<void>(done=>{resolve=done;});
    return {promise,resolve};
  };
  const closing=deferred(),closeRelease=deferred(),advancing=deferred(),advanceRelease=deferred();
  const originalGlob=fs.glob;
  let secondClosed=0,now=Date.now();
  t.mock.method(Date,"now",()=>now);
  const mocked=t.mock.method(fs,"glob",((...args:Parameters<typeof originalGlob>)=>{
    const iterator=originalGlob(...args),pattern=String(args[0]);
    return (async function*(){
      let count=0;
      try {
        for await(const path of iterator) {
          if(pattern==="second-*.txt"&&++count===129) {advancing.resolve();await advanceRelease.promise;}
          yield path;
        }
      } finally {
        if(pattern==="first-*.txt"){closing.resolve();await closeRelease.promise;}
        if(pattern==="second-*.txt")secondClosed++;
      }
    })();
  }) as typeof originalGlob);
  syncBuiltinESMExports();
  t.after(()=>{mocked.mock.restore();syncBuiltinESMExports();});
  await Promise.all(["first","second"].flatMap(prefix=>Array.from({length:134},(_,index)=>
    writeFile(join(f.workspace.root,`${prefix}-${String(index).padStart(3,"0")}.txt`),"needle\n"))));
  await f.capture({action:"search",query:"needle",patterns:["first-*.txt"],max_files:1});
  const second=await f.capture({action:"search",query:"needle",patterns:["second-*.txt"],max_files:1});
  now+=10*60_000+1;
  let pruning:ReturnType<typeof f.capture>|undefined,continuing:ReturnType<typeof f.capture>|undefined;
  try {
    pruning=f.capture({action:"search",query:"needle",patterns:["a.txt"],max_files:1});
    await closing.promise;
    continuing=f.capture({action:"search",result_ref:second.result_ref,file_offset:128});
    await advancing.promise;
    closeRelease.resolve();
    let deadline:NodeJS.Timeout|undefined;
    try {
      const next=await Promise.race([pruning,new Promise<never>((_,reject)=>{
        deadline=setTimeout(()=>reject(new Error("清理错误地等待了另一调用正在推进的已发布枚举")),1000);
      })]);
      assert.ok(next.result_ref);
    } finally {clearTimeout(deadline);}
    assert.equal(secondClosed,0,"过期快照不能清理已恢复 pending 的迭代器");
    advanceRelease.resolve();
    const continued=await continuing;
    assert.match(String(continued.entries[0]?.path),/^second-/);
    const following=await f.capture({action:"search",result_ref:second.result_ref,file_offset:129});
    assert.match(String(following.entries[0]?.path),/^second-/,"共享枚举仍保留原续页身份");
    assert.equal(secondClosed,0);
  } finally {
    closeRelease.resolve();advanceRelease.resolve();
    await Promise.allSettled([pruning,continuing]);
  }
});

test("超长准备错误遵守单项和批量回复预算，裁剪说明始终保留零输出游标",{timeout:15000},async t=>{
  const f=await fixture(t),message='\u0000"\\\n中文😀'.repeat(30_000),operations:string[]=[];
  for(let index=0;index<2;index++) {
    const requestId=`prepare-${index}`,operationId=f.ledger.operation({runId:f.run.id,requestKey:requestId,
      kind:"command",label:"Failed before process start",status:"failed"});
    f.runtime.store.reserveInvocation({id:requestId,ownerId:f.session.owner_id,transportInstanceId:"preparation",
      requestId,sessionId:f.session.id,memberId:f.member.id,toolName:"exec_command",argumentsJson:"{}",operationId,taskId:f.task.id});
    f.runtime.store.updateInvocation({ownerId:f.session.owner_id,transportInstanceId:"preparation",requestId,
      state:OperationState.failed,effect:"not_started",finished:true,responded:true,
      result:{kind:"error",errorCode:"INVALID_ARGUMENT",message,effect:"not_started",retryHint:"fix_input"}});
    operations.push(operationId);
  }
  for(const input of [
    {operation_id:operations[0],limit_bytes:16},
    {operation_id:operations[0],limit_bytes:32768},
    {outputs:operations.map(operation_id=>({operation_id,cursor:0})),limit_bytes:32768},
  ]) {
    const response=await f.read(input);
    assert.notEqual(response.isError,true,JSON.stringify(response));
    assert.ok(Buffer.byteLength(JSON.stringify(response))<=REPLY_BYTES,"JSON 转义后的完整回复受限");
    const body=response.structuredContent as Record<string,any>,pages=body.outputs??[body];
    assert.ok(pages.reduce((bytes:number,page:{result:string})=>bytes+Buffer.byteLength(page.result),0)<=input.limit_bytes);
    for(const page of pages) {
      assert.equal(page.effect,"not_started");assert.equal(page.error_message_truncated,true);
      assert.ok(message.startsWith(page.result));assert.equal(page.result.includes("\ufffd"),false);
      assert.equal(page.cursor,0);assert.equal(page.next_cursor,0);assert.equal(page.total_bytes,0);
      assert.equal(page.done,true);assert.equal(page.process_done,true);assert.equal(page.has_more,false);
    }
  }
  for(const operationId of operations) {
    const saved=f.runtime.store.findInvocationByOperation(f.session.owner_id,operationId)!;
    assert.equal(JSON.parse(saved.result_json!).message,message,"预算裁剪不修改原始错误回执");
  }
  const first=await f.status({operation_id:operations[0]});
  assert.notEqual(first.isError,true,JSON.stringify(first));assert.ok(Buffer.byteLength(JSON.stringify(first))<=REPLY_BYTES);
  const initial=first.structuredContent as Record<string,any>;
  assert.equal(initial.error.errorCode,"INVALID_ARGUMENT");assert.equal(initial.error.truncated,true);
  assert.equal(initial.error_page.encoding,"json");assert.ok(initial.error_page.next_offset>0);
  const continued=await f.status(initial.next_action.arguments);
  assert.notEqual(continued.isError,true,JSON.stringify(continued));assert.ok(Buffer.byteLength(JSON.stringify(continued))<=REPLY_BYTES);
  const next=continued.structuredContent as Record<string,any>;
  const original=f.runtime.store.findInvocationByOperation(f.session.owner_id,operations[0]!)!.result_json!;
  assert.equal(initial.error_page.text+next.error_page.text,Array.from(original).slice(0,next.error_page.next_offset).join(""));
});
