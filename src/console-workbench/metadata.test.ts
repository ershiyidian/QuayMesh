import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {loadConfig} from '../config.js';
import {writeTestQuayMeshConfig} from '../test-support/config.test.js';
import {WorkLedger} from '../work-ledger.js';
import {readWorkbenchMetadata} from './metadata.js';
import {WorkbenchFeed} from './feed.js';
import type {FederationRuntime} from '../federation/runtime.js';

test('local and remote metadata use desired settings and preserve data when node administration is unavailable',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'quaymesh-metadata-')),root=join(directory,'project');await mkdir(root);
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const config=loadConfig(writeTestQuayMeshConfig(join(directory,'config'),{storage:{stateDir:join(directory,'state')},workspaces:{allowedRoots:[root]}}));
  const nodeId=config.federation!.nodeId;
  const ledger=new WorkLedger(config.stateDir);ledger.begin({root,workspaceId:'test-workspace',workItemId:'test-item',runKey:'test-run',title:'visible project',origin:{entryPoint:'chatgpt_mcp',evidence:'server_entry'}});ledger.close();
  let fail=false;
  const runtime={nodes:()=>[{id:nodeId,nickname:'runtime name',online:true}],request:async(node:string,method:string)=>{
    assert.equal(node,nodeId);assert.equal(method,'settings.get');if(fail)throw new Error('admin temporarily unavailable');
    return {revision:7,savedRevision:7,appliedRevision:6,pending:true,applicationError:'busy command',nickname:'desired name',priority:23,
      roots:[{id:'desired-root',nickname:'desired root',path:root,tags:['saved'],enabled:true}],
      egress:{enabled:true,mihomoConfig:'/saved/config.yaml',proxyUrl:'http://127.0.0.1:9090',probeUrl:'https://example.invalid',recoveryDelayMs:1500,inheritProxy:true}};
  }} as unknown as FederationRuntime;
  const direct=await readWorkbenchMetadata(config,runtime);
  assert.equal(direct.settings?.nickname,'desired name');assert.equal(direct.settings?.revision,7);assert.equal(direct.settings?.appliedRevision,6);
  assert.equal(direct.settings?.pending,true);assert.equal(direct.settings?.error,'busy command');assert.equal(direct.settings?.egress.port,9090);
  assert.equal(direct.roots[0].localId,'desired-root');assert.equal(direct.roots[0].revision,7);
  const feed=new WorkbenchFeed(config,runtime),local=await feed.nodeSettings(nodeId);
  assert.deepEqual(local.settings,direct.settings);
  fail=true;const unavailable=await readWorkbenchMetadata(config,runtime);
  assert.equal(unavailable.projects.length,1);assert.equal(unavailable.settings?.revision,null);assert.match(unavailable.settings?.error??'',/admin temporarily unavailable/);
});
