import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WorkLedger} from '../work-ledger.js';
import {SessionStore} from './store.js';
import {SessionProjector} from './projection.js';
import type {SessionEvent} from './types.js';

for(const taskScoped of [true,false])test(`member projection preserves complete ${taskScoped?'Task':'legacy Session'} evidence without loading other members`,async t=>{
  const directory=mkdtempSync(join(tmpdir(),'qm-projection-scope-')),stateDir=join(directory,'state');
  const ledger=new WorkLedger(stateDir),store=new SessionStore(ledger.db);
  const projector=new SessionProjector(store,stateDir,null,undefined,'local');
  t.after(async()=>{await projector.close();ledger.close();rmSync(directory,{recursive:true,force:true});});
  const session=store.createSession('owner','projection-scope','Member evidence');
  const members=Array.from({length:3},(_,index)=>{
    const root=join(directory,`project-${index}`);mkdirSync(root);
    return store.addMember(session.id,'local',`workspace-${index}`,root,'checkout',null);
  });
  const selected=members[0]!;
  const task=taskScoped?store.createTask(session.id,'Member evidence','member-evidence'):null;
  if(task)for(const member of members)store.touchTaskMember(task.id,member.id);
  const at=Date.now()-60_000,iso=(offset:number)=>new Date(at+offset).toISOString();
  const append=(memberId:string,sourceId:string,type:SessionEvent['type'],payload:SessionEvent['payload'],offset:number)=>{
    store.appendEvent({session_id:session.id,task_id:task?.id??null,member_id:memberId,source_id:sourceId,type,payload,timestamp:iso(offset)});
  };
  ledger.db.transaction(()=>{
    append(selected.id,'selected-start','operation_started',{operation_id:'selected-operation',kind:'command',label:'echo complete',invocation_id:'selected-attempt'},1);
    for(let index=0;index<200;index++)append(members[1+index%2]!.id,`other-${index}`,'context_read',
      {actor:'model',path:`other/file-${index}.txt`,content:'other member evidence '.repeat(400)},10+index);
    append(selected.id,'selected-output','operation_output',{operation_id:'selected-operation',offset:8},220);
    append(selected.id,'selected-finish','operation_finished',{operation_id:'selected-operation',kind:'command',label:'echo complete',status:'succeeded',exit_code:0,output_available:true,invocation_id:'selected-attempt'},230);
    append(selected.id,'selected-context','context_read',{actor:'model',path:'README.md'},240);
    append(selected.id,'selected-review','verification_recorded',{outcome:'passed'},250);
    append(members[1]!.id,'other-latest','operation_started',{operation_id:'other-operation',kind:'command',label:'other task command'},260);
  })();
  const all=task?store.eventsForTask(task.id):store.eventsForSession(session.id);
  const own=all.filter(event=>event.member_id===selected.id);
  const scoped=task?store.eventsForTask(task.id,selected.id):store.eventsForSession(session.id,undefined,selected.id);
  assert.deepEqual(scoped,own);
  assert.deepEqual(store.eventsForSession(session.id,2,selected.id),own.slice(-2),'a member limit applies after member selection');
  assert.equal(all.length,206);assert.equal(own.length,5);

  const taskEvents=store.eventsForTask.bind(store),sessionEvents=store.eventsForSession.bind(store);
  const loadedEvents:number[]=[];
  const scopedTaskRead=t.mock.method(store,'eventsForTask',(taskId:string,memberId?:string)=>{
    const events=taskEvents(taskId,memberId);loadedEvents.push(events.length);return events;
  });
  const scopedSessionRead=t.mock.method(store,'eventsForSession',(sessionId:string,limit?:number,memberId?:string)=>{
    const events=sessionEvents(sessionId,limit,memberId);loadedEvents.push(events.length);return events;
  });
  const snapshot=await projector.readSnapshot(session.id,selected.id,task?.id);
  scopedTaskRead.mock.restore();scopedSessionRead.mock.restore();
  assert.deepEqual(loadedEvents,[own.length],'the actual projection reads only this member from SQLite');
  const taskRead=t.mock.method(store,'eventsForTask',(taskId:string)=>taskEvents(taskId));
  const sessionRead=t.mock.method(store,'eventsForSession',(sessionId:string,limit?:number)=>sessionEvents(sessionId,limit));
  const previous=await projector.readSnapshot(session.id,selected.id,task?.id);
  taskRead.mock.restore();sessionRead.mock.restore();
  const stable=(value:typeof snapshot)=>({...value,serverNow:0,observedAt:0,
    ...(value.executionObservation?{executionObservation:{...value.executionObservation,observedAt:0}}:{}),
    ...(value.live?{live:{...value.live,observedAt:0}}:{})});
  assert.deepEqual(stable(snapshot),stable(previous),'all projected fields match the former full-history read');
  assert.equal(snapshot.commands.length,1);
  assert.equal(snapshot.commands[0]!.cmd,'echo complete');
  assert.equal(snapshot.commands[0]!.output_available,true);
  assert.equal(snapshot.lastOutputAt,at+220);
  assert.equal(snapshot.lastActivityAt,at+250,'later events from another member do not advance this member');
  t.diagnostic(JSON.stringify({allEvents:all.length,memberEvents:scoped.length,
    allBytes:Buffer.byteLength(JSON.stringify(all)),memberBytes:Buffer.byteLength(JSON.stringify(scoped))}));
});
