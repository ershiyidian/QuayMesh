import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import Database from 'better-sqlite3';
import {WorkLedger} from '../../src/work-ledger.js';
import {ExecutionCoordinator} from '../../src/execution-coordinator.js';
import {SessionStore} from '../../src/session/store.js';
import {SessionProjector} from '../../src/session/projection.js';
import {SessionChangeCollector} from '../../src/session/changes.js';
import {CaptureReadClock} from '../../src/session/capture-read-observation.js';
import {projectionIdentity} from '../../src/session/projection-read-identity.js';
import {projectionScope,parseProjectionReadRequest,type ProjectionCaptureSource} from '../../src/session/projection-read-protocol.js';
import {readSessionProjection} from '../../src/session/projection-read-query.js';
import type {ConsoleReadDiagnostic} from '../../src/console-workbench/read-process.js';

function deferred() {
  let resolve!:()=>void;
  const promise=new Promise<void>(done=>{resolve=done;});
  return {promise,resolve};
}
async function fixture() {
  const directory=await mkdtemp(join(tmpdir(),'qm-projection-read-'));
  const stateDir=join(directory,'state'),root=join(directory,'workspace');await mkdir(root);
  await writeFile(join(root,'a.txt'),'owned evidence');
  const ledger=new WorkLedger(stateDir),store=new SessionStore(ledger.db);
  const session=store.createSession('owner',null,'Projection fixture');
  const member=store.addMember(session.id,'local','workspace',root,'checkout',null);
  const task=store.createTask(session.id,'Exact Task goal','request');store.touchTaskMember(task.id,member.id);
  store.appendEvent({session_id:session.id,task_id:task.id,member_id:member.id,type:'operation_started',source_id:'start',
    timestamp:'2026-11-01T00:00:00Z',payload:{operation_id:'op_fixture',kind:'command',label:'saved command'}});
  store.appendEvent({session_id:session.id,task_id:task.id,member_id:member.id,type:'operation_finished',source_id:'finish',
    timestamp:'2026-11-01T00:00:01Z',payload:{operation_id:'op_fixture',status:'succeeded',effect:'completed'}});
  const patchDir=join(stateDir,'session-evidence',session.id,member.id,task.id);await mkdir(patchDir,{recursive:true});
  const patchRef=join(patchDir,'changes.patch');await writeFile(patchRef,'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -0,0 +1 @@\n+owned evidence\n');
  store.taskData.putBaseline(task.id,{session_id:session.id,member_id:member.id,repo_root:root,baseline_ref:'base',latest_ref:'v1',coverage:'session_owned'});
  store.taskData.replaceFiles(task.id,session.id,member.id,'v1',[{id:'owned-file',member_id:member.id,status:'M',path:'a.txt',from:null,
    additions:1,removals:0,hash:'owned-hash',large:false,binary:false,coverage:'session_owned',revertible:true,patchRef}]);
  store.upsertContextRead({sessionId:session.id,memberId:member.id,taskId:task.id,actorId:'host',
    path:'TASK.md',kind:'instruction',state:'read',incrementRead:true});
  const changes=new SessionChangeCollector(store,stateDir);
  const request=()=>{
    const identity=projectionIdentity(store,session.id,member.id,task.id,'local'),fence=changes.captureReadFence();
    return parseProjectionReadRequest({operation:'session-projection',stateDir,consoleUrl:null,localNodeId:'local',identity,
      capture:changes.captureReadObservation(projectionScope(identity),fence)});
  };
  const saved=()=>ledger.db.prepare('SELECT snapshot_json FROM qm_task_projections WHERE task_id=? AND member_id=?')
    .get(task.id,member.id) as {snapshot_json:string}|undefined;
  return {directory,stateDir,root,ledger,store,session,member,task,changes,request,saved,
    async close(){await changes.close();ledger.close();await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:50});}};
}
function compiledWorker() {
  assert.ok(existsSync(new URL('../../dist/session/projection-read-worker.js',import.meta.url)),
    'Build tsconfig.build.json before exercising the actual projection child');
}

test('readonly projection keeps exact Task evidence and shares real revert occupancy checks without writes',async()=>{
  const f=await fixture(),watch=new Database(join(f.stateDir,'quaymesh.sqlite'),{readonly:true});
  const execution=new ExecutionCoordinator(f.stateDir);
  try {
    const before=watch.pragma('data_version',{simple:true});
    const result=await readSessionProjection(f.request());
    assert.equal(result.snapshot.taskId,f.task.id);assert.equal(result.snapshot.workspace?.id,f.member.id);
    assert.equal(result.snapshot.title,'Exact Task goal');assert.deepEqual(result.snapshot.files.map(row=>row.id),['owned-file']);
    assert.deepEqual(result.snapshot.instructions.map(row=>row.path),['TASK.md']);
    assert.equal(result.snapshot.commands[0]?.operation_id,'op_fixture');
    assert.equal(result.snapshot.capabilities.revert,true);
    assert.equal(watch.pragma('data_version',{simple:true}),before);assert.equal(f.saved(),undefined);
    const claim=execution.acquire({workspaceRoot:f.root,kind:'mutation',scopes:[{kind:'file',path:join(f.root,'a.txt'),access:'write'}]});
    try {
      const rows=f.ledger.db.prepare('SELECT * FROM execution_claims').all();
      const held=await readSessionProjection(f.request());
      assert.equal(held.snapshot.capabilities.revert,false);assert.ok(held.snapshot.notices.includes('Revert unavailable: active_writer'));
      assert.deepEqual(f.ledger.db.prepare('SELECT * FROM execution_claims').all(),rows,'observation must not reconcile or release occupancy');
    }finally{claim.release();}
    const request=f.request();
    for(const changed of [{ownerId:'other'},{nodeId:'remote'},{workspaceId:'another'},{root:join(f.root,'other')},{taskId:'missing-task'}])
      await assert.rejects(readSessionProjection({...request,identity:{...request.identity,...changed}}));
    assert.throws(()=>parseProjectionReadRequest({...request,sql:'SELECT 1'}));
    assert.throws(()=>parseProjectionReadRequest({...request,capture:{...request.capture,scope:{...request.capture!.scope,taskId:'other'}}}));
    assert.equal((await readSessionProjection({...request,capture:null})).snapshot.capabilities.revert,false,'missing capture proof must not mean idle');
    const remote=f.store.upsertRemoteMember({id:'remote-member',sessionId:f.session.id,nodeId:'worker',workspaceId:'remote-workspace',
      root:'e:\\remote-only\\path',sourceRoot:null,mode:'checkout',online:true,revision:0});
    const remoteRequest=parseProjectionReadRequest({operation:'session-projection',stateDir:f.stateDir,consoleUrl:null,localNodeId:'local',
      identity:projectionIdentity(f.store,f.session.id,remote.id,undefined),capture:null});
    const remoteResult=await readSessionProjection(remoteRequest);
    assert.equal(remoteResult.snapshot.workspace?.node_id,'worker');
    assert.equal(remoteResult.snapshot.capabilities.revert,false);
    assert.ok(remoteResult.snapshot.notices.includes('Revert unavailable: remote_member'));
  }finally{execution.close();watch.close();await f.close();}
});

test('compiled projection contains native SQLite stalls and preserves confirmed snapshots on cancellation and deadline', {timeout:20_000},async()=>{
  compiledWorker();
  const f=await fixture(),g=await fixture(),diagnostics:ConsoleReadDiagnostic[]=[];
  const first=new SessionProjector(f.store,f.stateDir,null,undefined,'local',{capture:f.changes,report:event=>diagnostics.push(event)});
  const second=new SessionProjector(g.store,g.stateDir,null,undefined,'local',{capture:g.changes,report:()=>{}});
  let ticks=0;const heartbeat=setInterval(()=>ticks++,10);
  try {
    await first.materialize(f.session.id,f.member.id,f.task.id);await second.materialize(g.session.id,g.member.id,g.task.id);
    const previous=f.saved()!.snapshot_json,oldPid=diagnostics.filter(event=>event.phase==='start').at(-1)?.childPid;
    assert.ok(oldPid);
    f.ledger.db.exec(`ALTER TABLE qm_events RENAME TO held_events;
      CREATE VIEW qm_events AS WITH RECURSIVE counter(n) AS
      (SELECT 1 UNION ALL SELECT n+1 FROM counter WHERE n<1000000000)
      SELECT 1 AS sequence,'${f.session.id}' AS session_id,'${f.task.id}' AS task_id,
        '${f.member.id}' AS member_id,'operation_output' AS event_type,
        CAST(sum(n) AS TEXT) AS source_id,'{}' AS data_json,'2026-11-01T00:00:00Z' AS created_at FROM counter;`);
    const cancel=new AbortController(),beforeTicks=ticks;
    const cancelled=assert.rejects(first.materialize(f.session.id,f.member.id,f.task.id,{signal:cancel.signal}),{code:'REQUEST_CANCELLED'});
    await delay(150);
    const peer=await second.materialize(g.session.id,g.member.id,g.task.id);
    assert.equal(peer.taskId,g.task.id,'a different runtime has independent projection capacity');
    cancel.abort();await cancelled;
    assert.ok(ticks-beforeTicks>=10,'synchronous native query must not freeze the parent heartbeat');
    assert.equal(f.saved()!.snapshot_json,previous);
    await assert.rejects(first.materialize(f.session.id,f.member.id,f.task.id,{timeoutMs:250}),{code:'REQUEST_TIMEOUT'});
    assert.equal(f.saved()!.snapshot_json,previous,'failed fresh observation must not replace saved evidence');
    f.ledger.db.exec('DROP VIEW qm_events; ALTER TABLE held_events RENAME TO qm_events');
    const recovered=await first.materialize(f.session.id,f.member.id,f.task.id);
    assert.deepEqual(recovered.files.map(row=>row.id),['owned-file']);
    assert.notEqual(diagnostics.filter(event=>event.phase==='start').at(-1)?.childPid,oldPid);
  }finally{clearInterval(heartbeat);await Promise.all([first.close(),second.close()]);await f.close();await g.close();}
});

test('publication rechecks revisions and capture generation under the write lock; shutdown never publishes a late child', {timeout:20_000},async()=>{
  compiledWorker();
  const f=await fixture();let clock=new CaptureReadClock();
  const source:ProjectionCaptureSource={captureReadFence:()=>clock.fence(),
    captureReadObservation:(scope,before)=>clock.observe(scope,before,{state:'idle',error:null})};
  let hold:ReturnType<typeof deferred>|undefined,entered:ReturnType<typeof deferred>|undefined;
  const projector=new SessionProjector(f.store,f.stateDir,null,async()=>{
    if(hold){entered!.resolve();await hold.promise;}
    return {allowed:true,reason:null,revision:f.store.getMember(f.session.id,f.member.id).revision};
  },'local',{capture:source,report:()=>{}});
  let lock:Database.Database|undefined;
  try {
    await projector.materialize(f.session.id,f.member.id,f.task.id);let previous=f.saved()!.snapshot_json;
    hold=deferred();entered=deferred();
    const changed=assert.rejects(projector.materialize(f.session.id,f.member.id,f.task.id),{code:'PROJECTION_CHANGED'});
    await entered.promise;f.store.appendEvent({session_id:f.session.id,task_id:f.task.id,member_id:f.member.id,
      type:'operation_output',source_id:'new-output',timestamp:new Date().toISOString(),payload:{operation_id:'op_fixture',bytes:1}});
    hold.resolve();await changed;assert.equal(f.saved()!.snapshot_json,previous);
    hold=undefined;await projector.materialize(f.session.id,f.member.id,f.task.id);previous=f.saved()!.snapshot_json;

    hold=deferred();entered=deferred();
    const newGeneration=assert.rejects(projector.materialize(f.session.id,f.member.id,f.task.id),{code:'PROJECTION_CHANGED'});
    await entered.promise;clock=new CaptureReadClock();hold.resolve();await newGeneration;
    assert.equal(f.saved()!.snapshot_json,previous,'capture generation cannot silently reset to idle');

    hold=deferred();entered=deferred();lock=new Database(join(f.stateDir,'quaymesh.sqlite'));lock.exec('BEGIN IMMEDIATE');
    let settled=false;
    const raced=assert.rejects(projector.materialize(f.session.id,f.member.id,f.task.id).finally(()=>{settled=true;}),{code:'PROJECTION_CHANGED'});
    await entered.promise;hold.resolve();await delay(50);assert.equal(settled,false);
    lock.prepare('UPDATE qm_tasks SET revision=revision+1,title=? WHERE id=?').run('New Task evidence',f.task.id);
    lock.exec('COMMIT');lock.close();lock=undefined;await raced;
    assert.equal(f.saved()!.snapshot_json,previous,'lock retry must recheck the exact prior evidence');

    hold=deferred();entered=deferred();
    const late=assert.rejects(projector.materialize(f.session.id,f.member.id,f.task.id),{code:'PROJECTION_CLOSED'});
    await entered.promise;await projector.close();hold.resolve();await late;
    assert.equal(f.saved()!.snapshot_json,previous);
  }finally{hold?.resolve();if(lock){if(lock.inTransaction)lock.exec('ROLLBACK');lock.close();}await projector.close();await f.close();}
});
