import assert from "node:assert/strict";
import test from "node:test";
import {readFile,writeFile,rm} from "node:fs/promises";
import {join} from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {fixture,until} from "./tool-contract/fixture.js";
import {SessionChangeCollector} from "../src/session/changes.js";
import {SessionService} from "../src/session/service.js";
import {WorkLedger} from "../src/work-ledger.js";
import {openDatabase} from "../src/db/client.js";
import {SessionStore} from "../src/session/store.js";
import {ExecutionCoordinator,type RuntimeWorkLease} from "../src/execution-coordinator.js";
import {randomUUID} from "node:crypto";

// 人为延迟准备步骤，HTTP、SQLite、文件副作用及重连均使用真实实现。
test("准备三十秒时立即交付受理回执，断连后同键不重写",{timeout:60000},async t=>{
  const f=await fixture(t);
  const definition=(await f.client.listTools()).tools.find(tool=>tool.name==='exec_command')!;
  const original=SessionChangeCollector.prototype.prepareWrite;
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  let preparing=false;
  t.mock.method(SessionChangeCollector.prototype,"prepareWrite",async function(this:SessionChangeCollector,...args:Parameters<typeof original>){
    preparing=true;await gate;return original.apply(this,args);
  });
  const script=join(f.project,"once.mjs");
  await writeFile(script,"import {appendFileSync} from 'node:fs';appendFileSync('once.txt','one\\n');console.log('saved-once');");
  const args={...f.scope,cmd:`"${process.execPath}" "${script}"`,yield_time_ms:0,operation_key:"durable-preparation"};
  let client:Client|undefined;
  const started=Date.now();
  try{
    const response=await f.raw("exec_command",args);
    assert.notEqual(response.isError,true,JSON.stringify(response));
    const first=response.structuredContent as any;
    const output=definition.outputSchema!;
    assert.deepEqual(Object.keys(first).filter(key=>!(key in (output.properties??{}))),[],
      '初始受理回执必须遵守向宿主声明的结构化输出协议');
    assert.ok(Date.now()-started<5000,"受理回执必须先于准备完成");
    assert.equal(first.accepted,true);assert.equal((response._meta as any)?.quaymesh?.phase,"preparing");
    assert.equal(first.effect,"not_started");assert.equal(first.result,"");assert.ok(preparing);
    const db=openDatabase(f.config.stateDir);
    try{
      const record=db.sqlite.prepare("select effect,operation_id from qm_invocations where operation_id=?").get(first.operation_id) as any;
      assert.equal(record.effect,"not_started");assert.equal(record.operation_id,first.operation_id);
    }finally{db.close();}
    await f.client.close();
    client=new Client({name:"preparing-reconnect",version:"1"});
    await client.connect(new StreamableHTTPClientTransport(new URL("/mcp",f.baseUrl),{requestInit:{headers:{authorization:`Bearer ${f.accessToken}`}}}));
    await client.listTools();
    const call=async(name:string,arguments_:Record<string,unknown>)=>{
      const response=await client!.callTool({name,arguments:arguments_,_meta:f.meta});assert.notEqual(response.isError,true,JSON.stringify(response));return response.structuredContent as any;
    };
    const second=await call("exec_command",args);assert.equal(second.operation_id,first.operation_id);
    const page=await call("read_output",{...f.scope,operation_id:first.operation_id,cursor:0});
    assert.equal(page.process_done,false);assert.equal(page.operation_state,"preparing");
    await delay(Math.max(0,30000-(Date.now()-started)));release();
    await until(async()=>(await call("read_output",{...f.scope,operation_id:first.operation_id,cursor:0})).process_done,15000);
    const completed=await call("read_output",{...f.scope,operation_id:first.operation_id,cursor:0});
    assert.equal(completed.exit_code,0,JSON.stringify(completed));
    assert.equal(await readFile(join(f.project,"once.txt"),"utf8"),"one\n");
    const replay=await call("exec_command",args);assert.equal(replay.operation_id,first.operation_id);
    assert.equal(await readFile(join(f.project,"once.txt"),"utf8"),"one\n");
  }finally{release();await client?.close();}
});

test("一百次输出查询不创建新 Run、Invocation 或模型进展",{timeout:30000},async t=>{
  const f=await fixture(t),command=await f.execute("console.log('durable-output');");
  await until(async()=>(await f.call("read_output",{...f.scope,operation_id:command.operation_id})).process_done);
  const db=openDatabase(f.config.stateDir);
  try{
    const before=db.sqlite.prepare("select count(*) n from qm_invocations").get() as any;
    const runs=db.sqlite.prepare("select count(*) n from console_work_runs").get() as any;
    const progress=db.sqlite.prepare("select max(created_at) t from qm_events where event_type='operation_started'").get() as any;
    for(let i=0;i<100;i++)assert.equal((await f.call("read_output",{...f.scope,operation_id:command.operation_id,cursor:0})).result,"durable-output\n");
    assert.deepEqual(db.sqlite.prepare("select count(*) n from qm_invocations").get(),before);
    assert.deepEqual(db.sqlite.prepare("select count(*) n from console_work_runs").get(),runs);
    assert.deepEqual(db.sqlite.prepare("select max(created_at) t from qm_events where event_type='operation_started'").get(),progress);
  }finally{db.close();}
});

test("完成回调暂时失败后，退出码不被覆盖且监督器补齐终态",{timeout:30000},async t=>{
  const f=await fixture(t);
  const original=SessionService.prototype.finishOperationById;
  let attempts=0;
  t.mock.method(SessionService.prototype,"finishOperationById",async function(this:SessionService,...args:Parameters<typeof original>){
    if(++attempts===1)throw new Error("INJECTED_FINALIZE_STORAGE_BUSY");return original.apply(this,args);
  });
  const command=await f.execute("console.log('completed-before-callback');");
  await until(async()=>(await f.call("read_output",{...f.scope,operation_id:command.operation_id,cursor:0})).process_done,15000);
  const page=await f.call("read_output",{...f.scope,operation_id:command.operation_id,cursor:0});
  assert.equal(page.exit_code,0);assert.equal(page.process_done,true);assert.match(page.result,/completed-before-callback/);
  const db=openDatabase(f.config.stateDir);
  try{
    await until(()=>{
      const row=db.sqlite.prepare("select state from qm_invocations where operation_id=?").get(command.operation_id) as any;
      return attempts>=2&&row.state==="succeeded";
    },12000);
    const row=db.sqlite.prepare("select status from console_operations where id=?").get(command.operation_id) as any;
    assert.equal(row.status,"completed");
  }finally{db.close();}
});

test("最终化意图失败后可幂等接续，不等待下一次用户请求",{timeout:30000},async t=>{
  const f=await fixture(t),command=await f.execute("console.log('ready-to-finalize');");
  await until(async()=>(await f.call("read_output",{...f.scope,operation_id:command.operation_id})).process_done);
  // 输出完成可先于退出回调；等执行所有者释放后再注入归档故障。
  const preparation=openDatabase(f.config.stateDir);
  try {
    await until(()=>!(preparation.sqlite.prepare("select 1 from qm_runtime_work where task_id=? and blocking=1 limit 1").get(f.task.task_id))
      && (preparation.sqlite.prepare("select state from qm_invocations where operation_id=?").get(command.operation_id) as any)?.state==="succeeded",15000);
  } finally { preparation.close(); }
  const finish=SessionService.prototype.finishTask,ledgerFinish=WorkLedger.prototype.finish;
  let service:SessionService|undefined,blocked=true;
  t.mock.method(SessionService.prototype,"finishTask",function(this:SessionService,...args:Parameters<typeof finish>){service=this;return finish.apply(this,args);});
  t.mock.method(WorkLedger.prototype,"finish",function(this:WorkLedger,...args:Parameters<typeof ledgerFinish>){
    if(blocked)throw new Error("INJECTED_ARCHIVE_NOT_READY");return ledgerFinish.apply(this,args);
  });
  const request={task_id:f.task.task_id,status:"completed",summary:"tested once"};
  assert.equal((await f.raw("finish_task",request)).isError,true);
  const db=openDatabase(f.config.stateDir);
  try{
    const before=db.sqlite.prepare("select count(*) n from qm_invocations where tool_name='exec_command'").get();
    const intent=db.sqlite.prepare("select completed_at,error from qm_task_finalizations where task_id=?").get(f.task.task_id) as any;
    assert.equal(intent.completed_at,null);assert.match(intent.error,/INJECTED_ARCHIVE/);
    blocked=false;assert.ok(service);await service.retryFinalizations();await service.retryFinalizations();
    const state=db.sqlite.prepare("select state,result_status from qm_tasks where id=?").get(f.task.task_id) as any;
    assert.deepEqual(state,{state:"closed",result_status:"completed"});
    assert.deepEqual(db.sqlite.prepare("select count(*) n from qm_invocations where tool_name='exec_command'").get(),before);
  }finally{db.close();}
});

test("前四个任务仍在执行时，后续完成意图不会被饿死",{timeout:30000},async t=>{
  const start=SessionService.prototype.startTask;
  let service:SessionService|undefined;
  t.mock.method(SessionService.prototype,"startTask",function(this:SessionService,...args:Parameters<typeof start>){
    service=this;return start.apply(this,args);
  });
  const f=await fixture(t,{git:false});
  assert.ok(service);
  const db=openDatabase(f.config.stateDir),store=new SessionStore(db.sqlite);
  const coordinator=new ExecutionCoordinator(f.config.stateDir),leases:RuntimeWorkLease[]=[];
  try {
    const owner=store.getSession(f.task.session_id).owner_id;
    for(let i=0;i<6;i++){
      const {task}=await service.startTask({owner_id:owner,conversation_id:randomUUID()},`收尾队列 ${i}`,randomUUID());
      store.taskData.requestFinalization(task.id,"completed","操作已经核对");
    }
    const pending=store.taskData.pendingFinalizations(6);
    assert.equal(pending.length,6);
    for(const intent of pending.slice(0,4))leases.push(coordinator.beginWork({kind:"tool",taskId:intent.task_id}));
    await service.retryFinalizations();
    assert.equal(store.getTask(pending[4]!.task_id).state,"active");
    await service.retryFinalizations();
    for(const intent of pending.slice(4))assert.equal(store.getTask(intent.task_id).result_status,"completed");
    for(const intent of pending.slice(0,4))assert.equal(store.getTask(intent.task_id).state,"active");
    for(const lease of leases)lease.release();
    await service.retryFinalizations();
    for(const intent of pending)assert.equal(store.getTask(intent.task_id).result_status,"completed");
  } finally {
    for(const lease of leases)lease.release();
    coordinator.close();db.close();
  }
});

test("交接收尾重试不等待或取消已经受理的后台命令",{timeout:30000},async t=>{
  const f=await fixture(t),gate=join(f.root,"finish-background");
  const command=await f.execute(`import {existsSync} from 'node:fs';const timer=setInterval(()=>{
    if(existsSync(${JSON.stringify(gate)})){clearInterval(timer);console.log('background-complete');}},20);`,{yield_time_ms:0});
  const finish=SessionService.prototype.finishTask,archive=WorkLedger.prototype.archiveTaskRuns;
  let service:SessionService|undefined,blocked=true;
  t.mock.method(SessionService.prototype,"finishTask",function(this:SessionService,...args:Parameters<typeof finish>){service=this;return finish.apply(this,args);});
  t.mock.method(WorkLedger.prototype,"archiveTaskRuns",function(this:WorkLedger,...args:Parameters<typeof archive>){
    if(blocked)throw new Error("INJECTED_HANDOFF_ARCHIVE");return archive.apply(this,args);
  });
  const db=openDatabase(f.config.stateDir);
  try {
    const first=await f.raw("finish_task",{task_id:f.task.task_id,status:"handed_off",summary:"后台继续"});
    assert.equal(first.isError,true);assert.match(JSON.stringify(first),/INJECTED_HANDOFF_ARCHIVE/);
    blocked=false;assert.ok(service);await service.retryFinalizations();
    assert.deepEqual(db.sqlite.prepare("select state,result_status from qm_tasks where id=?").get(f.task.task_id),{state:"closed",result_status:"handed_off"});
    assert.equal((await f.call("read_output",{...f.scope,operation_id:command.operation_id})).process_done,false);
    await writeFile(gate,"finish");
    await until(async()=>(await f.call("read_output",{...f.scope,operation_id:command.operation_id})).process_done);
    assert.equal((await f.call("read_output",{...f.scope,operation_id:command.operation_id})).result,"background-complete\n");
  } finally {blocked=false;await writeFile(gate,"finish");db.close();}
});
