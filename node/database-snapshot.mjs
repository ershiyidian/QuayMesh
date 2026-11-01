import { createRequire } from "node:module";
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const require=createRequire(new URL("../package.json",import.meta.url));
export async function snapshotDatabase(stateDir,target,progress=()=>{},{requireCurrentSchema=false}={}) {
  const file=join(resolve(stateDir),"core","quaymesh.sqlite");
  try{await access(file);}catch(error){
    if(error.code!=="ENOENT")throw error;
    if(requireCurrentSchema)throw new Error("无备份升级要求已存在的数据库；当前数据库不存在。");
    return {exists:false,version:0};
  }
  const Database=require("better-sqlite3");
  const db=new Database(file,{readonly:true,fileMustExist:true,timeout:3000});
  try{
    // A source read transaction keeps all incremental backup steps on one
    // WAL snapshot. Otherwise another connection's periodic writes restart
    // the copy, even while new command admission is paused.
    if(target||requireCurrentSchema)db.exec("BEGIN");
    const version=Number(db.prepare("SELECT max(version) AS version FROM qm_schema_migrations").get()?.version??0);
    if(requireCurrentSchema){
      const {LATEST_DATABASE_VERSION}=await import("../dist/db/migrations.js");
      if(!Number.isSafeInteger(LATEST_DATABASE_VERSION)||LATEST_DATABASE_VERSION<1)
        throw new Error("目标发行缺少有效的数据库结构版本。");
      if(version!==LATEST_DATABASE_VERSION)
        throw new Error(`无备份升级只允许相同数据库版本：当前 ${version}，目标 ${LATEST_DATABASE_VERSION}；保留当前服务。`);
      const {needsLegacyAgentRepair}=await import("../dist/db/legacy-agent-schema.js");
      if(needsLegacyAgentRepair(db))
        throw new Error("无备份升级检测到待执行的旧 Agent 数据结构或内容修复；保留当前服务。");
    }
    if(target){
      target=resolve(target);
      const pageSize=db.pragma("page_size",{simple:true}),totalPages=db.pragma("page_count",{simple:true});
      const report=value=>progress({type:"database_snapshot_progress",version,pageSize,...value});
      report({totalPages,remainingPages:totalPages});
      const completed=await db.backup(target,{progress:report});
      report(completed);
      db.exec("COMMIT");
    }
    return {exists:true,version,backup:target??null,...(requireCurrentSchema?{verifiedCurrentSchema:true}:{})};
  }finally{
    try{if(db.inTransaction)db.exec("ROLLBACK");}finally{db.close();}
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  let lastReport=-Infinity;
  const requireCurrentSchema=process.argv[4]==="--require-current-schema";
  try{
    const result=await snapshotDatabase(process.argv[2],process.argv[3]||undefined,value=>{
      const now=performance.now();
      if(process.send&&(now-lastReport>=1000||value.remainingPages===0)){
        process.send(value);lastReport=now;
      }
    },{requireCurrentSchema});
    console.log(JSON.stringify(result));
  }catch(error){
    if(!requireCurrentSchema)throw error;
    console.log(JSON.stringify({error:error.message}));process.exitCode=1;
  }finally{if(process.connected)process.disconnect();}
}
