import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import type {ServerConfig} from '../../src/config.js';
import {WorkLedger} from '../../src/work-ledger.js';
import {databasePath} from '../../src/db/client.js';
import {ConsoleReadProcessPool} from '../../src/console-workbench/read-process.js';
import {consoleReadConfig} from '../../src/console-workbench/read-protocol.js';
import {readSummaryDetail,detailTemporarilyUnavailable,PARTIAL_DETAIL_MESSAGE} from '../../src/console-workbench/read-summary-detail.js';

test('compiled readonly worker preserves scoped business errors, reads real summaries, and leaves the database unchanged',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'quaymesh-read-worker-'));
  const stateDir=join(directory,'state'),configDir=join(directory,'config'),root=join(directory,'workspace');
  await mkdir(configDir);await mkdir(root);
  const config={stateDir,configDir,allowedRoots:[root]} as ServerConfig;
  const ledger=new WorkLedger(stateDir);
  const run=ledger.begin({root,workspaceId:'reader-test',workItemId:'read-isolation',runKey:'once',title:'Readonly worker fixture',
    origin:{entryPoint:'qm_cli',evidence:'server_entry'}});
  ledger.close();
  const digest=async()=>createHash('sha256').update(await readFile(databasePath(stateDir))).digest('hex');
  const before=await digest(),safeConfig=consoleReadConfig(config),pool=new ConsoleReadProcessPool(undefined,5000,()=>{});
  try{
    await assert.rejects(pool.read({operation:'page',config:safeConfig,query:{cursor:'!bad!'}}),
      {code:'invalid_cursor',status:400,effect:'none'});
    await assert.rejects(pool.read({operation:'page',config:safeConfig,query:{root:join(directory,'outside')}}),
      {code:'project_scope',status:403,effect:'none'});
    const started=performance.now();
    const firstWave=await Promise.all(['metadata','task-index','session-titles'].map(operation=>pool.read({operation,config:safeConfig})));
    assert.equal(firstWave.length,3);
    t.diagnostic(`compiled reader first three routes: ${Math.round(performance.now()-started)} ms`);
    const partial=await readSummaryDetail(config,run.id);
    assert.equal(partial.run.localId,run.id);
    assert.equal(partial.complete,false);
    assert.equal(partial.missingPhases.length,1);
    assert.match(partial.summary,new RegExp(PARTIAL_DETAIL_MESSAGE));
    assert.deepEqual([partial.run.actions.review,partial.run.actions.complete,partial.run.actions.revert,partial.run.actions.patch],
      [false,false,false,false]);
    assert.deepEqual(partial.files,[]);
    assert.throws(()=>detailTemporarilyUnavailable(),{code:'console_detail_temporarily_unavailable',status:503,effect:'none'});
    assert.equal(await digest(),before,'readonly queries must not migrate, reconcile or write the database');
  }finally{pool.close();await rm(directory,{recursive:true,force:true});}
});
