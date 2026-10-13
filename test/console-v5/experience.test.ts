import assert from 'node:assert/strict';
import test from 'node:test';
import {consoleExperienceFixture} from './experience-fixture.js';
import {taskStages} from '../../src/console-task-state.js';
import {openDatabase} from '../../src/db/client.js';
import {createRealTestServer,structured} from '../session-card/server-fixture.js';

test('真实Console中任务状态、筛选、总览、路径与会话来源一致', {timeout:60000},async t=>{
  const f=await consoleExperienceFixture();t.after(()=>f.server.dispose());
  const list=await f.get('runs?days=0&limit=100');
  assert.equal(list.total,3);
  assert.equal(list.counts.waiting,1);assert.equal(list.counts.done,1);assert.equal(list.counts.ended,1);
  assert.equal(list.items.find((item:any)=>item.taskId===f.old.task_id).executionStatus,'ended');
  const completed=list.items.find((item:any)=>item.taskId===f.completed.task_id);
  assert.equal(completed.executionStatus,'completed');
  assert.equal(completed.workspaceCount,2);
  assert.deepEqual(completed.workspaces.map((value:any)=>value.root.toLowerCase()).sort(),[f.server.project,f.server.secondRoot].map(value=>value.toLowerCase()).sort());
  for(const [state] of taskStages){
    const page=await f.get('runs?days=0&status='+state);
    assert.equal(page.total,list.counts[state] ?? 0,state);
    assert.equal(page.items.length,page.total,state);
  }
  const overview=await f.get('overview?tz=Asia%2FShanghai');
  assert.equal(overview.runningCount,0);assert.equal(overview.active.length,0);
  assert.equal(overview.waitingCount,1);assert.equal(overview.waiting.length,1);
  assert.equal(overview.completedToday,1);
  assert.equal(overview.recent.some((run:any)=>run.taskId===f.old.task_id),true);
  const detail=await f.get('runs/'+encodeURIComponent(completed.id));
  assert.equal(detail.run.executionStatus,'completed');
  assert.equal(detail.run.workspaces.length,2);
  assert.equal(detail.files.some((file:any)=>file.path==='finished.txt'),true);
  const projectList=await f.get('projects');
  const project=projectList.items.find((value:any)=>value.path.toLowerCase()===f.server.project.toLowerCase());
  assert.equal(project.sessionCount,1);assert.equal(project.threadCount,0);assert.equal(project.active,0);
  const sessions=await f.get('projects/'+encodeURIComponent(project.id)+'/sessions');
  assert.equal(sessions.conversations.length,project.sessionCount);
  assert.equal(sessions.items.length,0);
  assert.equal(sessions.conversations[0].taskCount,3);
  assert.equal(sessions.conversations[0].tasks.find((value:any)=>value.taskId===f.completed.task_id).status,'done');
  const byPath=await f.get('runs?days=0&q='+encodeURIComponent(f.server.secondRoot.toLowerCase()));
  assert.equal(byPath.items.some((value:any)=>value.taskId===f.completed.task_id),true);
  const db=openDatabase(f.server.config.stateDir);
  try {assert.equal((db.sqlite.prepare("SELECT COUNT(*) count FROM console_work_runs WHERE status='running'").get() as {count:number}).count>0,true);}
  finally{db.close();}
});

test('同一真实任务运行进程时总览计数保持运行，完成后离开当前工作', {timeout:45000},async t=>{
  const f=await consoleExperienceFixture();t.after(()=>f.server.dispose());
  const command=await f.call('exec_command',{workspace_id:f.workspace.workspace_id,
    cmd:`"${process.execPath}" -e "setTimeout(()=>console.log('completed'),3000)"`,yield_time_ms:10});
  const running=await f.get('overview');assert.equal(running.runningCount,1);assert.equal(running.active.length,1);
  let observed=command;
  while(observed.running)observed=await f.call('write_stdin',{workspace_id:f.workspace.workspace_id,session_id:command.session_id,chars:'',yield_time_ms:1000});
  assert.equal(observed.exit_code,0);
  await f.call('finish_task',{task_id:f.waiting.task_id,status:'completed',summary:'命令正常结束'});
  const deadline=Date.now()+10000;
  let result=await f.get('overview');
  while(result.runningCount!==0&&Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,500));result=await f.get('overview');}
  assert.equal(result.runningCount,0);assert.equal(result.active.length,0);
});

test('仅打开工作区尚未执行命令的对话也出现在项目会话列表',async t=>{
  const server=await createRealTestServer({git:false});t.after(()=>server.dispose());
  const meta={'openai/session':'opened-only'};
  await server.client.callTool({name:'start_session',arguments:{title:'只打开工作区',request_key:'opened-only'},_meta:meta});
  const opened=structured(await server.client.callTool({name:'open_workspace',arguments:{path:server.project},_meta:meta}));
  const login=await fetch(server.baseUrl+'/console/api/login',{method:'POST',headers:{origin:server.baseUrl,'content-type':'application/json'},body:JSON.stringify({password:server.config.oauth.ownerToken})});
  assert.equal(login.status,200);const cookie=login.headers.getSetCookie()[0].split(';')[0];
  const projects=await (await fetch(server.baseUrl+'/console/api/v4/projects',{headers:{cookie}})).json() as any;
  const project=projects.items.find((value:any)=>value.path.toLowerCase()===server.project.toLowerCase());
  assert.equal(project.sessionCount,1);
  const sessions=await (await fetch(server.baseUrl+'/console/api/v4/projects/'+encodeURIComponent(project.id)+'/sessions',{headers:{cookie}})).json() as any;
  assert.equal(sessions.conversations.length,1);assert.equal(sessions.conversations[0].id,opened.session_id);
  assert.equal(sessions.conversations[0].taskCount,1);assert.equal(sessions.conversations[0].tasks[0].hasRun,false);
});
