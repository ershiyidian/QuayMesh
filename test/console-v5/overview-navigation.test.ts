import assert from 'node:assert/strict';
import test from 'node:test';
import {consoleExperienceFixture} from './experience-fixture.js';
import {openDatabase} from '../../src/db/client.js';
import {SessionStore} from '../../src/session/store.js';

test('overview group pagination keeps navigation counts aligned with the scope links', {timeout:30_000}, async()=>{
  const fixture=await consoleExperienceFixture();
  try {
    // A real open Task without an execution phase exercises the older group.
    const database=openDatabase(fixture.server.config.stateDir);
    let olderTaskId:string;
    try {
      const older=new SessionStore(database.sqlite).createTask(fixture.waiting.session_id,'较早的开放请求','overview-navigation-older');
      olderTaskId=older.id;
      const earlier=new Date(Date.now()-2*86_400_000).toISOString();
      database.sqlite.prepare('UPDATE qm_tasks SET created_at=?,last_activity_at=? WHERE id=?').run(earlier,earlier,olderTaskId);
    } finally {database.close();}
    const all=await fixture.get('runs?days=0');
    const overview=await fixture.get('overview?tz=UTC');
    const open=all.items.filter((task:{requestState:string})=>task.requestState==='active').length;
    const closed=all.items.filter((task:{requestState:string})=>task.requestState==='closed').length;
    assert.equal(overview.currentCount,1);
    assert.equal(overview.olderOpenCount,1);
    for(const group of ['current','olderOpen'] as const){
      const page=await fixture.get('runs?days=0&tz=UTC&overviewGroup='+group);
      assert.equal(page.total,group==='current'?overview.currentCount:overview.olderOpenCount);
      assert.deepEqual(page.items.map((task:{taskId:string})=>task.taskId),
        [group==='current'?fixture.waiting.task_id:olderTaskId]);
      assert.equal(page.counts.scopeAll,all.total,'scope links clear the overview group');
      assert.equal(page.counts.scopeOpen,open);
      assert.equal(page.counts.scopeClosed,closed);
    }
    const completed=all.items.find((task:{taskId:string})=>task.taskId===fixture.completed.task_id);
    assert.ok(completed?.finishedAt);
    const finishedDay=new Date(completed.finishedAt).toISOString().slice(0,10);
    const results=await fixture.get('runs?days=0&tz=UTC&requestState=closed&resultStatus=completed&finishedDay='+finishedDay);
    assert.equal(results.total,1,'resultStatus must exclude the closed Task with no confirmed result');
    assert.deepEqual(results.items.map((task:{taskId:string})=>task.taskId),[fixture.completed.task_id]);
    assert.equal((await fixture.get('runs?days=0&requestState=closed&resultStatus=failed')).total,0);
    for(const invalid of ['overviewGroup=not-a-group','resultStatus=not-a-result']){
      const response=await fetch(fixture.server.baseUrl+'/console/api/v4/runs?days=0&'+invalid,{headers:{cookie:fixture.cookie}});
      assert.equal(response.status,422,'invalid enum values must not silently become an unfiltered query');
      const body=await response.json() as {code:string;effect:string};
      assert.equal(body.code,'invalid_input');
      assert.equal(body.effect,'none');
    }
  } finally {await fixture.server.dispose();}
});
