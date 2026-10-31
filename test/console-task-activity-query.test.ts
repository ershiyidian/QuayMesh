import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkLedger } from '../src/work-ledger.js';
import { SessionStore } from '../src/session/store.js';
import { readLocalTaskIndex, readLocalRunSummaries, readLocalSessionTitles } from '../src/console-workbench/local-queries.js';
import { aggregateTaskIndex, aggregateTasks } from '../src/console-workbench/task-aggregation.js';
import { withTaskLifecycle } from '../src/console-task-state.js';
import { taskActivityView } from '../src/task-view.js';
import { createRealTestServer } from './session-card/server-fixture.js';

test('real SQLite projections share Task titles and physical execution observations without renewing idle Tasks', {timeout:120_000}, async t=>{
  const server=await createRealTestServer({git:false,uiEnabled:false});
  const ledger=new WorkLedger(server.config.stateDir),store=new SessionStore(ledger.db);
  t.after(async()=>{ledger.close();await server.dispose();});
  const now=Date.now(),old=now-16*60*60_000,iso=(time:number)=>new Date(time).toISOString();
  const session=store.createSession('owner','task-activity-query','Federated session');
  const nodeId=server.config.federation?.nodeId??'local';
  const member=store.addMember(session.id,nodeId,'activity-workspace',server.project,'checkout',null);
  const task=store.createTask(session.id,'QuayMesh task','activity-task');
  const run=ledger.begin({root:server.project,workspaceId:'activity-workspace',workItemId:'activity',runKey:'activity',
    title:'Train the public example model',origin:{entryPoint:'console',evidence:'server_entry'}});
  store.linkRun(session.id,member.id,run.id,task.id);
  const operation=ledger.operation({runId:run.id,requestKey:'training',kind:'command',label:'public training fixture',status:'running'});
  ledger.db.prepare('UPDATE qm_tasks SET created_at=?,last_activity_at=? WHERE id=?').run(iso(old),iso(now),task.id);
  ledger.db.prepare('UPDATE console_work_runs SET created_at=?,last_activity_at=? WHERE id=?').run(iso(old),iso(now),run.id);
  ledger.db.prepare('UPDATE console_operations SET created_at=?,observed_at=? WHERE id=?').run(iso(old),iso(old),operation);
  const message=ledger.db.prepare(`INSERT INTO qm_task_messages(id,task_id,sequence,message_key,body,role,created_at)
    VALUES(?,?,?,?,?,'user',?)`);
  message.run('activity-wrapper',task.id,1,'wrapper','<environment_context>fixture metadata</environment_context>',iso(old));
  message.run('activity-goal',task.id,2,'goal','Train and validate the public example model',iso(old));
  const lifecycle=readLocalSessionTitles(server.config).tasks.find(row=>row.id===task.id)!;
  assert.equal(lifecycle.title,'Train and validate the public example model');
  assert.equal(lifecycle.titleSource,'user_message');
  assert.equal(lifecycle.lastProgressAt,old,'general last_activity_at does not renew actual Task progress');
  const index=()=>withTaskLifecycle(aggregateTaskIndex(readLocalTaskIndex(server.config,Date.now()).items)[0]!,lifecycle);
  const view=(value:ReturnType<typeof index>)=>taskActivityView({requestState:value.requestState,result:value.resultStatus,
    execution:value.executionStatus,lastProgressAt:value.lastProgressAt,executionObservedAt:value.executionObservedAt});
  const idle=index();
  assert.equal(idle.lastProgressAt,old);
  assert.equal(view(idle).state,'idle');
  assert.equal(view(idle).current,false,'a newly fetched historical running row is not current execution');
  const confirmedAt=new Date().toISOString();
  ledger.observeOperations([operation],confirmedAt);
  const running=index();
  assert.equal(running.executionObservedAt,Date.parse(confirmedAt));
  assert.equal(running.lastProgressAt,old,'a supervisor observation is not new progress');
  assert.equal(view(running).state,'executing');
  assert.equal(view(running).current,true,'verified long training remains current without output');
  const detail=withTaskLifecycle(aggregateTasks(readLocalRunSummaries(server.config,[run.id]).items)[0]!,lifecycle);
  assert.equal(detail.title,running.title);
  assert.equal(detail.titleSource,running.titleSource);
  assert.equal(detail.lastProgressAt,running.lastProgressAt);
  assert.equal(detail.executionObservedAt,running.executionObservedAt);
  assert.equal(taskActivityView({requestState:detail.requestState,result:detail.resultStatus,execution:detail.executionStatus,
    lastProgressAt:detail.lastProgressAt,executionObservedAt:detail.executionObservedAt}).state,'executing');
  const custom=store.createTask(session.id,'Keep my explicit Task title','custom-title');
  message.run('custom-message',custom.id,1,'custom-goal','Another saved message',iso(now));
  const customView=readLocalSessionTitles(server.config).tasks.find(row=>row.id===custom.id)!;
  assert.equal(customView.title,'Keep my explicit Task title');assert.equal(customView.titleSource,'task');
});
