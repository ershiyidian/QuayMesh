import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {databasePath,openReadonlySqlite} from './readonly.js';

test('raw readonly SQLite enforces the same connection policy without migrating existing data',t=>{
  const directory=mkdtempSync(join(tmpdir(),'qm-raw-readonly-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const writer=new Database(databasePath(directory));
  writer.exec('CREATE TABLE saved(value TEXT); INSERT INTO saved VALUES(\'original\')');writer.close();
  const reader=openReadonlySqlite(directory);
  try{
    assert.equal(reader.readonly,true);
    assert.equal(reader.pragma('query_only',{simple:true}),1);
    assert.equal(reader.pragma('foreign_keys',{simple:true}),1);
    assert.equal(reader.pragma('busy_timeout',{simple:true}),1000);
    assert.deepEqual(reader.prepare('SELECT value FROM saved').all(),[{value:'original'}]);
    assert.throws(()=>reader.exec("UPDATE saved SET value='changed'"),/readonly/i);
    assert.throws(()=>reader.exec('CREATE TABLE unexpected(value)'),/readonly/i);
    assert.deepEqual(reader.prepare("SELECT name FROM sqlite_master WHERE type='table'").all(),[{name:'saved'}]);
  }finally{reader.close();}
  assert.equal(reader.open,false);
});

test('a missing readonly database fails without creating its directory or schema',t=>{
  const directory=mkdtempSync(join(tmpdir(),'qm-missing-readonly-')),missing=join(directory,'absent','state');
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  assert.throws(()=>openReadonlySqlite(missing));
  assert.equal(existsSync(join(directory,'absent')),false);
});
