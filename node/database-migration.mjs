import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const FROM_VERSION=16, TO_VERSION=19;
const claimColumns=["execution_id","execution_generation","owner_process_start"];
const legacyColumns=["effort","task_name","error_code","error_retryable","context_key","context_signature",
  "work_item_id","progress","recovery_type","parent_provider_session_id","control_state","provider_turn_id","control_revision"];
const steps=[
  {version:17,name:"quaymesh-bounded-diagnostic-queries",indexes:[
    "qm_events_task_diagnostic_time","qm_invocations_task_diagnostic_time","qm_invocations_pending_state"]},
  {version:18,name:"quaymesh-exact-execution-claims",indexes:["execution_claims_execution"],
    nullableTextColumns:{execution_claims:claimColumns,execution_waiters:claimColumns}},
  {version:19,name:"quaymesh-local-user-api",tables:["qm_task_peer_messages","qm_task_peer_deliveries",
    "qm_local_api_grants","qm_local_api_dispatches","qm_local_api_verifiers"],indexes:[
    "qm_task_peer_source_rate","qm_task_peer_target_rate","qm_local_api_grants_owner",
    "qm_local_api_grants_expiry","qm_local_api_dispatches_expiry","qm_tasks_local_api_created"]},
];
const quote=name=>'"'+name.replaceAll('"','""')+'"';
const columns=(db,name)=>db.pragma(`table_info(${quote(name)})`);
const count=(db,name)=>db.prepare(`SELECT COUNT(*) FROM ${quote(name)}`).pluck().get();
const history=db=>db.prepare("SELECT version,name,applied_at FROM qm_schema_migrations ORDER BY version").all();
const objects=db=>db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
const equal=(left,right)=>JSON.stringify(left)===JSON.stringify(right);

function migrationPlan(db) {
  const recorded=history(db),version=recorded.at(-1)?.version;
  if(version!==FROM_VERSION||recorded.length!==FROM_VERSION||recorded.some((row,index)=>row.version!==index+1)
      ||recorded.at(-1)?.name!=="quaymesh-task-creation-receipts")
    throw new Error(`无备份向前迁移仅接受已审核的统一数据库 16→19，当前记录版本 ${version??0}。`);
  const schema=objects(db),names=new Set(schema.map(row=>row.name));
  for(const name of steps.flatMap(step=>[...(step.tables??[]),...step.indexes]))
    if(names.has(name))throw new Error(`数据库 16 包含目标结构 ${name}，拒绝未经审核的混合结构。`);
  for(const [table,required] of Object.entries({qm_events:["task_id","created_at","sequence"],
    qm_invocations:["task_id","finished_at","created_at","id","state"],qm_tasks:["id","created_at"],
    execution_claims:["id","owner_id","owner_pid","operation_id","task_id"],execution_waiters:["id"]})){
    const available=new Set(columns(db,table).map(column=>column.name));
    if(required.some(name=>!available.has(name)))throw new Error(`数据库 16 缺少已审核的 ${table} 结构。`);
    if(["execution_claims","execution_waiters"].includes(table)&&claimColumns.some(name=>available.has(name)))
      throw new Error(`数据库 16 已包含部分新版 ${table} 字段，拒绝混合结构。`);
  }
  if(db.prepare("PRAGMA foreign_key_check").get())
    throw new Error("向前迁移计划检测到现有外键违例；在停止服务前拒绝迁移。");
  const agentColumns=new Set(columns(db,"local_agent_sessions").map(column=>column.name));
  const thinking=agentColumns.has("thinking");
  const backfillRows=thinking?db.prepare(`SELECT COUNT(*) FROM local_agent_sessions WHERE thinking IS NOT NULL${agentColumns.has("effort")?" AND effort IS NULL":""}`).pluck().get():0;
  return {policy:"forward-only",fromVersion:FROM_VERSION,toVersion:TO_VERSION,steps,
    legacyAgentRepair:{hasThinking:thinking,missingColumns:thinking?legacyColumns.filter(name=>!agentColumns.has(name)):[],
      createTurns:thinking&&!names.has("local_agent_turns"),backfill:{table:"local_agent_sessions",column:"effort",fromColumn:"thinking",
        condition:"effort IS NULL AND thinking IS NOT NULL",rows:backfillRows}}};
}

function captureBefore(db) {
  const schema=objects(db),tables=schema.filter(row=>row.type==="table");
  return {schema,history:history(db),tables:tables.map(({name})=>({name,columns:columns(db,name),rows:count(db,name)}))};
}

function verifyAfter(db,before,plan,needsLegacyAgentRepair) {
  const after=objects(db),byName=new Map(after.map(row=>[row.name,row]));
  const recorded=history(db);
  if(recorded.length!==TO_VERSION||!equal(recorded.slice(0,FROM_VERSION),before.history)
      ||steps.some((step,index)=>recorded[FROM_VERSION+index]?.version!==step.version||recorded[FROM_VERSION+index]?.name!==step.name))
    throw new Error("向前迁移没有保留原结构版本记录或没有准确完成 17/18/19。");
  const changedTables=new Set(["execution_claims","execution_waiters",
    ...(plan.legacyAgentRepair.hasThinking?["local_agent_sessions"]:[])]);
  for(const original of before.schema){
    const actual=byName.get(original.name);
    if(!actual||actual.type!==original.type||actual.tbl_name!==original.tbl_name
        ||(!changedTables.has(original.name)&&actual.sql!==original.sql))
      throw new Error(`向前迁移意外改变原数据库对象 ${original.name}。`);
  }
  for(const original of before.tables){
    const actual=columns(db,original.name);
    const allowed=original.name==="execution_claims"||original.name==="execution_waiters"?claimColumns
      :original.name==="local_agent_sessions"?plan.legacyAgentRepair.missingColumns:[];
    if(!equal(actual.slice(0,original.columns.length),original.columns)
        ||actual.slice(original.columns.length).some(column=>!allowed.includes(column.name)))
      throw new Error(`向前迁移意外改变原字段 ${original.name}。`);
    const expected=original.rows+(original.name==="qm_schema_migrations"?steps.length:0);
    if(count(db,original.name)!==expected)throw new Error(`向前迁移意外改变原表行数 ${original.name}。`);
  }
  for(const step of steps){
    for(const name of step.indexes)if(byName.get(name)?.type!=="index")throw new Error(`向前迁移缺少索引 ${name}。`);
    for(const name of step.tables??[])if(byName.get(name)?.type!=="table"||count(db,name)!==0)
      throw new Error(`向前迁移新增表未通过空表验证 ${name}。`);
  }
  const expectedTables=new Set([...before.tables.map(row=>row.name),...steps.flatMap(step=>step.tables??[]),
    ...(plan.legacyAgentRepair.createTurns?["local_agent_turns"]:[])]);
  if(after.filter(row=>row.type==="table").some(row=>!expectedTables.has(row.name)))
    throw new Error("向前迁移产生未经审核的新表。");
  for(const table of ["execution_claims","execution_waiters"]){
    const available=new Map(columns(db,table).map(column=>[column.name,column]));
    if(claimColumns.some(name=>{const column=available.get(name);return !column||column.type!=="TEXT"||column.notnull!==0||column.dflt_value!==null||column.pk!==0;}))
      throw new Error(`向前迁移的 ${table} 新字段不是可空 TEXT。`);
    if(db.prepare(`SELECT 1 FROM ${quote(table)} WHERE ${claimColumns.map(name=>`${quote(name)} IS NOT NULL`).join(" OR ")} LIMIT 1`).get())
      throw new Error(`向前迁移意外为旧 ${table} 推断执行身份。`);
  }
  if(needsLegacyAgentRepair(db))throw new Error("向前迁移后的旧 Agent 修复未完成。");
  if(db.prepare("PRAGMA foreign_key_check").get())throw new Error("向前迁移后的外键检查失败。");
  return {oldTablesChecked:before.tables.length,foreignKeysVerified:true,legacyRepairVerified:true};
}

/** The operator owns this helper; the immutable candidate supplies its actual
 * SQLite addon and migration function. Never use openDatabase here: it migrates
 * before our outer transaction and post-migration validation can be installed. */
export async function forwardOnlyDatabaseMigration({directory,stateDir,sourceCommit,apply=false}) {
  if(typeof apply!=="boolean")throw new Error("迁移 apply 选项必须是显式布尔值。");
  directory=resolve(directory);stateDir=resolve(stateDir);
  const release=JSON.parse(await readFile(join(directory,"release.json"),"utf8"));
  if(!sourceCommit||release.sourceCommit!==sourceCommit||release.uncommittedSource)
    throw new Error("向前迁移的候选发行身份未通过验证。");
  const {migrateDatabase,LATEST_DATABASE_VERSION}=await import(pathToFileURL(join(directory,"dist","db","migrations.js")).href);
  const {needsLegacyAgentRepair}=await import(pathToFileURL(join(directory,"dist","db","legacy-agent-schema.js")).href);
  if(LATEST_DATABASE_VERSION!==TO_VERSION||typeof migrateDatabase!=="function"||typeof needsLegacyAgentRepair!=="function")
    throw new Error("无备份向前迁移仅支持目标结构版本 19。");
  const Database=createRequire(join(directory,"package.json"))("better-sqlite3");
  const db=new Database(join(stateDir,"core","quaymesh.sqlite"),{readonly:!apply,fileMustExist:true,timeout:3000});
  try{
    db.pragma("foreign_keys = ON");
    const execute=()=>{
      const plan=migrationPlan(db);
      const receipt={exists:true,version:FROM_VERSION,backup:null,migrationPolicy:"forward-only",
        fromVersion:FROM_VERSION,targetVersion:TO_VERSION,targetCommit:sourceCommit,verifiedForwardOnlyPlan:true,migrationPlan:plan};
      if(!apply)return receipt;
      const before=captureBefore(db);
      // migrateDatabase's immediate transaction becomes a nested savepoint.
      // This callback is synchronous: validation must finish before COMMIT.
      migrateDatabase(db);
      const verified=verifyAfter(db,before,plan,needsLegacyAgentRepair);
      return {...receipt,version:TO_VERSION,migrated:true,verified:true,...verified};
    };
    if(apply)return db.transaction(execute).immediate();
    db.exec("BEGIN");return execute();
  }finally{
    try{if(db.inTransaction)db.exec("ROLLBACK");}finally{db.close();}
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{
    const [action,directory,stateDir,sourceCommit]=process.argv.slice(2);
    if(!["plan","apply"].includes(action)||!directory||!stateDir||!sourceCommit||process.argv.length!==6)
      throw new Error("需要固定的 plan/apply、候选发行、状态目录和发行标识。");
    console.log(JSON.stringify(await forwardOnlyDatabaseMigration({directory,stateDir,sourceCommit,apply:action==="apply"})));
  }catch(error){console.log(JSON.stringify({error:error.message}));process.exitCode=1;}
}
