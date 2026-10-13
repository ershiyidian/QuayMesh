import assert from "node:assert/strict";
import test from "node:test";
import {randomUUID} from "node:crypto";
import {openDatabase} from "../../src/db/client.js";
import {callOpen,createRealTestServer,structured} from "../session-card/server-fixture.js";

test("UJ01：同一 Task 多 iframe 挂载独立记录，重复生命周期事件去重",{timeout:60000},async t=>{
  const server=await createRealTestServer({git:false});t.after(()=>server.dispose());
  const conversation="card-multiple-mounts",meta={"openai/session":conversation};
  const task=structured(await server.client.callTool({name:"start_session",arguments:{title:"卡片挂载",request_key:"mount"},_meta:meta}));
  await callOpen(server.client,server.project,conversation);
  const first=randomUUID(),second=randomUUID();
  const emit=async(mount_id:string,stage:string)=>{
    const response=await server.client.callTool({name:"qm_widget_stage",arguments:{
      session_id:task.session_id,task_id:task.task_id,mount_id,resource_version:"task-card-v4",stage,
      display_mode:"inline",visible:stage==="visible",
    },_meta:meta});
    assert.notEqual(response.isError,true,JSON.stringify(response.content));
  };
  await emit(first,"mount");await emit(first,"mount");await emit(first,"initialized");await emit(first,"visible");await emit(first,"visible");
  await emit(second,"mount");await emit(second,"initialized");await emit(second,"visible");await emit(first,"hidden");
  const db=openDatabase(server.config.stateDir);
  try {
    const rows=db.sqlite.prepare("SELECT mount_id,stage,resource_version FROM qm_widget_stages WHERE task_id=? ORDER BY id").all(task.task_id) as Array<{mount_id:string;stage:string;resource_version:string}>;
    assert.deepEqual(rows.filter(row=>row.mount_id===first).map(row=>row.stage),["mount","initialized","visible","hidden"]);
    assert.deepEqual(rows.filter(row=>row.mount_id===second).map(row=>row.stage),["mount","initialized","visible"]);
    assert.ok(rows.every(row=>row.resource_version==="task-card-v4"));
  }finally{db.close();}
});

test("UJ02：真实卡片首次快照请求同时登记挂载和首次快照，后续轮询不增加阶段记录",{timeout:60000},async t=>{
  const server=await createRealTestServer({git:false});t.after(()=>server.dispose());
  const conversation="card-snapshot-mount",meta={"openai/session":conversation};
  const task=structured(await server.client.callTool({name:"start_session",arguments:{title:"首次快照记录",request_key:"snapshot-mount"},_meta:meta}));
  await callOpen(server.client,server.project,conversation);
  const mountId=randomUUID();
  const fetch=async(sinceRev:number,includeMount:boolean)=>{
    const response=await server.client.callTool({name:"qm_session",arguments:{
      session_id:task.session_id,task_id:task.task_id,since_rev:sinceRev,
      ...(includeMount?{mount_id:mountId,resource_version:"task-card-v4"}:{}),
    },_meta:meta});
    assert.notEqual(response.isError,true,JSON.stringify(response.content));
    return structured(response);
  };
  const initial=await fetch(-1,true);
  for(const stage of ["mount","first_snapshot"]){
    const repeated=await server.client.callTool({name:"qm_widget_stage",arguments:{
      session_id:task.session_id,task_id:task.task_id,mount_id:mountId,resource_version:"task-card-v4",stage,
    },_meta:meta});
    assert.notEqual(repeated.isError,true,JSON.stringify(repeated.content));
  }
  const unchanged=await fetch(initial.snapshot.rev as number,false);
  assert.equal(unchanged.unchanged,true);
  const db=openDatabase(server.config.stateDir);
  try {
    const rows=db.sqlite.prepare("SELECT mount_id,stage,resource_version FROM qm_widget_stages WHERE task_id=? ORDER BY id")
      .all(task.task_id) as Array<{mount_id:string;stage:string;resource_version:string}>;
    assert.deepEqual(rows.map(row=>row.stage),["mount","first_snapshot"]);
    assert.ok(rows.every(row=>row.mount_id===mountId&&row.resource_version==="task-card-v4"));
  }finally{db.close();}
  const bootstrapMount=randomUUID();
  const alreadyLoaded=await server.client.callTool({name:"qm_session",arguments:{
    session_id:task.session_id,task_id:task.task_id,since_rev:initial.snapshot.rev,
    mount_id:bootstrapMount,resource_version:"task-card-v4",
  },_meta:meta});
  assert.equal(structured(alreadyLoaded).unchanged,true);
  const again=openDatabase(server.config.stateDir);
  try {
    const stages=again.sqlite.prepare("SELECT stage FROM qm_widget_stages WHERE task_id=? AND mount_id=? ORDER BY id")
      .all(task.task_id,bootstrapMount) as Array<{stage:string}>;
    assert.deepEqual(stages.map(row=>row.stage),["mount","first_snapshot"]);
  }finally{again.close();}
});
