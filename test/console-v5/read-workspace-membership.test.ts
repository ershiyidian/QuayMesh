import assert from 'node:assert/strict';
import test from 'node:test';
import {consoleExperienceFixture} from './experience-fixture.js';
import {openDatabase} from '../../src/db/client.js';
import {canonicalWorkspaceRoot} from '../../src/roots.js';
import {createRealTestServer,structured} from '../session-card/server-fixture.js';

test('a read-only Task member remains visible beside a real patch phase and in project filters',{timeout:30_000},async()=>{
  const f=await consoleExperienceFixture();
  try {
    const database=openDatabase(f.server.config.stateDir);
    try {
      assert.equal(database.sqlite.prepare('SELECT COUNT(*) FROM qm_task_members WHERE task_id=?').pluck().get(f.completed.task_id),2);
      assert.equal(database.sqlite.prepare(`SELECT COUNT(*) FROM console_operations o JOIN qm_invocations i ON i.id=o.request_key
        WHERE i.task_id=? AND i.tool_name='read'`).pluck().get(f.completed.task_id),0);
      assert.equal(database.sqlite.prepare('SELECT COUNT(*) FROM qm_run_links WHERE task_id=?').pluck().get(f.completed.task_id),1);
    } finally {database.close();}
    const page=await f.get('runs?days=0&fresh=1');
    const done=page.items.find((row:any)=>row.taskId===f.completed.task_id);
    assert.ok(done);assert.equal(done.workspaceCount,2);
    assert.deepEqual(done.workspaces.map((row:any)=>canonicalWorkspaceRoot(row.root)).sort(),
      [canonicalWorkspaceRoot(f.server.project),canonicalWorkspaceRoot(f.server.secondRoot)].sort());
    assert.equal(done.phaseRefs.length,1,'membership must not create a fake execution phase');
    const projects=await f.get('projects');
    const project=projects.items.find((row:any)=>canonicalWorkspaceRoot(row.path)===canonicalWorkspaceRoot(f.server.project));
    assert.ok(project);
    const scoped=await f.get('runs?days=0&fresh=1&project='+encodeURIComponent(project.id));
    assert.ok(scoped.items.some((row:any)=>row.taskId===f.completed.task_id));
    const detail=await f.get('runs/'+encodeURIComponent('qmtask:'+f.completed.task_id)+'?fresh=1');
    assert.equal(detail.run.workspaceCount,2);
  } finally {await f.server.dispose();}
});

test('an attached workspace is listed and filterable before any business execution exists',{timeout:30_000},async()=>{
  const server=await createRealTestServer({git:false,uiEnabled:true});
  try {
    const meta={'openai/session':'read-only-attachment'};
    const call=async(name:string,args:Record<string,unknown>)=>{
      const reply=await server.client.callTool({name,arguments:args,_meta:meta});
      assert.notEqual(reply.isError,true,JSON.stringify(reply.content));
      return structured(reply);
    };
    const task=await call('start_session',{title:'只读核对两个工作区',request_key:'read-only-attachment'});
    const workspace=await call('open_workspace',{path:server.project});
    await call('read',{workspace_id:workspace.workspace_id,path:'README.md'});
    await call('attach_workspace',{session_id:task.session_id,path:server.secondRoot});
    const database=openDatabase(server.config.stateDir);
    let projectId:string;
    try {
      const project=database.sqlite.prepare('SELECT id FROM console_projects WHERE root=?')
        .get(canonicalWorkspaceRoot(server.secondRoot)) as {id:string}|undefined;
      assert.ok(project,'metadata must use the registered project, not a fabricated reference');
      projectId=project.id;
      assert.equal(database.sqlite.prepare('SELECT COUNT(*) FROM qm_task_members WHERE task_id=?').pluck().get(task.task_id),2);
      assert.equal(database.sqlite.prepare('SELECT COUNT(*) FROM qm_run_links WHERE task_id=?').pluck().get(task.task_id),0);
      assert.equal(database.sqlite.prepare('SELECT COUNT(*) FROM console_operations').pluck().get(),0);
    } finally {database.close();}
    const login=await fetch(server.baseUrl+'/console/api/login',{method:'POST',headers:{origin:server.baseUrl,'content-type':'application/json'},
      body:JSON.stringify({password:server.config.oauth.ownerToken})});
    assert.equal(login.status,200);
    const cookie=login.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
    const get=async(path:string)=>{
      const response=await fetch(server.baseUrl+'/console/api/v4/'+path,{headers:{cookie}});
      assert.equal(response.status,200,await response.clone().text());
      return await response.json() as any;
    };
    const projects=await get('projects');
    const project=projects.items.find((row:any)=>row.localId===projectId||canonicalWorkspaceRoot(row.path)===canonicalWorkspaceRoot(server.secondRoot));
    assert.ok(project);
    const page=await get('runs?days=0&fresh=1&project='+encodeURIComponent(project.id));
    const observed=page.items.find((row:any)=>row.taskId===task.task_id);
    assert.ok(observed);assert.equal(observed.workspaceCount,2);assert.deepEqual(observed.phaseRefs,[]);
  } finally {await server.dispose();}
});
