import test,{type TestContext} from "node:test";
import assert from "node:assert/strict";
import {chmod,mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {Readable,Writable} from "node:stream";
import Database from "better-sqlite3";
import {LocalUserClient,LocalUserClientError} from "../../src/local-user-api/client.js";
import {runLocalUserApiCli} from "../../src/local-user-api/cli.js";
import type {LocalCredentialVault} from "../../src/local-user-api/credentials.js";
import {LocalApiSessions,startLocalUnixApi} from "../../src/local-user-api/ipc.js";
import {LocalCredentialVerifier,LocalUserGrantStore} from "../../src/local-user-api/grants.js";
import {LocalObservationStore} from "../../src/local-user-api/observations.js";
import {LocalUserDispatcher} from "../../src/local-user-api/dispatcher.js";
import {localUserApiSchema} from "../../src/db/local-user-api-schema.js";
import {taskPeerSchema} from "../../src/db/task-peer-schema.js";
import {TaskPeerMailboxStore,type TaskPeerActivity} from "../../src/messaging/task-peer-mailbox.js";
import {taskPrincipalFromAuthInfo} from "../../src/tasks/task-access.js";
import {requestContextStorage} from "../../src/session/invocations.js";
import type {InvocationContext} from "../../src/session/types.js";
import type {TrustedInvocationEnvelope} from "../../src/federation/session-types.js";

async function fixture(t:TestContext){
  const db=new Database(":memory:");db.pragma("foreign_keys=ON");
  db.exec(`CREATE TABLE qm_sessions(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL);
    CREATE TABLE qm_tasks(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES qm_sessions(id),state TEXT NOT NULL,
      title TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,finished_at TEXT,result_status TEXT,
      last_activity_at TEXT NOT NULL DEFAULT 'unchanged');
    CREATE TABLE qm_session_members(id TEXT PRIMARY KEY,node_id TEXT NOT NULL);
    CREATE TABLE qm_task_members(task_id TEXT NOT NULL,member_id TEXT NOT NULL);
    CREATE TABLE qm_task_finalizations(task_id TEXT PRIMARY KEY,error TEXT,completed_at TEXT,recovery_state TEXT);
    CREATE TABLE qm_invocations(id TEXT PRIMARY KEY,operation_id TEXT,owner_id TEXT,task_id TEXT,session_id TEXT,member_id TEXT,tool_name TEXT,state TEXT);
    CREATE TABLE qm_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT,event_type TEXT,created_at TEXT,data_json TEXT);
    CREATE INDEX qm_events_task_sequence ON qm_events(task_id,sequence);
    INSERT INTO qm_sessions VALUES('s','owner'),('x','foreign');
    INSERT INTO qm_tasks(id,session_id,state,title,created_at) VALUES('a','s','active','A','2026-10-31'),
      ('b','s','active','B','2026-10-31'),('foreign','x','active','Private','2026-10-31');
    INSERT INTO qm_session_members VALUES('ma','worker'),('mb','worker');
    INSERT INTO qm_task_members VALUES('a','ma'),('b','mb');
    INSERT INTO qm_invocations VALUES('ia','oa','owner','a','s','ma','exec_command','running'),
      ('ib','ob','owner','b','s','mb','exec_command','running');
    INSERT INTO qm_events(task_id,event_type,created_at,data_json) VALUES('a','command_finished','2026-10-31','{"secret":"never expose"}');`);
  db.exec(localUserApiSchema);db.exec(taskPeerSchema);
  const now=()=>Date.now(),activities:TaskPeerActivity[]=["a","b"].map(taskId=>({taskId,executionStatus:"unknown",lastProgressAt:now()-1000,executionObservedAt:null}));
  const activity=async(_ids:readonly string[])=>activities,grants=new LocalUserGrantStore(db,now),local=new LocalCredentialVerifier(db,"worker",now);
  const peer=new TaskPeerMailboxStore(db,{ownerSource:"legacy-session",now,activityResolver:activity});
  const dispatcher=new LocalUserDispatcher(grants,new LocalObservationStore(db,"center",activity),peer);
  const sessions=new LocalApiSessions(local,async(identity,method,params)=>dispatcher.dispatch("worker",identity,method,params),{pollMs:20,heartbeatMs:10});
  const configDir=await mkdtemp(join(tmpdir(),"qmcross-"));await chmod(configDir,0o755);
  const server=await startLocalUnixApi({configDir,nodeId:"worker",sessions});
  t.after(async()=>{await server.close();db.close();await rm(configDir,{recursive:true,force:true});});
  const principal=taskPrincipalFromAuthInfo({extra:{owner_id:"owner"}});
  async function user(){const issued=await grants.issueUser(principal,{nodeId:"worker",clientName:"QuayDock",expiresAt:now()+60_000});
    await local.install(grants.verifier(issued.grantId));return {...issued,endpoint:server.endpoint};}
  async function model(task:"a"|"b"){
    const current:InvocationContext={owner_id:"owner",task_id:task,session_id:"s",member_id:`m${task}`,workspace_id:"workspace",
      invocation_id:`i${task}`,operation_id:`o${task}`,tool_name:"exec_command",actor:"model",conversation_id:null,transport_instance_id:"transport",request_id:`r${task}`};
    const trusted={...current,request_id:String(current.request_id)} as TrustedInvocationEnvelope;
    await requestContextStorage.run(current,()=>grants.recordCurrentDispatch("worker",trusted));
    const issued=await grants.issueModel("worker",current.invocation_id);await local.install(grants.verifier(issued.grantId));
    return {...issued,endpoint:server.endpoint};
  }
  return {db,grants,principal,configDir,server,user,model};
}

async function invoke(args:string[],options:{env?:NodeJS.ProcessEnv;input?:string;vault?:LocalCredentialVault}={}){
  let stdout="",stderr="";
  const out=new Writable({write(chunk,_encoding,done){stdout+=chunk.toString();done();}}),err=new Writable({write(chunk,_encoding,done){stderr+=chunk.toString();done();}});
  const status=await runLocalUserApiCli(args,{env:options.env??{},stdin:Readable.from([options.input??""]),stdout:out,stderr:err,vault:options.vault});
  return {status,stdout,stderr,result:stdout?JSON.parse(stdout):null,error:stderr?JSON.parse(stderr).error:null};
}

test("CLI enrollment and QuayDock reads work through the actual private IPC and central dispatcher",{timeout:8000},async t=>{
  const f=await fixture(t),issued=await f.user(),records=new Map<string,string>();
  const vault:LocalCredentialVault={read:async key=>records.get(key)??null,write:async(key,value)=>{records.set(key,value);}};
  const imported=await invoke(["client","import","quaydock","--stdin","--config-dir",f.configDir],{input:JSON.stringify(issued),vault});
  assert.equal(imported.status,0,imported.stderr);assert.equal(imported.stdout.includes(issued.credential),false);
  const read=(...args:string[])=>invoke(["local",...args,"--client","quaydock","--config-dir",f.configDir],{vault});
  assert.equal((await read("status")).result.nodeId,"worker");
  const tasks=await read("tasks","list","--limit","1");assert.equal(tasks.status,0,tasks.stderr);assert.equal(tasks.result.items[0].taskId,"a");assert.equal(tasks.result.hasMore,true);
  assert.equal((await read("tasks","list","--cursor",tasks.result.nextCursor)).result.items[0].taskId,"b");
  assert.equal((await read("tasks","get","a")).result.taskId,"a");
  const events=await read("events","read","a");assert.equal(events.status,0,events.stderr);assert.equal(events.result.items.length,1);assert.equal(events.stdout.includes("secret"),false);
  const denied=await invoke(["local","peer","send","b","--message-key","blocked","--stdin","--client","quaydock","--config-dir",f.configDir],{vault,input:"not authorized"});
  // Default read-only enrollment has no Task source; the mailbox rejects that
  // boundary before considering any peer capability.
  assert.equal(denied.status,1);assert.equal(denied.error.code,"TASK_PEER_SOURCE_BINDING_REQUIRED");assert.equal(denied.stdout,"");
  assert.equal((f.db.prepare("SELECT count(*) AS n FROM qm_task_peer_messages").get() as {n:number}).n,0);
  assert.equal((await read("tasks","get","foreign")).error.code,"TASK_ACCESS_DENIED");
});

test("real Task grants drive CLI peer send/replay/receive/ack and watch stops after central revocation",{timeout:8000},async t=>{
  const f=await fixture(t),a=await f.model("a"),b=await f.model("b");
  const terminal=(issued:typeof a,args:string[],input="")=>invoke(["local",...args],{input,env:{QUAYMESH_LOCAL_API_ENDPOINT:issued.endpoint,QUAYMESH_LOCAL_API_CREDENTIAL:issued.credential}});
  const tasks=await terminal(a,["tasks","list"]);assert.deepEqual(tasks.result.items.map((item:{taskId:string})=>item.taskId),["a"]);
  assert.equal((await terminal(a,["events","read","b"])).error.code,"LOCAL_API_TASK_SCOPE_DENIED");
  const command=["peer","send","b","--message-key","stable_peer","--stdin"],sent=await terminal(a,command,"Please check");
  assert.equal(sent.status,0,sent.stderr);assert.equal(sent.result.message.sourceTaskId,"a");
  const replay=await terminal(a,command,"Please check");assert.equal(replay.status,0,replay.stderr);assert.equal(replay.result.replayed,true);
  assert.equal((f.db.prepare("SELECT count(*) AS n FROM qm_task_peer_messages").get() as {n:number}).n,1);
  const received=await terminal(b,["peer","receive","--request-key","stable_receive"]);assert.equal(received.status,0,received.stderr);assert.equal(received.result.messages[0].id,sent.result.message.id);
  const nextB=await f.model("b");assert.equal(nextB.clientId,b.clientId);
  const ack=await terminal(nextB,["peer","ack",received.result.deliveryId,"--message-id",sent.result.message.id]);assert.equal(ack.status,0,ack.stderr);
  const client=new LocalUserClient({endpoint:a.endpoint,credential:a.credential});let frames=0;
  await assert.rejects(async()=>{for await(const _batch of client.watch({task_id:"a"})){
    frames++;await f.grants.revoke(f.principal,a.grantId);
  }},error=>error instanceof LocalUserClientError&&error.code==="LOCAL_API_UNAUTHORIZED");
  assert.equal(frames,1);
});
