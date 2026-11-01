import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';
import {ConsoleReadProcessPool,CONSOLE_READ_RESULT_BYTES,type ConsoleReadDiagnostic} from '../../src/console-workbench/read-process.js';

const fixture = String.raw`
import {DatabaseSync} from 'node:sqlite';
import {writeFileSync} from 'node:fs';
let text='';for await(const chunk of process.stdin)text+=chunk;
const input=JSON.parse(text);
if(input.mode==='native'){
  const db=new DatabaseSync(input.database,{readOnly:true});
  writeFileSync(input.marker,String(process.pid));
  db.prepare('WITH RECURSIVE count(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM count WHERE x<10000000000) SELECT sum(x) FROM count').get();
}else if(input.mode==='large'){
  process.stdout.write('x'.repeat(input.bytes));
}else{
  process.stdout.write(JSON.stringify({ok:true,value:{normal:'preserved',secretInherited:['QUAYMESH_LOCAL_API_CREDENTIAL','MODEL_API_TOKEN','NODE_OPTIONS'].some(key=>key in process.env)}}));
}
`;
async function setup() {
  const directory=await mkdtemp(join(tmpdir(),'quaymesh-console-reader-'));
  const worker=join(directory,'reader.mjs');await writeFile(worker,fixture);
  const database=join(directory,'read.sqlite');const db=new DatabaseSync(database);db.exec('CREATE TABLE sample(value INTEGER)');db.close();
  return {directory,database,worker:pathToFileURL(worker),marker:join(directory,'reader.pid')};
}
const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}};

test('native SQLite read is killed at its deadline while parent heartbeat and unrelated process survive',async()=>{
  const events:ConsoleReadDiagnostic[]=[];
  const files=await setup(),pool=new ConsoleReadProcessPool(files.worker,500,event=>events.push(event));
  const unrelated=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
  let ticks=0;const heartbeat=setInterval(()=>ticks++,5);
  try{
    await assert.rejects(pool.read({mode:'native',database:files.database,marker:files.marker}),{code:'console_read_timeout'});
    const reader=Number(await readFile(files.marker,'utf8'));
    for(let n=0;n<30&&alive(reader);n++)await delay(10);
    assert.equal(alive(reader),false,'the actual native read process must exit');
    assert.ok(ticks>=10,'parent event loop must remain responsive');
    assert.ok(unrelated.pid&&alive(unrelated.pid),'a different process must not be terminated');
    assert.equal(unrelated.exitCode,null);
    assert.ok(events.some(event=>event.phase==='start'));
    assert.ok(events.some(event=>event.phase==='timeout'));
    assert.ok(events.some(event=>event.phase==='finish'));
    assert.ok(events.every(event=>event.route==='unknown'));
    assert.ok(!JSON.stringify(events).includes(files.directory),'diagnostics must not include request paths');
  }finally{clearInterval(heartbeat);pool.close();unrelated.kill('SIGKILL');await rm(files.directory,{recursive:true,force:true});}
});

test('queue is bounded; an aborted queued read never starts and close cancels only own readers',async()=>{
  const files=await setup(),pool=new ConsoleReadProcessPool(files.worker,5000);
  const controller=new AbortController();
  try{
    const jobs=[pool.read({mode:'native',database:files.database,marker:files.marker}).catch(error=>error.code)];
    jobs.push(pool.read({mode:'normal'},controller.signal).catch(error=>error.code));
    for(let n=0;n<7;n++)jobs.push(pool.read({mode:'normal'}).catch(error=>error.code));
    await assert.rejects(pool.read({mode:'normal'}),{code:'console_read_busy'});
    controller.abort();assert.equal(await jobs[1],'console_read_aborted');
    pool.close();
    assert.deepEqual(await Promise.all(jobs),Array(9).fill('console_read_aborted'));
  }finally{pool.close();await delay(50);await rm(files.directory,{recursive:true,force:true});}
});

test('reader inherits no credential or NODE_OPTIONS and oversized output is terminated',async()=>{
  const files=await setup(),pool=new ConsoleReadProcessPool(files.worker,3000);
  const keys=['QUAYMESH_LOCAL_API_CREDENTIAL','MODEL_API_TOKEN','NODE_OPTIONS'];
  const saved=keys.map(key=>process.env[key]);
  try{
    process.env.QUAYMESH_LOCAL_API_CREDENTIAL='synthetic-do-not-inherit';process.env.MODEL_API_TOKEN='synthetic-do-not-inherit';
    process.env.NODE_OPTIONS='--require /must-not-be-loaded';
    assert.deepEqual(await pool.read({mode:'normal'}),{normal:'preserved',secretInherited:false});
    await assert.rejects(pool.read({mode:'large',bytes:CONSOLE_READ_RESULT_BYTES+1}),{code:'console_read_too_large'});
  }finally{
    keys.forEach((key,index)=>{if(saved[index]===undefined)delete process.env[key];else process.env[key]=saved[index];});
    pool.close();await delay(50);await rm(files.directory,{recursive:true,force:true});
  }
});
