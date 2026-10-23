import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {openDatabase} from "../db/client.js";
import {SessionStore} from "./store.js";

test("D01：大型真实事件库按操作索引定位，最新尝试与会话成员范围保持准确",async t=>{
  const directory=await mkdtemp(join(tmpdir(),"qm-operation-index-")),db=openDatabase(directory),store=new SessionStore(db.sqlite);
  t.after(async()=>{db.close();await rm(directory,{recursive:true,force:true});});
  const session=store.createSession("owner","conversation","Indexed status"),
    member=store.addMember(session.id,"local","ws",directory,"checkout",null),task=store.createTask(session.id,"Lookup");
  const other=store.addMember(session.id,"remote","other",directory,"checkout",null),at=new Date().toISOString();
  const insert=db.sqlite.prepare(`INSERT INTO qm_events(session_id,task_id,member_id,event_type,source_id,data_json,created_at)
    VALUES(?,?,?,?,?,?,?)`);
  db.sqlite.transaction(()=>{
    for(let i=0;i<20_000;i++)insert.run(session.id,task.id,member.id,"operation_started",`noise-${i}`,JSON.stringify({operation_id:`op-noise-${i}`}),at);
    insert.run(session.id,task.id,member.id,"operation_started","op-target",JSON.stringify({operation_id:"op-target",attempt:1}),at);
    insert.run(session.id,task.id,member.id,"operation_started","retry-event",JSON.stringify({operation_id:"op-target",attempt:2}),at);
    insert.run(session.id,task.id,member.id,"operation_finished","finish-event",JSON.stringify({operation_id:"op-target",status:"succeeded"}),at);
    insert.run(session.id,task.id,other.id,"operation_finished","foreign-event",JSON.stringify({operation_id:"op-target",status:"failed"}),at);
  })();
  assert.equal(store.findOperationEvent("op-target")?.payload.attempt,2);
  const scoped=store.eventsForOperation("op-target",session.id,member.id);
  assert.equal(scoped.length,3);assert.equal(scoped.at(-1)?.payload.status,"succeeded");
  const lookups=[
    ["SELECT sequence FROM qm_events WHERE source_id=? AND event_type='operation_started' ORDER BY sequence DESC LIMIT 1","qm_events_source_type"],
    ["SELECT sequence FROM qm_events WHERE json_extract(data_json,'$.operation_id')=? AND event_type='operation_started' ORDER BY sequence DESC LIMIT 1","qm_events_operation_type"],
  ];
  for(const [sql,index] of lookups){
    const plan=db.sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all("op-target") as Array<{detail:string}>;
    assert.ok(plan.some(row=>row.detail.includes(index)),JSON.stringify(plan));
    assert.ok(!plan.some(row=>/SCAN qm_events/u.test(row.detail)),JSON.stringify(plan));
  }
});
