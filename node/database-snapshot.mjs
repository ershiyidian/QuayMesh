import { createRequire } from "node:module";
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";

const require=createRequire(new URL("../package.json",import.meta.url));
const file=join(resolve(process.argv[2]),"core","quaymesh.sqlite");
let exists=true;
try{await access(file);}catch(error){if(error.code==="ENOENT")exists=false;else throw error;}
if(!exists)console.log(JSON.stringify({exists:false,version:0}));
else{
  const Database=require("better-sqlite3");
  const db=new Database(file,{readonly:true,fileMustExist:true,timeout:3000});
  try{
    const version=Number(db.prepare("SELECT max(version) AS version FROM qm_schema_migrations").get()?.version??0);
    const target=process.argv[3]?resolve(process.argv[3]):undefined;
    if(target)await db.backup(target);
    console.log(JSON.stringify({exists:true,version,backup:target??null}));
  }finally{db.close();}
}
