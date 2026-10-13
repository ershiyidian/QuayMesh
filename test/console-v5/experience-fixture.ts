import assert from 'node:assert/strict';
import {createRealTestServer,structured} from '../session-card/server-fixture.js';
import {openDatabase} from '../../src/db/client.js';

export async function consoleExperienceFixture() {
  const server=await createRealTestServer({git:false,uiEnabled:true});
  const meta={'openai/session':'console-experience'};
  const call=async(name:string,args:Record<string,unknown>)=>{
    const result=await server.client.callTool({name,arguments:args,_meta:meta});
    assert.notEqual(result.isError,true,JSON.stringify(result.content));
    return structured(result);
  };
  const old=await call('start_session',{title:'已经结束的调查',request_key:'experience-old'});
  const workspace=await call('open_workspace',{path:server.project});
  await call('read',{workspace_id:workspace.workspace_id,path:'README.md'});
  const completed=await call('start_session',{title:'已经完成的改动',request_key:'experience-complete'});
  await call('read',{workspace_id:workspace.workspace_id,path:'README.md'});
  const second=await call('attach_workspace',{session_id:completed.session_id,path:server.secondRoot});
  await call('apply_patch',{workspace_id:second.workspace_id,patch:'*** Begin Patch\n*** Add File: finished.txt\n+真实完成的文件内容\n*** End Patch'});
  await call('finish_task',{task_id:completed.task_id,status:'completed',summary:'文件已经写入'});
  const waiting=await call('start_session',{title:'等待下一步的工作',request_key:'experience-wait'});
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
  return {server,call,get,cookie,auth,old,completed,waiting,workspace,second};
}
