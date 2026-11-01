import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdir, readFile, readdir, writeFile, symlink, chmod, copyFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { migrateDatabase } from "../../dist/db/migrations.js";
import { quiescenceSubject, recordExecutionQuiescence, unresolvedSubjects, retainableCommandClaims,
  readMaintenanceStatus } from "../../dist/maintenance-status.js";
import { retainedHistoryIdentity, assertRetainedHistory } from "../maintenance-history.mjs";
import { forwardOnlyDatabaseMigration } from "../database-migration.mjs";
import { activateInstallation, databaseMigration, databaseSnapshot, enforceInstallationRollbackBoundary } from "../install.mjs";
import { main } from "../cli.mjs";
import { cluster, freePort, token } from "./helpers.mjs";

const repository=fileURLToPath(new URL("../../",import.meta.url)),commit="a".repeat(40),previousCommit="c".repeat(40);
const exactColumns=["execution_id","execution_generation","owner_process_start"];
const newTables=["qm_task_peer_messages","qm_task_peer_deliveries","qm_local_api_grants","qm_local_api_dispatches","qm_local_api_verifiers"];
const legacyColumns=["effort","task_name","error_code","error_retryable","context_key","context_signature",
  "work_item_id","progress","recovery_type","parent_provider_session_id","control_state","provider_turn_id","control_revision"];
const version=db=>db.prepare("SELECT max(version) FROM qm_schema_migrations").pluck().get();
const tableRows=(db,table)=>db.prepare(`SELECT * FROM ${table}`).all();
const historySnapshot=db=>({historyPolicy:"preserve",protocolVersion:2,claimFingerprintVersion:2,
  admission:readMaintenanceStatus(db),subjects:unresolvedSubjects(db),claims:retainableCommandClaims(db)});

function restoreRealV16(db){
  db.exec(`DROP TABLE qm_local_api_dispatches;DROP TABLE qm_local_api_verifiers;DROP TABLE qm_local_api_grants;
    DROP TABLE qm_task_peer_deliveries;DROP TABLE qm_task_peer_messages;DROP INDEX qm_tasks_local_api_created;
    DROP INDEX execution_claims_execution;
    ALTER TABLE execution_claims DROP COLUMN execution_id;ALTER TABLE execution_claims DROP COLUMN execution_generation;
    ALTER TABLE execution_claims DROP COLUMN owner_process_start;ALTER TABLE execution_waiters DROP COLUMN execution_id;
    ALTER TABLE execution_waiters DROP COLUMN execution_generation;ALTER TABLE execution_waiters DROP COLUMN owner_process_start;
    DROP INDEX qm_events_task_diagnostic_time;DROP INDEX qm_invocations_task_diagnostic_time;DROP INDEX qm_invocations_pending_state;
    DELETE FROM qm_schema_migrations WHERE version>16;`);
}

async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),"quaymesh-forward-only-")),stateDir=join(root,"state"),candidate=join(root,"immutable-candidate");
  await mkdir(join(stateDir,"core"),{recursive:true});await mkdir(candidate);
  await writeFile(join(candidate,"package.json"),'{"type":"module"}');
  await writeFile(join(candidate,"release.json"),JSON.stringify({sourceCommit:commit,platform:"linux-x64"}));
  for(const name of ["dist","node_modules"])
    await symlink(join(repository,name),join(candidate,name),process.platform==="win32"?"junction":"dir");
  await mkdir(join(candidate,"node"));
  await copyFile(join(repository,"node","database-snapshot.mjs"),join(candidate,"node","database-snapshot.mjs"));
  const file=join(stateDir,"core","quaymesh.sqlite"),db=new Database(file);db.pragma("journal_mode=WAL");
  t.after(async()=>{db.close();await rm(root,{recursive:true,force:true});});migrateDatabase(db);
  db.exec(`INSERT INTO qm_sessions(id,owner_id,title,created_at,last_activity_at) VALUES('session','owner','retained','2026-10-01','2026-10-01');
    INSERT INTO qm_tasks(id,session_id,title,start_sequence,created_at,last_activity_at) VALUES('task','session','retained',0,'2026-10-01','2026-10-01');
    INSERT INTO console_projects(id,root,name,created_at) VALUES('project','/fixture','retained','2026-10-01');
    INSERT INTO console_work_items(id,project_id,item_key,title,created_at) VALUES('item','project','key','retained','2026-10-01');
    INSERT INTO console_work_runs(id,project_id,item_id,run_key,request_hash,origin,created_at,status)
      VALUES('run','project','item','key','hash','{}','2026-10-01','reconciliation_required');
    INSERT INTO console_operations(id,run_id,request_key,kind,label,status,evidence,created_at,finished_at)
      VALUES('operation','run','request','command','retained','reconciliation_required','[]','2026-10-01','2026-10-02');
    INSERT INTO local_agent_sessions(id,workspace_root,profile_name,provider,status,effort,created_at,updated_at)
      VALUES('agent','/fixture','fixture','fixture','failed','medium','2026-10-01','2026-10-02');
    INSERT INTO console_executions(id,run_id,agent_id,provider,status,requested,created_at,finished_at)
      VALUES('execution','run','agent','fixture','unknown',1,'2026-10-01','2026-10-02');
    INSERT INTO execution_owners(domain,id,generation,owner_token,owner_pid,process_start,created_at)
      VALUES('operation','operation','request','retired-owner',${process.pid},'retired-fixture-generation','2026-10-01'),
      ('execution','execution','execution-generation','retired-owner',${process.pid},'retired-fixture-generation','2026-10-01');
    INSERT INTO execution_claims(id,owner_id,owner_pid,kind,checkout_root,resources,acquired_at,operation_id,task_id,title)
      VALUES('claim','retired-owner',${process.pid},'command','/fixture','[]','2026-10-01','operation','task','retained');
    UPDATE qm_runtime_admission SET accepting=0,reason='node-maintenance' WHERE id=1;
    CREATE TABLE retained_payload(id TEXT PRIMARY KEY,value TEXT);
    INSERT INTO retained_payload VALUES('retained','original-value');`);
  recordExecutionQuiescence(db,[quiescenceSubject(db,"execution","execution")],
    {id:"prior-reviewed-receipt",verifiedAt:"2026-10-03T00:00:00.000Z",evidence:{fixture:"retained physical boundary"}});
  restoreRealV16(db);
  return {root,stateDir,candidate,file,db,manifest:{directory:candidate,stateDir,nodeExecutable:process.execPath,sourceCommit:commit}};
}

function capturedRows(db){
  return Object.fromEntries(["console_operations","console_executions","execution_owners","execution_quiescence",
    "execution_claims","execution_waiters","local_agent_sessions","qm_tasks","retained_payload"]
    .map(table=>[table,tableRows(db,table)]));
}
function assertOldRows(db,before){
  for(const [table,rows] of Object.entries(before)){
    const current=tableRows(db,table);
    assert.deepEqual(current.map(row=>Object.fromEntries(Object.keys(rows[0]??row).map(key=>[key,row[key]]))),rows,table);
  }
}

test("forward-only计划只读且独立operator用不可变候选真实迁移16→19，保留业务和preserve-v2证据",async t=>{
  const f=await fixture(t),before=capturedRows(f.db),identity=retainedHistoryIdentity(historySnapshot(f.db));
  assert.equal(before.execution_quiescence.length,1);
  const release=await readFile(join(f.candidate,"release.json")),files=await readdir(f.candidate);
  const plan=await databaseMigration(f.manifest);
  assert.equal(version(f.db),16);assert.deepEqual(capturedRows(f.db),before);
  assert.equal(plan.version,16);assert.equal(plan.backup,null);assert.equal(plan.verifiedForwardOnlyPlan,true);
  assert.deepEqual(plan.migrationPlan.steps.map(step=>step.version),[17,18,19]);
  const result=await databaseMigration(f.manifest,{apply:true});
  assert.equal(result.version,19);assert.equal(result.verified,true);assert.equal(result.foreignKeysVerified,true);
  assertOldRows(f.db,before);assertRetainedHistory(historySnapshot(f.db),identity);
  assert.equal(f.db.prepare("SELECT invalidated_at FROM execution_quiescence").pluck().get(),null);
  for(const table of ["execution_claims","execution_waiters"]){
    assert.ok(exactColumns.every(name=>f.db.pragma(`table_info(${table})`).some(column=>column.name===name&&column.type==="TEXT"&&column.notnull===0&&column.dflt_value===null)));
    for(const row of tableRows(f.db,table))for(const key of exactColumns)assert.equal(row[key],null);
  }
  for(const table of newTables)assert.equal(f.db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get(),0);
  assert.equal(f.db.pragma("integrity_check",{simple:true}),"ok");
  assert.deepEqual(await readFile(join(f.candidate,"release.json")),release);assert.deepEqual(await readdir(f.candidate),files);
  await assert.rejects(readFile(join(f.candidate,"node","database-migration.mjs")),{code:"ENOENT"},"candidate has no operator helper to patch");
  assert.deepEqual((await readdir(join(f.stateDir,"core"))).filter(name=>!/^quaymesh\.sqlite(?:-wal|-shm)?$/.test(name)),[]);
});

test("forward-only保留旧waiter各业务字段，新增执行身份保持NULL",async t=>{
  const f=await fixture(t);
  f.db.prepare(`INSERT INTO execution_waiters(id,owner_id,owner_pid,kind,checkout_root,access_mode,resources,expires_at_ms)
    VALUES('waiter','retired-owner',?,'command','/fixture','write','[]',1)`).run(process.pid);
  const before=tableRows(f.db,"execution_waiters");
  await forwardOnlyDatabaseMigration({...f.manifest,apply:true});
  assertOldRows(f.db,{execution_waiters:before});
  for(const key of exactColumns)assert.equal(tableRows(f.db,"execution_waiters")[0][key],null);
});

test("真实迁移savepoint结束后同步校验失败，外层事务回滚17/18/19和全部legacy修复",async t=>{
  const f=await fixture(t);
  f.db.exec(`ALTER TABLE local_agent_sessions ADD COLUMN thinking TEXT;
    UPDATE local_agent_sessions SET thinking='high',effort=NULL;
    CREATE TRIGGER unexpected_migration_write AFTER INSERT ON qm_schema_migrations WHEN NEW.version=19
      BEGIN DELETE FROM retained_payload;END;`);
  const before=capturedRows(f.db),schema=f.db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all();
  await assert.rejects(databaseMigration(f.manifest,{apply:true}),/意外改变原表行数 retained_payload/);
  assert.equal(version(f.db),16);assert.deepEqual(capturedRows(f.db),before);
  assert.deepEqual(f.db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all(),schema);
  assert.equal(f.db.prepare("SELECT effort FROM local_agent_sessions").pluck().get(),null);
  assert.equal(f.db.inTransaction,false);f.db.exec("BEGIN IMMEDIATE;ROLLBACK");
});

test("forward-only计划明确legacy缺列和回填，提交后保留非NULL effort和thinking NULL",async t=>{
  for(const missingEffort of [false,true]){
    const f=await fixture(t);
    f.db.exec("DROP INDEX agent_context_affinity;DROP TABLE local_agent_turns;ALTER TABLE local_agent_sessions ADD COLUMN thinking TEXT;");
    for(const name of legacyColumns)if(missingEffort||name!=="effort")f.db.exec(`ALTER TABLE local_agent_sessions DROP COLUMN ${name}`);
    f.db.exec(`INSERT INTO local_agent_sessions(id,workspace_root,profile_name,provider,status,thinking,created_at,updated_at)
      VALUES('copy','/fixture','fixture','fixture','failed','high','2026-10-01','2026-10-02'),
      ('keep','/fixture','fixture','fixture','failed','high','2026-10-01','2026-10-02'),
      ('empty','/fixture','fixture','fixture','failed',NULL,'2026-10-01','2026-10-02');`);
    if(!missingEffort)f.db.exec("UPDATE local_agent_sessions SET effort='medium' WHERE id='keep'");
    const plan=await databaseMigration(f.manifest);
    assert.equal(plan.migrationPlan.legacyAgentRepair.missingColumns.length,missingEffort?13:12);
    assert.equal(plan.migrationPlan.legacyAgentRepair.createTurns,true);
    assert.equal(plan.migrationPlan.legacyAgentRepair.backfill.rows,missingEffort?2:1);
    assert.equal(plan.migrationPlan.legacyAgentRepair.backfill.condition,"effort IS NULL AND thinking IS NOT NULL");
    await databaseMigration(f.manifest,{apply:true});
    assert.deepEqual(f.db.prepare("SELECT id,thinking,effort FROM local_agent_sessions WHERE id<>'agent' ORDER BY id").all(),[
      {id:"copy",thinking:"high",effort:"high"},{id:"empty",thinking:null,effort:null},
      {id:"keep",thinking:"high",effort:missingEffort?"high":"medium"},
    ]);
    assert.equal(f.db.prepare("SELECT COUNT(*) FROM local_agent_turns").pluck().get(),0);
  }
});

test("forward-only拒绝其他源版本、残缺历史、混合16结构及错误候选身份",async t=>{
  for(const variant of ["v15","v17","v20","gap","mixed","wrong-release"]){
    const f=await fixture(t);
    if(variant==="v15")f.db.exec("DELETE FROM qm_schema_migrations WHERE version=16");
    if(variant==="v17"||variant==="v20")f.db.prepare("INSERT INTO qm_schema_migrations VALUES(?,'unreviewed','fixture')").run(Number(variant.slice(1)));
    if(variant==="gap")f.db.exec("DELETE FROM qm_schema_migrations WHERE version=7");
    if(variant==="mixed")f.db.exec("ALTER TABLE execution_claims ADD COLUMN execution_id TEXT");
    const before=capturedRows(f.db),oldVersion=version(f.db);
    await assert.rejects(databaseMigration({...f.manifest,...(variant==="wrong-release"?{sourceCommit:"b".repeat(40)}:{})}),
      /仅接受已审核|拒绝混合结构|候选发行身份/);
    assert.equal(version(f.db),oldVersion);assert.deepEqual(capturedRows(f.db),before);
  }
});

test("forward-only策略须显式无备份；CLI不接受隐式迁移选择",async()=>{
  await assert.rejects(activateInstallation("not-read.json",{migrationPolicy:"forward-only"}),/backup:false/);
  await assert.rejects(activateInstallation("not-read.json",{backup:false,migrationPolicy:"force"}),/migrationPolicy/);
  await assert.rejects(main(["activate","--prepared","not-read.json","--forward-only"]),/必须同时选择 --no-backup/);
});

async function activationFixture(t){
  const f=await fixture(t),requests=[],secret=token(),port=await freePort();
  const trace=join(f.root,"service-trace.jsonl"),stopped=join(f.root,"service-stopped");
  const server=http.createServer(async(req,res)=>{
    requests.push(req.url);res.setHeader("content-type","application/json");
    if(req.url==="/status"){
      const down=await readFile(stopped).then(()=>true,()=>false);
      res.end(JSON.stringify(down?null:{nodeId:"edge",release:previousCommit,components:[]}));return;
    }
    assert.equal(req.headers.authorization,`Bearer ${secret}`);
    if(req.url==="/maintenance/begin"||req.url==="/maintenance/resume"){res.end('{}');return;}
    res.writeHead(404).end();
  });
  await new Promise(resolve=>server.listen(port,"127.0.0.1",resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const config=join(f.root,"node.json"),stagedConfig=join(f.root,"staged.json"),unitFile=join(f.root,"fixture.service");
  await writeFile(join(f.root,"cluster.json"),JSON.stringify(cluster()));
  await writeFile(join(f.root,"secrets.env"),`QUAYMESH_CLUSTER_TOKEN=${secret}\n`);
  const configuration=JSON.stringify({schemaVersion:1,id:"edge",stateDir:f.stateDir,adminPort:port,capabilities:{worker:true},
    mesh:{enabled:false,address:"127.0.0.2"},clusterFile:join(f.root,"cluster.json"),secretsFile:join(f.root,"secrets.env")});
  await writeFile(config,configuration);await writeFile(stagedConfig,configuration);await writeFile(unitFile,"old-unit");
  const previous={...f.manifest,version:1,nodeId:"edge",sourceCommit:previousCommit,adminPort:port,unitFile,platform:"linux",user:true};
  await writeFile(join(f.root,"installation.json"),JSON.stringify(previous));
  const prepared={...previous,...f.manifest,configDir:f.root,config,stagedConfig,
    entrypoint:join(f.candidate,"bin","quaymesh.js")};
  const manifestFile=join(f.root,"prepared.json");await writeFile(manifestFile,JSON.stringify(prepared));
  return {...f,manifestFile,requests,trace,stopped};
}

test("CLI forward-only预检拒绝未审核版本或既有FK违例时恢复原暂停且尚未停服务",async t=>{
  for(const foreignKeyFailure of [false,true]){
    const f=await activationFixture(t);
    if(foreignKeyFailure){
      f.db.pragma("foreign_keys=OFF");f.db.exec("UPDATE qm_tasks SET session_id='missing-parent' WHERE id='task'");
    }else f.db.exec("DELETE FROM qm_schema_migrations WHERE version=16");
    await assert.rejects(main(["activate","--prepared",f.manifestFile,"--no-backup","--forward-only"]),
      foreignKeyFailure?/现有外键违例/:/仅接受已审核/);
    assert.deepEqual(f.requests,["/status","/maintenance/begin","/maintenance/resume"]);
    assert.equal(version(f.db),foreignKeyFailure?16:15);await assert.rejects(readFile(f.stopped),{code:"ENOENT"});
  }
});

test("正规stop后才迁移，提交19后新服务失败保留recovery_required且不启动旧16",{skip:process.platform!=="linux"},async t=>{
  const f=await activationFixture(t),bin=join(f.root,"fake-service-manager");await mkdir(bin);
  const executable=join(bin,"systemctl");
  await writeFile(executable,`#!${process.execPath}
import {appendFileSync,writeFileSync} from 'node:fs';import {createRequire} from 'node:module';
const Database=createRequire(${JSON.stringify(join(repository,"package.json"))})('better-sqlite3');
const db=new Database(${JSON.stringify(f.file)},{readonly:true});
const version=db.prepare('SELECT max(version) FROM qm_schema_migrations').pluck().get();db.close();
const action=process.argv.slice(2).find(value=>['stop','daemon-reload','enable'].includes(value));
appendFileSync(${JSON.stringify(f.trace)},JSON.stringify({action,version})+'\\n');
if(action==='stop')writeFileSync(${JSON.stringify(f.stopped)},'stopped');
if(action==='enable')process.exitCode=1;
`);await chmod(executable,0o755);
  const oldPath=process.env.PATH;process.env.PATH=bin+":"+oldPath;
  t.after(()=>{process.env.PATH=oldPath;});
  const before=capturedRows(f.db);
  await assert.rejects(activateInstallation(f.manifestFile,{backup:false,migrationPolicy:"forward-only"}),/发行切换失败/);
  const trace=(await readFile(f.trace,"utf8")).trim().split("\n").map(value=>JSON.parse(value));
  assert.deepEqual(trace,[{action:"stop",version:16},{action:"daemon-reload",version:19},{action:"enable",version:19}]);
  assert.equal(version(f.db),19);assertOldRows(f.db,before);
  const transition=JSON.parse(await readFile(join(f.stateDir,"installation-transition.json"),"utf8"));
  assert.equal(transition.phase,"recovery_required");assert.equal(transition.database.version,16);
  assert.equal(transition.database.backup,null);assert.equal(transition.currentDatabaseVersion,19);
  assert.equal(transition.databaseMigration.verified,true);
  assert.equal(f.requests.includes("/maintenance/resume"),false);
  assert.equal(JSON.parse(await readFile(join(f.root,"installation.json"),"utf8")).sourceCommit,previousCommit);
});

test("forward-only提交后的启动标记通过398实际启动预算检查，恢复仍以原16为边界",{skip:process.platform!=="linux"},async t=>{
  const f=await activationFixture(t),bin=join(f.root,"fake-service-manager");await mkdir(bin);
  const transitionFile=join(f.stateDir,"installation-transition.json"),executable=join(bin,"systemctl");
  await writeFile(executable,`#!${process.execPath}
import {appendFileSync,readFileSync,writeFileSync} from 'node:fs';import {createRequire} from 'node:module';
import {installationStartupBudget} from ${JSON.stringify(pathToFileURL(join(repository,"node","app.mjs")).href)};
const Database=createRequire(${JSON.stringify(join(repository,"package.json"))})('better-sqlite3');
const db=new Database(${JSON.stringify(f.file)},{readonly:true});
const version=db.prepare('SELECT max(version) FROM qm_schema_migrations').pluck().get();db.close();
const action=process.argv.slice(2).find(value=>['stop','daemon-reload','enable'].includes(value));
const observation={action,version};
if(action==='daemon-reload'){
  const marker=JSON.parse(readFileSync(${JSON.stringify(transitionFile)},'utf8'));
  observation.startupVersion=marker.database?.version;
  observation.beforeVersion=marker.databaseBeforeMigration?.version;
  try{observation.budget=await installationStartupBudget(${JSON.stringify(f.candidate)},marker,${JSON.stringify(commit)});}
  catch(error){observation.startupError=error.message;process.exitCode=1;}
}
appendFileSync(${JSON.stringify(f.trace)},JSON.stringify(observation)+'\\n');
if(action==='stop')writeFileSync(${JSON.stringify(f.stopped)},'stopped');
if(action==='enable')process.exitCode=1;
`);await chmod(executable,0o755);
  const oldPath=process.env.PATH;process.env.PATH=bin+":"+oldPath;
  t.after(()=>{process.env.PATH=oldPath;});
  await assert.rejects(activateInstallation(f.manifestFile,{backup:false,migrationPolicy:"forward-only"}),/发行切换失败/);
  const trace=(await readFile(f.trace,"utf8")).trim().split("\n").map(value=>JSON.parse(value));
  const startup=trace.find(value=>value.action==="daemon-reload");
  assert.equal(startup?.startupError,undefined,"the unchanged 398 startup check must accept the post-migration marker");
  assert.deepEqual(trace,[{action:"stop",version:16},{action:"daemon-reload",version:19,
    startupVersion:19,beforeVersion:16,budget:{coreReadinessMs:30000}},{action:"enable",version:19}]);
  const recovery=JSON.parse(await readFile(transitionFile,"utf8"));
  assert.equal(recovery.phase,"recovery_required");assert.equal(recovery.database.version,16);
  assert.equal(recovery.database.backup,null);assert.equal(recovery.currentDatabaseVersion,19);
  assert.equal(recovery.databaseBeforeMigration.version,16);assert.equal(recovery.databaseMigration.version,19);
  assert.equal(f.requests.includes("/maintenance/resume"),false);
  assert.equal(JSON.parse(await readFile(join(f.root,"installation.json"),"utf8")).sourceCommit,previousCommit);
});

test("迁移提交后的回执丢失不是回滚证明，读取真实19后拒绝旧版恢复",{skip:process.platform!=="linux"},async t=>{
  const f=await fixture(t),wrapper=join(f.root,"drop-migration-receipt.mjs");
  await writeFile(wrapper,`#!${process.execPath}
import {spawn} from 'node:child_process';
const child=spawn(${JSON.stringify(process.execPath)},process.argv.slice(2),{stdio:['ignore','ignore','inherit']});
child.once('error',()=>{process.exitCode=1;});child.once('close',code=>{process.exitCode=code??1;});
`);await chmod(wrapper,0o755);
  const snapshot=await databaseMigration(f.manifest);
  await assert.rejects(databaseMigration({...f.manifest,nodeExecutable:wrapper},{apply:true}));
  const current=await databaseSnapshot({...f.manifest,directory:repository});
  assert.equal(current.version,19);
  await assert.rejects(enforceInstallationRollbackBoundary({manifest:f.manifest,previous:{sourceCommit:"old-schema-16"},
    transition:{id:"lost-receipt"},snapshot,current,error:new Error("receipt lost")}),/旧版本无法自动启动/);
  assert.equal(JSON.parse(await readFile(join(f.stateDir,"installation-transition.json"),"utf8")).phase,"recovery_required");
});
