import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {fileURLToPath,pathToFileURL} from 'node:url';
import type {ServerConfig} from '../../src/config.js';
import {WorkLedger} from '../../src/work-ledger.js';
import {SessionStore} from '../../src/session/store.js';
import {databasePath} from '../../src/db/client.js';
import {ConsoleReadProcessPool} from '../../src/console-workbench/read-process.js';
import {consoleReadConfig} from '../../src/console-workbench/read-protocol.js';
import {readLocalTaskStateIndex,type TaskStateIndexRead} from '../../src/console-workbench/local-queries.js';

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

test('a fresh compiled state read loads only SQL reader dependencies, then keeps later full reads readonly',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'quaymesh-state-imports-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const stateDir=join(directory,'state'),root=join(directory,'workspace'),hidden=join(directory,'hidden');
  await mkdir(root);await mkdir(hidden);
  const config={stateDir,configDir:directory,allowedRoots:[root]} as ServerConfig;
  const ledger=new WorkLedger(stateDir),store=new SessionStore(ledger.db),at=Date.now();
  for(const [key,workspace] of [['visible',root],['hidden',hidden]]){
    const session=store.createSession('owner',key!,'Saved '+key);
    const member=store.addMember(session.id,'local','workspace-'+key,workspace!,'checkout',null);
    const task=store.createTask(session.id,'Task '+key);store.touchTaskMember(task.id,member.id);
    const run=ledger.begin({root:workspace!,workItemId:task.id,runKey:key!,title:'Saved phase',origin:{entryPoint:'console',evidence:'server_entry'}});
    store.linkRun(session.id,member.id,run.id,task.id);
  }
  ledger.close();
  const expected=readLocalTaskStateIndex(config,at);
  assert.equal(expected.tasks.length,1);assert.equal(expected.phases.length,1);
  const digest=async()=>createHash('sha256').update(await readFile(databasePath(stateDir))).digest('hex');
  const before=await digest(),hook=join(directory,'loaded-modules.mjs'),report=join(directory,'loaded-modules.json');
  const packageUrl=new URL('../../package.json',import.meta.url).href;
  // Observe actual imports and native readonly handles in a fresh process.
  // The hook changes no query/results and is used only by this local regression.
  await writeFile(hook,`import {registerHooks,createRequire} from 'node:module';
import {writeFileSync} from 'node:fs';
const modules=new Set(),frames=[],connections=[];
registerHooks({load(url,context,next){modules.add(url);return next(url,context);}});
const Database=createRequire(${JSON.stringify(packageUrl)})('better-sqlite3');
const prepare=Database.prototype.prepare;
Database.prototype.prepare=function(...args){connections.push(this.readonly);return prepare.apply(this,args);};
const write=process.stdout.write;
process.stdout.write=function(...args){
  const value=JSON.parse(String(args[0]));
  frames.push({id:value.id,modules:[...modules],connections:[...connections]});
  return write.apply(this,args);
};
process.once('exit',()=>writeFileSync(${JSON.stringify(report)},JSON.stringify(frames)));
`);
  const child=spawn(process.execPath,['--max-old-space-size=192','--import',pathToFileURL(hook).href,
    fileURLToPath(new URL('../../dist/console-workbench/read-worker.js',import.meta.url))],{stdio:['pipe','pipe','pipe']});
  const closed=once(child,'close');let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});
  const lines=createInterface({input:child.stdout});
  const read=async(id:number,operation:string)=>{
    const line=once(lines,'line',{signal:AbortSignal.timeout(5000)});
    child.stdin.write(JSON.stringify({id,request:{operation,config:consoleReadConfig(config),at}})+'\n');
    const value=JSON.parse(String((await line)[0]));assert.equal(value.ok,true);return value.value;
  };
  try{
    const cold=await read(1,'task-state-index'),warm=await read(2,'task-state-index');
    const normalized=({observedAt:_at,...value}:TaskStateIndexRead)=>value;
    assert.deepEqual(normalized(cold),normalized(expected));assert.deepEqual(normalized(warm),normalized(expected));
    const full=await read(3,'task-index');assert.equal(full.items.length,1);assert.equal(full.items[0].localId,expected.phases[0]!.localId);
    child.stdin.end();const [code,signal]=await closed;assert.equal(code,0,stderr);assert.equal(signal,null);assert.equal(stderr,'');
    const frames=JSON.parse(await readFile(report,'utf8')) as Array<{id:number;modules:string[];connections:boolean[]}>;
    assert.deepEqual(frames.map(frame=>frame.id),[1,2,3]);
    for(const frame of frames.slice(0,2)){
      assert.ok(frame.modules.some(url=>url.endsWith('/local-state-queries.js')));
      assert.ok(frame.modules.every(url=>!/(?:\/drizzle-orm(?:@|\/)|\/db\/(?:client|schema|migrations|wal-checkpoint)\.js|\/(?:work-ledger|execution-coordinator|local-queries|local|usage-query)\.js|\/koffi(?:@|\/))/.test(url)),
        'state reads must not load unrelated ORM, writers, recovery or full projections');
    }
    assert.ok(frames[2]!.modules.some(url=>url.endsWith('/local-queries.js')),'later full reads retain their original implementation');
    assert.ok(frames.every(frame=>frame.connections.length>0&&frame.connections.every(Boolean)),
      'the process-wide readonly mode must also cover modules loaded after a lightweight read');
    assert.equal(await digest(),before);
  }finally{
    lines.close();if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await closed;
  }
});
