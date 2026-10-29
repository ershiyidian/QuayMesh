import assert from "node:assert/strict";
import test from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { migrateDatabase } from "../src/db/migrations.js";
import { processOwnerAlive, processStartIdentity } from "../src/process-identity.js";
import { runMaintenanceProof } from "../node/maintenance-lease.mjs";

// This integration test executes the built candidate's unmodified proof entry
// point with its own Node process and real SQLite. Run after pnpm build.
test("built维护proof完整协议释放已物理审查claim；缺opt-in、旧代次仍存活、指纹漂移均原子拒绝",{timeout:30_000},async t=>{
  const root=await mkdtemp(join(tmpdir(),"qm-proof-command-")),children:Array<{child:ChildProcess;ended:Promise<unknown>}>=[];
  let db:Database.Database|undefined;
  t.after(async()=>{
    for(const {child,ended} of children)if(child.exitCode===null&&child.signalCode===null){child.kill();await ended;}
    db?.close();await rm(root,{recursive:true,force:true});
  });
  const processFixture=async()=>{
    const child=spawn(process.execPath,["-e",`process.send('ready');process.on('message',()=>process.exit(0));`],
      {stdio:["ignore","ignore","ignore","ipc"]});
    const ended=once(child,"exit");children.push({child,ended});
    await once(child,"message",{signal:AbortSignal.timeout(5000)});
    const start=processStartIdentity(child.pid!);assert.ok(start);
    return {pid:child.pid!,start,stop:async()=>{child.send("exit");await ended;}};
  };
  const historicalOwner=await processFixture();await historicalOwner.stop();
  const manager=await processFixture(),oldCore=await processFixture(),newCore=await processFixture();
  await mkdir(join(root,"core"));
  db=new Database(join(root,"core","quaymesh.sqlite"));db.pragma("journal_mode = WAL");migrateDatabase(db);
  db.exec(`
    INSERT INTO console_projects(id,root,name,created_at) VALUES('project','/project','fixture','2026-10-12');
    INSERT INTO console_work_items(id,project_id,item_key,title,created_at) VALUES('item','project','key','fixture','2026-10-12');
    INSERT INTO console_work_runs(id,project_id,item_id,run_key,request_hash,origin,created_at,status)
      VALUES('run','project','item','run-key','hash','{}','2026-10-12','reconciliation_required');
    INSERT INTO console_operations(id,run_id,request_key,kind,label,status,evidence,created_at)
      VALUES('operation','run','old-attempt','command','original unknown command','reconciliation_required','[]','2026-10-12');
    UPDATE qm_runtime_admission SET accepting=0,reason='node-maintenance' WHERE id=1;
  `);
  db.prepare(`INSERT INTO execution_owners(domain,id,generation,owner_token,owner_pid,process_start,created_at)
    VALUES('operation','operation','old-attempt','old-owner-token',?,?,'2026-10-12')`).run(historicalOwner.pid,historicalOwner.start);
  db.prepare(`INSERT INTO execution_claims(id,owner_id,owner_pid,kind,checkout_root,resources,acquired_at,operation_id)
    VALUES('claim','old-coordinator',?,'command','/project','[]','2026-10-12','operation')`).run(historicalOwner.pid);
  const original=db.prepare("SELECT * FROM console_operations").all(),originalClaims=db.prepare("SELECT * FROM execution_claims").all();
  const manifest={directory:fileURLToPath(new URL("..",import.meta.url)),nodeExecutable:process.execPath,stateDir:root};
  const inspect=()=>runMaintenanceProof(manifest,{action:"inspect",stateDir:root,pids:[manager.pid,oldCore.pid,newCore.pid]});
  const baseline=await inspect();
  assert.equal(baseline.admission.claims,1);assert.equal(baseline.admission.quiescent,false);
  assert.equal(baseline.claims.length,1);assert.equal(baseline.claims[0].processStart,historicalOwner.start);
  const attemptId=randomUUID(),manifestFile=join(root,"prepared.json");
  await writeFile(manifestFile,JSON.stringify({stateDir:root,sourceCommit:"new-release",attemptId}));
  const manifestSha256=createHash("sha256").update(await readFile(manifestFile)).digest("hex");
  const identity=({pid,start}:{pid:number;start:string})=>({pid,start});
  const context={attemptId,stateDir:root,oldCommit:"old-release",targetCommit:"new-release",manifestFile,manifestSha256,
    transitionFile:join(root,"installation-transition.json"),createdAt:new Date().toISOString(),
    manager:identity(manager),core:identity(oldCore)};
  await writeFile(context.transitionFile,JSON.stringify({id:attemptId,previousCommit:"old-release",sourceCommit:"new-release",
    maintenanceLease:{attemptId,manifestSha256}}));
  await writeFile(join(root,"core","active-release.json"),JSON.stringify({commit:"new-release",pid:newCore.pid}));
  const census=()=>({digest:createHash("sha256").update(JSON.stringify([historicalOwner,manager,oldCore].map(value=>({
    ...identity(value),alive:processOwnerAlive({owner_pid:value.pid,process_start:value.start}),
  })))).digest("hex"),observedAt:new Date().toISOString()});
  const stages:Array<{stage:string;at:string;census:{digest:string;observedAt:string}}>=[];
  const stage=(name:string)=>stages.push({stage:name,at:new Date().toISOString(),census:census()});
  stage("before_backup");
  const backupFile=join(root,"rollback.sqlite");await db.backup(backupFile);
  stage("after_backup");stage("before_stop");
  const request=()=>({action:"record",stateDir:root,attemptId,targetCommit:"new-release",core:identity(newCore),
    previousProcesses:[identity(manager),identity(oldCore)],subjects:baseline.subjects,claims:baseline.claims,
    receipt:{id:attemptId,verifiedAt:new Date().toISOString(),evidence:{version:1,boundary:"reviewed_installation_stop_domain",
      context,claims:baseline.claims,stages}}});
  // Even a complete-shaped receipt cannot get past real live old generations.
  stage("after_stop");
  await assert.rejects(runMaintenanceProof(manifest,request()),/previous manager or Core generation/);
  stages.pop();await manager.stop();await oldCore.stop();stage("after_stop");
  const stopped=await inspect();
  assert.equal(stopped.processes.find((value:{pid:number})=>value.pid===manager.pid).alive,false);
  assert.equal(stopped.processes.find((value:{pid:number})=>value.pid===oldCore.pid).alive,false);
  const noOptIn=request();delete (noOptIn as {claims?:unknown}).claims;
  await assert.rejects(runMaintenanceProof(manifest,noOptIn),/Unreviewed or unsupported execution claims/);
  const drifted=request();drifted.claims=[{...baseline.claims[0],fingerprint:"e".repeat(64)}];
  drifted.receipt.evidence.claims=drifted.claims;
  await assert.rejects(runMaintenanceProof(manifest,drifted),/Command claim changed after physical review/);
  assert.equal(db.prepare("SELECT count(*) FROM execution_quiescence").pluck().get(),0);
  assert.equal(db.prepare("SELECT count(*) FROM execution_claim_reconciliations").pluck().get(),0);
  assert.deepEqual(db.prepare("SELECT * FROM execution_claims").all(),originalClaims);
  const result=await runMaintenanceProof(manifest,request());
  assert.equal(result.released,1);assert.equal(result.replayed,0);assert.equal(result.admission.claims,0);
  assert.equal(result.admission.accepting,false);assert.equal(result.admission.quiescent,true);
  assert.equal(result.admission.reconciliationPending,true);assert.equal(result.admission.unresolvedOperations,1);
  assert.deepEqual(db.prepare("SELECT * FROM console_operations").all(),original);
  assert.equal(db.prepare("SELECT count(*) FROM execution_claim_reconciliations").pluck().get(),1);
  const repeated=await runMaintenanceProof(manifest,request());assert.equal(repeated.released,0);assert.equal(repeated.replayed,1);
  assert.equal(db.prepare("SELECT count(*) FROM execution_claim_reconciliations").pluck().get(),1);
  const backup=new Database(backupFile,{readonly:true});
  try {
    assert.deepEqual(backup.prepare("SELECT * FROM execution_claims").all(),originalClaims);
    assert.deepEqual(backup.prepare("SELECT * FROM console_operations").all(),original);
    assert.equal(backup.prepare("SELECT count(*) FROM execution_quiescence").pluck().get(),0);
  } finally {backup.close();}
});
