import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { executionClaimSchema } from "../../dist/db/execution-claim-schema.js";
import { canonicalExecutionRoot } from "../../dist/execution-coordinator.js";
import { inspectExecutionClaim } from "../../dist/execution-claim-recovery.js";
import { installationBackgroundMaintenanceAllowed } from "../../dist/installation-transition.js";
import { readMaintenanceStatus, unresolvedSubjects, reviewableCommandClaims, retainableCommandClaims } from "../../dist/maintenance-status.js";
import { processStartIdentity } from "../../dist/process-identity.js";
import { SessionStore } from "../../dist/session/store.js";
import { WorkLedger } from "../../dist/work-ledger.js";
import { WorkRunReconciler } from "../../dist/work-run-reconciler.js";
import { retainedHistoryIdentity, assertRetainedHistory } from "../maintenance-history.mjs";
import { runMaintenanceProof } from "../maintenance-lease.mjs";
import { enforceInstallationRollbackBoundary } from "../install.mjs";

const identitySupported=process.platform==="linux"||process.platform==="win32";
const hash=value=>createHash("sha256").update(value).digest("hex");
const deadline=()=>AbortSignal.timeout(5_000);

async function fixture(t){
  const directory=await mkdtemp(join(tmpdir(),"qm-preserve-install-")),stateDir=join(directory,"state"),root=join(directory,"project");
  await mkdir(root);await mkdir(join(stateDir,"core"),{recursive:true});
  const ledger=new WorkLedger(join(stateDir,"core")),store=new SessionStore(ledger.db);
  t.after(async()=>{ledger.close();await rm(directory,{recursive:true,force:true});});
  const session=store.createSession("fixture-owner",null,"Preservation fixture");
  const member=store.addMember(session.id,"fixture","fixture-workspace",root,"fixture-checkout",null);
  const task=store.createTask(session.id,"Historical task");store.touchTaskMember(task.id,member.id);
  const run=ledger.begin({root,workspaceId:member.workspace_id,workItemId:task.id,runKey:task.id,title:"Historical task",
    origin:{entryPoint:"console",evidence:"server_entry"}});
  store.linkRun(session.id,member.id,run.id,task.id);
  const generation="inv_"+randomUUID(),operationId=ledger.operation({runId:run.id,requestKey:generation,kind:"command",
    label:"Unconfirmed historical command",status:"running"});
  ledger.endOperation(operationId,"reconciliation_required",[],generation);
  assert.equal(ledger.db.prepare("SELECT COUNT(*) FROM execution_owners WHERE domain='operation' AND id=?").pluck().get(operationId),1);
  // The same PID with a distinct start identity is a previous generation,
  // never evidence that its external descendants have stopped.
  const oldStart="retired:"+processStartIdentity(process.pid),claimId="claim_"+randomUUID();
  ledger.db.prepare("UPDATE execution_owners SET process_start=? WHERE domain='operation' AND id=?").run(oldStart,operationId);
  ledger.db.prepare(`INSERT INTO execution_claims
    (id,owner_id,owner_pid,kind,checkout_root,agent_id,resources,acquired_at,access_mode,thread_key,
      scopes_json,operation_id,task_id,title,execution_id,execution_generation,owner_process_start)
    VALUES(?,?,?,'command',?,NULL,'[]',?,'write',NULL,NULL,?,?,?,NULL,NULL,NULL)`)
    .run(claimId,"previous-coordinator",process.pid,canonicalExecutionRoot(root),new Date().toISOString(),operationId,task.id,task.title);
  ledger.db.prepare("UPDATE qm_runtime_admission SET accepting=0,reason='node-maintenance' WHERE id=1").run();
  const snapshot=()=>({historyPolicy:"preserve",protocolVersion:2,claimFingerprintVersion:2,
    admission:readMaintenanceStatus(ledger.db),subjects:unresolvedSubjects(ledger.db),claims:retainableCommandClaims(ledger.db)});
  const rows=()=>({operations:ledger.db.prepare("SELECT * FROM console_operations ORDER BY id").all(),
    owners:ledger.db.prepare("SELECT * FROM execution_owners ORDER BY domain,id").all(),
    claims:ledger.db.prepare("SELECT * FROM execution_claims ORDER BY id").all(),
    receipts:ledger.db.prepare("SELECT * FROM execution_quiescence ORDER BY id").all()});
  return {directory,stateDir,root,ledger,store,session,member,task,run,generation,operationId,claimId,snapshot,rows};
}

function restoreV16(db){
  db.exec(`DROP INDEX execution_claims_execution;
    ALTER TABLE execution_claims DROP COLUMN execution_id;
    ALTER TABLE execution_claims DROP COLUMN execution_generation;
    ALTER TABLE execution_claims DROP COLUMN owner_process_start;
    ALTER TABLE execution_waiters DROP COLUMN execution_id;
    ALTER TABLE execution_waiters DROP COLUMN execution_generation;
    ALTER TABLE execution_waiters DROP COLUMN owner_process_start;
    DELETE FROM qm_schema_migrations WHERE version>16;`);
}

test("preserve-v2 maps only the exact v18 NULL additions and retains every historical field",{skip:!identitySupported},async t=>{
  const f=await fixture(t);restoreV16(f.ledger.db);
  const before=f.snapshot(),expected=retainedHistoryIdentity(before),legacy=reviewableCommandClaims(f.ledger.db);
  assert.equal(before.claims.length,1);assert.equal(before.admission.physicalUnknown,1);
  f.ledger.db.exec(executionClaimSchema);
  f.ledger.db.prepare("INSERT INTO qm_schema_migrations(version,name,applied_at) VALUES(18,'exact-v18-fixture',?)").run(new Date().toISOString());
  const migrated=f.snapshot();
  assert.deepEqual(migrated.claims,before.claims);assert.deepEqual(migrated.subjects,before.subjects);
  assert.notDeepEqual(reviewableCommandClaims(f.ledger.db),legacy,"legacy prove fingerprint remains the complete raw row");
  assertRetainedHistory(migrated,expected);
  const mutations=[
    ["execution_generation","another-attempt"],["execution_id","another-execution"],["owner_process_start","another-process"],
    ["scopes_json",'{"changed":true}'],["task_id",f.store.createTask(f.session.id,"Other task").id],["owner_id","another-owner"],
  ];
  const original=f.ledger.db.prepare("SELECT * FROM execution_claims WHERE id=?").get(f.claimId);
  for(const [column,value] of mutations){
    f.ledger.db.prepare(`UPDATE execution_claims SET ${column}=? WHERE id=?`).run(value,f.claimId);
    assert.throws(()=>assertRetainedHistory(f.snapshot(),expected),/historical identities/);
    f.ledger.db.prepare(`UPDATE execution_claims SET ${column}=? WHERE id=?`).run(original[column],f.claimId);
  }
  f.ledger.db.exec("ALTER TABLE execution_claims ADD COLUMN future_identity TEXT");
  assert.throws(()=>assertRetainedHistory(f.snapshot(),expected),/historical identities/,
    "an unreviewed future schema column is not silently normalized away");
  assert.equal(f.ledger.db.prepare("SELECT COUNT(*) FROM execution_quiescence").pluck().get(),0);
});

async function stoppedGeneration(t){
  const child=spawn(process.execPath,["-e","process.stdin.once('data',()=>process.exit(0));setTimeout(()=>process.exit(1),10000)"],
    {stdio:["pipe","ignore","ignore"]});
  t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill();});
  await once(child,"spawn",{signal:deadline()});
  const identity={pid:child.pid,start:processStartIdentity(child.pid)};assert.ok(identity.start);
  const exited=once(child,"exit",{signal:deadline()});child.stdin.end("exit\n");await exited;
  return identity;
}

async function proofRequest(t,f){
  const manager=await stoppedGeneration(t),core=await stoppedGeneration(t),createdAt=new Date().toISOString();
  const manifestFile=join(f.directory,"prepared.json"),targetCommit="a".repeat(40),oldCommit="b".repeat(40),attemptId=randomUUID();
  await writeFile(manifestFile,JSON.stringify({version:1,sourceCommit:targetCommit,stateDir:f.stateDir}));
  const context={version:2,historyPolicy:"preserve",attemptId,stateDir:resolve(f.stateDir),createdAt,
    targetCommit,oldCommit,transitionFile:join(f.stateDir,"installation-transition.json"),manifestFile,
    manifestSha256:hash(await readFile(manifestFile)),manager,core,retainedHistory:retainedHistoryIdentity(f.snapshot())};
  await writeFile(context.transitionFile,JSON.stringify({id:attemptId,sourceCommit:targetCommit,previousCommit:oldCommit,phase:"validating",
    maintenanceLease:{version:2,historyPolicy:"preserve",attemptId,manifestSha256:context.manifestSha256,retainedHistory:context.retainedHistory}}));
  await writeFile(join(f.stateDir,"core","active-release.json"),JSON.stringify({commit:targetCommit,pid:process.pid}));
  const states=f.snapshot();
  return {action:"verify-retained",historyPolicy:"preserve",stateDir:f.stateDir,attemptId,targetCommit,
    core:{pid:process.pid,start:processStartIdentity(process.pid)},previousProcesses:[manager,core],
    subjects:states.subjects,claims:states.claims,
    review:{id:attemptId,verifiedAt:new Date().toISOString(),evidence:{version:2,
      boundary:"reviewed_installation_service_stop_domain",context,
      stages:["before_backup","after_backup","before_stop","after_stop"].map(stage=>({stage,at:createdAt,
        census:{digest:"c".repeat(64),observedAt:createdAt}}))}}};
}

test("the actual readonly proof child verifies preservation without recording quiescence or deleting claims",{skip:!identitySupported,timeout:20_000},async t=>{
  const f=await fixture(t),request=await proofRequest(t,f),before=f.rows();
  const manifest={nodeExecutable:process.execPath,directory:resolve(fileURLToPath(new URL("../..",import.meta.url)))};
  const result=await runMaintenanceProof(manifest,request);
  assert.equal(result.verifiedRetained,true);assert.equal(result.recorded,0);assert.equal(result.released,0);
  assert.equal(result.retainedClaims,1);assert.equal(result.retainedSubjects,1);
  assert.equal(result.admission.quiescent,false);assert.equal(result.admission.physicalUnknown,1);
  assert.deepEqual(f.rows(),before);
  for(const mutate of [
    value=>{value.claims=[];},value=>{value.subjects[0].generation="another-attempt";},
    value=>{value.review.evidence.context.retainedHistory.claimDigest="d".repeat(64);},
    value=>{value.review.evidence.stages.pop();},value=>{value.action="record";value.receipt=value.review;},
  ]){
    const changed=structuredClone(request);mutate(changed);
    await assert.rejects(runMaintenanceProof(manifest,changed));
    assert.deepEqual(f.rows(),before);
  }
});

test("preserve transition delays real startup reconciliation; release never turns unknown claims into completion",{skip:!identitySupported},async t=>{
  const f=await fixture(t),marker=join(f.stateDir,"installation-transition.json");
  await writeFile(marker,JSON.stringify({maintenanceLease:{version:2,historyPolicy:"preserve"}}));
  const orphanTask=f.store.createTask(f.session.id,"Old in-flight task");f.store.touchTaskMember(orphanTask.id,f.member.id);
  const orphanRun=f.ledger.begin({root:f.root,workspaceId:f.member.workspace_id,workItemId:orphanTask.id,runKey:orphanTask.id,
    title:"Old in-flight task",origin:{entryPoint:"console",evidence:"server_entry"}});
  f.store.linkRun(f.session.id,f.member.id,orphanRun.id,orphanTask.id);
  const orphan=f.ledger.operation({runId:orphanRun.id,requestKey:"pending_"+randomUUID(),kind:"read",label:"Old in-flight operation",status:"running"});
  f.ledger.db.prepare("UPDATE execution_owners SET process_start=? WHERE domain='operation' AND id=?").run("retired-generation",orphan);
  const before=f.rows();
  const reconciler=new WorkRunReconciler(join(f.stateDir,"core"),60_000,error=>{throw error;},()=>installationBackgroundMaintenanceAllowed(marker));
  try {
  reconciler.start();reconciler.tick();await reconciler.tickAsync();
  assert.deepEqual(f.rows(),before,"neither startup nor tick writes the preserved attempt set");
  await rm(marker);reconciler.tick();
  assert.equal(f.ledger.db.prepare("SELECT status FROM console_operations WHERE id=?").pluck().get(orphan),"reconciliation_required",
    "deferred startup runs after the explicit transition is released");
  assert.equal(inspectExecutionClaim(f.ledger.db,f.claimId).state,"unknown");
  assert.deepEqual(f.ledger.db.prepare("SELECT * FROM execution_claims ORDER BY id").all(),before.claims);
  assert.equal(f.ledger.db.prepare("SELECT COUNT(*) FROM execution_quiescence").pluck().get(),0);
  } finally { await reconciler.close(); }
});

test("installation background gate fails closed for malformed markers and leaves ordinary prove behavior intact",async t=>{
  const directory=await mkdtemp(join(tmpdir(),"qm-preserve-marker-")),file=join(directory,"transition.json");
  t.after(()=>rm(directory,{recursive:true,force:true}));
  assert.equal(installationBackgroundMaintenanceAllowed(file),true);
  for(const marker of [{phase:"validating"},{maintenanceLease:{historyPolicy:"prove"}}]){
    await writeFile(file,JSON.stringify(marker));assert.equal(installationBackgroundMaintenanceAllowed(file),true);
  }
  for(const value of ['{"maintenanceLease":{"historyPolicy":"preserve"}}','{"maintenanceLease":{"historyPolicy":"unknown"}}','{"broken":','null','[]','{"maintenanceLease":{"version":2}}'," ".repeat(65_537)]){
    await writeFile(file,value);assert.equal(installationBackgroundMaintenanceAllowed(file),false);
  }
  await rm(file);await mkdir(file);assert.equal(installationBackgroundMaintenanceAllowed(file),false);
});


test("preserve post-stop failure persists recovery even at the same schema; prove keeps the original rollback boundary",async t=>{
  const directory=await mkdtemp(join(tmpdir(),"qm-preserve-rollback-"));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const marker=join(directory,"installation-transition.json"),backup=join(directory,"backup.sqlite"),config=join(directory,"node.json");
  await writeFile(backup,"unchanged-backup");await writeFile(config,"unchanged-prepared-config");
  const manifest={stateDir:directory,sourceCommit:"new-commit"},previous={sourceCommit:"old-commit"};
  const snapshot={version:19,backup},transition={id:"owned-attempt",phase:"validating",ownerPid:process.pid,
    maintenanceLease:{version:2,historyPolicy:"preserve",attemptId:"owned-attempt"}};
  const input={manifest,previous,transition,snapshot,current:{version:19},error:new Error("candidate readiness failed")};
  let oldServiceStarts=0;
  await assert.rejects(async()=>{
    await enforceInstallationRollbackBoundary({...input,historyPolicy:"preserve"});oldServiceStarts++;
  },/不自动启动/);
  assert.equal(oldServiceStarts,0);
  const recovery=JSON.parse(await readFile(marker,"utf8"));
  assert.equal(recovery.phase,"recovery_required");assert.equal(recovery.id,transition.id);
  assert.deepEqual(recovery.maintenanceLease,transition.maintenanceLease);assert.deepEqual(recovery.database,snapshot);
  assert.equal(recovery.currentDatabaseVersion,19);assert.equal(recovery.previousCommit,"old-commit");
  assert.equal(await readFile(backup,"utf8"),"unchanged-backup");assert.equal(await readFile(config,"utf8"),"unchanged-prepared-config");
  await rm(marker);
  await enforceInstallationRollbackBoundary({...input,historyPolicy:"prove"});
  await assert.rejects(readFile(marker),error=>error.code==="ENOENT");
  await assert.rejects(enforceInstallationRollbackBoundary({...input,current:{version:20},historyPolicy:"prove"}),/数据库已从 19 升级到 20/);
  assert.equal(JSON.parse(await readFile(marker,"utf8")).phase,"recovery_required");
});
