import assert from 'node:assert/strict';
import test from 'node:test';
import {execFile} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';

const execute=promisify(execFile);

test('native SQLite survives repeated close and GC for writable and read-only connections',{timeout:60000},async t=>{
  const directory=await mkdtemp(join(tmpdir(),'quaymesh-sqlite-gc-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const program=`import Database from 'better-sqlite3';
    import assert from 'node:assert/strict';
    const path=process.argv[1];let initial=new Database(path);
    initial.exec('CREATE TABLE records(value INTEGER);INSERT INTO records VALUES(42)');initial.close();initial=null;
    for(let i=0;i<500;i++){
      let db=i%2?new Database(path,{readonly:true,fileMustExist:true}):new Database(':memory:');
      if(i%2)assert.equal(db.prepare('SELECT value FROM records').get().value,42);
      else {db.exec('CREATE TABLE records(value INTEGER);INSERT INTO records VALUES(42)');assert.equal(db.prepare('SELECT value FROM records').get().value,42);}
      db.close();db=null;global.gc();
    }
    process.stdout.write(JSON.stringify({cycles:500,result:'pass'}));`;
  const {stdout}=await execute(process.execPath,['--expose-gc','--input-type=module','-e',program,join(directory,'snapshot.sqlite')],{timeout:50000});
  assert.deepEqual(JSON.parse(stdout),{cycles:500,result:'pass'});
});
