import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {memberRunActivity} from './member-run-activity.js';

const after='2026-11-01T00:00:30.000Z';
function fixture() {
  const db=new Database(':memory:');
  db.exec(`CREATE TABLE qm_run_links(run_id TEXT PRIMARY KEY,session_id TEXT,member_id TEXT);
    CREATE INDEX links_member ON qm_run_links(session_id,member_id);
    CREATE TABLE console_operations(id TEXT PRIMARY KEY,run_id TEXT,status TEXT,observed_at TEXT);
    CREATE INDEX ops_run ON console_operations(run_id,status,observed_at);
    CREATE TABLE console_executions(id TEXT PRIMARY KEY,run_id TEXT,status TEXT,observed_at TEXT);
    CREATE INDEX executions_run ON console_executions(run_id,status,observed_at);`);
  const link=db.prepare('INSERT INTO qm_run_links VALUES(?,?,?)');
  db.exec('BEGIN');
  for(let i=0;i<4000;i++)link.run(`history_${i}`,'session','member');
  link.run('other_member','session','other');link.run('other_session','other','member');
  db.exec('COMMIT');
  return db;
}
function previous(db:Database.Database,sessionId:string,memberId:string) {
  const runs=db.prepare('SELECT run_id FROM qm_run_links WHERE session_id=? AND member_id=? ORDER BY rowid DESC')
    .all(sessionId,memberId) as {run_id:string}[];
  if(!runs.length)return null;
  return {runId:runs[0]!.run_id,confirmed:runs.some(run=>Boolean(db.prepare(`SELECT 1 FROM console_operations
    WHERE run_id=? AND status IN ('starting','queued','running') AND observed_at>=?
    UNION ALL SELECT 1 FROM console_executions WHERE run_id=? AND status IN ('starting','queued','running') AND observed_at>=? LIMIT 1`)
    .get(run.run_id,after,run.run_id,after)))};
}

test('one scalar query preserves older active phases and latest-phase order across long member histories',()=>{
  const db=fixture();let prepares=0;
  const counted=new Proxy(db,{get(target,key){
    if(key==='prepare')return (sql:string)=>{prepares++;return target.prepare(sql);};
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
  try {
    db.prepare('INSERT INTO console_operations VALUES(?,?,?,?)').run('training','history_3','running',after);
    assert.deepEqual(memberRunActivity(counted,'session','member',after),previous(db,'session','member'));
    assert.equal(prepares,1,'do not enumerate run IDs or issue one query per historical phase');
    assert.deepEqual(memberRunActivity(db,'session','member',after),{runId:'history_3999',confirmed:true});
    assert.equal(memberRunActivity(db,'missing','member',after),null);
  }finally{db.close();}
});

test('freshness boundaries, terminal/unknown work and unrelated members retain the previous meanings',()=>{
  const db=fixture();
  try {
    const op=db.prepare('INSERT INTO console_operations VALUES(?,?,?,?)');
    op.run('foreign1','other_member','running',after);op.run('foreign2','other_session','running',after);
    op.run('stale','history_2','running','2026-11-01T00:00:29.999Z');
    op.run('done','history_4','completed',after);op.run('unknown','history_5','reconciliation_required',after);
    assert.deepEqual(memberRunActivity(db,'session','member',after),{runId:'history_3999',confirmed:false});
    db.prepare('INSERT INTO console_executions VALUES(?,?,?,?)').run('agent','history_1','queued',after);
    assert.deepEqual(memberRunActivity(db,'session','member',after),previous(db,'session','member'));
    assert.equal(memberRunActivity(db,'session','member',after)?.confirmed,true);
    db.prepare('UPDATE console_executions SET status=?').run('cancelled');
    assert.equal(memberRunActivity(db,'session','member',after)?.confirmed,false);
  }finally{db.close();}
});
