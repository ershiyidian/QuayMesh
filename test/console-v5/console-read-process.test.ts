import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
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
import {createInterface} from 'node:readline';
import {setTimeout as delay} from 'node:timers/promises';
for await(const line of createInterface({input:process.stdin,crlfDelay:Infinity})) {
const {id,request:input}=JSON.parse(line);
if(input.mode==='native'){
  const db=new DatabaseSync(input.database,{readOnly:true});
  writeFileSync(input.marker,String(process.pid));
  db.prepare('WITH RECURSIVE count(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM count WHERE x<10000000000) SELECT sum(x) FROM count').get();
}else if(input.mode==='large'){
  process.stdout.write('x'.repeat(input.bytes));
}else if(input.mode==='identity'){
  process.stdout.write(JSON.stringify({id,ok:true,value:{pid:process.pid}})+'\n');
}else if(input.mode==='business'){
  process.stdout.write(JSON.stringify({id,ok:false,code:'invalid_cursor'})+'\n');
}else if(input.mode==='extra'){
  process.stdout.write(JSON.stringify({id,ok:true,value:'unexpected'})+'\n'+JSON.stringify({id,ok:true,value:'extra'})+'\n');
}else if(input.mode==='late'){
  process.stdout.write(JSON.stringify({id,ok:true,value:'first'})+'\n');
  setTimeout(()=>process.stdout.write(JSON.stringify({id,ok:true,value:'late-first'})+'\n'),20);
}else if(input.mode==='held'){
  await delay(100);process.stdout.write(JSON.stringify({id,ok:true,value:'second'})+'\n');
}else{
  process.stdout.write(JSON.stringify({id,ok:true,value:{normal:'preserved',secretInherited:['QUAYMESH_LOCAL_API_CREDENTIAL','MODEL_API_TOKEN','NODE_OPTIONS'].some(key=>key in process.env)}})+'\n');
}
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

test('healthy reads reuse one process; active cancellation replaces only that reader before continuing',async()=>{
  const files=await setup(),pool=new ConsoleReadProcessPool(files.worker,3000,()=>{});
  try{
    const first=await pool.read<{pid:number}>({mode:'identity'});
    await assert.rejects(pool.read({mode:'business'}),{code:'invalid_cursor',status:400,effect:'none'});
    assert.equal((await pool.read<{pid:number}>({mode:'identity'})).pid,first.pid);
    const controller=new AbortController();
    const reading=pool.read({mode:'native',database:files.database,marker:files.marker},controller.signal);
    const rejected=assert.rejects(reading,{code:'console_read_aborted'});
    for(let n=0;n<100;n++){
      try{await readFile(files.marker);break;}catch{await delay(10);}
    }
    assert.equal(Number(await readFile(files.marker,'utf8')),first.pid);
    const after=pool.read<{pid:number}>({mode:'identity'});
    controller.abort();await rejected;
    const replacement=await after;
    assert.notEqual(replacement.pid,first.pid);
    assert.equal(alive(first.pid),false,'capacity is reused only after the cancelled child closes');
  }finally{pool.close();await delay(50);await rm(files.directory,{recursive:true,force:true});}
});

for(const release of ['response','close'] as const)test(`an expired queued read never starts after an owned reader ${release}`,async()=>{
  const files=await setup(),events:ConsoleReadDiagnostic[]=[],budget=500;
  let blockFinish:string|undefined;
  const pool=new ConsoleReadProcessPool(files.worker,budget,event=>{
    events.push(event);
    if(event.phase==='finish'&&event.route===blockFinish){
      blockFinish=undefined;
      // Hold this real response/close callback past the queued request's total
      // budget, before the event loop can dispatch that request's timer. The
      // next drain must check elapsed time itself, without starting more work.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,budget+25);
    }
  });
  try{
    const first=await pool.read<{pid:number}>({mode:'identity'});
    const controller=new AbortController();
    const active=release==='response'
      ?pool.read({operation:'metadata',mode:'identity'})
      :pool.read({operation:'page',mode:'native',database:files.database,marker:files.marker},controller.signal);
    const activeSettled=release==='response'?active:assert.rejects(active,{code:'console_read_aborted'});
    if(release==='close'){
      for(let n=0;n<100&&!existsSync(files.marker);n++)await delay(5);
      assert.equal(Number(await readFile(files.marker,'utf8')),first.pid);
    }
    const expired=assert.rejects(pool.read({operation:'task-state-index',mode:'identity'}),{code:'console_read_timeout'});
    blockFinish=release==='response'?'metadata':'page';
    if(release==='close')controller.abort();
    await Promise.all([activeSettled,expired]);
    assert.equal(events.filter(event=>event.route==='task-state-index'&&event.phase==='start').length,0,
      'expired work must neither be sent to the warm reader nor spawn a replacement');
    const completion=events.filter(event=>event.route==='task-state-index'&&event.phase==='finish');
    assert.equal(completion.length,1);assert.equal(completion[0].childPid,null);
    const next=await pool.read<{pid:number}>({mode:'identity'});
    if(release==='response')assert.equal(next.pid,first.pid,'queue expiration must preserve the healthy warm reader');
    else{
      assert.equal(alive(first.pid),false,'the cancelled native reader must close before capacity is reused');
      assert.notEqual(next.pid,first.pid);
    }
  }finally{pool.close();await delay(50);await rm(files.directory,{recursive:true,force:true});}
});

test('an unsolicited second frame cannot resolve the next queued read',async()=>{
  const files=await setup(),pool=new ConsoleReadProcessPool(files.worker,3000,()=>{});
  try{
    const bad=assert.rejects(pool.read({mode:'extra'}),{code:'console_read_failed'});
    const next=pool.read<{pid:number}>({mode:'identity'});
    await bad;assert.equal(typeof(await next).pid,'number');
  }finally{pool.close();await delay(50);await rm(files.directory,{recursive:true,force:true});}
});

test('a late old response in a separate chunk cannot resolve the next request',async()=>{
  const files=await setup(),pool=new ConsoleReadProcessPool(files.worker,3000,()=>{});
  try{
    const first=pool.read({mode:'late'});
    const rejected=assert.rejects(pool.read({mode:'held'}),{code:'console_read_failed'});
    assert.equal(await first,'first');await rejected;
    assert.equal(typeof(await pool.read<{pid:number}>({mode:'identity'})).pid,'number');
  }finally{pool.close();await delay(50);await rm(files.directory,{recursive:true,force:true});}
});

test('an idle warm reader does not keep its owner alive after all requested work finishes',async()=>{
  const compiledReader=new URL('../../dist/console-workbench/read-process.js',import.meta.url);
  assert.ok(existsSync(compiledReader),'Build tsconfig.build.json before testing the raw Node owner lifecycle');
  const files=await setup();
  const script=join(files.directory,'owner.mjs');
  await writeFile(script,`import {ConsoleReadProcessPool} from ${JSON.stringify(compiledReader.href)};
const pool=new ConsoleReadProcessPool(new URL(${JSON.stringify(files.worker.href)}),3000,()=>{});
process.once('exit',()=>pool.close());process.once('SIGTERM',()=>{pool.close();process.exit(1);});
await pool.read({mode:'identity'});`);
  const owner=spawn(process.execPath,[script],{stdio:['ignore','ignore','pipe']});
  let stderr=Buffer.alloc(0);
  owner.stderr!.on('data',(chunk:Buffer|string)=>{
    stderr=Buffer.concat([stderr,Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk)]).subarray(-16*1024);
  });
  let timedOut=false;
  const timeout=setTimeout(()=>{timedOut=true;owner.kill('SIGTERM');},3000);
  try{
    const code=await new Promise<number|null>((resolve,reject)=>{owner.once('error',reject);owner.once('close',resolve);});
    assert.equal(timedOut,false,'idle stdio handles must not keep the owner running');
    assert.equal(code,0,`raw Node owner stderr (last 16 KiB): ${stderr.toString('utf8')}`);
  }finally{clearTimeout(timeout);if(owner.exitCode===null)owner.kill('SIGTERM');await rm(files.directory,{recursive:true,force:true});}
});
