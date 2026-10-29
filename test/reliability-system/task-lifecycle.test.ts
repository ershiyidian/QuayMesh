import assert from "node:assert/strict";
import test from "node:test";
import {rm} from "node:fs/promises";
import {join} from "node:path";
import {openDatabase} from "../../src/db/client.js";
import {validateSnapshot} from "../../src/session/schema.js";
import {callOpen,createRealTestServer,structured} from "../session-card/server-fixture.js";

test("TK01/TK02：新独立目标保留旧Task；显式结束仅固定所选目标的真实结果",{timeout:60000},async t=>{
  const server=await createRealTestServer({git:false,uiEnabled:true});t.after(()=>server.dispose());
  const conversation="task-archive-lifecycle",meta={"openai/session":conversation};
  const first=structured(await server.client.callTool({name:"start_session",arguments:{title:"第一轮",request_key:"first"},_meta:meta}));
  const opened=structured(await callOpen(server.client,server.project,conversation));
  const selected=structured(await server.client.callTool({name:"task_resume",arguments:{action:"inspect",task_id:first.task_id},_meta:meta}));
  const second=structured(await server.client.callTool({name:"start_session",arguments:{title:"第二轮",request_key:"second",
    new_goal:true,expected_binding_revision:(selected.binding as {binding_revision:number}).binding_revision},_meta:meta}));
  assert.notEqual(first.task_id,second.task_id);

  const db=openDatabase(server.config.stateDir);
  try {
    const previous=db.sqlite.prepare(`SELECT state,result_status,closure_reason,archived_at,delivery_ended_at,source_kind
      FROM qm_tasks WHERE id=?`).get(first.task_id) as Record<string,unknown>;
    assert.equal(previous.state,"active");assert.equal(previous.result_status,null);
    assert.equal(previous.closure_reason,null);assert.equal(previous.archived_at,null);
    assert.equal(previous.delivery_ended_at,null);assert.equal(previous.source_kind,"user_request");
  } finally {db.close();}

  const oldSnapshot=validateSnapshot(structured(await server.client.callTool({name:"qm_session",arguments:{
    session_id:opened.session_id,task_id:first.task_id,member_id:opened.member_id,since_rev:-1}})).snapshot);
  assert.equal(oldSnapshot.taskState,"active");assert.equal(oldSnapshot.closureReason,null);assert.equal(oldSnapshot.taskResult,null);
  assert.equal(oldSnapshot.deliveryEndedAt,null);assert.equal(oldSnapshot.endedAt,null);assert.equal(oldSnapshot.status,"idle");
  assert.ok(!oldSnapshot.notices.some(value=>value.includes("已归档")));

  const finished=structured(await server.client.callTool({name:"finish_task",arguments:{task_id:second.task_id,status:"completed",summary:"第二轮完成"},_meta:meta}));
  assert.equal(finished.result_status,"completed");
  const finalSnapshot=validateSnapshot(structured(await server.client.callTool({name:"qm_session",arguments:{
    session_id:opened.session_id,task_id:second.task_id,member_id:opened.member_id,since_rev:-1}})).snapshot);
  assert.equal(finalSnapshot.closureReason,"explicit");assert.equal(finalSnapshot.taskResult,"completed");
  assert.equal(finalSnapshot.status,"done");assert.ok(finalSnapshot.deliveryEndedAt);assert.equal(finalSnapshot.endedAt,finalSnapshot.deliveryEndedAt);
  const unchanged=validateSnapshot(structured(await server.client.callTool({name:"qm_session",arguments:{
    session_id:opened.session_id,task_id:first.task_id,member_id:opened.member_id,since_rev:-1}})).snapshot);
  assert.equal(unchanged.taskState,"active");assert.equal(unchanged.taskResult,null);
  assert.equal(unchanged.archivedAt,null);assert.equal(unchanged.deliveryEndedAt,null);
});

test("TK03/R34：辅助变化摘要失败不吞掉已确认交付结果",{timeout:60000},async t=>{
  const server=await createRealTestServer({git:true,uiEnabled:true});t.after(()=>server.dispose());
  const conversation="task-change-summary-failure",meta={"openai/session":conversation};
  const task=structured(await server.client.callTool({name:"start_session",arguments:{title:"变化摘要失败",request_key:"summary-failure"},_meta:meta}));
  const opened=structured(await callOpen(server.client,server.project,conversation));
  const patch=await server.client.callTool({name:"apply_patch",arguments:{workspace_id:opened.workspace_id,
    patch:"*** Begin Patch\n*** Add File: delivered.txt\n+delivered\n*** End Patch"},_meta:meta});
  assert.notEqual(patch.isError,true,JSON.stringify(patch.content));
  // 删除真实 Git 对象库，让后续摘要捕获通过真实 Git 命令失败；交付内容本身已经写入。
  await rm(join(server.project,".git","objects"),{recursive:true,force:true,maxRetries:5,retryDelay:100});
  const finish=await server.client.callTool({name:"finish_task",arguments:{task_id:task.task_id,status:"completed",summary:"文件已经交付"},_meta:meta});
  assert.notEqual(finish.isError,true,JSON.stringify(finish.content));
  assert.equal(structured(finish).result_status,"completed");

  const db=openDatabase(server.config.stateDir);
  try {
    const row=db.sqlite.prepare("SELECT result_status,change_summary_state,change_summary_error,delivery_ended_at FROM qm_tasks WHERE id=?")
      .get(task.task_id) as Record<string,unknown>;
    assert.equal(row.result_status,"completed");assert.equal(row.change_summary_state,"incomplete");
    assert.equal(typeof row.change_summary_error,"string");assert.equal(typeof row.delivery_ended_at,"string");
  } finally {db.close();}
  const snapshot=validateSnapshot(structured(await server.client.callTool({name:"qm_session",arguments:{
    session_id:opened.session_id,task_id:task.task_id,member_id:opened.member_id,since_rev:-1}})).snapshot);
  assert.equal(snapshot.taskResult,"completed");assert.equal(snapshot.changeSummary?.state,"incomplete");
  assert.ok(snapshot.notices.some(value=>value.includes("变化摘要未完整取得")));
});
