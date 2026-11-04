import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {readIsolatedRunDetail,readIsolatedArtifact,observeCachedLocalDetail} from '../../src/console-workbench/read-detail.js';
import {closeConsoleReaders,readLocalProjectSessions} from '../../src/console-workbench/isolated-queries.js';
import {readonlyDetailFixture} from './readonly-detail-fixture.js';

after(()=>closeConsoleReaders());

test('compiled detail worker uses the live capture fence, keeps SQL readonly and rechecks scope on a reused reader',async()=>{
  const f=await readonlyDetailFixture();
  try{
    const source={changes:f.changes},version=f.ledger.db.pragma('data_version',{simple:true});
    const first=await readIsolatedRunDetail(f.config,f.run.id,source);
    assert.equal(first.complete,true);
    assert.equal(first.instructions[0]?.path,'TASK-INSTRUCTIONS.md');
    assert.equal(f.store.taskData.projection(f.task.id,f.member.id),null);
    assert.equal(f.ledger.db.pragma('data_version',{simple:true}),version);
    const projectId=f.ledger.run(f.run.id).project_id;
    const sessions=await readLocalProjectSessions(f.config,projectId);
    assert.equal(sessions.conversations.find(value=>value.id===f.session.id)?.tasks.find(value=>value.taskId===f.task.id)?.hasRun,true);
    assert.deepEqual(sessions.executionClaims,[]);
    assert.equal(f.ledger.db.pragma('data_version',{simple:true}),version);
    await assert.rejects(readLocalProjectSessions({...f.config,allowedRoots:[]},projectId),{code:'project_scope',status:403});
    await assert.rejects(readIsolatedRunDetail({...f.config,allowedRoots:[]},f.run.id,source),{code:'project_scope',status:403});
    const patch=await readIsolatedArtifact(f.config,{kind:'patch',runId:f.run.id,expectedTaskId:f.task.id},source);
    assert.equal(patch.patch,'');assert.equal(patch.complete,true);
    await assert.rejects(readIsolatedArtifact(f.config,{kind:'patch',runId:f.run.id,expectedTaskId:'another-task'},source),
      {code:'task_scope',status:403});
    await assert.rejects(readIsolatedArtifact(f.config,{kind:'patch',runId:f.run.id,expectedSessionId:f.session.id},source),
      {code:'task_scope',status:403});
    const reading=readIsolatedRunDetail(f.config,f.run.id,source);
    f.changes.markDirty(f.member.id,[],f.task.id);
    const cachedPending=observeCachedLocalDetail(first,source);
    assert.equal(cachedPending.changed,true);
    assert.equal(cachedPending.value.changeCaptures[0]?.state,'pending');
    assert.equal(cachedPending.value.complete,false);
    assert.equal(cachedPending.value.run.actions.complete,false);
    const changed=await reading;
    assert.equal(changed.complete,false);
    assert.equal(changed.missingPhases[0]?.pending,true);
    assert.equal(changed.run.actions.complete,false);
    await f.changes.flush();
    const cachedIdle=observeCachedLocalDetail(first,source);
    assert.equal(cachedIdle.changed,true);
    assert.equal(cachedIdle.value.changeCaptures[0]?.state,'idle');
    assert.equal(cachedIdle.value.complete,false,'current idle cannot authorize file evidence read before the capture');
    assert.equal(cachedIdle.value.run.actions.complete,false);
    assert.equal((await readIsolatedRunDetail(f.config,f.run.id,source)).complete,true);
  }finally{await f.close();}
});
