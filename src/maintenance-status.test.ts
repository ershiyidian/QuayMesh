import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import Database from "better-sqlite3";
import { migrateDatabase } from "./db/migrations.js";
import { readMaintenanceStatus, unresolvedSubjects, recordExecutionQuiescence } from "./maintenance-status.js";
import { processOwner } from "./process-identity.js";

function fixture(t: TestContext) {
  const db=new Database(":memory:");t.after(()=>db.close());migrateDatabase(db);
  db.prepare("INSERT INTO console_projects(id,root,name,created_at) VALUES('project','/project','fixture','2026-10-12')").run();
  db.prepare("INSERT INTO console_work_items(id,project_id,item_key,title,created_at) VALUES('item','project','key','fixture','2026-10-12')").run();
  db.prepare(`INSERT INTO console_work_runs(id,project_id,item_id,run_key,request_hash,origin,created_at,status)
    VALUES('run','project','item','run-key','hash','{}','2026-10-12','reconciliation_required')`).run();
  const add=(id:string)=>db.prepare(`INSERT INTO console_operations(id,run_id,request_key,kind,label,status,evidence,created_at,finished_at)
    VALUES(?,'run',?,'command','fixture','reconciliation_required','[{"label":"preserved","outcome":"not_run","reference":"unknown effects"}]','2026-10-12','2026-10-13')`).run(id,id);
  add("legacy");
  const receipt={id:"physical-census-1",verifiedAt:new Date().toISOString(),evidence:{boundary:"test_physical_empty"}};
  return {db,add,receipt};
}

test("无owner历史保持physical_unknown，核验物理边界后仍保留所有未知结果与原始历史",t=>{
  const {db,receipt}=fixture(t),before=db.prepare("SELECT * FROM console_operations").all();
  const unresolved=readMaintenanceStatus(db);
  assert.equal(unresolved.quiescent,false);assert.equal(unresolved.physicalUnknown,1);
  assert.equal(unresolved.physicalUnknownWork[0].reason,"legacy_owner_unknown");
  recordExecutionQuiescence(db,unresolvedSubjects(db),receipt);
  const settled=readMaintenanceStatus(db);
  assert.equal(settled.quiescent,true);assert.equal(settled.idle,true);
  assert.equal(settled.reconciliationPending,true);assert.equal(settled.unresolvedOperations,1);
  assert.equal(settled.reconciledPhysicalBoundaries,1);
  assert.deepEqual(db.prepare("SELECT * FROM console_operations").all(),before);
  assert.equal(db.prepare("SELECT status FROM console_work_runs").pluck().get(),"reconciliation_required");
});

test("同样数量的历史行改变attempt或新增owner，不可复用物理收据",t=>{
  const {db,receipt}=fixture(t);
  recordExecutionQuiescence(db,unresolvedSubjects(db),receipt);
  db.prepare("UPDATE console_operations SET request_key='new-attempt' WHERE id='legacy'").run();
  assert.equal(readMaintenanceStatus(db).quiescent,false);
  recordExecutionQuiescence(db,unresolvedSubjects(db),{...receipt,id:"second-review"});
  db.prepare(`INSERT INTO execution_owners(domain,id,generation,owner_token,owner_pid,process_start,created_at)
    VALUES('operation','legacy','new-attempt',?,?,?,'2026-10-23')`).run(processOwner.token,processOwner.pid,processOwner.start);
  const status=readMaintenanceStatus(db);
  assert.equal(status.quiescent,false);assert.equal(status.physicalUnknownWork[0].reason,"unresolved_live_owner");
});

test("已核验历史不能掩盖活动claim、未分发队列和持久runtime work",t=>{
  const {db,receipt}=fixture(t);recordExecutionQuiescence(db,unresolvedSubjects(db),receipt);
  db.prepare(`INSERT INTO execution_claims(id,owner_id,owner_pid,kind,checkout_root,resources,acquired_at,access_mode)
    VALUES('claim','owner',?,'command','/project','[]','2026-10-23','write')`).run(process.pid);
  assert.equal(readMaintenanceStatus(db).quiescent,false);
  db.prepare("DELETE FROM execution_claims WHERE id='claim'").run();
  db.prepare(`INSERT INTO qm_runtime_work(id,owner_id,owner_pid,kind,blocking,started_at)
    VALUES('work','owner',?,'tool',1,'2026-10-23')`).run(process.pid);
  assert.equal(readMaintenanceStatus(db).activeWork,1);
  db.prepare("DELETE FROM qm_runtime_work WHERE id='work'").run();
  db.prepare(`INSERT INTO console_operations(id,run_id,request_key,kind,label,status,evidence,created_at)
    VALUES('queued','run','queued','command','queued','queued','[]','2026-10-23')`).run();
  assert.equal(readMaintenanceStatus(db).quiescent,false);
});

test("批量历史指纹变化时整个物理收据事务拒绝，readonly查询不修改历史或写收据",t=>{
  const {db,add,receipt}=fixture(t);add("other");const subjects=unresolvedSubjects(db);
  db.prepare("UPDATE console_operations SET evidence='[]' WHERE id='other'").run();
  assert.throws(()=>recordExecutionQuiescence(db,subjects,receipt),/changed after physical review/);
  assert.equal(db.prepare("SELECT count(*) FROM execution_quiescence").pluck().get(),0);
  const before=db.prepare("SELECT total_changes()").pluck().get();
  readMaintenanceStatus(db);readMaintenanceStatus(db);
  assert.equal(db.prepare("SELECT total_changes()").pluck().get(),before);
});

test("维护查询给出真实总量但最多展示20条未知历史，观察工作与阻塞工作分开",t=>{
  const {db,add}=fixture(t);
  for(let index=0;index<40;index++)add(`legacy-${index}`);
  db.prepare(`INSERT INTO qm_runtime_work(id,owner_id,owner_pid,kind,blocking,started_at)
    VALUES('observe','owner',?,'observe',0,'2026-10-23'),('tool','owner',?,'tool',1,'2026-10-23')`).run(process.pid,process.pid);
  const status=readMaintenanceStatus(db);
  assert.equal(status.unresolvedOperations,41);assert.equal(status.physicalUnknown,41);
  assert.equal(status.physicalUnknownWork.length,20);assert.equal(status.physicalUnknownWorkTruncated,true);
  assert.equal(status.allRuntimeWork,2);assert.equal(status.activeWork,1);assert.equal(status.nonBlockingWork,1);
  assert.equal(status.persistedRuntimeWork,2);
  assert.deepEqual(status.allWork,[{kind:"observe",count:1,blocking:0,nonBlocking:1},{kind:"tool",count:1,blocking:1,nonBlocking:0}]);
});

test("SQLite REPLACE及owner删除或替换均撤销旧物理证明，不能依赖递归DELETE触发器",t=>{
  const {db,receipt}=fixture(t);
  recordExecutionQuiescence(db,unresolvedSubjects(db),receipt);
  const row=db.prepare("SELECT * FROM console_operations WHERE id='legacy'").get() as Record<string,unknown>;
  const columns=Object.keys(row);
  db.prepare(`INSERT OR REPLACE INTO console_operations(${columns.join(",")}) VALUES(${columns.map(()=>"?").join(",")})`)
    .run(...columns.map(key=>row[key]));
  assert.equal(readMaintenanceStatus(db).physicalUnknown,1);
  db.prepare(`INSERT INTO execution_owners(domain,id,generation,owner_token,owner_pid,process_start,created_at)
    VALUES('operation','legacy','generation','token',?,'old-start','2026-10-23')`).run(process.pid);
  recordExecutionQuiescence(db,unresolvedSubjects(db),{...receipt,id:"owner-reviewed"});
  db.prepare("UPDATE execution_owners SET generation='next-generation' WHERE domain='operation' AND id='legacy'").run();
  assert.equal(readMaintenanceStatus(db).physicalUnknown,1);
  recordExecutionQuiescence(db,unresolvedSubjects(db),{...receipt,id:"updated-owner-reviewed"});
  db.prepare("DELETE FROM execution_owners WHERE domain='operation' AND id='legacy'").run();
  assert.equal(readMaintenanceStatus(db).physicalUnknown,1);
});
