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
import type {TaskStateIndexRead} from '../../src/console-workbench/local-queries.js';

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
  const before=await digest(),safeConfig=consoleReadConfig(config),readerPids=new Set<number>();
  const pool=new ConsoleReadProcessPool(undefined,5000,event=>{if(event.phase==='start'&&event.childPid)readerPids.add(event.childPid);});
  try{
    const operations=['metadata','task-index','session-titles','task-state-index'] as const;
    const started=performance.now();
    const coldWave=await Promise.all(operations.map(operation=>pool.read({operation,config:safeConfig})));
    const coldMs=Math.round(performance.now()-started);
    assert.equal(coldWave.length,4);
    const state=coldWave[3] as TaskStateIndexRead;
    assert.equal(state.projection,'state');assert.equal(state.phases[0]?.localId,run.id);
    assert.equal('tokens' in state.phases[0]!,false);assert.equal('changed' in state.phases[0]!,false);
    assert.ok(Array.isArray(state.sessions));assert.ok(Array.isArray(state.tasks));
    const warmStarted=performance.now();
    const warmWave=await Promise.all(operations.map(operation=>pool.read({operation,config:safeConfig})));
    assert.equal(warmWave.length,4);
    t.diagnostic(`compiled reader first four routes: cold ${coldMs} ms; reused ${Math.round(performance.now()-warmStarted)} ms`);
    await assert.rejects(pool.read({operation:'page',config:safeConfig,query:{cursor:'!bad!'}}),
      {code:'invalid_cursor',status:400,effect:'none'});
    await assert.rejects(pool.read({operation:'page',config:safeConfig,query:{root:join(directory,'outside')}}),
      {code:'project_scope',status:403,effect:'none'});
    const summaries=await pool.read<{items:Array<{localId:string}>}>({operation:'run-summaries',config:safeConfig,ids:[run.id]});
    assert.equal(summaries.items[0]?.localId,run.id);
    assert.equal(readerPids.size,1,'healthy and scoped business-error requests reuse the same owned reader');
    assert.equal(await digest(),before,'readonly queries must not migrate, reconcile or write the database');
  }finally{pool.close();await rm(directory,{recursive:true,force:true});}
});
