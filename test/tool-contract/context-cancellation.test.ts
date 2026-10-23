import assert from "node:assert/strict";
import test from "node:test";
import {databasePath,openDatabase} from "../../src/db/client.js";
import {holdSqliteWriteLock} from "../../src/test-support/sqlite-lock.js";
import {fixture,until} from "./fixture.js";

test("真实 MCP 上下文入口在写锁期间按观察期限返回，取消后不再保存结果",{timeout:15000},async t=>{
  const f=await fixture(t,{git:false}),db=openDatabase(f.config.stateDir);
  t.after(()=>db.close());
  const command=await f.execute("console.log('saved-before-observation-lock');",{yield_time_ms:2000});
  await until(async()=>(await f.call("read_output",{...f.scope,operation_id:command.operation_id})).process_done===true);
  await f.call("workspace_context",{...f.scope,action:"capture",files:[{path:"README.md"}]});
  const count=()=>db.sqlite.prepare("SELECT COUNT(*) FROM qm_context_results").pluck().get() as number;
  const before=count(),lock=await holdSqliteWriteLock(databasePath(f.config.stateDir),2000);
  let released=false;
  void lock.done.then(()=>{released=true;});
  try {
    const outputStarted=performance.now();
    const output=await f.client.callTool({name:"read_output",arguments:{...f.scope,operation_id:command.operation_id},
      _meta:{...f.meta,"quaymesh/deadline_at":Date.now()+400}});
    assert.notEqual(output.isError,true,JSON.stringify(output));
    assert.match(String(output.structuredContent?.result),/saved-before-observation-lock/);
    assert.ok(performance.now()-outputStarted<1000);assert.equal(released,false);
    for(const arguments_ of [
      {...f.scope,action:"capture",files:[{path:"README.md"}]},
      {...f.scope,action:"list",depth:1},
    ]) {
      const started=performance.now();
      const response=await f.client.callTool({name:"workspace_context",arguments:arguments_,
        _meta:{...f.meta,"quaymesh/deadline_at":Date.now()+400}});
      assert.equal(response.isError,true,JSON.stringify(response));
      assert.match(JSON.stringify(response),/TOOL_REQUEST_EXPIRED/);
      assert.ok(performance.now()-started<1000,"HTTP 观察不能被同步 touchSession 卡住");
      assert.equal(released,false);assert.equal(count(),before);
    }
  } finally {await lock.release();}
  await until(()=>Number(db.sqlite.prepare("SELECT COUNT(*) FROM qm_runtime_work WHERE kind='resource'").pluck().get())===0);
  assert.equal(count(),before,"观察已取消，延后获取的临时资源不能再保存内容");
  const next=await f.call("workspace_context",{...f.scope,action:"capture",files:[{path:"README.md"}]});
  assert.ok(next.result_ref);assert.equal(count(),before+1);
});
