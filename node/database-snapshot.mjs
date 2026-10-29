import { createRequire } from "node:module";
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const require=createRequire(new URL("../package.json",import.meta.url));
export async function snapshotDatabase(stateDir,target,progress=()=>{}) {
  const file=join(resolve(stateDir),"core","quaymesh.sqlite");
  try{await access(file);}catch(error){if(error.code==="ENOENT")return {exists:false,version:0};throw error;}
  const Database=require("better-sqlite3");
  const db=new Database(file,{readonly:true,fileMustExist:true,timeout:3000});
  try{
    // A source read transaction keeps all incremental backup steps on one
    // WAL snapshot. Otherwise another connection's periodic writes restart
    // the copy, even while new command admission is paused.
    if(target)db.exec("BEGIN");
    const version=Number(db.prepare("SELECT max(version) AS version FROM qm_schema_migrations").get()?.version??0);
    if(target){
      target=resolve(target);
      const pageSize=db.pragma("page_size",{simple:true}),totalPages=db.pragma("page_count",{simple:true});
      const report=value=>progress({type:"database_snapshot_progress",version,pageSize,...value});
      report({totalPages,remainingPages:totalPages});
      const completed=await db.backup(target,{progress:report});
      report(completed);
      db.exec("COMMIT");
    }
    return {exists:true,version,backup:target??null};
  }finally{
    try{if(db.inTransaction)db.exec("ROLLBACK");}finally{db.close();}
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  let lastReport=-Infinity;
  try{
    const result=await snapshotDatabase(process.argv[2],process.argv[3],value=>{
      const now=performance.now();
      if(process.send&&(now-lastReport>=1000||value.remainingPages===0)){
        process.send(value);lastReport=now;
      }
    });
    console.log(JSON.stringify(result));
  }finally{if(process.connected)process.disconnect();}
}
