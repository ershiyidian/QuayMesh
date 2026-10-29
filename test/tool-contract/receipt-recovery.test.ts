import assert from "node:assert/strict";
import test from "node:test";
import {randomUUID} from "node:crypto";
import {readFile,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {openDatabase} from "../../src/db/client.js";
import {SessionStore} from "../../src/session/store.js";
import {OperationState} from "../../src/session/types.js";
import {replyBytes,REPLY_BYTES} from "../../src/bounded-reply.js";
import {twoNodes} from "./fixture.js";

test("B04：真实双节点联合入口回执与 owner 状态，查无记录和离线都保留原操作身份",{timeout:60000},async t=>{
  const {worker,cloud}=await twoNodes(t);
  const meta={"openai/session":randomUUID()};
  const raw=(name:string,args:Record<string,unknown>)=>cloud.client.callTool({name,arguments:args,_meta:meta});
  const call=async(name:string,args:Record<string,unknown>)=>{
    const reply=await raw(name,args);assert.notEqual(reply.isError,true,JSON.stringify(reply));
    return reply.structuredContent as Record<string,any>;
  };
  await call("start_session",{title:"Recover entry receipt",request_key:randomUUID()});
  const opened=await call("open_workspace",{root_id:"worker/main"}),workspaceId=opened.workspace_id;
  const script=join(worker.project,"once.mjs");
  await writeFile(script,"import {appendFileSync} from 'node:fs';appendFileSync('once.txt','once\\n');\n");
  const command={workspace_id:workspaceId,cmd:`"${process.execPath}" "${script}"`,yield_time_ms:2000,operation_key:randomUUID()};
  const completed=await call("exec_command",command),operationId=completed.operation_id;
  assert.equal(await readFile(join(worker.project,"once.txt"),"utf8"),"once\n");
  const receiptOnly=`op_${randomUUID().replaceAll("-","")}`,historicalId=`op_${randomUUID().replaceAll("-","")}`;
  let originalTaskId="",historicalTaskId="",historicalSessionId="";
  const db=openDatabase(cloud.config.stateDir);
  try {
    const store=new SessionStore(db.sqlite),original=store.findInvocationByOperationId(operationId)!;
    assert.ok(original,"the ingress node must persist the original receipt");
    originalTaskId=original.task_id!;
    store.reserveInvocation({id:randomUUID(),ownerId:original.owner_id,transportInstanceId:"lost-before-owner-record",
      requestId:"1",sessionId:original.session_id,memberId:original.member_id,taskId:original.task_id!,
      toolName:"apply_patch",operationId:receiptOnly,argumentsJson:"{}"});
    store.updateInvocation({ownerId:original.owner_id,transportInstanceId:"lost-before-owner-record",requestId:"1",
      state:OperationState.unknown,effect:"unknown",finished:true,result:{kind:"error",errorCode:"RPC_INTERRUPTED",
        message:"Owner receipt not yet observed",effect:"unknown",retryHint:"query_original"}});
    assert.equal(store.findOperationEvent(receiptOnly),null);
    const other=store.createSession(original.owner_id,"historical-conversation","Other conversation");
    const member=store.addMember(other.id,"worker",store.getMember(original.session_id,original.member_id).workspace_id,
      worker.project,"checkout",null),task=store.createTask(other.id,"Historical task");
    historicalTaskId=task.id;historicalSessionId=other.id;
    store.reserveInvocation({id:randomUUID(),ownerId:original.owner_id,transportInstanceId:"historical",requestId:"1",
      sessionId:other.id,memberId:member.id,taskId:task.id,toolName:"apply_patch",operationId:historicalId,argumentsJson:"{}"});
  } finally {db.close();}
  const query=(id:string)=>call("workspace_context",{workspace_id:workspaceId,action:"status",operation_id:id});
  const known=await query(operationId);
  assert.equal(known.owner_lookup,"found");assert.equal(known.owner_node_id,"worker");
  assert.equal(known.receipt_node_id,"cloud");assert.equal(known.entry_receipt.operation_id,operationId);
  const missing=await query(receiptOnly);
  assert.equal(missing.owner_lookup,"not_found");assert.equal(missing.operation_state,"unknown");
  assert.equal(missing.effect,"unknown");assert.equal(missing.entry_receipt.operation_id,receiptOnly);
  assert.deepEqual(missing.unknown_effects,[receiptOnly]);
  assert.equal(missing.next_action.arguments.operation_id,receiptOnly);
  const batch=await call("workspace_context",{workspace_id:workspaceId,action:"status",operation_ids:[operationId,receiptOnly,"op_123abc"]});
  assert.equal(batch.partial,true);assert.equal(batch.results[0].owner_lookup,"found");
  assert.equal(batch.results[1].owner_lookup,"not_found");assert.equal(batch.results[2].operation_state,"unknown");
  assert.ok(replyBytes(batch)<=REPLY_BYTES);
  // 同 owner 的 Task 不受旧 conversation 隔离；明确操作身份允许只读原回执。
  const privateId=`op_${randomUUID().replaceAll("-","")}`,privateMarker=`private-result-${randomUUID()}`;
  const privateIdentities:string[]=[privateMarker];
  for(const server of [cloud,worker]){
    const database=openDatabase(server.config.stateDir);
    try{
      const store=new SessionStore(database.sqlite),original=store.findInvocationByOperationId(operationId)!;
      const session=store.createSession("other-owner",randomUUID(),privateMarker);
      const member=store.addMember(session.id,"worker",store.getMember(original.session_id,original.member_id).workspace_id,
        worker.project,"checkout",null),task=store.createTask(session.id,privateMarker);
      privateIdentities.push(session.id,task.id,member.id);
      store.reserveInvocation({id:randomUUID(),ownerId:"other-owner",transportInstanceId:"private",requestId:"1",
        sessionId:session.id,memberId:member.id,taskId:task.id,toolName:"apply_patch",operationId:privateId,argumentsJson:"{}"});
      store.updateInvocation({ownerId:"other-owner",transportInstanceId:"private",requestId:"1",state:OperationState.succeeded,
        effect:"completed",finished:true,responded:true,result:{kind:"result",value:{result:privateMarker,task_id:task.id}}});
    }finally{database.close();}
  }
  const observationState=()=>[cloud,worker].map(server=>{
    const database=openDatabase(server.config.stateDir);
    try{return{
      sessions:database.sqlite.prepare("SELECT id,current_task_id FROM qm_sessions ORDER BY id").all(),
      bindings:database.sqlite.prepare("SELECT id,task_id,revision FROM qm_task_bindings ORDER BY id").all(),
      counts:Object.fromEntries(["qm_sessions","qm_tasks","qm_task_members","qm_invocations","qm_events"]
        .map(table=>[table,database.sqlite.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get()])),
    };}finally{database.close();}
  });
  const beforeObservations=observationState();
  const historical=await query(historicalId);
  assert.equal(historical.operation_id,historicalId);
  assert.equal(historical.task_id,historicalTaskId);
  assert.equal(historical.session_id,historicalSessionId);
  assert.equal(historical.entry_receipt.operation_id,historicalId);
  assert.equal(historical.entry_receipt.task_id,historicalTaskId);
  assert.equal(historical.operation_state,"accepted");
  assert.equal(historical.effect,"not_started");
  assert.equal(historical.owner_lookup,"unreachable","the Worker has no mirror; observing must not create one");
  assert.deepEqual(observationState(),beforeObservations,"reading another owned Task cannot select it or create records");

  // 不同 owner 的真实回执与未知 operation 一样不可见，包括没有 host entry 的调用。
  for(const entry of [true,false]){
    for(const id of [privateId,`op_${randomUUID().replaceAll("-","")}`]){
      const reply=await cloud.client.callTool({name:"workspace_context",arguments:{workspace_id:workspaceId,action:"status",
        operation_id:id,...(!entry?{task_id:originalTaskId}:{})},...(entry?{_meta:meta}:{})});
      assert.notEqual(reply.isError,true,JSON.stringify(reply));
      const status=reply.structuredContent as Record<string,any>;
      assert.equal(status.operation_id,id);assert.equal(status.lookup,"not_found");
      assert.equal(status.operation_state,"unknown");assert.equal(status.effect,"unknown");
      assert.equal(status.result_ready,false);assert.deepEqual(status.operations,[]);
      assert.equal(status.entry_receipt,undefined);
      for(const identity of privateIdentities)assert.equal(JSON.stringify(reply).includes(identity),false);
    }
  }
  for(const id of [privateId,`op_${randomUUID().replaceAll("-","")}`]){
    const reply=await cloud.client.callTool({name:"workspace_context",arguments:{workspace_id:workspaceId,action:"status",operation_id:id}});
    assert.equal(reply.isError,true);
    assert.equal((reply.structuredContent as Record<string,unknown>).error_code,"SESSION_BINDING_AMBIGUOUS");
    for(const identity of privateIdentities)assert.equal(JSON.stringify(reply).includes(identity),false);
  }
  assert.deepEqual(observationState(),beforeObservations,"unauthorized and unknown observations cannot create records or change selection");
  const replay=await call("exec_command",command);assert.equal(replay.operation_id,operationId);
  assert.equal(await readFile(join(worker.project,"once.txt"),"utf8"),"once\n");
  await worker.dispose();
  const offline=await query(operationId);
  assert.equal(offline.owner_lookup,"unreachable");assert.equal(offline.operation_id,operationId);
  assert.equal(offline.entry_receipt.operation_id,operationId);
  assert.equal(offline.operation_state,"succeeded");
  const unknown=await query(receiptOnly);
  assert.equal(unknown.owner_lookup,"unreachable");assert.equal(unknown.operation_state,"unknown");
  assert.equal(unknown.observation_error.code,"NODE_UNAVAILABLE");
  // B08：完整 Cloud HTTP→路由→离线 owner 链路的原样错误必须保留同一个 code。
  const unavailable=await raw("workspace_context",{workspace_id:workspaceId,action:"status",operation_id:"op_aabbcc"});
  assert.equal(unavailable.isError,true);
  const error=unavailable.structuredContent as Record<string,unknown>;
  assert.equal(error.error_code,"NODE_UNAVAILABLE");assert.equal(error.effect,"unknown");
  assert.equal(error.retry_hint,"query_original");
  assert.match(JSON.stringify(unavailable.content),/QuayMesh recovery: error_code=NODE_UNAVAILABLE; effect=unknown; retry_hint=query_original/);
});

test("批量状态按最终文本镜像计费，八个真实命令保留身份并可逐项完整续读",{timeout:120000},async t=>{
  const {worker,cloud}=await twoNodes(t),meta={"openai/session":randomUUID()};
  const raw=(name:string,args:Record<string,unknown>)=>cloud.client.callTool({name,arguments:args,_meta:meta});
  const textBody=(reply:Awaited<ReturnType<typeof raw>>):Record<string,any>=>{
    assert.notEqual(reply.isError,true,JSON.stringify(reply));
    assert.ok(Buffer.byteLength(JSON.stringify(reply))<=REPLY_BYTES);
    assert.ok(Array.isArray(reply.content));
    const first=reply.content[0];
    assert.ok(first&&typeof first==="object"&&"type" in first&&first.type==="text"&&"text" in first&&typeof first.text==="string");
    const body=JSON.parse(first.text);
    assert.deepEqual(body,reply.structuredContent);
    return body;
  };
  const task=textBody(await raw("start_session",{title:"Bounded status batch",request_key:randomUUID()}));
  const workspace=textBody(await raw("open_workspace",{root_id:"worker/main"}));
  const text='中文😀"\\'.repeat(700),script=join(worker.project,"status-output.mjs");
  await writeFile(script,`process.stdout.write(${JSON.stringify(text)});\n`);
  const commands=[];
  for(let index=0;index<8;index++){
    const reply=await raw("exec_command",{workspace_id:workspace.workspace_id,cmd:`"${process.execPath}" "${script}"`,
      yield_time_ms:2000,max_output_tokens:4000,operation_key:randomUUID()});
    assert.notEqual(reply.isError,true,JSON.stringify(reply));
    const command=reply.structuredContent as Record<string,any>;
    assert.equal(command.running,false);
    assert.equal(command.result,text);
    commands.push(command);
  }
  const batch=textBody(await raw("workspace_context",{workspace_id:workspace.workspace_id,action:"status",
    operation_ids:commands.map(command=>command.operation_id)}));
  assert.equal(batch.partial,false);
  assert.deepEqual(batch.results.map((row:Record<string,unknown>)=>row.operation_id),commands.map(command=>command.operation_id));
  for(const row of batch.results){
    assert.equal(row.task_id,task.task_id);
    assert.equal(row.operation_state,"succeeded");
    assert.equal(row.effect,"completed");
    assert.equal(row.owner_lookup,"found");
    assert.equal(row.entry_receipt.operation_id,row.operation_id);
    assert.equal(row.details_deferred,true);
    assert.equal(row.next_action.tool,"workspace_context");
    assert.equal(row.next_action.arguments.operation_id,row.operation_id);
    assert.equal(row.next_action.arguments.task_id,task.task_id);
    let offset=0,serialized="";
    for(let pageIndex=0;pageIndex<30;pageIndex++){
      const status=textBody(await raw(row.next_action.tool,{...row.next_action.arguments,offset}));
      assert.equal(status.operation_id,row.operation_id);
      const page=status.initial_receipt_page;
      assert.ok(page,"the original receipt remains pageable after its batch preview was deferred");
      assert.equal(page.offset,offset);
      serialized+=page.text;
      if(page.next_offset===null)break;
      assert.ok(page.next_offset>offset);
      offset=page.next_offset;
      assert.ok(pageIndex<29,"single-operation pagination must finish");
    }
    assert.equal(JSON.parse(serialized).structuredContent.result,text);
  }
});
