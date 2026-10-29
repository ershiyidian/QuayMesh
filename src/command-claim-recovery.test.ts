import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { migrateDatabase } from "./db/migrations.js";
import { processOwner, processOwnerAlive, processStartIdentity } from "./process-identity.js";
import { readMaintenanceStatus, recordExecutionQuiescence, reviewableCommandClaims,
  releaseReviewedCommandClaims, unresolvedSubjects, type ReviewedCommandClaim, type QuiescenceSubject } from "./maintenance-status.js";

async function fixture(t: TestContext) {
  // Save an actual process generation, then wait for its real exit. A dead
  // owner only makes a claim reviewable; it never supplies a physical receipt.
  const child=spawn(process.execPath,["-e",`process.send('ready');process.on('message',()=>process.exit(0));`],
    {stdio:["ignore","ignore","ignore","ipc"]});
  const ended=once(child,"exit");
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill();await ended;}});
  await once(child,"message",{signal:AbortSignal.timeout(5000)});
  const pid=child.pid!,start=processStartIdentity(pid);assert.ok(start,"the real owner's process generation must be available");
  child.send("exit");await ended;
  assert.equal(processOwnerAlive({owner_pid:pid,process_start:start}),false);
  const db=new Database(":memory:");t.after(()=>db.close());migrateDatabase(db);
  db.exec(`
    INSERT INTO console_projects(id,root,name,created_at) VALUES('project','/project','fixture','2026-10-12');
    INSERT INTO console_work_items(id,project_id,item_key,title,created_at) VALUES('item','project','key','fixture','2026-10-12');
    INSERT INTO console_work_runs(id,project_id,item_id,run_key,request_hash,origin,created_at,status)
      VALUES('run','project','item','run-key','hash','{}','2026-10-12','reconciliation_required');
    INSERT INTO console_operations(id,run_id,request_key,kind,label,status,evidence,created_at)
      VALUES('operation','run','attempt','command','unresolved command','reconciliation_required','[{"effect":"unknown"}]','2026-10-12');
    INSERT INTO qm_sessions(id,owner_id,title,created_at,last_activity_at)
      VALUES('session','user','original session','2026-10-12','2026-10-12');
    INSERT INTO qm_session_members(id,session_id,node_id,workspace_id,root,mode,recovery_root,first_seen_at,last_observed_at)
      VALUES('member','session','node','workspace','/project','direct','/recovery','2026-10-12','2026-10-12');
    INSERT INTO qm_tasks(id,session_id,title,created_at,last_activity_at)
      VALUES('task','session','original task','2026-10-12','2026-10-12');
    INSERT INTO qm_invocations(id,owner_id,transport_instance_id,request_id,session_id,member_id,tool_name,
      arguments_json,operation_id,state,effect,result_json,created_at,response_at,response_json,task_id)
      VALUES('invocation','user','transport','key','session','member','exec_command','{"command":"unknown"}',
        'operation','unknown','unknown','{"retry_hint":"reconcile_only"}','2026-10-12','2026-10-12',
        '{"operation_id":"operation","effect":"started"}','task');
    UPDATE qm_runtime_admission SET accepting=0,reason='release-preflight:review-attempt' WHERE id=1;
  `);
  db.prepare(`INSERT INTO execution_owners(domain,id,generation,owner_token,owner_pid,process_start,created_at)
    VALUES('operation','operation','attempt','process-owner',?,?,'2026-10-12')`).run(pid,start);
  db.prepare(`INSERT INTO execution_claims(id,owner_id,owner_pid,kind,checkout_root,resources,acquired_at,
    access_mode,scopes_json,operation_id,task_id,title)
    VALUES('claim','coordinator-owner',?,'command','/project','["resource"]','2026-10-12','write',
      '[{"root":"/project","access":"write"}]','operation','task','original claim')`).run(pid);
  const rows=(table:string)=>db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
  const business=()=>Object.fromEntries(["console_operations","console_work_runs","qm_sessions","qm_session_members",
    "qm_tasks","qm_invocations","execution_owners"].map(table=>[table,rows(table)]));
  const apply=(claims:ReviewedCommandClaim[]=reviewableCommandClaims(db),subjects:QuiescenceSubject[]=unresolvedSubjects(db),
    boundary="reviewed_installation_stop_domain",receiptId="review-attempt")=>db.transaction(()=>{
      recordExecutionQuiescence(db,subjects,{id:receiptId,verifiedAt:new Date().toISOString(),
        evidence:{version:1,boundary,context:{attemptId:receiptId},claims}});
      return releaseReviewedCommandClaims(db,claims,receiptId);
    }).immediate();
  return {db,rows,business,apply,pid,start};
}

test("真实owner退出仅提供精确候选，普通物理记录和无事务调用绝不释放command claim",async t=>{
  const {db,rows,apply,business}=await fixture(t),before=business();
  const changes=db.prepare("SELECT total_changes()").pluck().get(),claims=reviewableCommandClaims(db);
  assert.equal(claims.length,1);assert.equal(claims[0].operationId,"operation");
  assert.equal(claims[0].ownerId,"coordinator-owner","coordinator id differs from process-owner token");
  assert.equal(db.prepare("SELECT total_changes()").pluck().get(),changes,"inspection must not reconcile or write");
  assert.equal(readMaintenanceStatus(db).claims,1);assert.equal(readMaintenanceStatus(db).quiescent,false);
  assert.throws(()=>releaseReviewedCommandClaims(db,claims,"review-attempt"),/requires the physical receipt transaction/);
  assert.throws(()=>apply(claims,unresolvedSubjects(db),"owner_pid_disappeared"),/exact physical receipt/);
  assert.equal(rows("execution_claims").length,1);assert.equal(rows("execution_quiescence").length,0);
  assert.equal(rows("execution_claim_reconciliations").length,0);assert.deepEqual(business(),before);
});

test("核验收据、审计与精确claim释放原子提交，SQLite备份及所有业务结果保持原样且重放不重复",async t=>{
  const {db,rows,apply,business}=await fixture(t),before=business(),claims=reviewableCommandClaims(db),subjects=unresolvedSubjects(db);
  const root=await mkdtemp(join(tmpdir(),"qm-reviewed-claim-"));t.after(()=>rm(root,{recursive:true,force:true}));
  const backupFile=join(root,"rollback.sqlite");await db.backup(backupFile);
  assert.deepEqual(apply(claims,subjects),{released:1,replayed:0});
  assert.equal(rows("execution_claims").length,0);assert.equal(rows("execution_quiescence").length,1);
  const audit=rows("execution_claim_reconciliations") as Array<{reason:string;evidence:string}>;
  assert.equal(audit.length,1);assert.equal(audit[0].reason,"reviewed_command_physical_quiescence");
  const evidence=JSON.parse(audit[0].evidence);
  assert.equal(evidence.receiptId,"review-attempt");assert.deepEqual(evidence.claim,claims[0]);
  assert.equal(evidence.originalClaim.scopes_json,'[{"root":"/project","access":"write"}]');
  assert.equal(evidence.resultReconciliation,"unchanged");assert.deepEqual(business(),before);
  const status=readMaintenanceStatus(db);assert.equal(status.quiescent,true);assert.equal(status.accepting,false);
  assert.equal(status.reconciliationPending,true);assert.equal(status.unresolvedOperations,1);
  assert.deepEqual(apply(claims,subjects),{released:0,replayed:1});
  assert.equal(rows("execution_claim_reconciliations").length,1);assert.deepEqual(business(),before);
  const backup=new Database(backupFile,{readonly:true});
  try {
    assert.equal(backup.prepare("SELECT count(*) FROM execution_claims").pluck().get(),1);
    assert.equal(backup.prepare("SELECT count(*) FROM execution_quiescence").pluck().get(),0);
    assert.deepEqual(backup.prepare("SELECT * FROM qm_invocations").all(),before.qm_invocations);
  } finally {backup.close();}
});

test("claim完整行、operation和owner任意变化即使总数不变也拒绝，不能保存部分物理证明",async t=>{
  const {db,rows,apply}=await fixture(t),claims=reviewableCommandClaims(db),subjects=unresolvedSubjects(db);
  const mutations=[
    "UPDATE execution_claims SET scopes_json='[]'", "UPDATE execution_claims SET resources='[]'",
    "UPDATE execution_claims SET owner_id='other-owner'", "UPDATE execution_claims SET operation_id='other-operation'",
    "UPDATE execution_claims SET acquired_at='2026-10-13'", "UPDATE execution_claims SET access_mode='read'",
    "UPDATE execution_claims SET task_id='other-task'", "UPDATE execution_claims SET title='changed-title'",
    "UPDATE console_operations SET request_key='next-attempt'", "UPDATE console_operations SET evidence='[]'",
    "UPDATE execution_owners SET process_start='other-generation'", "UPDATE execution_owners SET owner_token='other-token'",
  ];
  for(const sql of mutations){
    db.exec("SAVEPOINT changed");db.exec(sql);
    assert.throws(()=>apply(claims,subjects),/changed|physical receipt/);
    assert.equal(rows("execution_claims").length,1);assert.equal(rows("execution_quiescence").length,0);
    assert.equal(rows("execution_claim_reconciliations").length,0);
    db.exec("ROLLBACK TO changed; RELEASE changed");
  }
});

test("非command、缺进程身份、存活owner或代次不匹配不成为可审查集合，额外claim也阻挡释放",async t=>{
  const {db,rows,apply}=await fixture(t),claims=reviewableCommandClaims(db),subjects=unresolvedSubjects(db);
  for(const sql of ["UPDATE execution_claims SET kind='agent'", "UPDATE execution_owners SET process_start=NULL",
    "DELETE FROM execution_owners", "UPDATE execution_owners SET generation='other-attempt'",
    "UPDATE execution_claims SET owner_pid=1"]){
    db.exec("SAVEPOINT unsupported");db.exec(sql);
    assert.deepEqual(reviewableCommandClaims(db),[]);assert.equal(readMaintenanceStatus(db).claims,1);
    assert.throws(()=>apply(claims,subjects));assert.equal(rows("execution_claims").length,1);
    db.exec("ROLLBACK TO unsupported; RELEASE unsupported");
  }
  db.exec("SAVEPOINT live");
  db.prepare("UPDATE execution_owners SET owner_pid=?,process_start=?").run(processOwner.pid,processOwner.start);
  db.prepare("UPDATE execution_claims SET owner_pid=?").run(processOwner.pid);
  assert.deepEqual(reviewableCommandClaims(db),[]);assert.throws(()=>apply(claims,subjects));
  db.exec("ROLLBACK TO live; RELEASE live");
  db.exec(`INSERT INTO execution_claims(id,owner_id,owner_pid,kind,checkout_root,resources,acquired_at)
    VALUES('extra','owner',1,'mutation','/project','[]','2026-10-12')`);
  assert.throws(()=>apply(claims,subjects),/Unreviewed or unsupported/);
  assert.equal(rows("execution_claims").length,2);assert.equal(rows("execution_quiescence").length,0);
});

test("已恢复准入、运行时行或排队工作阻挡reviewed释放，旧egress非blocking标记不构成豁免",async t=>{
  const {db,rows,apply}=await fixture(t);
  for(const sql of ["UPDATE qm_runtime_admission SET accepting=1",
    `INSERT INTO qm_runtime_work(id,owner_id,owner_pid,kind,blocking,started_at) VALUES('work','owner',${process.pid},'egress',0,'2026-10-12')`,
    `INSERT INTO qm_runtime_work(id,owner_id,owner_pid,kind,blocking,started_at) VALUES('work','owner',1,'observe',0,'2026-10-12')`,
    "INSERT INTO console_operations(id,run_id,request_key,kind,label,status,evidence,created_at) VALUES('queued','run','queued','command','queued','queued','[]','2026-10-12')"]){
    db.exec("SAVEPOINT activity");db.exec(sql);
    assert.throws(()=>apply(),/paused admission and no other physical work/);
    assert.equal(rows("execution_claims").length,1);assert.equal(rows("execution_quiescence").length,0);
    db.exec("ROLLBACK TO activity; RELEASE activity");
  }
});

test("审计或DELETE真实SQL失败回滚整个物理收据事务，随后重试仍可精确恢复",async t=>{
  const {db,rows,apply,business}=await fixture(t),before=business();
  for(const target of ["audit","delete"]){
    db.exec(target==="audit"
      ? "CREATE TRIGGER refuse BEFORE INSERT ON execution_claim_reconciliations BEGIN SELECT RAISE(ABORT,'fixture audit refused'); END"
      : "CREATE TRIGGER refuse BEFORE DELETE ON execution_claims BEGIN SELECT RAISE(ABORT,'fixture delete refused'); END");
    assert.throws(()=>apply(),/fixture .* refused/);
    assert.equal(rows("execution_claims").length,1);assert.equal(rows("execution_quiescence").length,0);
    assert.equal(rows("execution_claim_reconciliations").length,0);assert.deepEqual(business(),before);
    db.exec("DROP TRIGGER refuse");
  }
  assert.deepEqual(apply(),{released:1,replayed:0});assert.deepEqual(business(),before);
});

test("claim无审计消失或换维护attempt不能重放旧释放，已改operation的历史证明也不可再用",async t=>{
  const {db,rows,apply}=await fixture(t),claims=reviewableCommandClaims(db),subjects=unresolvedSubjects(db);
  db.exec("SAVEPOINT disappeared; DELETE FROM execution_claims");
  assert.throws(()=>apply(claims,subjects),/disappeared without its matching release receipt/);
  assert.equal(rows("execution_quiescence").length,0);
  db.exec("ROLLBACK TO disappeared; RELEASE disappeared");
  apply(claims,subjects);
  assert.throws(()=>apply(claims,subjects,"reviewed_installation_stop_domain","different-attempt"),/matching release receipt/);
  assert.equal(rows("execution_quiescence").length,1);assert.equal(rows("execution_claim_reconciliations").length,1);
  db.exec("UPDATE console_operations SET evidence='[{\"effect\":\"later-observation\"}]'");
  assert.throws(()=>apply(claims,subjects),/changed after physical review/);
  assert.equal(readMaintenanceStatus(db).physicalUnknown,1);
});
