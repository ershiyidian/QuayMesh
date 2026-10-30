import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase} from '../db/client.js';
import {SessionStore} from './store.js';

test('周期收尾只索引未决回执和对应事件，保留重试归属及原回执',async t=>{
  const root=await mkdtemp(join(tmpdir(),'qm-reconcile-index-'));
  const database=openDatabase(join(root,'state')), db=database.sqlite, store=new SessionStore(db);
  t.after(async()=>{database.close();await rm(root,{recursive:true,force:true});});
  const owner='reconcile-owner', session=store.createSession(owner,'reconcile-entry','Reconcile query');
  const member=store.addMember(session.id,'local','ws_reconcile',root,'checkout',null);
  const task=store.createTask(session.id,'Reconcile query');
  const at=new Date().toISOString();
  db.prepare('INSERT INTO console_projects(id,root,name,created_at) VALUES (?,?,?,?)').run('project',root,'Reconcile',at);
  db.prepare('INSERT INTO console_work_items(id,project_id,item_key,title,created_at) VALUES (?,?,?,?,?)')
    .run('item','project','item','Reconcile',at);
  db.prepare(`INSERT INTO console_work_runs(id,project_id,item_id,run_key,request_hash,origin,created_at)
    VALUES ('run','project','item','run','request','test',?)`).run(at);
  const receipt=(id:string,operationId:string)=>store.reserveInvocation({id,ownerId:owner,
    transportInstanceId:'entry',requestId:id,sessionId:session.id,memberId:member.id,taskId:task.id,
    toolName:'exec_command',argumentsJson:'{}',operationId});
  const operation=(id:string,status:string,requestKey=id)=>db.prepare(`INSERT INTO console_operations
    (id,run_id,request_key,kind,label,status,created_at,finished_at) VALUES (?,'run',?,'command',?,?,?,?)`)
    .run(id,requestKey,id,status,at,status==='running'?null:at);
  const event=(operationId:string,status:string,invocationId?:string)=>store.appendEvent({
    session_id:session.id,task_id:task.id,member_id:member.id,type:'operation_finished',
    source_id:`${operationId}-${invocationId??'legacy'}-finish`,timestamp:at,
    payload:{operation_id:operationId,status,...invocationId?{invocation_id:invocationId}:{}},
  });
  receipt('event-result','op_event');operation('op_event','completed');event('op_event','failed');
  receipt('fallback','op_fallback');operation('op_fallback','cancelled');
  receipt('running','op_running');operation('op_running','running');
  receipt('unknown','op_unknown');operation('op_unknown','reconciliation_required');
  receipt('old-attempt','op_retry');receipt('new-attempt','op_retry');
  db.prepare('UPDATE qm_invocations SET retry_of_invocation_id=? WHERE id=?').run('old-attempt','new-attempt');
  operation('op_retry','completed','new-attempt');event('op_retry','failed','old-attempt');event('op_retry','succeeded','new-attempt');
  const firstReply=JSON.stringify({kind:'error',errorCode:'REQUEST_TIMEOUT'});
  db.prepare('UPDATE qm_invocations SET response_at=?,response_json=? WHERE id=?').run(at,firstReply,'event-result');
  let plan:unknown;
  const prepare=db.prepare.bind(db);
  t.mock.method(db,'prepare',((sql:string)=>{
    if(sql.startsWith('UPDATE qm_invocations AS i SET'))plan=prepare(`EXPLAIN QUERY PLAN ${sql}`).all();
    return prepare(sql);
  }) as typeof db.prepare);
  assert.equal(store.reconcileFinishedInvocations(),4);
  assert.match(JSON.stringify(plan),/SEARCH i USING INDEX qm_invocations_pending_state/);
  assert.match(JSON.stringify(plan),/SEARCH e USING INDEX qm_events_operation_type/);
  const states=db.prepare('SELECT id,state,effect FROM qm_invocations ORDER BY id').all();
  assert.deepEqual(states,[
    {id:'event-result',state:'failed',effect:'completed'},
    {id:'fallback',state:'cancelled',effect:'completed'},
    {id:'new-attempt',state:'succeeded',effect:'completed'},
    {id:'old-attempt',state:'accepted',effect:'not_started'},
    {id:'running',state:'accepted',effect:'not_started'},
    {id:'unknown',state:'unknown',effect:'unknown'},
  ]);
  assert.deepEqual(db.prepare('SELECT response_at,response_json FROM qm_invocations WHERE id=?').get('event-result'),
    {response_at:at,response_json:firstReply});
  assert.equal(store.reconcileFinishedInvocations(),0);
});

test('真实v16数据库升级到v17只增加索引并保留既有任务和首次回执',async t=>{
  const root=await mkdtemp(join(tmpdir(),'qm-diagnostic-migration-'));
  const stateDir=join(root,'state');
  let database=openDatabase(stateDir);
  t.after(async()=>{database.close();await rm(root,{recursive:true,force:true});});
  const store=new SessionStore(database.sqlite), owner='migration-owner';
  const session=store.createSession(owner,'migration-entry','Existing session');
  const member=store.addMember(session.id,'local','ws_migration',root,'checkout',null);
  const task=store.createTask(session.id,'Existing task');
  store.reserveInvocation({id:'existing-receipt',ownerId:owner,transportInstanceId:'entry',requestId:'request',
    sessionId:session.id,memberId:member.id,taskId:task.id,toolName:'exec_command',operationId:'op_existing',argumentsJson:'{}'});
  store.updateInvocation({ownerId:owner,transportInstanceId:'entry',requestId:'request',responded:true,
    result:{kind:'result',value:{message:'saved-first-receipt'}}});
  store.appendEvent({session_id:session.id,task_id:task.id,member_id:member.id,type:'operation_started',
    source_id:'op_existing',timestamp:new Date().toISOString(),
    payload:{operation_id:'op_existing',invocation_id:'existing-receipt',status:'running'}});
  const addedIndexes=['qm_events_task_diagnostic_time','qm_invocations_task_diagnostic_time','qm_invocations_pending_state'];
  // v17 仅增加这三个索引，移除它们及版本记录即可得到含真实旧数据的 v16 数据库。
  database.sqlite.transaction(()=>{
    for(const name of addedIndexes)database.sqlite.exec(`DROP INDEX ${name}`);
    database.sqlite.prepare('DELETE FROM qm_schema_migrations WHERE version=17').run();
  })();
  const schema=()=>database.sqlite.prepare(`SELECT type,name,sql FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`).all() as Array<{type:string;name:string;sql:string}>;
  const saved=()=>({
    session:database.sqlite.prepare('SELECT * FROM qm_sessions WHERE id=?').get(session.id),
    task:database.sqlite.prepare('SELECT * FROM qm_tasks WHERE id=?').get(task.id),
    member:database.sqlite.prepare('SELECT * FROM qm_session_members WHERE id=?').get(member.id),
    receipt:database.sqlite.prepare('SELECT * FROM qm_invocations WHERE id=?').get('existing-receipt'),
    events:database.sqlite.prepare('SELECT * FROM qm_events WHERE task_id=? ORDER BY sequence').all(task.id),
    migrations:database.sqlite.prepare('SELECT * FROM qm_schema_migrations WHERE version<=16 ORDER BY version').all(),
  });
  const beforeSchema=schema(), beforeData=saved();
  assert.deepEqual(database.sqlite.prepare('SELECT max(version) AS version FROM qm_schema_migrations').get(),{version:16});
  database.close();
  database=openDatabase(stateDir);
  assert.deepEqual(database.sqlite.prepare('SELECT max(version) AS version FROM qm_schema_migrations').get(),{version:17});
  assert.deepEqual(saved(),beforeData);
  const afterSchema=schema();
  assert.deepEqual(afterSchema.filter(row=>!addedIndexes.includes(row.name)),beforeSchema);
  assert.deepEqual(afterSchema.filter(row=>addedIndexes.includes(row.name)).map(row=>row.name).sort(),[...addedIndexes].sort());
});
