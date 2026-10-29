import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {openDatabase} from "../../src/db/client.js";
import {SessionStore} from "../../src/session/store.js";
import {createInvocationContext,executeRecorded} from "../../src/session/invocations.js";
import {classifyError,classifyToolResultError,toolErrorResult} from "../../src/session/outcome.js";
import {ExecutionConflictError} from "../../src/execution-coordinator.js";

async function fixture(){
  const directory=await mkdtemp(join(tmpdir(),"qm-outcome-")),database=openDatabase(join(directory,"state")),store=new SessionStore(database.sqlite);
  const session=store.createSession("owner","conversation","outcome"),member=store.addMember(session.id,"desktop","ws",directory,"checkout",null);
  return {directory,database,store,context:createInvocationContext({auth:{owner_id:"owner"},transport:{instance_id:"transport"},request:{id:"request",conversation_id:"conversation",tool_name:"patch"},session:{session_id:session.id,member_id:member.id,workspace_id:"ws"}}),async close(){database.close();await rm(directory,{recursive:true,force:true});}};
}

test("OP08：明确未启动、部分效果和远端未知使用不同 effect",()=>{
  const conflict=new ExecutionConflictError("claim",undefined,"冲突",undefined,"not_started");
  assert.deepEqual(classifyError(conflict,{sideEffecting:true,effectStarted:true}).effect,"not_started");
  const partial=classifyError(new Error("local write failed"),{sideEffecting:true,effectStarted:true});
  assert.equal(partial.effect,"partial");assert.equal(partial.retryHint,"do_not_retry");
  const timeout=Object.assign(new Error("remote timeout"),{code:"REQUEST_TIMEOUT"});
  const unknown=classifyError(timeout,{sideEffecting:true,forwarded:true,effectStarted:true});
  assert.equal(unknown.effect,"unknown");assert.equal(unknown.retryHint,"query_original");
  const result=toolErrorResult(timeout,{operationId:"op-1",ownerNodeId:"s2",sideEffecting:true,forwarded:true});
  assert.equal(result.structuredContent.operation_id,"op-1");assert.equal(result.structuredContent.owner_node_id,"s2");
  const returned=classifyToolResultError({isError:true,content:[{type:"text",text:"执行资源暂时不可用。操作尚未开始。"}],
    structuredContent:{error_code:"EXECUTION_CONFLICT",effect:"not_started"}},{sideEffecting:true});
  assert.equal(returned.effect,"not_started");assert.equal(returned.retryHint,"retry_later");
});

test("OP09：记录层保留 not_started 和 unknown，不再统一写 completed",async t=>{
  const f=await fixture();t.after(()=>f.close());
  const conflict=await executeRecorded(f.store,f.context,{operation_key:"conflict"},{
    beforeEffect(){throw new ExecutionConflictError("claim",undefined,"冲突");},invoke:async()=>({ok:true}),sideEffecting:true,
  }).catch(error=>error);
  assert.match(String(conflict),/冲突/);
  const first=f.store.findKeyedInvocation("owner",f.context.session_id,f.context.member_id,"conflict")!;
  assert.equal(first.effect,"not_started");

  const secondContext={...f.context,request_id:"request-2",invocation_id:"invocation-2"};
  const timeout=Object.assign(new Error("lost response"),{code:"REQUEST_TIMEOUT"});
  await assert.rejects(executeRecorded(f.store,secondContext,{operation_key:"timeout"},{invoke:async()=>{throw timeout;},sideEffecting:true,forwarded:true}),/lost response/);
  const second=f.store.findKeyedInvocation("owner",f.context.session_id,f.context.member_id,"timeout")!;
  assert.equal(second.effect,"unknown");assert.equal(second.state,"unknown");
});
