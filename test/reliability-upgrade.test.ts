import assert from "node:assert/strict";
import test, {type TestContext} from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createRealTestServer } from "./session-card/server-fixture.js";
import { SessionOutputStore } from "../src/session/output.js";
import { ProcessSessionManager } from "../src/process-sessions.js";
import { openDatabase } from "../src/db/client.js";
import { SessionStore } from "../src/session/store.js";
import { SessionProjector } from "../src/session/projection.js";
import { WorkLedger } from "../src/work-ledger.js";
import { REPLY_BYTES } from "../src/bounded-reply.js";
import { toolDeadline, remainingToolTime, TOOL_DEADLINE_META } from "../src/tool-request-budget.js";

async function fixture(t: TestContext, files: Record<string,string>={}) {
  const f=await createRealTestServer({files,uiEnabled:true});
  t.after(()=>f.dispose());
  const meta={"openai/session":randomUUID()};
  async function raw(name:string,args:Record<string,unknown>,client=f.client) {
    return client.callTool({name,arguments:args,_meta:meta});
  }
  async function call(name:string,args:Record<string,unknown>,client=f.client):Promise<Record<string,any>> {
    const result=await raw(name,args,client);
    assert.notEqual(result.isError,true,JSON.stringify(result));
    assert.ok(result.structuredContent);
    return result.structuredContent as Record<string,any>;
  }
  const task=await call("start_session",{title:"可靠性实际验证",request_key:randomUUID()});
  const opened=await raw("open_workspace",{path:f.project});
  assert.notEqual(opened.isError,true,JSON.stringify(opened));
  assert.ok(opened.structuredContent);
  const workspace={...(opened.structuredContent as Record<string,any>),...((opened._meta as any)?.quaymesh??{})};
  const scope={workspace_id:workspace.workspace_id};
  async function execute(source:string,options:Record<string,unknown>={}) {
    const path=join(f.project,`check-${randomUUID()}.mjs`);
    await writeFile(path,source);
    return call("exec_command",{...scope,cmd:`"${process.execPath}" "${path}"`,yield_time_ms:12000,...options});
  }
  async function finished(operationId:string) {
    const deadline=Date.now()+10000;
    while(Date.now()<deadline) {
      const result=await call("read_output",{...scope,operation_id:operationId,cursor:0});
      if(result.process_done)return result;
      await delay(30);
    }
    throw new Error("真实命令未按期完成");
  }
  async function newClient() {
    const client=new Client({name:"quaymesh-reconnect-verification",version:"1"});
    t.after(()=>client.close());
    await client.connect(new StreamableHTTPClientTransport(new URL("/mcp",f.baseUrl),{
      requestInit:{headers:{authorization:`Bearer ${f.accessToken}`}},
    }));
    return client;
  }
  return {...f,task,workspace,scope,call,raw,execute,finished,newClient};
}

test("二十个小文件实际一次返回，文本镜像与结构化正文一致且不追加重复正文", {timeout:60000}, async t=>{
  const files=Object.fromEntries(Array.from({length:20},(_,i)=>[`batch-${i}.ts`,`export const value${i} = ${i};\n`]));
  const f=await fixture(t,files);
  const response=await f.raw("workspace_context",{...f.scope,action:"capture",files:Object.keys(files).map(path=>({path}))});
  assert.notEqual(response.isError,true,JSON.stringify(response));
  const result=response.structuredContent as any;
  assert.equal(result.entries.length,20);
  assert.equal(result.next_cursor,null);
  for(const entry of result.entries)assert.equal(entry.lines.map((line:any)=>line.text+line.eol).join(""),files[entry.path]);
  assert.ok(Buffer.byteLength(JSON.stringify(response))<REPLY_BYTES);
  const mirror=response.content[0];
  assert.ok(mirror?.type==="text");
  assert.deepEqual(JSON.parse(mirror.text),result);
  assert.equal(response.content.filter(item=>item.type==="text"&&item.text.includes("export const value")).length,1);
});

test("多文件长行分页保留原内容，原文件删除以后仍可继续", {timeout:60000}, async t=>{
  const original="第一行\r\n"+"内容😀".repeat(12000)+"\r\n最后一行\n";
  const f=await fixture(t,{"long.txt":original,"end.txt":"end\n"});
  let page=await f.call("workspace_context",{...f.scope,action:"capture",files:[{path:"long.txt"},{path:"end.txt"}]});
  const ref=page.result_ref;
  await rm(join(f.project,"long.txt"));
  const recovered=new Map<string,string>();
  for(let count=0;count<40;count++) {
    for(const entry of page.entries)for(const line of entry.lines) {
      recovered.set(entry.path,(recovered.get(entry.path) ?? "")+line.text+line.eol);
    }
    if(page.next_cursor===null)break;
    page=await f.call("workspace_context",{...f.scope,action:"capture",result_ref:ref,cursor:page.next_cursor});
    assert.equal(page.result_ref,ref);
    if(count===39)throw new Error("分页未结束");
  }
  assert.equal(recovered.get("long.txt"),original);
  assert.equal(recovered.get("end.txt"),"end\n");
});

test("目录匹配与多查询词合并返回，单个文件失败明确报告", {timeout:60000}, async t=>{
  const f=await fixture(t,{"src/a.ts":"alpha\ncontext\n","src/b.ts":"beta\n","src/no.txt":"alpha"});
  const result=await f.call("workspace_context",{...f.scope,action:"search",directory:"src",patterns:["*.ts"],queries:["alpha","beta"]});
  assert.equal(result.entries.length,2);
  assert.equal(result.partial,false);
  const partial=await f.call("workspace_context",{...f.scope,action:"capture",files:[{path:"src/a.ts"},{path:"missing.ts"}]});
  assert.equal(partial.partial,true);
  assert.ok(partial.entries.find((entry:any)=>entry.path==="missing.ts").error);
  assert.equal(partial.entries[0].lines[0].text,"alpha");
});

test("真实失败命令保存输出与退出码，执行终态不能回退", {timeout:60000}, async t=>{
  const f=await fixture(t);
  const command=await f.execute("process.stderr.write('真实错误\\n'); process.exitCode=7;");
  const output=await f.finished(command.operation_id);
  assert.equal(output.exit_code,7);
  assert.equal(output.result,"真实错误\n");
  const db=openDatabase(f.config.stateDir);
  try {
    const row=db.sqlite.prepare("SELECT state,finished_at,response_at FROM qm_invocations WHERE operation_id=?").get(command.operation_id) as any;
    assert.equal(row.state,"failed");
    assert.ok(row.finished_at);assert.ok(row.response_at);
    const snapshot=await f.call("qm_session",{session_id:f.workspace.session_id,task_id:f.task.task_id,since_rev:-1});
    assert.equal(snapshot.snapshot.currentCommand.exitCode,7);
    assert.equal(snapshot.snapshot.taskState,"active");
    assert.equal(snapshot.snapshot.startedAt,Date.parse((db.sqlite.prepare("SELECT created_at FROM qm_tasks WHERE id=?").get(f.task.task_id) as any).created_at));
  } finally {db.close();}
});

test("大输出分段可完整续读，三个消费者互不消耗", {timeout:60000}, async t=>{
  const f=await fixture(t);
  const text="汉字😀:0123456789\n".repeat(6000);
  const command=await f.execute(`process.stdout.write(${JSON.stringify(text)});`);
  await f.finished(command.operation_id);
  const clients=await Promise.all([f.newClient(),f.newClient()]);
  const first=await Promise.all([f.client,...clients].map(client=>f.call("read_output",{
    ...f.scope,operation_id:command.operation_id,cursor:0,limit_bytes:1024},client)));
  assert.equal(first[0]!.result,first[1]!.result);
  assert.equal(first[0]!.result,first[2]!.result);
  let cursor=0,recovered="";
  for(let count=0;count<100;count++) {
    const page=await f.call("read_output",{...f.scope,operation_id:command.operation_id,cursor,limit_bytes:8192});
    recovered+=page.result;
    assert.ok(page.next_cursor>=cursor);
    cursor=page.next_cursor;
    if(page.done)break;
    if(count===99)throw new Error("输出分页未结束");
  }
  assert.equal(recovered,text);
  assert.equal(cursor,Buffer.byteLength(text));
  const repeated=await f.call("read_output",{...f.scope,operation_id:command.operation_id,cursor:0,limit_bytes:1024});
  assert.equal(repeated.result,first[0]!.result);
});

test("同一写操作跨 HTTP 连接重试只执行一次，明确重跑使用新 key", {timeout:60000}, async t=>{
  const f=await fixture(t);
  const script=join(f.project,"append.mjs");
  await writeFile(script,"import {appendFileSync} from 'node:fs'; appendFileSync('once.txt','one\\n'); console.log('appended');");
  const args={...f.scope,cmd:`"${process.execPath}" "${script}"`,yield_time_ms:12000,operation_key:"append-once"};
  const first=await f.call("exec_command",args);
  await f.finished(first.operation_id);
  const client=await f.newClient();
  const replay=await f.call("exec_command",args,client);
  assert.equal(replay.operation_id,first.operation_id);
  assert.equal(await readFile(join(f.project,"once.txt"),"utf8"),"one\n");
  const changed=await f.raw("exec_command",{...args,cmd:args.cmd+" changed"},client);
  assert.equal(changed.isError,true);
  const second=await f.call("exec_command",{...args,operation_key:"append-again"},client);
  await f.finished(second.operation_id);
  assert.notEqual(second.operation_id,first.operation_id);
  assert.equal(await readFile(join(f.project,"once.txt"),"utf8"),"one\none\n");
});

test("实际断开 MCP 客户端后后台命令继续，并可从新连接取结果", {timeout:60000}, async t=>{
  const f=await fixture(t);
  const gate=join(f.root,"release");
  const command=await f.execute(`import {existsSync} from 'node:fs';
    const timer=setInterval(()=>{if(existsSync(${JSON.stringify(gate)})){clearInterval(timer);console.log('completed-after-disconnect');}},20);`,
    {yield_time_ms:0,operation_key:"background-disconnect"});
  assert.equal(command.running,true);
  await f.client.close();
  await writeFile(gate,"continue");
  const client=await f.newClient();
  const deadline=Date.now()+10000;
  let output:any;
  do {
    output=await f.call("read_output",{...f.scope,operation_id:command.operation_id,cursor:0},client);
    if(output.process_done)break;
    await delay(30);
  } while(Date.now()<deadline);
  assert.equal(output.process_done,true,`断连后命令未结束：${JSON.stringify(output)}`);
  assert.equal(output.result,"completed-after-disconnect\n");
});

test("新会话在同一授权工作区取消原命令，取消后结果仍可读取", {timeout:60000}, async t=>{
  const f=await fixture(t);
  const command=await f.execute("console.log('waiting-for-cancellation');setInterval(()=>{},1000);",{yield_time_ms:100});
  const client=await f.newClient();
  const meta={"openai/session":randomUUID()};
  const start=await client.callTool({name:"start_session",arguments:{title:"恢复并取消",request_key:randomUUID()},_meta:meta});
  assert.notEqual(start.isError,true,JSON.stringify(start));
  const opened=await client.callTool({name:"open_workspace",arguments:{path:f.project},_meta:meta});
  assert.notEqual(opened.isError,true,JSON.stringify(opened));
  const workspaceId=(opened.structuredContent as any).workspace_id;
  const cancelled=await client.callTool({name:"cancel_command",arguments:{workspace_id:workspaceId,operation_id:command.operation_id},_meta:meta});
  assert.notEqual(cancelled.isError,true,JSON.stringify(cancelled));
  const output=await f.finished(command.operation_id);
  assert.equal(output.process_done,true);
  const again=await client.callTool({name:"cancel_command",arguments:{workspace_id:workspaceId,operation_id:command.operation_id},_meta:meta});
  assert.notEqual(again.isError,true,JSON.stringify(again));
  assert.equal((again.structuredContent as any).cancel_requested,false);
});

test("检查点保存模型判断，派生的独立目标保留来源并分别计时", {timeout:60000}, async t=>{
  const f=await fixture(t);
  await f.call("checkpoint_task",{...f.scope,goal:"核查输出",decisions:["保留原始结果"],next_action:"读取下一组结果",evidence_refs:["README.md"]});
  const first=await f.call("workspace_context",{...f.scope,action:"recovery",task_id:f.task.task_id});
  assert.equal(first.checkpoints[0].source,"model");
  assert.equal(first.facts.source,"execution_records");
  const selected=await f.call("task_resume",{action:"inspect",task_id:f.task.task_id});
  const next=await f.call("start_session",{title:"独立派生核查",request_key:"continue-new",source_task_id:f.task.task_id,
    new_goal:true,expected_binding_revision:selected.binding.binding_revision});
  assert.notEqual(next.task_id,f.task.task_id);
  const db=openDatabase(f.config.stateDir);
  try {
    const row=db.sqlite.prepare("SELECT source_task_id,created_at FROM qm_tasks WHERE id=?").get(next.task_id) as any;
    assert.equal(row.source_task_id,f.task.task_id);
    const snapshot=await f.call("qm_session",{session_id:next.session_id,task_id:next.task_id,since_rev:-1});
    assert.equal(snapshot.snapshot.startedAt,Date.parse(row.created_at));
    assert.equal(snapshot.snapshot.currentCommand,null);
  } finally {db.close();}
  const recovered=await f.call("workspace_context",{...f.scope,action:"recovery",task_id:f.task.task_id});
  assert.equal(recovered.checkpoints[0].next_action,"读取下一组结果");
});

test("卡片批量输出从真实命令读取，完成任务关闭自动刷新", {timeout:60000}, async t=>{
  const f=await fixture(t);
  const commands=[];
  for(let index=0;index<3;index++) {
    const command=await f.execute(`console.log('batch-${index}');`);
    await f.finished(command.operation_id);
    commands.push({command_id:command.operation_id,cursor:0});
  }
  const batch=await f.call("qm_command_outputs",{session_id:f.workspace.session_id,task_id:f.task.task_id,member_id:f.workspace.member_id,commands});
  assert.equal(batch.partial,false);
  assert.deepEqual(batch.results.map((r:any)=>r.chunk),["batch-0\n","batch-1\n","batch-2\n"]);
  await f.call("finish_task",{task_id:f.task.task_id,status:"completed",summary:"真实验证完成"});
  const before=await f.call("qm_session",{session_id:f.workspace.session_id,task_id:f.task.task_id,since_rev:-1});
  assert.equal(before.snapshot.taskState,"closed");
  assert.equal(before.snapshot.capabilities.refresh,false);
  const unchanged=await f.call("qm_session",{session_id:f.workspace.session_id,task_id:f.task.task_id,since_rev:before.rev});
  assert.equal(unchanged.unchanged,true);
});

test("真实进程内存记录回收后磁盘结果保留，重建输出读取器仍可读取", {timeout:60000}, async t=>{
  const root=await mkdtemp(join(tmpdir(),"qm-output-retained-"));
  const output=new SessionOutputStore(root);
  const manager=new ProcessSessionManager({completedSessionTtlMs:20});
  t.after(async()=>{await manager.shutdown();await output.close();await rm(root,{recursive:true,force:true});});
  manager.setOutputSink({open:async id=>{await output.open("test-session",id,id);},
    append:(id,bytes)=>output.append(id,bytes),finish:(id,exit,signal)=>output.finish(id,exit,signal)});
  const script=join(root,"producer.mjs");
  await writeFile(script,"console.log('saved-on-disk');");
  const result=await manager.start({workspaceId:"workspace",cwd:root,command:`"${process.execPath}" "${script}"`,
    sessionOperationId:"op_durable_output",yieldTimeMs:12000});
  assert.equal(result.running,false);
  await delay(60);
  assert.equal(manager.findOperation("op_durable_output"),null);
  const reopened=new SessionOutputStore(root);
  try {
    const page=await reopened.modelRead("test-session","op_durable_output",0,1024);
    assert.equal(page.chunk,"saved-on-disk\n");
    assert.equal(page.processDone,true);
  } finally {await reopened.close();}
});

test("通信预算继承剩余时间，显式等待与长文件传输保持各自契约",()=>{
  const deadline=toolDeadline("read",{},undefined,1000);
  assert.equal(deadline,11000);
  assert.equal(toolDeadline("read",{},{[TOOL_DEADLINE_META]:deadline},4000),deadline);
  assert.equal(remainingToolTime(deadline,4000),7000);
  assert.throws(()=>remainingToolTime(deadline,11001),/TOOL_REQUEST_EXPIRED/);
  assert.equal(toolDeadline("write_stdin",{yield_time_ms:12000},undefined,1000),26000);
  assert.equal(toolDeadline("open_workspace",{},undefined,1000),26000);
});

test("明确取消只作用于指定真实进程，重复取消不创建新执行", {timeout:60000}, async t=>{
  const f=await fixture(t);
  const running=await f.execute("console.log('ready-to-cancel'); setInterval(()=>{},1000);",{yield_time_ms:1});
  assert.equal(running.running,true);
  const cancelled=await f.call("cancel_command",{...f.scope,operation_id:running.operation_id});
  assert.equal(cancelled.cancel_requested,true);
  const finished=await f.finished(running.operation_id);
  assert.equal(finished.process_done,true);
  assert.notEqual(finished.exit_code,0);
  const repeated=await f.call("cancel_command",{...f.scope,operation_id:running.operation_id});
  assert.equal(repeated.cancel_requested,false);
  const unaffected=await f.execute("console.log('independent-command');");
  assert.match((await f.finished(unaffected.operation_id)).result,/independent-command/);
});

test("历史已关闭交接记录继续显示后台命令，完成后保留原结束时间", {timeout:60000}, async t=>{
  const f=await fixture(t);
  const gate=join(f.root,"legacy-handoff-complete");
  const command=await f.execute(`import {existsSync} from 'node:fs';const timer=setInterval(()=>{
    if(existsSync(${JSON.stringify(gate)})){clearInterval(timer);console.log('handoff-completed');}},20);`,{yield_time_ms:1});
  // Seed a confirmed receipt from the previous release. New finish_task(handed_off) must reject.
  try {
    const db=openDatabase(f.config.stateDir),ledger=new WorkLedger(f.config.stateDir),store=new SessionStore(db.sqlite);
    const projector=new SessionProjector(store,f.config.stateDir,null,undefined,f.config.federation?.nodeId ?? "local");
    try {
      // The old finalizer captured each member before closing the Task. A bare
      // closed row is not a historical receipt with observable background work.
      for(const memberId of store.taskMemberIds(f.task.task_id)) {
        const snapshot=await projector.materialize(f.workspace.session_id,memberId,f.task.task_id);
        store.putTaskSnapshot(f.task.task_id,memberId,snapshot.rev,snapshot,
          store.fileSummaries(f.workspace.session_id,memberId,f.task.task_id));
      }
      const when=new Date().toISOString();
      db.sqlite.prepare(`UPDATE qm_tasks SET state='closed',revision=revision+1,result_status='handed_off',
        summary='legacy confirmed handoff',finished_at=?,archived_at=?,delivery_ended_at=?,closure_reason='explicit' WHERE id=?`)
        .run(when,when,when,f.task.task_id);
      db.sqlite.prepare(`INSERT INTO qm_task_finalizations(task_id,status,summary,requested_at,completed_at,error,mailbox_sequence)
        VALUES(?,'handed_off','legacy confirmed handoff',?,?,NULL,0)`).run(f.task.task_id,when,when);
      ledger.archiveTaskRuns(f.task.task_id);
    } finally {await projector.close();ledger.close();db.close();}
    const before=await f.call("qm_session",{session_id:f.workspace.session_id,task_id:f.task.task_id,since_rev:-1});
    assert.equal(before.snapshot.capabilities.refresh,true);
    assert.equal(before.snapshot.taskResult,"handed_off");
    assert.equal(typeof before.snapshot.deliveryEndedAt,"number");
    assert.equal(before.snapshot.endedAt,before.snapshot.deliveryEndedAt,"交接时本轮用时已固定");
    await writeFile(gate,"finish");
    await f.finished(command.operation_id);
    const after=await f.call("qm_session",{session_id:f.workspace.session_id,task_id:f.task.task_id,since_rev:before.rev});
    assert.equal(after.unchanged,false);
    assert.equal(after.snapshot.capabilities.refresh,false);
    assert.equal(after.snapshot.endedAt,before.snapshot.endedAt,"后台结束不重新计算本轮时长");
    assert.ok(after.snapshot.currentCommand.endedAt>=after.snapshot.endedAt);
    assert.equal(after.snapshot.currentCommand.status,"ok");
  } finally {await writeFile(gate,"finish");}
});
