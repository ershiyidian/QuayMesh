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
  const receiptOnly=`op_${randomUUID().replaceAll("-","")}`,foreignId=`op_${randomUUID().replaceAll("-","")}`;
  const db=openDatabase(cloud.config.stateDir);
  try {
    const store=new SessionStore(db.sqlite),original=store.findInvocationByOperationId(operationId)!;
    assert.ok(original,"the ingress node must persist the original receipt");
    store.reserveInvocation({id:randomUUID(),ownerId:original.owner_id,transportInstanceId:"lost-before-owner-record",
      requestId:"1",sessionId:original.session_id,memberId:original.member_id,taskId:original.task_id!,
      toolName:"apply_patch",operationId:receiptOnly,argumentsJson:"{}"});
    store.updateInvocation({ownerId:original.owner_id,transportInstanceId:"lost-before-owner-record",requestId:"1",
      state:OperationState.unknown,effect:"unknown",finished:true,result:{kind:"error",errorCode:"RPC_INTERRUPTED",
        message:"Owner receipt not yet observed",effect:"unknown",retryHint:"query_original"}});
    assert.equal(store.findOperationEvent(receiptOnly),null);
    const other=store.createSession(original.owner_id,"foreign-conversation","Other conversation");
    const member=store.addMember(other.id,"worker",store.getMember(original.session_id,original.member_id).workspace_id,
      worker.project,"checkout",null),task=store.createTask(other.id,"Foreign task");
    store.reserveInvocation({id:randomUUID(),ownerId:original.owner_id,transportInstanceId:"foreign",requestId:"1",
      sessionId:other.id,memberId:member.id,taskId:task.id,toolName:"apply_patch",operationId:foreignId,argumentsJson:"{}"});
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
  const foreign=await raw("workspace_context",{workspace_id:workspaceId,action:"status",operation_id:foreignId});
  assert.equal(foreign.isError,true);assert.match(JSON.stringify(foreign),/WORKSPACE_SESSION_MISMATCH/);
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
