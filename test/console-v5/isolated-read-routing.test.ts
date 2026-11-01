import test from 'node:test';
import assert from 'node:assert/strict';
import type {ServerConfig} from '../../src/config.js';
import type {FederationRuntime} from '../../src/federation/runtime.js';
import {WorkbenchFeed} from '../../src/console-workbench/feed.js';
import {isolatedConsoleReadPath,isolatedReadUpgradeRequired,READ_UPGRADE_MESSAGE} from '../../src/console-workbench/isolated-routes.js';

test('Console read routes use the versioned isolation boundary and leave write reconciliation outside it',()=>{
  for(const path of ['/metadata','/runs','/task-index','/session-titles','/run-summaries','/overview','/overview-usage','/usage','/activity',
    '/runs/run1','/runs/run1/files/file1','/runs/run1/commands/command1','/runs/run1/patch','/projects/project1/sessions','/tasks/task1/messages-state']) {
    assert.equal(isolatedConsoleReadPath('/workbench'+path+'?limit=2'),'/workbench/isolated-v1'+path+'?limit=2');
  }
  assert.equal(isolatedConsoleReadPath('/workbench/receipts/key'),'/workbench/receipts/key');
  assert.equal(isolatedConsoleReadPath('/workbench/settings'),'/workbench/settings');
  assert.equal(isolatedReadUpgradeRequired('/workbench/isolated-v1/runs/absent',404,{code:'run_not_found'}),false);
});

test('an older node is never retried through the synchronous route and confirmed cached data is retained',async()=>{
  const paths:string[]=[];let older=false;
  const runtime={nodes:()=>[{id:'worker',nickname:'Worker',online:true}],request:async(_node:string,_method:string,input:{path:string})=>{
    paths.push(input.path);return older?{status:404,body:{code:'route_not_found'}}:{status:200,body:{items:[{id:'saved-task'}]}};
  }} as unknown as FederationRuntime;
  const feed=new WorkbenchFeed({} as ServerConfig,runtime);
  const first=await feed.readNode<{items:Array<{id:string}>}>('worker','/workbench/task-index',()=>{throw new Error('unexpected local read');});
  assert.deepEqual(first.data,{items:[{id:'saved-task'}]});
  older=true;
  const failed=await feed.readNode<{items:Array<{id:string}>}>('worker','/workbench/task-index',()=>{throw new Error('unexpected local read');},{fresh:true});
  assert.deepEqual(failed.data,first.data);
  assert.equal(failed.source.observedAt,first.source.observedAt);
  assert.equal(failed.source.online,true);
  assert.equal(failed.source.error,READ_UPGRADE_MESSAGE);
  assert.deepEqual(paths,['/workbench/isolated-v1/task-index','/workbench/isolated-v1/task-index']);
  await assert.rejects(feed.call('worker','/workbench/task-index'),{code:'node_read_upgrade_required',status:503,effect:'none'});
  assert.equal(paths.at(-1),'/workbench/isolated-v1/task-index');
});
