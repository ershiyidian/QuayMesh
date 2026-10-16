import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {twoNodes,until} from './tool-contract/fixture.js';
import {WORKSPACE_APP_VERSION} from '../src/session/card-contract.js';

test('跨节点静默执行持续刷新活性，不制造 Task 修订或模型活动', {timeout:60000}, async t=>{
  const {worker,cloud}=await twoNodes(t);
  const meta={'openai/session':randomUUID()};
  async function call(name:string,args:Record<string,unknown>){
    const result=await cloud.client.callTool({name,arguments:name==='qm_session'?{...args,resource_version:WORKSPACE_APP_VERSION}:args,_meta:meta});
    assert.notEqual(result.isError,true,JSON.stringify(result));
    return result.structuredContent as any;
  }
  const task=await call('start_session',{request_key:randomUUID(),title:'跨节点活性测试'});
  const workspace=await call('open_workspace',{root_id:'worker/main'});
  const gate=join(worker.root,'complete'),script=join(worker.project,'silent.mjs');
  await writeFile(script,`import {existsSync} from 'node:fs'; const t=setInterval(()=>{if(existsSync(${JSON.stringify(gate)})){clearInterval(t);}},50);`);
  const command=await call('exec_command',{workspace_id:workspace.workspace_id,cmd:`"${process.execPath}" "${script}"`,yield_time_ms:0,operation_key:'silent-once'});
  let first:any;
  await until(async()=>{
    const result=await call('qm_session',{session_id:task.session_id,task_id:task.task_id,since_rev:-1});
    first=result.snapshot;return first?.executionObservation?.activeOperationIds.includes(command.operation_id);
  });
  // 完成初始事件传播，再观察没有新输出、没有新操作时的活性更新。
  await delay(1000);
  first=(await call('qm_session',{session_id:task.session_id,task_id:task.task_id,since_rev:-1})).snapshot;
  await delay(12000);
  const next=await call('qm_session',{session_id:task.session_id,task_id:task.task_id,since_rev:first.rev});
  assert.equal(next.unchanged,true,JSON.stringify(next));
  assert.equal(next.rev,first.rev);
  assert.ok(next.observation.observedAt>first.executionObservation.observedAt);
  assert.ok(next.observation.activeOperationIds.includes(command.operation_id));
  const full=(await call('qm_session',{session_id:task.session_id,task_id:task.task_id,since_rev:-1})).snapshot;
  assert.equal(full.lastModelToolAt,first.lastModelToolAt);
  await writeFile(gate,'done');
  await until(async()=>(await call('read_output',{workspace_id:workspace.workspace_id,operation_id:command.operation_id})).process_done);
  await until(async()=>{
    const snapshot=(await call('qm_session',{session_id:task.session_id,task_id:task.task_id,since_rev:-1})).snapshot;
    return !snapshot.executionObservation.activeOperationIds.includes(command.operation_id);
  });
});
