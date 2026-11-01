import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,mkdirSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import type {ServerConfig} from '../config.js';
import {databasePath} from '../db/client.js';
import {WorkLedger} from '../work-ledger.js';
import {SessionStore} from '../session/store.js';
import {readLocalTaskIndex,readLocalTaskStateIndex,readLocalSessionTitles,type TaskPhaseIndex} from './local-queries.js';
import {aggregateTaskIndex,aggregateTaskStateIndex} from './task-aggregation.js';
import {runQuery} from './run-query.js';

function fixture(t:test.TestContext) {
  const directory=mkdtempSync(join(tmpdir(),'qm-task-state-')),root=join(directory,'project');mkdirSync(root);
  const config={stateDir:join(directory,'state'),configDir:directory,allowedRoots:[root]} as ServerConfig;
  const ledger=new WorkLedger(config.stateDir),store=new SessionStore(ledger.db),at=Date.now();
  t.after(()=>{ledger.close();rmSync(directory,{recursive:true,force:true});});
  const session=store.createSession('owner','state-projection','Saved conversation');
  const member=store.addMember(session.id,'local','workspace',root,'checkout',null);
  const old=new Date(at-3_600_000).toISOString(),fresh=new Date(at).toISOString();
  const add=(name:string,status='completed',options:{closed?:boolean;stale?:boolean;kind?:string;taskId?:string;runStatus?:string}={})=>{
    const task=options.taskId?store.getTask(options.taskId):store.createTask(session.id,name);
    store.touchTaskMember(task.id,member.id);
    const run=ledger.begin({root,workItemId:task.id,runKey:name.replace(/[^A-Za-z0-9._:/-]/g,'_'),title:name,origin:{entryPoint:'console',evidence:'server_entry'}});
    store.linkRun(session.id,member.id,run.id,task.id);
    const operation=ledger.operation({runId:run.id,requestKey:name,kind:options.kind??'command',label:name,status});
    ledger.db.prepare('UPDATE console_operations SET created_at=?,finished_at=?,observed_at=? WHERE id=?')
      .run(old,['running','starting','queued'].includes(status)?null:old,options.stale?old:fresh,operation);
    ledger.db.prepare('UPDATE console_work_runs SET created_at=?,last_activity_at=?,status=?,finished_at=?,acceptance=? WHERE id=?')
      .run(old,old,options.runStatus??'running',options.runStatus==='completed'?old:null,'pending',run.id);
    ledger.db.prepare('UPDATE qm_tasks SET created_at=?,last_activity_at=?,state=?,result_status=?,finished_at=?,delivery_ended_at=? WHERE id=?')
      .run(old,old,options.closed?'closed':'active',options.closed?'completed':null,options.closed?old:null,options.closed?old:null,task.id);
    return {task,run,operation};
  };
  return {config,ledger,store,session,member,root,at,old,fresh,add};
}

const stateFields=({tokens:_tokens,changed:_changed,...state}:TaskPhaseIndex)=>state;

test('state projection preserves all phase classifications, task titles, lifecycle, members and acceptance',t=>{
  const f=fixture(t);
  const cases=[f.add('running','running'),f.add('closed-running','running',{closed:true}),f.add('closed-queued','queued',{closed:true}),
    f.add('unknown','unknown'),f.add('stale','running',{stale:true}),f.add('failed','failed'),
    f.add('stopped','stopped'),f.add('waiting'),f.add('review','completed',{closed:true,runStatus:'completed'})];
  f.add('new-phase','completed',{taskId:cases[0]!.task.id});
  // A newer read/control operation cannot erase the last substantive failure.
  f.ledger.db.prepare(`INSERT INTO console_operations(id,run_id,request_key,kind,label,status,created_at,finished_at)
    VALUES('poll-after-failure',?,'poll','agent_control','Poll','completed',?,?)`).run(cases[5]!.run.id,f.fresh,f.fresh);
  const finalizing=f.add('finalizing');
  f.ledger.db.prepare(`INSERT INTO qm_task_finalizations(task_id,status,summary,requested_at,error)
    VALUES(?,'completed','saved',?,'delivery not confirmed')`).run(finalizing.task.id,f.fresh);
  const noPhase=f.store.createTask(f.session.id,'QuayMesh task');f.store.touchTaskMember(noPhase.id,f.member.id);
  f.ledger.db.prepare(`INSERT INTO qm_task_messages(id,task_id,sequence,message_key,body,created_at)
    VALUES('title-message',?,1,'title','Keep the exact research request',?)`).run(noPhase.id,f.old);
  const remoteRoot=join(f.config.configDir,'remote-project');mkdirSync(remoteRoot);
  const remote=f.store.addMember(f.session.id,'remote','remote-workspace',remoteRoot,'checkout',null);
  f.store.touchTaskMember(cases[0]!.task.id,remote.id);

  const full=readLocalTaskIndex(f.config,f.at),titles=readLocalSessionTitles(f.config),state=readLocalTaskStateIndex(f.config,f.at);
  assert.equal(state.projection,'state');
  assert.deepEqual(state.phases,full.items.map(stateFields));
  assert.deepEqual(state.sessions,titles.items);assert.deepEqual(state.tasks,titles.tasks);assert.equal(state.authoritative,titles.authoritative);
  assert.deepEqual(aggregateTaskStateIndex(state.phases,f.at),aggregateTaskIndex(full.items,f.at).map(({tokens:_tokens,changed:_changed,...value})=>value));
  for(const phase of state.phases){assert.equal('tokens' in phase,false);assert.equal('changed' in phase,false);}
  const byRun=new Map(state.phases.map(phase=>[phase.localId,phase]));
  assert.equal(byRun.get(cases[1]!.run.id)?.executionStatus,'running');
  assert.equal(byRun.get(cases[2]!.run.id)?.executionStatus,'queued');
  assert.equal(byRun.get(cases[4]!.run.id)?.executionStatus,'unknown');
  assert.equal(byRun.get(cases[5]!.run.id)?.executionStatus,'failed');
  assert.equal(byRun.get(finalizing.run.id)?.finalization?.status,'failed');
});

test('one readonly snapshot keeps phase and task facts consistent across a real concurrent commit',t=>{
  const f=fixture(t),selected=f.add('Before commit','completed',{runStatus:'completed'});
  let committed=false,connections=new Set<Database.Database>();
  const original=Database.prototype.prepare;
  t.mock.method(Database.prototype,'prepare',function(this:Database.Database,sql:string){
    if(this.readonly)connections.add(this);
    if(this.readonly&&!committed&&sql.includes('SELECT id,title,revision,last_activity_at FROM qm_sessions')){
      assert.equal(this.inTransaction,true);committed=true;
      f.ledger.db.transaction(()=>{
        f.ledger.db.prepare("UPDATE qm_tasks SET title='After commit',revision=revision+1 WHERE id=?").run(selected.task.id);
        f.ledger.db.prepare("UPDATE console_work_runs SET status='failed' WHERE id=?").run(selected.run.id);
      })();
    }
    return original.call(this,sql);
  });
  const state=readLocalTaskStateIndex(f.config,f.at);
  assert.equal(committed,true);assert.equal(connections.size,1);
  assert.equal(state.phases[0]!.title,'Before commit');assert.equal(state.phases[0]!.executionStatus,'completed');
  assert.equal(state.tasks[0]!.title,'Before commit');
  const next=readLocalTaskStateIndex(f.config,f.at);
  assert.equal(next.phases[0]!.title,'After commit');assert.equal(next.phases[0]!.executionStatus,'failed');
  assert.equal(next.tasks[0]!.title,'After commit');
});

test('heartbeat, owner observations and repeated state polls never advance saved progress',t=>{
  const f=fixture(t),selected=f.add('Long running','running');
  const first=readLocalTaskStateIndex(f.config,f.at),progress=first.phases[0]!.lastProgressAt;
  f.ledger.heartbeat(selected.run.id);
  const later=f.at+20_000;
  f.ledger.observeOperations([selected.operation],new Date(later).toISOString());
  const second=readLocalTaskStateIndex(f.config,later);
  assert.equal(second.phases[0]!.lastProgressAt,progress);
  assert.equal(second.phases[0]!.executionObservedAt,later);
  assert.equal(second.phases[0]!.executionStatus,'running');
  assert.equal(readLocalTaskStateIndex(f.config,later+1000).phases[0]!.lastProgressAt,progress);
  assert.equal(readLocalTaskStateIndex(f.config,later+31_000).phases[0]!.executionStatus,'unknown');
});

test('large real historical JSON payloads are excluded from state SQL and malformed unused payloads cannot break the homepage',t=>{
  const f=fixture(t),padding='x'.repeat(32*1024),evidence=JSON.stringify([{label:'historical-output',value:padding}]);
  const delta=JSON.stringify({totalTokens:7,history:padding}),phases:Array<ReturnType<typeof f.add>>=[];
  f.ledger.db.prepare(`INSERT INTO local_agent_sessions(id,workspace_root,profile_name,provider,status,created_at,updated_at)
    VALUES('history-agent',?,'fixture','codex','idle',?,?)`).run(f.root,f.old,f.old);
  f.ledger.db.transaction(()=>{
    const operation=f.ledger.db.prepare(`INSERT INTO console_operations(id,run_id,request_key,kind,label,status,evidence,created_at,finished_at)
      VALUES(?,?,?,'command','Historical command','completed',?,?,?)`);
    const execution=f.ledger.db.prepare(`INSERT INTO console_executions(id,run_id,agent_id,provider,status,delta,created_at,finished_at)
      VALUES(?,?,'history-agent','codex','completed',?,?,?)`);
    for(let index=0;index<96;index++){
      const phase=f.add('history-'+index);phases.push(phase);
      for(let row=0;row<16;row++){
        const id=`history-${index}-${row}`;
        operation.run('op-'+id,phase.run.id,id,evidence,f.old,f.old);
        execution.run('ex-'+id,phase.run.id,delta,f.old,f.old);
      }
    }
  })();
  f.ledger.db.pragma('wal_checkpoint(TRUNCATE)');
  const before=readFileSync(databasePath(f.config.stateDir));
  const fullStarted=performance.now(),full=readLocalTaskIndex(f.config,f.at),fullMs=performance.now()-fullStarted;
  const statements:string[]=[],original=Database.prototype.prepare;
  t.mock.method(Database.prototype,'prepare',function(this:Database.Database,sql:string){
    if(this.readonly)statements.push(sql);return original.call(this,sql);
  });
  const stateStarted=performance.now(),state=readLocalTaskStateIndex(f.config,f.at),stateMs=performance.now()-stateStarted;
  assert.deepEqual(state.phases,full.items.map(stateFields));
  assert.ok(statements.length>0);
  assert.ok(statements.every(sql=>!/(?:json_extract|json_each|json_array_length)\s*\(/i.test(sql)),'the homepage executes no historical JSON parser');
  assert.ok(statements.every(sql=>!sql.includes('qm_run_checkpoints')),'phase checkpoint bodies stay out of the state read');
  assert.deepEqual(readFileSync(databasePath(f.config.stateDir)),before,'the state path does not migrate or rewrite its source');
  t.diagnostic(`${96*16*2} historical JSON payloads, ${(before.length/1024/1024).toFixed(1)} MiB SQLite; full ${fullMs.toFixed(1)} ms, state ${stateMs.toFixed(1)} ms`);

  f.ledger.db.prepare("UPDATE console_executions SET delta='malformed-unneeded-json'").run();
  f.ledger.db.prepare("UPDATE console_operations SET evidence='malformed-unneeded-json'").run();
  f.ledger.db.prepare(`INSERT INTO qm_run_checkpoints(run_id,session_id,member_id,revision,snapshot_json,files_json,captured_at)
    VALUES(?,?,?,1,'malformed-snapshot','malformed-files',?)`).run(phases[0]!.run.id,f.session.id,f.member.id,f.old);
  assert.throws(()=>readLocalTaskIndex(f.config,f.at),/malformed JSON/);
  assert.deepEqual(readLocalTaskStateIndex(f.config,f.at).phases,state.phases);
  const query=runQuery(f.ledger,'local',f.ledger.projects().map(project=>project.id),{days:'0'},f.at,{fields:'state',counts:false});
  const sample=f.ledger.db.prepare(`${query.sql} SELECT * FROM selected LIMIT 1`).get(...query.params) as Record<string,unknown>;
  for(const name of ['tokens','changed','archived_files','summary','evidence'])assert.equal(name in sample,false);
  assert.throws(()=>runQuery(f.ledger,'local',[],{changed:'1'},f.at,{fields:'state'}),{code:'invalid_read'});
});
