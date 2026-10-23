import assert from 'node:assert/strict';
import test, {type TestContext} from 'node:test';
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadConfig} from '../config.js';
import {writeTestQuayMeshConfig} from '../test-support/config.test.js';
import {WorkLedger} from '../work-ledger.js';
import {LocalAgentStore} from '../local-agent-store.js';
import {SqliteWorkspaceStore} from '../workspace-store.js';
import {WorkspaceRegistry} from '../workspaces.js';
import {SessionService} from './service.js';
import {SessionStore} from './store.js';
import {SessionProjector} from './projection.js';
import {ExecutionState, HostState, ReviewState} from './types.js';
import {runQuery} from '../console-workbench/run-query.js';
import {WorkbenchFeed} from '../console-workbench/feed.js';
import {readLocalIndex} from '../console-workbench/local.js';
import {readLocalSessionTitles, readLocalTaskIndex} from '../console-workbench/local-queries.js';
import {aggregateTaskIndex, aggregateTasks, fallbackTask, filterTaskIndex, taskOnlyIndex} from '../console-workbench/task-aggregation.js';
import {needsAttention, taskStage, withTaskLifecycle} from '../console-task-state.js';
import {taskView} from '../task-view.js';
import {cardPresentation} from '../ui/session-card/timing.js';

async function fixture(t: TestContext) {
  const directory=await mkdtemp(join(tmpdir(),'qm-console-lifecycle-'));
  const root=join(directory,'project'),stateDir=join(directory,'state');
  await mkdir(root);
  const config=loadConfig(writeTestQuayMeshConfig(join(directory,'config'),{
    storage:{stateDir},workspaces:{allowedRoots:[root],worktreeRoot:join(directory,'worktrees')},
  }));
  if(config.federation)config.federation.nodeId='local';
  const ledger=new WorkLedger(stateDir),store=new SessionStore(ledger.db);
  const agents=new LocalAgentStore(stateDir);
  const agent=agents.create({workspaceId:'workspace',workspaceRoot:root,profileName:'console-regression',provider:'codex'});
  const workspaceStore=new SqliteWorkspaceStore(stateDir);
  const service=new SessionService(store,new WorkspaceRegistry(config,workspaceStore),ledger);
  const session=store.createSession('owner','console-lifecycle','状态回归');
  const member=store.addMember(session.id,'local','workspace',root,'checkout',null);
  const task=store.createTask(session.id,'真实 SQLite 任务');
  store.touchTaskMember(task.id,member.id);
  const createRun=(key:string)=>{
    const run=ledger.begin({root,workspaceId:'workspace',workItemId:task.id,runKey:key,title:task.title,
      origin:{entryPoint:'chatgpt_mcp',evidence:'server_entry'}});
    store.linkRun(session.id,member.id,run.id,task.id);
    return run;
  };
  const rows=(query:Record<string,string>={})=>{
    const selected=runQuery(ledger,'local',ledger.projects().map(project=>project.id),{days:'0',...query},Date.now());
    return ledger.db.prepare(`${selected.sql} SELECT * FROM selected`).all(...selected.params) as Array<Record<string,any>>;
  };
  t.after(async()=>{await service.close();agents.close();workspaceStore.close();ledger.close();await rm(directory,{recursive:true,force:true});});
  return {root,stateDir,config,ledger,store,service,session,member,task,agent,createRun,rows};
}

test('明确 legacy 事件不会归入后续 Task，省略 Task 与显式历史 Task 保持各自语义',async t=>{
  const f=await fixture(t);
  const later=f.store.createTask(f.session.id,'后续请求');
  f.store.touchTaskMember(later.id,f.member.id);
  const a=f.store.getTask(f.task.id).revision,b=f.store.getTask(later.id).revision;
  const event={session_id:f.session.id,member_id:f.member.id,type:'file_changed' as const,
    source_id:'legacy-change',timestamp:new Date().toISOString(),payload:{}};
  f.store.appendEvent({...event,task_id:null});
  assert.equal(f.store.eventsForSession(f.session.id).find(row=>row.source_id==='legacy-change')?.task_id,null);
  assert.equal(f.store.getTask(f.task.id).revision,a);
  assert.equal(f.store.getTask(later.id).revision,b,'legacy evidence cannot advance the current Task');
  await f.store.appendEventAsync({...event,source_id:'current-change'});
  assert.equal(f.store.eventsForTask(later.id).filter(row=>row.source_id==='current-change').length,1);
  assert.equal(f.store.getTask(later.id).revision,b+1);
  await f.store.appendEventAsync({...event,task_id:f.task.id,source_id:'historical-change'});
  assert.equal(f.store.eventsForTask(f.task.id).filter(row=>row.source_id==='historical-change').length,1);
  assert.equal(f.store.getTask(f.task.id).revision,a+1);
  assert.equal(f.store.getTask(later.id).revision,b+1,'explicit historical evidence cannot advance the current Task');
});

test('执行端结束后协调端确认失败，SQL、摘要与生命周期均保留交付待确认',async t=>{
  const f=await fixture(t),run=f.createRun('finished-owner');
  f.ledger.finish(run.id,{status:'completed',acceptance:'not_applicable',summary:'worker finished',evidence:[]});
  f.store.taskData.requestFinalization(f.task.id,'completed','finish');
  f.store.taskData.finishFinalization(f.task.id,'snapshot failed');
  assert.equal(f.rows()[0].execution,'finalizing');
  assert.equal(f.rows({attention:'1'})[0].id,run.id);
  const summary=readLocalIndex(f.config,[run.id]).runs[0]!;
  assert.equal(summary.executionStatus,'finalizing');
  assert.match(summary.reason!,/snapshot failed/);
  assert.equal(summary.finishedAt,null);
  const lifecycle=readLocalSessionTitles(f.config).tasks[0]!;
  const merged=withTaskLifecycle({...summary,executionStatus:'completed'},lifecycle);
  assert.equal(merged.executionStatus,'finalizing');
  assert.equal(lifecycle.finalization?.status,'failed');
});

for(const status of ['failed','cancelled'] as const) test(`最后一个代理 ${status} 后，无后续执行时留在待处理`,async t=>{
  const f=await fixture(t),run=f.createRun('agent');
  const execution=f.ledger.beginExecution({runId:run.id,agentId:f.agent.id,provider:'codex'});
  f.ledger.endExecution(execution,status);
  const read=f.ledger.operation({runId:run.id,requestKey:'inspect',kind:'read',label:'inspect',status:'running'});
  f.ledger.endOperation(read,'completed');
  const row=f.rows()[0];
  assert.equal(row.execution,status==='failed'?'failed':'interrupted_recoverable');
  assert.equal(f.rows({attention:'1'}).length,1);
  const item=readLocalIndex(f.config,[run.id]).runs[0]!;
  assert.equal(item.requestState,'active');
  assert.equal(item.resultStatus,null);
  assert.equal(item.actionableInterruption,true);
  await f.service.reconcile(f.session.id);
  assert.equal(f.store.getSession(f.session.id).execution_state,ExecutionState.idle);
  const projector=new SessionProjector(f.store,f.stateDir,null,undefined,'local');
  try {
    const expected=status==='failed'?ExecutionState.failed:ExecutionState.interrupted;
    const member=await projector.materialize(f.session.id,f.member.id,f.task.id);
    assert.equal(member.execution_status,expected,'Task/member 结果不借用 Session 的 idle');
    f.store.taskData.putProjection(f.task.id,f.member.id,member.rev,{...member,execution_status:ExecutionState.idle});
    const aggregate=(await projector.readTask(f.task.id,-1)).snapshot!;
    assert.equal(aggregate.execution_status,expected,'同 revision 的旧投影也不能覆盖所属 Task/member 的执行结果');
    assert.equal(cardPresentation(aggregate,Date.now()).label,status==='failed'?'未完成':'执行已中断');
  } finally {await projector.close();}
});

test('同一毫秒成功接续同一代理后，旧失败不把整个任务永久标为失败',async t=>{
  const f=await fixture(t),run=f.createRun('retry');
  const projector=new SessionProjector(f.store,f.stateDir,null,undefined,'local');
  t.after(()=>projector.close());
  const first=f.ledger.beginExecution({runId:run.id,agentId:f.agent.id,provider:'codex'});
  f.ledger.endExecution(first,'failed');
  const failed=await projector.materialize(f.session.id,f.member.id,f.task.id);
  assert.equal(cardPresentation(failed,Date.now()).status,'failed');
  const second=f.ledger.beginExecution({runId:run.id,agentId:f.agent.id,provider:'codex'});
  f.ledger.endExecution(second,'completed');
  const sameTime=new Date().toISOString();
  f.ledger.db.prepare('UPDATE console_executions SET created_at=?,finished_at=? WHERE run_id=?').run(sameTime,sameTime,run.id);
  f.ledger.db.prepare('UPDATE console_executions SET id=? WHERE id=?').run('exec_z_older',first);
  f.ledger.db.prepare('UPDATE console_executions SET id=? WHERE id=?').run('exec_a_newer',second);
  assert.equal(f.rows()[0].execution,'waiting');
  assert.equal(f.rows({attention:'1'}).length,0);
  const continued=await projector.materialize(f.session.id,f.member.id,f.task.id);
  assert.equal(continued.execution_status,ExecutionState.idle);
  assert.equal(cardPresentation(continued,Date.now()).label,'当前无后台执行');
  assert.equal((await projector.readTask(f.task.id,-1)).snapshot?.execution_status,ExecutionState.idle);
  assert.equal((await f.service.finishTask('owner',f.task.id,'completed','successful retry')).result_status,'completed');
});

test('卡片按 Task/member 读取执行结果，其他成员和新请求不继承旧失败',async t=>{
  const f=await fixture(t),run=f.createRun('failed-card');
  const failed=f.ledger.beginExecution({runId:run.id,agentId:f.agent.id,provider:'codex'});
  f.ledger.endExecution(failed,'failed');
  f.store.setExecutionState(f.session.id,ExecutionState.failed);
  const otherRoot=join(f.root,'other-card-workspace');await mkdir(otherRoot);
  const other=f.store.addMember(f.session.id,'local','other-card-workspace',otherRoot,'checkout',null);
  assert.notEqual(other.id,f.member.id,'不同成员使用不同节点/根目录身份');
  f.store.touchTaskMember(f.task.id,other.id);
  const otherRun=f.ledger.begin({root:otherRoot,workspaceId:other.workspace_id,workItemId:f.task.id,runKey:'other-card',
    title:f.task.title,origin:{entryPoint:'chatgpt_mcp',evidence:'server_entry'}});
  f.store.linkRun(f.session.id,other.id,otherRun.id,f.task.id);
  const successful=f.ledger.operation({runId:otherRun.id,requestKey:'other-success',kind:'command',label:'success',status:'running'});
  f.ledger.endOperation(successful,'completed');
  assert.equal(f.store.taskData.latestRunResult(f.task.id,f.member.id)?.last_outcome,'failed');
  assert.equal(f.store.taskData.latestRunResult(f.task.id,other.id)?.last_outcome,'completed');
  const projector=new SessionProjector(f.store,f.stateDir,null,undefined,'local');
  try {
    const aggregate=(await projector.readTask(f.task.id,-1)).snapshot!;
    assert.equal(cardPresentation(aggregate,Date.now()).status,'failed');
    const otherCard=(await projector.readTask(f.task.id,-1,other.id)).snapshot!;
    assert.equal(otherCard.execution_status,ExecutionState.idle);
    assert.equal(cardPresentation(otherCard,Date.now()).label,'当前无后台执行');
    const next=f.store.createTask(f.session.id,'下一请求');
    f.store.touchTaskMember(next.id,f.member.id);
    const nextCard=(await projector.readTask(next.id,-1,f.member.id)).snapshot!;
    assert.equal(f.store.getSession(f.session.id).execution_state,ExecutionState.failed);
    assert.equal(nextCard.execution_status,ExecutionState.idle);
    assert.equal(cardPresentation(nextCard,Date.now()).label,'当前无后台执行');
    const historical=(await projector.materialize(f.session.id,f.member.id,f.task.id));
    assert.equal(cardPresentation(historical,Date.now()).status,'failed');
  } finally {await projector.close();}
});

test('存在待核对 Run 或操作时，finish_task 保留开放任务和原始未决证据',async t=>{
  const f=await fixture(t),run=f.createRun('unknown');
  f.ledger.markRunReconciliationRequired(run.id);
  await assert.rejects(f.service.finishTask('owner',f.task.id,'completed','finish'),/TASK_RECONCILIATION_REQUIRED/);
  assert.equal(f.store.getTask(f.task.id).state,'active');
  assert.equal(f.ledger.run(run.id).status,'reconciliation_required');
  assert.equal(f.rows()[0].execution,'unknown');
  assert.equal(f.store.taskData.finalization(f.task.id)?.completed_at,null);
});

test('交付终态写入失败时，最终确认原子回滚且可真实重试',async t=>{
  const f=await fixture(t),run=f.createRun('finish-atomic');
  f.ledger.db.exec(`CREATE TRIGGER refuse_task_close BEFORE UPDATE OF state ON qm_tasks
    WHEN NEW.state='closed' BEGIN SELECT RAISE(ABORT,'task close refused'); END`);
  await assert.rejects(f.service.finishTask('owner',f.task.id,'completed','finish'),/task close refused/);
  assert.equal(f.store.getTask(f.task.id).state,'active');
  assert.equal(f.ledger.run(run.id).status,'completed');
  assert.equal(f.store.taskData.finalization(f.task.id)?.completed_at,null);
  assert.equal(f.rows()[0].execution,'finalizing');
  f.ledger.db.exec('DROP TRIGGER refuse_task_close');
  const finished=await f.service.finishTask('owner',f.task.id,'completed','finish');
  assert.equal(finished.state,'closed');
  assert.ok(f.store.taskData.finalization(f.task.id)?.completed_at);
  assert.equal(f.rows()[0].execution,'completed');
});

test('旧版本已确认却未关闭的收尾记录仍进入恢复队列',async t=>{
  const f=await fixture(t);
  f.store.taskData.requestFinalization(f.task.id,'completed','finish');
  f.store.taskData.finishFinalization(f.task.id);
  assert.equal(f.store.taskData.pendingFinalizations()[0]?.task_id,f.task.id);
  await f.service.retryFinalizations();
  assert.equal(f.store.getTask(f.task.id).result_status,'completed');
});

test('迟到的代理回调不能重启或改写已停止的执行',async t=>{
  const f=await fixture(t),run=f.createRun('terminal');
  const execution=f.ledger.beginExecution({runId:run.id,agentId:f.agent.id,provider:'codex'});
  f.ledger.endExecution(execution,'cancelled');
  const before=f.ledger.execution(execution),revision=f.ledger.run(run.id).revision;
  f.ledger.requestStarted(execution);
  f.ledger.endExecution(execution,'completed');
  assert.deepEqual(f.ledger.execution(execution),before);
  assert.equal(f.ledger.run(run.id).revision,revision);
});

test('历史任务 A 的验收只写 A 的指定阶段，当前任务 B 保持原验收状态',async t=>{
  const f=await fixture(t),run=f.createRun('review-a');
  f.store.closeTask(f.task.id,'completed','A done');
  const next=f.store.createTask(f.session.id,'B');
  f.store.setTaskReviewState(f.session.id,f.task.id,f.member.id,run.id,ReviewState.passed);
  const review=f.store.eventsForTask(f.task.id).filter(event=>event.type==='verification_recorded');
  assert.equal(review.length,1);assert.equal(review[0]!.payload.run_id,run.id);
  assert.equal(f.store.eventsForTask(next.id).length,0);
  assert.equal(f.store.getSession(f.session.id).review_state,ReviewState.unknown);
  f.store.setTaskReviewState(f.session.id,f.task.id,f.member.id,run.id,ReviewState.passed);
  assert.equal(f.store.eventsForTask(f.task.id).filter(event=>event.type==='verification_recorded').length,1);
  assert.throws(()=>f.store.setTaskReviewState(f.session.id,next.id,f.member.id,run.id,ReviewState.passed),/TASK_RUN_MISMATCH/);
});

test('历史任务快照的验收按 A 读取，当前任务 B 的验收不会串入，毫秒级时间相同也刷新',async t=>{
  const f=await fixture(t),run=f.createRun('review-snapshot-a');
  const projector=new SessionProjector(f.store,f.stateDir,null,undefined,'local');
  try {
    const frozen=await projector.materialize(f.session.id,f.member.id,f.task.id);
    f.store.putTaskSnapshot(f.task.id,f.member.id,frozen.rev,{...frozen,observedAt:Date.now()+60_000},[]);
    f.store.closeTask(f.task.id,'completed','A done');
    const next=f.store.createTask(f.session.id,'B');
    f.store.touchTaskMember(next.id,f.member.id);
    f.store.setTaskReviewState(f.session.id,f.task.id,f.member.id,run.id,ReviewState.passed);
    assert.equal((await projector.readTask(f.task.id,-1)).snapshot?.review_status,ReviewState.passed);
    assert.equal((await projector.materialize(f.session.id,f.member.id,next.id)).review_status,ReviewState.unknown);
    assert.equal((await projector.readTask(next.id,-1)).snapshot?.review_status,ReviewState.unknown);
    f.store.setReviewState(f.session.id,ReviewState.failed);
    assert.equal((await projector.materialize(f.session.id,f.member.id,f.task.id)).review_status,ReviewState.passed);
    assert.equal((await projector.readTask(next.id,-1)).snapshot?.review_status,ReviewState.failed);
  } finally {await projector.close();}
});

test('新任务不继承旧任务验收，多成员验收必须完整，成员卡片分别保留各自证据',async t=>{
  const f=await fixture(t),first=f.createRun('review-member-one');
  const otherRoot=join(f.root,'other');await mkdir(otherRoot);
  const other=f.store.addMember(f.session.id,'local','other-workspace',otherRoot,'checkout',null);
  f.store.touchTaskMember(f.task.id,other.id);
  const second=f.ledger.begin({root:otherRoot,workspaceId:'other-workspace',workItemId:f.task.id,runKey:'review-member-two',
    title:f.task.title,origin:{entryPoint:'chatgpt_mcp',evidence:'server_entry'}});
  f.store.linkRun(f.session.id,other.id,second.id,f.task.id);
  const projector=new SessionProjector(f.store,f.stateDir,null,undefined,'local');
  try {
    f.store.setTaskReviewState(f.session.id,f.task.id,f.member.id,first.id,ReviewState.passed);
    assert.equal(f.store.getSession(f.session.id).review_state,ReviewState.unknown);
    assert.equal((await projector.readTask(f.task.id,-1)).snapshot?.review_status,ReviewState.unknown);
    assert.equal((await projector.readTask(f.task.id,-1,f.member.id)).snapshot?.review_status,ReviewState.passed);
    f.store.setTaskReviewState(f.session.id,f.task.id,other.id,second.id,ReviewState.passed);
    assert.equal((await projector.readTask(f.task.id,-1)).snapshot?.review_status,ReviewState.passed);
    const next=f.store.createTask(f.session.id,'下一任务');
    assert.equal(f.store.getSession(f.session.id).review_state,ReviewState.unknown);
    assert.equal(f.store.taskReviewState(next.id),ReviewState.unknown);
  } finally {await projector.close();}
});

test('无 Run 任务按真实 Task revision 结束，旧版本拒绝且不保存收尾意图',async t=>{
  const f=await fixture(t),revision=f.store.getTask(f.task.id).revision;
  await assert.rejects(f.service.finishTask('owner',f.task.id,'completed','done',revision-1),/TASK_REVISION_CONFLICT/);
  assert.equal(f.store.taskData.finalization(f.task.id),null);
  const finished=await f.service.finishTask('owner',f.task.id,'completed','done',revision);
  assert.equal(finished.state,'closed');assert.equal(finished.result_status,'completed');
  assert.equal(f.store.runIdsForTask(f.task.id).length,0);
});

test('复用同一任务的收尾 Promise 前仍检查所属用户',async t=>{
  const f=await fixture(t);
  const finishing=f.service.finishTask('owner',f.task.id,'completed','done');
  await assert.rejects(f.service.finishTask('another-owner',f.task.id,'completed','done'),/SESSION_NOT_FOUND/);
  await finishing;
  const next=f.store.createTask(f.session.id,'owner receipt');
  const owned=f.service.finishOwnedTask('owner',next.id,'completed','done');
  await assert.rejects(f.service.finishOwnedTask('another-owner',next.id,'completed','done'),/SESSION_NOT_FOUND/);
  await owned;
});

test('历史归档任务补充明确交付结果失败后仍能恢复，拒绝用结果覆盖另一个已确认终态',async t=>{
  const f=await fixture(t);
  f.store.archiveTask(f.task.id,'legacy_archive');
  f.ledger.db.exec(`CREATE TRIGGER refuse_legacy_close BEFORE UPDATE OF result_status ON qm_tasks
    WHEN NEW.result_status IS NOT NULL BEGIN SELECT RAISE(ABORT,'legacy close refused'); END`);
  await assert.rejects(f.service.finishTask('owner',f.task.id,'completed','confirmed'),/legacy close refused/);
  assert.equal(f.store.taskData.pendingFinalizations()[0]?.task_id,f.task.id);
  f.ledger.db.exec('DROP TRIGGER refuse_legacy_close');
  await f.service.retryFinalizations();
  assert.equal(f.store.getTask(f.task.id).result_status,'completed');
  await assert.rejects(f.service.finishTask('owner',f.task.id,'cancelled','different'),/TASK_ALREADY_FINISHED_WITH_DIFFERENT_RESULT/);
});

test('阶段完成不替代请求交付终态，开放请求仍可按阶段待验收筛选',async t=>{
  const f=await fixture(t),run=f.createRun('phase-complete');
  f.ledger.finish(run.id,{status:'completed',acceptance:'not_applicable',summary:'phase done',evidence:[]});
  f.ledger.db.prepare("UPDATE console_work_runs SET acceptance='pending' WHERE id=?").run(run.id);
  const raw=readLocalIndex(f.config,[run.id]).runs[0]!;
  const lifecycle=readLocalSessionTitles(f.config).tasks[0]!;
  const global=withTaskLifecycle(raw,lifecycle);
  assert.equal(raw.executionStatus,'completed');assert.equal(global.executionStatus,'waiting');
  assert.equal(global.phaseExecutionStatus,'completed');
  assert.equal(taskStage(global.executionStatus,global.acceptanceStatus,global.phaseExecutionStatus),'review');
  const task=withTaskLifecycle(aggregateTaskIndex(readLocalTaskIndex(f.config).items)[0]!,lifecycle);
  assert.equal(filterTaskIndex([task],{stage:'waiting'},Date.now()).length,1);
  assert.equal(filterTaskIndex([task],{stage:'review'},Date.now()).length,0);
  const feed=new WorkbenchFeed(f.config);
  const review=await feed.runs({days:'0',stage:'waiting',status:'review'});
  assert.deepEqual(review.items.map(item=>item.taskId),[f.task.id]);
  assert.equal((await feed.runs({days:'0',stage:'waiting',status:'accepted'})).total,0);
});

test('历史交付终态不会遮蔽真实执行或待核对结果，交付结果本身保持不变',async t=>{
  const f=await fixture(t),run=f.createRun('legacy-active-after-closure');
  const operation=f.ledger.operation({runId:run.id,requestKey:'live-command',kind:'command',label:'live',status:'running'});
  f.store.closeTask(f.task.id,'completed','historical closure');
  assert.equal(f.rows()[0].execution,'running');
  assert.equal(readLocalIndex(f.config,[run.id]).runs[0]!.resultStatus,'completed');
  f.ledger.endOperation(operation,'reconciliation_required');
  assert.equal(f.rows()[0].execution,'unknown');
  assert.equal(f.rows({attention:'1'}).length,1);
  assert.equal(f.store.getTask(f.task.id).result_status,'completed');
});

test('Task 卡片包含真实代理活性、过期观察与未知操作，终态后清除后台观察',async t=>{
  const f=await fixture(t),run=f.createRun('agent-observation');
  const execution=f.ledger.beginExecution({runId:run.id,agentId:f.agent.id,provider:'codex'});
  const projector=new SessionProjector(f.store,f.stateDir,null,undefined,'local');
  try {
    assert.deepEqual(projector.observeTask(f.task.id).preparingOperationIds,[`execution:${execution}`]);
    f.ledger.requestStarted(execution);
    assert.deepEqual(projector.observeTask(f.task.id).activeOperationIds,[`execution:${execution}`]);
    f.ledger.db.prepare('UPDATE console_executions SET observed_at=? WHERE id=?').run(new Date(Date.now()-60_000).toISOString(),execution);
    assert.deepEqual(projector.observeTask(f.task.id).staleOperationIds,[`execution:${execution}`]);
    f.ledger.endExecution(execution,'completed');
    const operation=f.ledger.operation({runId:run.id,requestKey:'unknown-command',kind:'command',label:'unknown',status:'running'});
    f.ledger.endOperation(operation,'reconciliation_required');
    const observation=projector.observeTask(f.task.id);
    assert.deepEqual(observation.activeOperationIds,[]);assert.deepEqual(observation.preparingOperationIds,[]);
    assert.deepEqual(observation.staleOperationIds,[operation]);
  } finally {await projector.close();}
});

test('旧阶段未决结果继续参与主状态，新阶段不会将其遮蔽',async t=>{
  const f=await fixture(t),old=f.createRun('old');
  f.ledger.markRunReconciliationRequired(old.id);
  f.createRun('new');
  const index=aggregateTaskIndex(readLocalTaskIndex(f.config).items)[0]!;
  const detail=aggregateTasks(readLocalIndex(f.config).runs)[0]!;
  assert.equal(index.executionStatus,'unknown');assert.equal(detail.executionStatus,'unknown');
  assert.equal(index.actionableInterruption,true);assert.equal(detail.actionableInterruption,true);
  assert.equal(index.currentPhaseRefs.length,2);
});

test('已停的旧阶段不拖空当前完成阶段的结束时间，索引和详情保持一致',async t=>{
  const f=await fixture(t),old=f.createRun('old');
  f.ledger.db.prepare("UPDATE console_work_runs SET status='interrupted' WHERE id=?").run(old.id);
  const current=f.createRun('current');
  f.ledger.finish(current.id,{status:'completed',acceptance:'not_applicable',summary:'done',evidence:[]});
  const index=aggregateTaskIndex(readLocalTaskIndex(f.config).items)[0]!;
  const detail=aggregateTasks(readLocalIndex(f.config).runs)[0]!;
  assert.equal(index.executionStatus,'completed');assert.ok(index.finishedAt);
  assert.equal(index.finishedAt,detail.finishedAt);
});

test('无 Run 任务有可用索引与详情摘要，且保留真实任务版本',async t=>{
  const f=await fixture(t);
  const lifecycle=readLocalSessionTitles(f.config).tasks[0]!;
  const index=taskOnlyIndex(lifecycle),run=fallbackTask(index);
  assert.equal(index.taskId,f.task.id);assert.equal(index.taskRevision,lifecycle.revision);
  assert.equal(run.id,`qmtask:${f.task.id}`);assert.deepEqual(run.phaseRefs,[]);
  assert.equal(run.actions.complete,true);assert.equal(run.usage.quality,'not_used');
  assert.equal(run.warnings.length,0);
});

test('关闭请求仍保留未知后台事实；交接保持独立语义',()=>{
  assert.equal(taskView({requestState:'closed',result:null,execution:'waiting',active:false,unresolved:true}).status,'unknown');
  assert.equal(taskView({requestState:'closed',result:'handed_off',execution:'waiting'}).status,'handed_off');
  const running=taskView({requestState:'closed',result:'handed_off',execution:'running'});
  assert.equal(running.status,'running');assert.equal(running.resultStatus,'handed_off');
});

test('待接续与最终确认不受旧创建时间隐藏，组合 stage 和待处理筛选一致',async t=>{
  const f=await fixture(t);
  const lifecycle=readLocalSessionTitles(f.config).tasks[0]!;
  const index=taskOnlyIndex({...lifecycle,createdAt:Date.now()-10*86400000,lastActivityAt:Date.now()-11*60000});
  assert.equal(index.executionStatus,'stalled');assert.equal(needsAttention(index),true);
  assert.equal(filterTaskIndex([index],{days:'7',attention:'1'},Date.now()).length,1);
  assert.equal(filterTaskIndex([index],{stage:'waiting,stalled,finalizing'},Date.now()).length,1);
  assert.equal(taskStage('stopping','unknown'),'stopping');
});

test('SQL 待处理 OR 不会绕过项目过滤',async t=>{
  const f=await fixture(t),run=f.createRun('scope');
  const execution=f.ledger.beginExecution({runId:run.id,agentId:f.agent.id,provider:'codex'});
  f.ledger.endExecution(execution,'cancelled');
  assert.equal(f.rows({attention:'1',project:'missing-project'}).length,0);
});

test('业务 revision 不变时，卡片轻量通道仍报告当前连接和执行状态',async t=>{
  const f=await fixture(t),run=f.createRun('live-status');
  const projector=new SessionProjector(f.store,f.stateDir,null,undefined,'local');
  t.after(()=>projector.close());
  const initial=await projector.readTask(f.task.id,-1);
  assert.ok(initial.snapshot);assert.equal(initial.live?.hostStatus,HostState.connected);
  const revision=f.store.getTask(f.task.id).revision;
  f.ledger.db.prepare('update qm_session_members set online=0 where id=?').run(f.member.id);
  const disconnected=await projector.readTask(f.task.id,revision);
  assert.equal(disconnected.unchanged,true);assert.equal(disconnected.live?.hostStatus,HostState.disconnected);
  f.ledger.db.prepare('update qm_session_members set online=1 where id=?').run(f.member.id);
  f.ledger.finish(run.id,{status:'failed',acceptance:'not_applicable',summary:'真实执行失败',evidence:[]});
  const recovered=await projector.readTask(f.task.id,revision);
  assert.equal(recovered.unchanged,true);assert.equal(recovered.live?.hostStatus,HostState.connected);
  assert.equal(recovered.live?.executionStatus,ExecutionState.failed);
  assert.equal(f.store.getTask(f.task.id).revision,revision);
});
