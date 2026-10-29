import assert from "node:assert/strict";
import test from "node:test";
import {readFile,writeFile,mkdir} from "node:fs/promises";
import {existsSync} from "node:fs";
import {join} from "node:path";
import {openDatabase} from "../../src/db/client.js";
import {canonicalResourcePath} from "../../src/execution-resources.js";
import {fixture,until} from "./fixture.js";

test("PR01/03/04/05/06/11/15/16：真实并行、资源冲突和跨Task归属",{timeout:60000},async t=>{
  const f=await fixture(t,{files:{"a/input.txt":"a\n","b/input.txt":"b\n","plain.txt":"old\n"}});
  const gate=join(f.root,"release"),markers=[join(f.root,"a-started"),join(f.root,"b-started")];
  const starts=await Promise.all(["a","b"].map((scope,index)=>f.execute(
    `import {writeFileSync,existsSync} from 'node:fs';writeFileSync(${JSON.stringify(markers[index])},String(Date.now()));
     const t=setInterval(()=>{if(existsSync(${JSON.stringify(gate)})){clearInterval(t);console.log('done-${scope}');}},20);`,
    {working_directory:scope,execution_scope:scope,yield_time_ms:0})));
  await until(()=>markers.every(existsSync));
  for(const start of starts)assert.equal((await f.call("read_output",{...f.scope,operation_id:start.operation_id})).process_done,false);
  const reads=await Promise.all(["a/input.txt","b/input.txt"].map(path=>f.call("read",{...f.scope,path})));
  assert.equal(reads[0].result.trim(),"a");assert.equal(reads[1].result.trim(),"b");
  const patches=await Promise.all(["independent1.txt","independent2.txt"].map(path=>f.call("apply_patch",{...f.scope,
    patch:`*** Begin Patch\n*** Add File: ${path}\n+written\n*** End Patch`,expected_content:{[path]:null}})));
  assert.equal(patches.length,2);
  const conflict=await f.raw("apply_patch",{...f.scope,patch:"*** Begin Patch\n*** Add File: a/blocked.txt\n+blocked\n*** Add File: free.txt\n+must-not-write\n*** End Patch"});
  assert.equal(conflict.isError,true,JSON.stringify(conflict));
  assert.equal((conflict._meta as any)?.quaymesh?.error?.code,'EXECUTION_CONFLICT');
  assert.equal((conflict._meta as any)?.quaymesh?.error?.started,false);
  assert.equal(existsSync(join(f.project,"free.txt")),false);assert.equal(existsSync(join(f.project,"a","blocked.txt")),false);
  const stale=await f.raw("apply_patch",{...f.scope,patch:"*** Begin Patch\n*** Update File: plain.txt\n@@\n-old\n+new\n*** End Patch",expected_content:{"plain.txt":"earlier\n"}});
  assert.equal(stale.isError,true);assert.equal(await readFile(join(f.project,"plain.txt"),"utf8"),"old\n");
  await Promise.all(Array.from({length:8},(_,index)=>f.call("checkpoint_task",{...f.scope,goal:`并发记录 ${index}`,decisions:["真实测试"],next_action:"等待命令"})));
  const selected=await f.call("task_resume",{action:"inspect",task_id:f.task.task_id});
  const next=await f.call("start_session",{title:"独立后续目标",request_key:"new-task",source_task_id:f.task.task_id,
    new_goal:true,expected_binding_revision:selected.binding.binding_revision});
  assert.notEqual(next.task_id,f.task.task_id);
  await writeFile(gate,"finish");
  for(const start of starts)await until(async()=>(await f.call("read_output",{...f.scope,operation_id:start.operation_id})).process_done);
  const db=openDatabase(f.config.stateDir);
  try {
    const intervals=starts.map(start=>db.sqlite.prepare(`SELECT i.created_at,i.finished_at,e.task_id
      FROM qm_invocations i JOIN qm_events e ON json_extract(e.data_json,'$.operation_id')=i.operation_id
      AND e.event_type='operation_started' WHERE i.operation_id=? LIMIT 1`).get(start.operation_id) as any);
    assert.equal(intervals[0].task_id,f.task.task_id);assert.equal(intervals[1].task_id,f.task.task_id);
    assert.ok(Date.parse(intervals[0].created_at)<Date.parse(intervals[1].finished_at));
    assert.ok(Date.parse(intervals[1].created_at)<Date.parse(intervals[0].finished_at));
  } finally {db.close();}
  const history=await f.call("qm_session",{session_id:f.task.session_id,task_id:f.task.task_id,since_rev:-1});
  assert.equal(history.snapshot.commands.filter((item:any)=>starts.some(start=>start.operation_id===item.operation_id)).length,2);
  const current=await f.call("qm_session",{session_id:next.session_id,task_id:next.task_id,since_rev:-1});
  assert.equal(current.snapshot.commands.length,0);
});

test("PR08/09/10：并发附着不重复成员，相同key只写一次，不同key允许重跑",{timeout:60000},async t=>{
  const f=await fixture(t);
  const second=join(f.project,"second");await mkdir(second);
  const attached=await Promise.all([0,1].map(()=>f.call("attach_workspace",{path:second,session_id:f.task.session_id})));
  assert.equal(attached[0].workspace_id,attached[1].workspace_id);
  const snapshot=await f.call("qm_session",{session_id:f.task.session_id,task_id:f.task.task_id,since_rev:-1});
  assert.equal(snapshot.snapshot.workspaces.filter((item:any)=>canonicalResourcePath(item.root)===canonicalResourcePath(second)).length,1);
  const file=join(second,"append.mjs");await writeFile(file,"import {appendFileSync} from 'node:fs';appendFileSync('once.txt','one\\n');\n");
  const args={workspace_id:attached[0].workspace_id,cmd:`"${process.execPath}" "${file}"`,operation_key:"same-intent",yield_time_ms:1000};
  const repeated=await Promise.all([f.call("exec_command",args),f.call("exec_command",args)]);
  assert.equal(repeated[0].operation_id,repeated[1].operation_id);
  await until(async()=>(await f.call("read_output",{workspace_id:args.workspace_id,operation_id:repeated[0].operation_id})).process_done);
  assert.equal(await readFile(join(second,"once.txt"),"utf8"),"one\n");
  const again=await f.call("exec_command",{...args,operation_key:"new-intent"});
  await until(async()=>(await f.call("read_output",{workspace_id:args.workspace_id,operation_id:again.operation_id})).process_done);
  assert.notEqual(again.operation_id,repeated[0].operation_id);assert.equal(await readFile(join(second,"once.txt"),"utf8"),"one\none\n");
});

test("PR07/13：固定profile与项目写入并行，取消只影响目标",{timeout:60000},async t=>{
  const f=await fixture(t,{configure:async config=>{
    const script=join(config.configDir,"monitor.mjs");await writeFile(script,"console.log('monitor-ready');setInterval(()=>{},1000);\n");
    return {...config,commandProfiles:{monitor:{description:"测试固定只读监控",executable:process.execPath,args:[script],reads:[script],writes:[],resources:[]}}};
  }});
  const monitor=await f.call("exec_command",{...f.scope,profile:"monitor",yield_time_ms:0});
  const independent=await f.execute("console.log('independent-ready');setInterval(()=>{},1000);",{yield_time_ms:0});
  await until(async()=>(await f.call("read_output",{...f.scope,operation_id:independent.operation_id})).result.includes("independent-ready"));
  await f.call("cancel_command",{...f.scope,operation_id:monitor.operation_id});
  await until(async()=>(await f.call("read_output",{...f.scope,operation_id:monitor.operation_id})).process_done);
  assert.equal((await f.call("read_output",{...f.scope,operation_id:independent.operation_id})).process_done,false);
  await f.call("cancel_command",{...f.scope,operation_id:independent.operation_id});
});
