import assert from 'node:assert/strict';
import {createRealTestServer,structured,waitForRecordedTool} from '../session-card/server-fixture.js';
import {openDatabase} from '../../src/db/client.js';
import {SessionChangeCollector} from '../../src/session/changes.js';
import {SessionStore} from '../../src/session/store.js';
import {canonicalWorkspaceRoot} from '../../src/roots.js';
import {WorkLedger} from '../../src/work-ledger.js';

export async function consoleExperienceFixture(options: { historicalBackground?: boolean } = {}) {
  const server=await createRealTestServer({git:false,uiEnabled:true});
  try {
  const meta={'openai/session':'console-experience'};
  const call=async(name:string,args:Record<string,unknown>)=>{
    const result=await server.client.callTool({name,arguments:args,_meta:meta});
    assert.notEqual(result.isError,true,JSON.stringify(result.content));
    return structured(result);
  };
  const old=await call('start_session',{title:'已经结束的调查',request_key:'experience-old'});
  const workspace=await call('open_workspace',{path:server.project});
  await call('read',{workspace_id:workspace.workspace_id,path:'README.md'});
  const oldSelection=await call('task_resume',{action:'inspect',task_id:old.task_id});
  const completed=await call('start_session',{title:'已经完成的改动',request_key:'experience-complete',new_goal:true,
    expected_binding_revision:(oldSelection.binding as {binding_revision:number}).binding_revision});
  await call('read',{workspace_id:workspace.workspace_id,path:'README.md'});
  const second=await call('attach_workspace',{session_id:completed.session_id,path:server.secondRoot});
  const patch=await server.client.callTool({name:'apply_patch',arguments:{workspace_id:second.workspace_id,patch:'*** Begin Patch\n*** Add File: finished.txt\n+真实完成的文件内容\n*** End Patch'},_meta:meta});
  await waitForRecordedTool(server,{sessionId:String(completed.session_id),workspaceId:String(second.workspace_id),conversationId:meta['openai/session'],paths:['finished.txt']},patch);
  let historicalBackgroundOperationId: string | undefined;
  if(options.historicalBackground) {
    const ledger=new WorkLedger(server.config.stateDir);
    try {
      const row=ledger.db.prepare('SELECT run_id FROM qm_run_links WHERE task_id=? ORDER BY rowid DESC LIMIT 1')
        .get(completed.task_id) as {run_id:string}|undefined;
      assert.ok(row);
      // Create the historical operation while this Task can still accept work.
      // Its completed receipt permits the normal finish below; a lifecycle
      // fixture can later load an older, delayed observation of this same ID.
      historicalBackgroundOperationId=ledger.operation({runId:row.run_id,requestKey:'console-lifecycle-delayed-running',
        kind:'command',label:'历史任务结束后到达的后台执行回执',status:'running'});
      ledger.endOperation(historicalBackgroundOperationId,'completed');
    } finally {ledger.close();}
  }
  await call('finish_task',{task_id:completed.task_id,status:'completed',summary:'文件已经写入'});
  const completedSelection=await call('task_resume',{action:'inspect',task_id:completed.task_id});
  const waiting=await call('start_session',{title:'等待下一步的工作',request_key:'experience-wait',new_goal:true,
    expected_binding_revision:(completedSelection.binding as {binding_revision:number}).binding_revision});
  await call('read',{workspace_id:workspace.workspace_id,path:'README.md'});
  const db=openDatabase(server.config.stateDir);
  try {
    // 重建线上已有的记录组合，查询必须依据Task的完成证据。
    db.sqlite.prepare(`UPDATE console_work_runs SET status='running',finished_at=NULL
      WHERE id IN (SELECT run_id FROM qm_run_links WHERE task_id IN (?,?))`).run(old.task_id,completed.task_id);
    db.sqlite.prepare("UPDATE qm_tasks SET state='closed',result_status=NULL WHERE id=?").run(old.task_id);
  } finally {db.close();}
  const login=await fetch(server.baseUrl+'/console/api/login',{method:'POST',headers:{origin:server.baseUrl,'content-type':'application/json'},
    body:JSON.stringify({password:server.config.oauth.ownerToken})});
  assert.equal(login.status,200,await login.clone().text());
  const auth=await login.json() as {csrf:string;expiresAt:number};
  const cookie=login.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
  const get=async(path:string)=>{
    const response=await fetch(server.baseUrl+'/console/api/v4/'+path,{headers:{cookie}});
    assert.equal(response.status,200,await response.clone().text());
    return await response.json() as any;
  };
  return {server,call,get,cookie,auth,old,completed,waiting,workspace,second,historicalBackgroundOperationId};
  } catch(error) {await server.dispose();throw error;}
}

/** Obtain the real collector without adding a production-only test hook. */
export async function liveCaptureFixture(f:Awaited<ReturnType<typeof consoleExperienceFixture>>) {
  await f.call('read',{workspace_id:f.second.workspace_id,path:'finished.txt'});
  const reference='qmtask:'+f.waiting.task_id;
  const observed:{collector?:SessionChangeCollector}={};
  const original=SessionChangeCollector.prototype.captureObservation;
  let detail:any;
  try {
    SessionChangeCollector.prototype.captureObservation=function(memberId,taskId){
      if(taskId===f.waiting.task_id)observed.collector=this;
      return original.call(this,memberId,taskId);
    };
    detail=await f.get('runs/'+encodeURIComponent(reference)+'?fresh=1');
  } finally {SessionChangeCollector.prototype.captureObservation=original;}
  assert.ok(observed.collector,'The real live detail must observe its capture scope');
  const phase=detail.phases.find((value:any)=>canonicalWorkspaceRoot(value.run.root)===canonicalWorkspaceRoot(f.server.secondRoot));
  assert.ok(phase?.run.memberId,'The current task must have a phase in the shared workspace');
  const database=openDatabase(f.server.config.stateDir);
  try {
    const member=new SessionStore(database.sqlite).getMember(f.waiting.session_id,phase.run.memberId);
    return {collector:observed.collector,member,taskId:f.waiting.task_id as string,phaseId:phase.id as string,reference};
  } finally {database.close();}
}
