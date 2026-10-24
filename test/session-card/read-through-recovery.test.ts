import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import Database from "better-sqlite3";
import { federationConfigSchema } from "../../src/federation/schema.js";
import type { SessionFeed } from "../../src/federation/session-feed.js";
import { WORKSPACE_APP_VERSION } from "../../src/session/card-contract.js";
import { createRealTestServer, freePort, structured, type RealTestServer } from "./server-fixture.js";

const meta={"openai/session":"read-through-recovery-conversation"};
const feed=(server:RealTestServer)=>(server.running.federation as unknown as {sessionFeed:SessionFeed}).sessionFeed;

async function pair(t:TestContext){
  const ports=await Promise.all([freePort(),freePort(),freePort(),freePort()]);
  const servers:RealTestServer[]=[];
  t.after(async()=>{for(const server of servers.reverse())await server.dispose();});
  for(const [index,nodeId] of ["entry","worker"].entries()){
    servers.push(await createRealTestServer({configure:async config=>{
      const tokenFile=join(config.configDir,"cluster.token");
      await writeFile(tokenFile,"read-through-recovery-real-cluster-token");
      return {...config,federation:federationConfigSchema.parse({enabled:true,nodeId,nickname:nodeId,
        capabilities:{coordinator:index===0,worker:true,discovery:false,egress:false,meshRelay:index===0,desktopUi:false,consoleRelay:false},
        coordinatorId:"entry",host:"127.0.0.1",port:ports[index],ingressPort:ports[index+2],tokenFile,
        heartbeatMs:1000,rpcTimeoutMs:5000,peers:[{id:index===0?"worker":"entry",url:`http://127.0.0.1:${ports[1-index]}`}],
        roots:[{id:"main",nickname:nodeId,path:config.allowedRoots[0]}],egress:{enabled:false},
      })};
    }}));
  }
  const [entry,worker]=servers;
  assert.ok(await entry.running.federation!.transport.waitForLink("worker",5000));
  const started=structured(await entry.client.callTool({name:"start_session",arguments:{request_key:"recovery-test-task",title:"恢复原工作区"},_meta:meta}));
  return {entry,worker,taskId:String(started.task_id),sessionId:String(started.session_id)};
}

async function open(entry:RealTestServer){
  const reply=await entry.client.callTool({name:"open_workspace",arguments:{root_id:"worker/main"},_meta:meta});
  assert.notEqual(reply.isError,true,JSON.stringify(reply));
  return {...structured(reply),...((reply._meta as {quaymesh?:Record<string,unknown>})?.quaymesh??{})};
}

function taskRow(server:RealTestServer,taskId:string){
  const db=new Database(join(server.config.stateDir,"quaymesh.sqlite"),{readonly:true});
  try{return db.prepare("select revision,last_activity_at from qm_tasks where id=?").get(taskId) as {revision:number;last_activity_at:string};}
  finally{db.close();}
}

async function read(entry:RealTestServer,sessionId:string,taskId:string,sinceRev=-1,mountId?:string,memberId?:string){
  const reply=await entry.client.callTool({name:"qm_session",arguments:{session_id:sessionId,task_id:taskId,since_rev:sinceRev,
    resource_version:WORKSPACE_APP_VERSION,...(mountId?{mount_id:mountId}:{}),...(memberId?{member_id:memberId}:{})}});
  assert.notEqual(reply.isError,true,JSON.stringify(reply));
  return structured(reply);
}

async function settleOpening(...servers:RealTestServer[]){
  // 两个真实节点共用测试事件循环；先等待 open 已启动的导出和投影自然完成。
  // 后续读请求及冷缓存 materialize 仍在外部写锁下实际执行。
  for(let pass=0;pass<20;pass++){
    const pending=servers.flatMap(server=>{
      const current=feed(server) as unknown as {
        refreshing:Map<string,Promise<void>>;
        projector:{scheduled:Map<string,Promise<void>>};
        service:{pendingRecovery:Set<Promise<void>>};
      };
      return [...current.refreshing.values(),...current.projector.scheduled.values(),...current.service.pendingRecovery];
    });
    if(!pending.length)return;
    await Promise.all(pending);
  }
  throw new Error("Opening background work did not settle");
}

function mountStages(entry:RealTestServer,taskId:string,mountId:string){
  const db=new Database(join(entry.config.stateDir,"quaymesh.sqlite"),{readonly:true});
  try{return db.prepare("select stage from qm_widget_stages where task_id=? and mount_id=? order by id").pluck().all(taskId,mountId);}
  finally{db.close();}
}

async function holdExternalWriteLock(filename:string){
  const child=spawn(process.execPath,["-e",`
    const Database=require(process.argv[2]);
    const db=new Database(process.argv[1]);
    db.exec('BEGIN IMMEDIATE');
    let released=false;
    const release=()=>{
      if(released)return;
      released=true;
      clearTimeout(timer);
      db.exec('ROLLBACK');db.close();
      if(process.connected)process.disconnect();
    };
    const timer=setTimeout(release,15000);
    process.once('message',release);
    process.once('disconnect',release);
    process.send('locked');
  `,filename,createRequire(import.meta.url).resolve("better-sqlite3")],{stdio:["ignore","ignore","pipe","ipc"]});
  let stderr="",released=false;
  child.stderr!.on("data",chunk=>{stderr+=String(chunk);});
  const done=new Promise<void>((resolve,reject)=>{
    child.once("error",reject);
    child.once("exit",code=>{released=true;code===0?resolve():reject(new Error(`SQLite lock process exited ${code}: ${stderr}`));});
  });
  void done.catch(()=>{});
  await new Promise<void>((resolve,reject)=>{
    const exited=()=>reject(new Error(`SQLite lock process exited before locking: ${stderr}`));
    child.once("exit",exited);
    child.once("error",reject);
    child.once("message",message=>{
      child.off("exit",exited);
      message==="locked"?resolve():reject(new Error(`Unexpected lock process message: ${String(message)}`));
    });
  });
  return {pid:child.pid,get released(){return released;},async release(){
    if(child.connected)child.send("release",()=>{});
    await done;
  }};
}

function expireObservation(entry:RealTestServer,taskId:string,memberId:string){
  const db=new Database(join(entry.config.stateDir,"quaymesh.sqlite"));
  try{
    const row=db.prepare("select snapshot_json from qm_task_projections where task_id=? and member_id=?").get(taskId,memberId) as {snapshot_json:string};
    const snapshot=JSON.parse(row.snapshot_json);
    snapshot.executionObservation.observedAt=Date.now()-45_000;
    db.prepare("update qm_task_projections set snapshot_json=? where task_id=? and member_id=?").run(JSON.stringify(snapshot),taskId,memberId);
  }finally{db.close();}
  const state=feed(entry) as unknown as {
    subscriptions:Map<string,{confirmedAt:number;lastRevision:number}>;
    refreshing:Map<string,Promise<void>>;
  };
  for(const subscription of state.subscriptions.values())subscription.confirmedAt=0;
  return state;
}

test("coordinator restart recovers an existing task before unchanged reads and coalesces concurrent refreshes",{timeout:90_000},async t=>{
  const {entry,worker,taskId,sessionId}=await pair(t);
  const opened=await open(entry);
  const initial=await read(entry,sessionId,taskId);
  assert.ok(initial.snapshot);
  const oldActivity=taskRow(entry,taskId).last_activity_at;
  const oldDatabase=new Database(join(entry.config.stateDir,"quaymesh.sqlite"));
  try{
    const row=oldDatabase.prepare("select snapshot_json from qm_task_projections where task_id=? and member_id=?").get(taskId,opened.member_id) as {snapshot_json:string};
    const snapshot=JSON.parse(row.snapshot_json);
    snapshot.executionObservation.observedAt=Date.now()-45_000;
    oldDatabase.prepare("update qm_task_projections set snapshot_json=? where task_id=? and member_id=?").run(JSON.stringify(snapshot),taskId,opened.member_id);
  }finally{oldDatabase.close();}
  await entry.restart(async()=>{
    const command=await worker.client.callTool({name:"exec_command",arguments:{workspace_id:String(opened.workspace_id).replace(/^qm:worker:/,""),
      cmd:"node -e \"require('node:fs').writeFileSync('during-restart.txt','completed while coordinator was down')\"",yield_time_ms:1000},_meta:meta});
    assert.notEqual(command.isError,true,JSON.stringify(command));
    const until=Date.now()+5000;
    while(Date.now()<until){
      const content=await readFile(join(worker.project,"during-restart.txt"),"utf8").catch(error=>{if(error.code==="ENOENT")return "";throw error;});
      if(content)break;
      await delay(25);
    }
    assert.equal(await readFile(join(worker.project,"during-restart.txt"),"utf8"),"completed while coordinator was down");
  });
  assert.ok(await entry.running.federation!.transport.waitForLink("worker",5000));
  const workerFeed=feed(worker),original=workerFeed.handleRequest.bind(workerFeed);
  let subscriptions=0;
  workerFeed.handleRequest=async(params,peer)=>{if(params.kind==="subscribe"){subscriptions++;await delay(2000);}return original(params,peer);};
  const currentRevision=taskRow(entry,taskId).revision;
  const requestedAt=Date.now();
  const replies=await Promise.all([read(entry,sessionId,taskId,currentRevision),read(entry,sessionId,taskId,currentRevision)]);
  assert.ok(Date.now()-requestedAt<1800,"慢来源不会阻塞前台直到完整刷新结束");
  assert.ok(replies.every(reply=>reply.unchanged===true&&reply.observation.stale===true));
  let latest=await read(entry,sessionId,taskId);
  for(let i=0;i<60&&!latest.snapshot.files.some((file:{path:string})=>file.path==="during-restart.txt");i++){
    await delay(50);latest=await read(entry,sessionId,taskId);
  }
  assert.equal(subscriptions,1,"同一任务成员的并发查询复用一次远端读取");
  assert.ok(latest.rev>currentRevision,"原工作区的状态自动恢复并推进显示版本");
  assert.ok(latest.snapshot.commands.length>initial.snapshot.commands.length);
  assert.ok(latest.snapshot.files.some((file:{path:string})=>file.path==="during-restart.txt"));
  assert.equal(latest.snapshot.taskId,taskId);
  assert.equal(latest.snapshot.workspaces[0].id,opened.member_id);
  assert.notEqual(latest.observation.stale,true);
  assert.equal(taskRow(entry,taskId).last_activity_at,oldActivity,"连接和状态查询不冒充模型执行进展");

  const database=new Database(join(entry.config.stateDir,"quaymesh.sqlite"));
  try{
    const row=database.prepare("select snapshot_json from qm_task_projections where task_id=? and member_id=?").get(taskId,opened.member_id) as {snapshot_json:string};
    const snapshot=JSON.parse(row.snapshot_json);
    snapshot.executionObservation.observedAt=Date.now()-45_000;
    database.prepare("update qm_task_projections set snapshot_json=? where task_id=? and member_id=?").run(JSON.stringify(snapshot),taskId,opened.member_id);
  }finally{database.close();}
  const subscriptionsMap=(feed(entry) as unknown as {subscriptions:Map<string,{confirmedAt:number}>}).subscriptions;
  for(const subscription of subscriptionsMap.values())subscription.confirmedAt=0;
  workerFeed.handleRequest=original;
  const before=taskRow(entry,taskId),confirmationRequestedAt=Date.now();
  const unchanged=await read(entry,sessionId,taskId,before.revision);
  assert.equal(unchanged.unchanged,true);
  assert.ok(unchanged.observation.observedAt>=confirmationRequestedAt,"内容未变也返回所属节点新确认的执行状态");
  assert.notEqual(unchanged.observation.stale,true);
  assert.equal(taskRow(entry,taskId).last_activity_at,before.last_activity_at);
});

test("a failed first subscription retries through the same workspace without reopening it",{timeout:60_000},async t=>{
  const {entry,worker,taskId,sessionId}=await pair(t);
  const workerFeed=feed(worker),original=workerFeed.handleRequest.bind(workerFeed);
  let unavailable=true;
  workerFeed.handleRequest=async(params,peer)=>{
    if(unavailable&&params.kind==="subscribe")throw new Error("TEST_OWNER_SUBSCRIPTION_UNAVAILABLE");
    return original(params,peer);
  };
  const opened=await open(entry);
  for(let i=0;i<100&&!feed(entry).subscriptionFailure(sessionId,String(opened.member_id));i++)await delay(20);
  assert.match(feed(entry).subscriptionFailure(sessionId,String(opened.member_id))??"",/TEST_OWNER_SUBSCRIPTION_UNAVAILABLE/);
  unavailable=false;
  const command=await entry.client.callTool({name:"exec_command",arguments:{workspace_id:opened.workspace_id,cmd:"node -e \"process.stdout.write('same workspace recovered')\"",yield_time_ms:1000},_meta:meta});
  assert.notEqual(command.isError,true,JSON.stringify(command));
  let result=await read(entry,sessionId,taskId);
  for(let i=0;i<30&&!result.snapshot.commands.length;i++){await delay(50);result=await read(entry,sessionId,taskId);}
  assert.ok(result.snapshot.commands.length>0);
  assert.equal(feed(entry).subscriptionFailure(sessionId,String(opened.member_id)),null);
  assert.equal(result.snapshot.workspaces[0].id,opened.member_id);
});

for(const lockedNode of ["entry","worker"] as const){
  test(`read-through stays responsive and recovers after an external ${lockedNode} SQLite writer outlasts its deadline`,{timeout:60_000},async t=>{
    const {entry,worker,taskId,sessionId}=await pair(t);
    const opened=await open(entry),memberId=String(opened.member_id);
    await settleOpening(entry,worker);
    const initial=await read(entry,sessionId,taskId);
    assert.ok(initial.snapshot);
    await settleOpening(entry,worker);
    const state=expireObservation(entry,taskId,memberId);
    assert.equal(state.refreshing.size,0);
    if(lockedNode==="worker"){
      // 来源冷缓存迫使真实 RPC 经过 materialize 的缓存写入路径。
      const db=new Database(join(worker.config.stateDir,"quaymesh.sqlite"));
      try{db.prepare("delete from qm_task_projections where task_id=? and member_id=?").run(taskId,memberId);}
      finally{db.close();}
      for(const subscription of state.subscriptions.values())subscription.lastRevision=-1;
    }
    const workerFeed=feed(worker),original=workerFeed.handleRequest.bind(workerFeed);
    let requested=0,settled=0;
    workerFeed.handleRequest=async(params,peer,signal)=>{
      if(params.kind!=="subscribe")return original(params,peer,signal);
      requested++;
      try{return await original(params,peer,signal);}finally{settled++;}
    };
    const before=taskRow(entry,taskId);
    const mountId=randomUUID();
    const locked=lockedNode==="entry"?entry:worker;
    const lock=await holdExternalWriteLock(join(locked.config.stateDir,"quaymesh.sqlite"));
    let ticks=0,maxGapMs=0,previous=performance.now();
    const timer=setInterval(()=>{
      const now=performance.now();maxGapMs=Math.max(maxGapMs,now-previous);previous=now;ticks++;
    },20);
    try{
      const started=performance.now();
      const [full,unchanged]=await Promise.all([read(entry,sessionId,taskId,-1,mountId),read(entry,sessionId,taskId,before.revision,mountId,memberId)]);
      const foregroundMs=performance.now()-started;
      assert.ok(foregroundMs>=650&&foregroundMs<1500,`750 ms 前台预算（含传输余量）：${foregroundMs}`);
      assert.equal(lock.released,false,"读请求必须在外部写锁仍持有时返回");
      assert.equal(unchanged.unchanged,true);
      assert.equal(unchanged.observation.stale,true);
      assert.equal(full.snapshot.taskId,taskId);
      assert.equal(full.snapshot.workspaces[0].id,memberId);
      assert.deepEqual(full.snapshot.commands,initial.snapshot.commands,"仍显示上次已确认的数据");
      assert.deepEqual(mountStages(entry,taskId,mountId),lockedNode==="entry"?[]:["mount","first_snapshot"],
        "挂载诊断可落盘时正常记录，入口写锁下不拖延读取");
      const pending=[...state.refreshing.values()];
      assert.equal(pending.length,1,"并发读共享同一恢复请求");
      await Promise.all(pending);
      for(let i=0;i<25&&settled!==requested;i++)await delay(20);
      const totalMs=performance.now()-started;
      assert.ok(totalMs>=4500&&totalMs<6500,`网络、快照及错误落库共享 5 s 上限：${totalMs}`);
      assert.equal(state.refreshing.size,0,"截止后释放刷新占位，后续读取可重试");
      assert.equal(requested,1);
      assert.equal(settled,requested,"来源 materialize 在同一期限内取消或结束");
      assert.ok(feed(entry).subscriptionFailure(sessionId,memberId));
      assert.equal(lock.released,false,"失败处理不能再同步等待另一轮 SQLite 锁");
      assert.ok(ticks>=100,`event loop ticks: ${ticks}`);
      assert.ok(maxGapMs<700,`最大事件循环间隔：${maxGapMs}`);
      assert.equal(entry.running.federation!.transport.links.get("worker")?.connected,true);
      await lock.release();
      const recoveryRequestedAt=Date.now();
      const recovered=await read(entry,sessionId,taskId,before.revision,mountId);
      assert.equal(recovered.unchanged,true);
      assert.notEqual(recovered.observation.stale,true);
      assert.ok(recovered.observation.observedAt>=recoveryRequestedAt);
      assert.equal(feed(entry).subscriptionFailure(sessionId,memberId),null);
      assert.equal(taskRow(entry,taskId).last_activity_at,before.last_activity_at,"观察恢复不冒充业务进展");
      assert.deepEqual(mountStages(entry,taskId,mountId),["mount","first_snapshot"],"重试挂载指标幂等，不重复插入阶段");
      const selected=await read(entry,sessionId,taskId,-1,mountId,memberId);
      assert.equal(selected.snapshot.taskId,taskId);
      assert.equal(selected.snapshot.workspaces[0].id,memberId,"入口允许读取所属远端成员的投影");
      const otherReply=await entry.client.callTool({name:"start_session",arguments:{request_key:randomUUID(),title:"隔离的授权范围"},
        _meta:{"openai/session":"read-through-separate-conversation"}});
      assert.notEqual(otherReply.isError,true,JSON.stringify(otherReply));
      const other=structured(otherReply);
      assert.notEqual(other.session_id,sessionId);
      for(const rejected of [
        {session_id:sessionId,task_id:taskId,member_id:"not-a-member",code:/TASK_MEMBER_MISMATCH/},
        {session_id:sessionId,task_id:other.task_id,member_id:memberId,code:/TASK_SESSION_MISMATCH/},
        {session_id:other.session_id,task_id:other.task_id,member_id:memberId,code:/TASK_MEMBER_MISMATCH/},
      ]){
        const {code,...scope}=rejected;
        const reply=await entry.client.callTool({name:"qm_session",arguments:{...scope,since_rev:-1,resource_version:WORKSPACE_APP_VERSION}});
        assert.equal(reply.isError,true,"观察仍拒绝非法成员及跨会话任务/成员组合");
        assert.match(JSON.stringify(reply),code);
      }
      t.diagnostic(JSON.stringify({locked_node:lockedNode,lock_process:lock.pid,foreground_ms:foregroundMs,
        refresh_ms:totalMs,ticks,max_gap_ms:maxGapMs,recovered_task_id:taskId,recovered_member_id:memberId}));
    }finally{
      clearInterval(timer);
      workerFeed.handleRequest=original;
      await lock.release();
    }
  });
}
