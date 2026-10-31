import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import Database from "better-sqlite3";
import { taskPeerSchema } from "../db/task-peer-schema.js";
import { taskMailboxSchema } from "../db/task-mailbox-schema.js";
import { taskPrincipalFromAuthInfo } from "../tasks/task-access.js";
import { TASK_EXECUTION_FRESHNESS_MS, TASK_SILENCE_MS } from "../task-view.js";
import { TaskMailboxStore } from "./task-mailbox.js";
import { MAX_TASK_PEER_SOURCE_PER_MINUTE, TaskPeerMailboxStore, type TaskPeerActivity,
  type TaskPeerCapability, type TaskPeerGrant } from "./task-peer-mailbox.js";

function fixture(t: TestContext) {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON"); db.pragma("busy_timeout = 5000");
  db.exec(`CREATE TABLE qm_sessions(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL);
    CREATE TABLE qm_tasks(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES qm_sessions(id),state TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,last_activity_at TEXT NOT NULL DEFAULT 'unchanged');
    CREATE TABLE qm_task_finalizations(task_id TEXT PRIMARY KEY,error TEXT,completed_at TEXT,recovery_state TEXT);
    INSERT INTO qm_sessions VALUES('session','owner'),('foreign-session','foreign-owner');
    INSERT INTO qm_tasks(id,session_id,state) VALUES('a','session','active'),('b','session','active'),
      ('c','session','active'),('d','session','active'),('e','session','active'),('foreign','foreign-session','active');`);
  db.exec(taskMailboxSchema); db.exec(taskPeerSchema);
  t.after(()=>db.close());
  let now = 1_800_000_000_000, resolutions = 0;
  const activities = new Map<string,TaskPeerActivity>(["a","b","c","d","e"].map(taskId=>[taskId,
    {taskId,executionStatus:"unknown",lastProgressAt:now-1000,executionObservedAt:null}]));
  let resolveActivity = async (ids: readonly string[]) => ids.flatMap(id=>activities.has(id) ? [{...activities.get(id)!}] : []);
  const store = new TaskPeerMailboxStore(db,{ownerSource:"legacy-session",now:()=>now,
    activityResolver:ids=>{resolutions++;return resolveActivity(ids);}});
  const principal = taskPrincipalFromAuthInfo({extra:{owner_id:"owner"}});
  function grant(sourceTaskId: string, clientId=`client-${sourceTaskId}`, allowed=["a","b","c","d","e","foreign"]) {
    const state = {revoked:false,capabilities:new Set<TaskPeerCapability>(["peer:send","peer:read","peer:ack"]),allowed:new Set(allowed)};
    const access: TaskPeerGrant = Object.freeze({principal,clientId,grantId:`grant-${clientId}`,sourceTaskId,peerTaskIds:Object.freeze([...allowed]),
      assertCurrent(capability: TaskPeerCapability, tasks: readonly string[]) {
        assert.equal(db.inTransaction,true,"authorization must be repeated inside the existing transaction");
        if(state.revoked || !state.capabilities.has(capability) || tasks.some(id=>!state.allowed.has(id)))
          throw Object.assign(new Error("LOCAL_GRANT_DENIED"),{code:"LOCAL_GRANT_DENIED"});
      }});
    return {access,state};
  }
  return {db,store,activities,principal,grant,now:()=>now,advance:(ms:number)=>{now+=ms;},
    resolutions:()=>resolutions,resolveWith:(resolver:typeof resolveActivity)=>{resolveActivity=resolver;}};
}

test("peer exchange and acknowledgements are separate from user dialogue and Task activity",async t=>{
  const f=fixture(t),a=f.grant("a").access,b=f.grant("b").access;
  const users = new TaskMailboxStore(f.db,{ownerSource:"legacy-session",now:f.now});
  const user = await users.enqueue({principal:f.principal,taskId:"b"},{messageKey:"human",body:"The user started this dialogue."});
  const beforeTasks=f.db.prepare("SELECT * FROM qm_tasks ORDER BY id").all();
  const beforeUser=f.db.prepare("SELECT * FROM qm_task_messages").all();
  const sent=await f.store.send(a,{targetTaskId:"b",messageKey:"first",body:"The shared build is ready."});
  assert.equal(sent.message.role,"task"); assert.equal(sent.message.sourceTaskId,"a");
  const page=await f.store.receive(b,{requestKey:"read-first"});
  assert.equal(page.messages[0].id,sent.message.id); assert.ok(page.deliveryId);
  assert.deepEqual(await f.store.ack(b,{deliveryId:page.deliveryId!,messageIds:[sent.message.id]}),{acknowledged:1,replayed:false});
  assert.deepEqual(await f.store.ack(b,{deliveryId:page.deliveryId!,messageIds:[sent.message.id]}),{acknowledged:1,replayed:true});
  const reply=await f.store.send(b,{targetTaskId:"a",messageKey:"reply",body:"I will validate it.",replyTo:sent.message.id});
  assert.equal(reply.message.replyTo,sent.message.id);
  assert.deepEqual(f.db.prepare("SELECT * FROM qm_tasks ORDER BY id").all(),beforeTasks);
  assert.deepEqual(f.db.prepare("SELECT * FROM qm_task_messages").all(),beforeUser);
  assert.equal(users.inspect({principal:f.principal,taskId:"b"}).pending,1,"peer ack cannot acknowledge the user");
  await assert.rejects(f.store.send(b,{targetTaskId:"a",messageKey:"fake-user-reply",body:"Not allowed",replyTo:user.message.id}),
    {code:"TASK_PEER_REPLY_SCOPE_MISMATCH"});
});

test("verified owner, fixed source Task, grant scope and each method capability are required",async t=>{
  const f=fixture(t),a=f.grant("a"),b=f.grant("b");
  await assert.rejects(f.store.send(JSON.parse(JSON.stringify(a.access)),{targetTaskId:"b",messageKey:"json",body:"x"}),
    {code:"TASK_PEER_VERIFIED_GRANT_REQUIRED"});
  await assert.rejects(f.store.send({...a.access,principal:{ownerId:"owner"} as typeof f.principal},
    {targetTaskId:"b",messageKey:"forged",body:"x"}),{code:"MISSING_AUTHENTICATED_OWNER"});
  await assert.rejects(f.store.send({...a.access,sourceTaskId:null},{targetTaskId:"b",messageKey:"unbound",body:"x"}),
    {code:"TASK_PEER_SOURCE_BINDING_REQUIRED"});
  await assert.rejects(f.store.send(a.access,{targetTaskId:"foreign",messageKey:"foreign",body:"x"}),{code:"TASK_ACCESS_DENIED"});
  a.state.allowed.delete("b");
  await assert.rejects(f.store.send(a.access,{targetTaskId:"b",messageKey:"scope",body:"x"}),{code:"LOCAL_GRANT_DENIED"});
  assert.equal(f.resolutions(),0,"unauthorized requests must not observe activity");
  b.state.capabilities.delete("peer:read");
  await assert.rejects(f.store.receive(b.access,{requestKey:"denied"}),{code:"LOCAL_GRANT_DENIED"});
  assert.equal(f.db.prepare("SELECT count(*) FROM qm_task_peer_messages").pluck().get(),0);
});

test("peer traffic cannot revive idle Tasks; current execution evidence expires at 30 seconds",async t=>{
  const f=fixture(t),a=f.grant("a").access,b=f.grant("b").access;
  const input={targetTaskId:"b",messageKey:"first",body:"Initial coordination"};
  const first=await f.store.send(a,input);
  f.advance(TASK_SILENCE_MS);
  await f.store.receive(b,{requestKey:"observe-only"});
  await assert.rejects(f.store.send(a,{...input,messageKey:"idle"}),{code:"TASK_PEER_TASK_INACTIVE"});
  assert.equal((await f.store.send(a,input)).message.id,first.message.id,"same-key receipt remains readable while idle");
  for (const id of ["a","b"]) Object.assign(f.activities.get(id)!,{executionStatus:"running",executionObservedAt:f.now(),stale:true});
  await f.store.send(a,{...input,messageKey:"actual-training"});
  f.advance(TASK_EXECUTION_FRESHNESS_MS);
  await assert.rejects(f.store.send(a,{...input,messageKey:"expired-proof"}),{code:"TASK_PEER_TASK_INACTIVE"});
  assert.ok(f.db.prepare("SELECT last_activity_at FROM qm_tasks").all().every(row=>(row as {last_activity_at:string}).last_activity_at==="unchanged"));
});

test("authorization, closure and evidence age are rechecked after asynchronous node observation",async t=>{
  const f=fixture(t),a=f.grant("a");
  let resume!: (rows:TaskPeerActivity[])=>void;
  f.resolveWith(()=>new Promise(resolve=>{resume=resolve;}));
  const sending=f.store.send(a.access,{targetTaskId:"b",messageKey:"revoke",body:"x"});
  a.state.revoked=true;
  resume([...f.activities.values()]);
  await assert.rejects(sending,{code:"LOCAL_GRANT_DENIED"});
  a.state.revoked=false;
  const closing=f.store.send(a.access,{targetTaskId:"b",messageKey:"close",body:"x"});
  f.db.prepare("UPDATE qm_tasks SET state='closed' WHERE id='b'").run();
  resume([...f.activities.values()]);
  await assert.rejects(closing,{code:"TASK_PEER_TASK_INACTIVE"});
  f.db.prepare("UPDATE qm_tasks SET state='active' WHERE id='b'").run();
  for (const id of ["a","b"]) Object.assign(f.activities.get(id)!,{
    executionStatus:"running",lastProgressAt:f.now()-TASK_SILENCE_MS,executionObservedAt:f.now()});
  const expired=f.store.send(a.access,{targetTaskId:"b",messageKey:"proof-expired-while-waiting",body:"x"});
  f.advance(TASK_EXECUTION_FRESHNESS_MS);
  resume([...f.activities.values()]);
  await assert.rejects(expired,{code:"TASK_PEER_TASK_INACTIVE"});
  assert.equal(f.db.prepare("SELECT count(*) FROM qm_task_peer_messages").pluck().get(),0);
});

test("identical send retries preserve one identity while changed content or peer direction fails",async t=>{
  const f=fixture(t),a=f.grant("a").access;
  const input={targetTaskId:"b",messageKey:"one",body:"x"};
  const [first,repeated]=await Promise.all([f.store.send(a,input),f.store.send(a,input)]);
  assert.equal(first.message.id,repeated.message.id);assert.equal(repeated.replayed,true);
  await assert.rejects(f.store.send(a,{...input,body:"changed"}),{code:"TASK_PEER_IDEMPOTENCY_CONFLICT"});
  await assert.rejects(f.store.send(a,{...input,messageKey:"wrong-direction",replyTo:first.message.id}),{code:"TASK_PEER_REPLY_SCOPE_MISMATCH"});
  f.db.prepare("UPDATE qm_tasks SET state='closed' WHERE id='b'").run();
  assert.equal((await f.store.send(a,input)).replayed,true);
  await assert.rejects(f.store.send(a,{...input,messageKey:"new-closed"}),{code:"TASK_PEER_TASK_INACTIVE"});
});

test("escaped and UTF-8 bodies are bounded and inbox pagination preserves whole messages",async t=>{
  const f=fixture(t),a=f.grant("a").access,b=f.grant("b").access;
  for (const body of ["x".repeat(16*1024+1),"\n".repeat(16*1024),"界".repeat(6000)])
    await assert.rejects(f.store.send(a,{targetTaskId:"b",messageKey:"oversize",body}),{code:"TASK_PEER_INVALID_BODY"});
  for (let i=0;i<3;i++) await f.store.send(a,{targetTaskId:"b",messageKey:`large-${i}`,body:"x".repeat(16*1024)});
  const first=await f.store.receive(b,{requestKey:"page-1",limit:8});
  assert.equal(first.messages.length,1); assert.equal(first.hasMore,true);assert.equal(first.nextSequence,1);
  assert.deepEqual(await f.store.receive(b,{requestKey:"page-1",limit:8}),{...first,replayed:true});
  const second=await f.store.receive(b,{requestKey:"page-2",afterSequence:first.nextSequence,limit:8});
  assert.equal(second.messages[0].sequence,2);
  await assert.rejects(f.store.receive(b,{requestKey:"page-1",afterSequence:1,limit:8}),{code:"TASK_PEER_IDEMPOTENCY_CONFLICT"});
  const before=f.db.prepare("SELECT count(*) FROM qm_task_peer_deliveries").pluck().get();
  await f.store.receive(b,{requestKey:"empty",afterSequence:3});
  assert.equal(f.db.prepare("SELECT count(*) FROM qm_task_peer_deliveries").pluck().get(),before,"empty polling stores no new delivery");
});

test("rate limits cover the source Task across clients and exact-key retries do not consume quota",async t=>{
  const f=fixture(t),a=f.grant("a").access;
  for(let i=0;i<MAX_TASK_PEER_SOURCE_PER_MINUTE;i++) await f.store.send(a,{targetTaskId:"b",messageKey:`rate-${i}`,body:"x"});
  await assert.rejects(f.store.send(f.grant("a","other-client").access,{targetTaskId:"b",messageKey:"extra",body:"x"}),{code:"TASK_PEER_RATE_LIMIT"});
  assert.equal((await f.store.send(a,{targetTaskId:"b",messageKey:"rate-0",body:"x"})).replayed,true);
  f.advance(60_000);
  await f.store.send(a,{targetTaskId:"b",messageKey:"later",body:"x"});
  for(let i=0;i<12;i++) await f.store.send(f.grant("d").access,{targetTaskId:"b",messageKey:`d-${i}`,body:"x"});
  for(let i=0;i<11;i++) await f.store.send(f.grant("e").access,{targetTaskId:"b",messageKey:`e-${i}`,body:"x"});
  await assert.rejects(f.store.send(f.grant("e").access,{targetTaskId:"b",messageKey:"target-full",body:"x"}),{code:"TASK_PEER_RATE_LIMIT"});
});

test("restricted A/B inbox filters C before pagination without exposing or acknowledging C",async t=>{
  const f=fixture(t),a=f.grant("a","restricted",["a","b"]).access,b=f.grant("b").access,c=f.grant("c").access;
  const firstC=await f.store.send(c,{targetTaskId:"a",messageKey:"c-first",body:"Out of scope first"});
  const firstB=await f.store.send(b,{targetTaskId:"a",messageKey:"b-first",body:"Permitted first"});
  const secondC=await f.store.send(c,{targetTaskId:"a",messageKey:"c-second",body:"Out of scope second"});
  const secondB=await f.store.send(b,{targetTaskId:"a",messageKey:"b-second",body:"Permitted second"});
  const page=await f.store.receive(a,{requestKey:"page-1",limit:1});
  assert.deepEqual(page.messages.map(row=>row.id),[firstB.message.id]);
  assert.equal(page.nextSequence,firstB.message.sequence);assert.equal(page.hasMore,true);
  assert.deepEqual(await f.store.receive(a,{requestKey:"page-1",limit:1}),{...page,replayed:true});
  const next=await f.store.receive(a,{requestKey:"page-2",limit:1,afterSequence:page.nextSequence});
  assert.deepEqual(next.messages.map(row=>row.id),[secondB.message.id]);
  assert.equal(next.nextSequence,secondB.message.sequence);assert.equal(next.hasMore,false);
  await assert.rejects(f.store.ack(a,{deliveryId:page.deliveryId!,messageIds:[firstC.message.id]}),{code:"TASK_PEER_MESSAGE_NOT_DELIVERED"});
  await f.store.ack(a,{deliveryId:page.deliveryId!,messageIds:[firstB.message.id]});
  for(const id of [firstC.message.id,secondC.message.id])
    assert.equal(f.db.prepare("SELECT acknowledged_at FROM qm_task_peer_messages WHERE id=?").pluck().get(id),null);
  const deliveries=f.db.prepare("SELECT message_ids_json FROM qm_task_peer_deliveries WHERE receiver_client_id='restricted'")
    .all() as {message_ids_json:string}[];
  assert.deepEqual(deliveries.flatMap(row=>JSON.parse(row.message_ids_json)),[firstB.message.id,secondB.message.id]);
});

test("narrowed peer scope rejects old out-of-scope delivery replays and ack while fresh reads continue",async t=>{
  const f=fixture(t),wide=f.grant("a","same-client").access,b=f.grant("b").access,c=f.grant("c").access;
  const denied=await f.store.send(c,{targetTaskId:"a",messageKey:"c-first",body:"Previously permitted"});
  const old=await f.store.receive(wide,{requestKey:"old-page"});
  const narrow=f.grant("a","same-client",["a","b"]).access;
  const allowed=await f.store.send(b,{targetTaskId:"a",messageKey:"b-next",body:"Still permitted"});
  await assert.rejects(f.store.receive(narrow,{requestKey:"old-page"}),{code:"LOCAL_GRANT_DENIED"});
  await assert.rejects(f.store.ack(narrow,{deliveryId:old.deliveryId!,messageIds:[denied.message.id]}),{code:"LOCAL_GRANT_DENIED"});
  const fresh=await f.store.receive(narrow,{requestKey:"fresh-page"});
  assert.deepEqual(fresh.messages.map(row=>row.id),[allowed.message.id]);
  assert.equal(f.db.prepare("SELECT acknowledged_at FROM qm_task_peer_messages WHERE id=?").pluck().get(denied.message.id),null);
});

test("acknowledgement is limited to the same client's exact delivery and renewed permissions",async t=>{
  const f=fixture(t),a=f.grant("a").access,b=f.grant("b");
  const first=await f.store.send(a,{targetTaskId:"b",messageKey:"one",body:"x"});
  const page=await f.store.receive(b.access,{requestKey:"first"});
  const second=await f.store.send(a,{targetTaskId:"b",messageKey:"two",body:"x"});
  await assert.rejects(f.store.ack(b.access,{deliveryId:page.deliveryId!,messageIds:[second.message.id]}),{code:"TASK_PEER_MESSAGE_NOT_DELIVERED"});
  await assert.rejects(f.store.ack(a,{deliveryId:page.deliveryId!,messageIds:[first.message.id]}),{code:"TASK_PEER_DELIVERY_MISMATCH"});
  await assert.rejects(f.store.ack(f.grant("b","different-client").access,{deliveryId:page.deliveryId!,messageIds:[first.message.id]}),{code:"TASK_PEER_DELIVERY_MISMATCH"});
  b.state.allowed.delete("a");
  await assert.rejects(f.store.ack(b.access,{deliveryId:page.deliveryId!,messageIds:[first.message.id]}),{code:"LOCAL_GRANT_DENIED"});
  assert.equal(f.db.prepare("SELECT count(*) FROM qm_task_peer_messages WHERE acknowledged_at IS NOT NULL").pluck().get(),0);
});

test("a pending finalization and a promise-returning authorization check cannot admit peer work",async t=>{
  const f=fixture(t),a=f.grant("a").access;
  f.db.prepare("INSERT INTO qm_task_finalizations(task_id,error,completed_at,recovery_state) VALUES('b',NULL,NULL,NULL)").run();
  await assert.rejects(f.store.send(a,{targetTaskId:"b",messageKey:"finishing",body:"x"}),{code:"TASK_PEER_TASK_FINISHING"});
  const invalid={...a,assertCurrent:async()=>{}};
  await assert.rejects(f.store.send(invalid,{targetTaskId:"b",messageKey:"async-auth",body:"x"}),{code:"TASK_PEER_AUTHORIZATION_MUST_BE_SYNCHRONOUS"});
  assert.equal(f.db.prepare("SELECT count(*) FROM qm_task_peer_messages").pluck().get(),0);
});
