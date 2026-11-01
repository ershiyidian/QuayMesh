import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import Database from 'better-sqlite3';
import {WorkLedger} from '../../src/work-ledger.js';
import {SessionStore} from '../../src/session/store.js';
import {readWorkspaceStatus} from '../../src/session/status-read-query.js';
import {parseStatusReadRequest,type StatusReadRequest} from '../../src/session/status-read-protocol.js';
import {SessionStatusReader} from '../../src/session/status-reader.js';
import type {ConsoleReadDiagnostic} from '../../src/console-workbench/read-process.js';

async function fixture() {
  const directory=await mkdtemp(join(tmpdir(),'qm-status-read-'));
  const stateDir=join(directory,'state'),root=join(directory,'workspace');await mkdir(root);
  await mkdir(join(root,'other'));
  const ledger=new WorkLedger(stateDir),store=new SessionStore(ledger.db);
  const session=store.createSession('owner',null,'Status fixture');
  const member=store.addMember(session.id,'local','workspace',root,'checkout',null);
  const other=store.addMember(session.id,'local','other-workspace',join(root,'other'),'checkout',null);
  const task=store.createTask(session.id,'Fixture goal','request');store.touchTaskMember(task.id,member.id);store.touchTaskMember(task.id,other.id);
  let sequence=0;
  const event=(id:string,type:'operation_started'|'operation_finished'|'operation_output',payload:Record<string,unknown>={},memberId=member.id)=>{
    store.appendEvent({session_id:session.id,task_id:task.id,member_id:memberId,type,
      source_id:`event_${++sequence}`,timestamp:new Date(Date.UTC(2026,10,1,0,0,sequence)).toISOString(),
      payload:{operation_id:id,...payload}});
  };
  event('old','operation_started',{kind:'command',label:'Old training',invocation_id:'old_attempt'});
  for(let i=0;i<24;i++){
    event(`op_${i}`,'operation_started',{kind:'command',label:`command ${i}`,invocation_id:`attempt_${i}`});
    event(`op_${i}`,'operation_finished',{status:'succeeded',effect:'completed',invocation_id:`attempt_${i}`});
    event(`foreign_${i}`,'operation_started',{kind:'command'},other.id);
    event(`op_${i}`,'operation_output',{bytes:10});
  }
  // Finishing an old operation must not make it newest in the status page.
  event('old','operation_finished',{status:'succeeded',effect:'completed',invocation_id:'old_attempt'});
  event('retry','operation_started',{kind:'command',invocation_id:'attempt_old'});
  event('retry','operation_finished',{status:'failed',effect:'not_started',invocation_id:'attempt_old'});
  event('retry','operation_started',{kind:'command',invocation_id:'attempt_new',retry_of_invocation_id:'attempt_old'});
  event('retry','operation_finished',{status:'unknown',effect:'unknown',invocation_id:'attempt_new'});
  store.rememberAgentOperation({operationId:'op_23',agentId:'saved-agent',sessionId:session.id,memberId:member.id});
  const input:StatusReadRequest={operation:'workspace-status',stateDir,ownerId:'owner',sessionId:session.id,
    memberId:member.id,workspaceId:member.workspace_id,nodeId:'local',root,taskId:task.id,limit:20};
  return {directory,stateDir,root,ledger,store,input,event,
    async close(){ledger.close();await rm(directory,{recursive:true,force:true});}};
}

test('readonly status preserves retry and insertion order, limits final rows and enforces scope',async()=>{
  const f=await fixture(),watch=new Database(join(f.stateDir,'quaymesh.sqlite'),{readonly:true});
  try {
    const before=watch.pragma('data_version',{simple:true});
    const result=readWorkspaceStatus(f.input);
    assert.deepEqual(result.operations.map(row=>row.operation_id),['retry',...Array.from({length:19},(_,i)=>`op_${23-i}`)]);
    assert.equal(result.operations[0]!.state,'unknown');assert.deepEqual(result.unknown_effects,['retry']);
    assert.equal(result.operations[1]!.agent_id,'saved-agent');
    assert.ok(result.operations.every(row=>row.process_handle===undefined));
    assert.equal(watch.pragma('data_version',{simple:true}),before);
    for(const changed of [{ownerId:'someone-else'},{nodeId:'remote'},{workspaceId:'other-workspace'},{root:join(f.root,'different')}])
      assert.throws(()=>readWorkspaceStatus({...f.input,...changed}));
    const otherSession=f.store.createSession('owner',null,'Separate goal');
    const otherTask=f.store.createTask(otherSession.id,'Other task','other-request');
    assert.throws(()=>readWorkspaceStatus({...f.input,taskId:otherTask.id}));
    assert.throws(()=>parseStatusReadRequest({...f.input,limit:21}));
    assert.throws(()=>parseStatusReadRequest({...f.input,sql:'SELECT 1'}));
  }finally{watch.close();await f.close();}
});

test('compiled status reader contains a real slow SQLite query; cancelling it leaves another reader responsive', {timeout:15_000},async()=>{
  const worker=new URL('../../dist/session/status-read-worker.js',import.meta.url);
  assert.ok(existsSync(worker),'Build tsconfig.build.json before testing the real read worker');
  const f=await fixture(),g=await fixture(),events:ConsoleReadDiagnostic[]=[];
  const first=new SessionStatusReader(f.stateDir,'local',event=>events.push(event));
  const second=new SessionStatusReader(g.stateDir,'local',()=>{});
  let ticks=0;const heartbeat=setInterval(()=>ticks++,5);
  try {
    assert.equal((await first.read(f.input)).operations.length,20);
    const stablePid=events.find(event=>event.phase==='start')?.childPid;
    assert.ok(stablePid);
    // The warm child opens a new readonly connection for the next request. This
    // deliberately expensive native SQLite view cannot be interrupted by a JS timer.
    f.ledger.db.exec(`ALTER TABLE qm_events RENAME TO held_events;
      CREATE VIEW qm_events AS WITH RECURSIVE counter(n) AS
      (SELECT 1 UNION ALL SELECT n+1 FROM counter WHERE n<1000000000)
      SELECT 1 AS sequence,'${f.input.sessionId}' AS session_id,NULL AS task_id,
        '${f.input.memberId}' AS member_id,'operation_output' AS event_type,
        CAST(sum(n) AS TEXT) AS source_id,'{}' AS data_json,'2026-11-01T00:00:00Z' AS created_at FROM counter;`);
    const controller=new AbortController();
    const stopped=assert.rejects(first.read(f.input,controller.signal),{code:'REQUEST_CANCELLED'});
    await delay(100);
    assert.equal((await second.read(g.input)).operations.length,20,'MCP read capacity is not shared across runtimes');
    controller.abort();await stopped;
    assert.ok(ticks>=10,'native work must not occupy the parent event loop');
    f.ledger.db.exec('DROP VIEW qm_events; ALTER TABLE held_events RENAME TO qm_events');
    assert.equal((await first.read(f.input)).operations.length,20);
    assert.notEqual(events.filter(event=>event.phase==='start').at(-1)?.childPid,stablePid);
  }finally{clearInterval(heartbeat);first.close();second.close();await delay(100);await f.close();await g.close();}
});

test('the compiled worker also serves the shipped one-shot engine frame without a loader', {timeout:10_000},async()=>{
  const worker=new URL('../../dist/session/status-read-worker.js',import.meta.url);
  assert.ok(existsSync(worker),'Build tsconfig.build.json before testing the raw worker');
  const f=await fixture();
  const child=spawn(process.execPath,[fileURLToPath(worker)],{stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='';
  child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{stdout+=chunk;assert.ok(stdout.length<1024*1024);});
  child.stderr.setEncoding('utf8');child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-16*1024);});
  const timeout=setTimeout(()=>child.kill(),8000);
  try {
    child.stdin.end(JSON.stringify(f.input)+'\n');
    const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
    assert.equal(code,0,stderr);
    const reply=JSON.parse(stdout);assert.equal(reply.ok,true);assert.equal(reply.value.operations.length,20);
  }finally{clearTimeout(timeout);if(child.exitCode===null)child.kill();await f.close();}
});
