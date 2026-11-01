import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { migrateDatabase, LATEST_DATABASE_VERSION } from "../../dist/db/migrations.js";
import { activateInstallation, databaseSnapshot, enforceInstallationRollbackBoundary } from "../install.mjs";
import { main } from "../cli.mjs";
import { cluster, directory, freePort, token } from "./helpers.mjs";

const releaseRoot=fileURLToPath(new URL("../../",import.meta.url));
const manifest=stateDir=>({nodeExecutable:process.execPath,directory:releaseRoot,stateDir});

async function databaseFixture(t,{version=LATEST_DATABASE_VERSION,legacy=false}={}){
  const root=await directory(t);await mkdir(join(root,"core"));
  const file=join(root,"core","quaymesh.sqlite"),db=new Database(file);
  try{
    if(legacy)db.exec(`CREATE TABLE qm_schema_migrations(version INTEGER PRIMARY KEY);
      INSERT INTO qm_schema_migrations VALUES(${LATEST_DATABASE_VERSION});
      CREATE TABLE local_agent_sessions(id TEXT PRIMARY KEY,thinking TEXT);
      INSERT INTO local_agent_sessions VALUES('retained-agent','high');`);
    else{
      migrateDatabase(db);
      if(version<LATEST_DATABASE_VERSION)db.prepare("DELETE FROM qm_schema_migrations WHERE version>?").run(version);
      if(version>LATEST_DATABASE_VERSION)db.prepare("INSERT INTO qm_schema_migrations(version,name,applied_at) VALUES(?,'future','fixture')").run(version);
    }
  }finally{db.close();}
  return {root,file,manifest:manifest(root)};
}

test("显式无备份检查用真实候选SQLite只读连接，保持数据库内容且不创建复制文件",async t=>{
  const f=await databaseFixture(t),before=await readFile(f.file),files=await readdir(f.root);
  const result=await databaseSnapshot(f.manifest,undefined,{requireCurrentSchema:true});
  assert.deepEqual(result,{exists:true,version:LATEST_DATABASE_VERSION,backup:null,verifiedCurrentSchema:true});
  assert.deepEqual(await readFile(f.file),before);
  assert.deepEqual(await readdir(f.root),files);
  const writer=new Database(f.file);
  try{writer.exec("BEGIN IMMEDIATE;ROLLBACK");}finally{writer.close();}
});

test("无备份拒绝待迁移和降级数据库，原只读回退检查仍可读取它们",async t=>{
  for(const version of [LATEST_DATABASE_VERSION-1,LATEST_DATABASE_VERSION+1]){
    const f=await databaseFixture(t,{version}),before=await readFile(f.file);
    await assert.rejects(databaseSnapshot(f.manifest,undefined,{requireCurrentSchema:true}),
      new RegExp(`无备份升级检查失败.*当前 ${version}，目标 ${LATEST_DATABASE_VERSION}`));
    assert.deepEqual(await databaseSnapshot(f.manifest),{exists:true,version,backup:null});
    assert.deepEqual(await readFile(f.file),before);
    assert.deepEqual(await readdir(f.root),["core"]);
  }
});

test("同版本旧Agent仍待修复时拒绝无备份且保留所有旧字段和内容",async t=>{
  const f=await databaseFixture(t,{legacy:true}),before=await readFile(f.file);
  await assert.rejects(databaseSnapshot(f.manifest,undefined,{requireCurrentSchema:true}),/旧 Agent 数据结构或内容修复/);
  assert.deepEqual(await readFile(f.file),before);
  const db=new Database(f.file,{readonly:true});
  try{
    assert.deepEqual(db.prepare("SELECT * FROM local_agent_sessions").all(),[{id:"retained-agent",thinking:"high"}]);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='local_agent_turns'").get(),undefined);
  }finally{db.close();}
});

test("无备份检查拒绝不存在的数据库，不创建初始库",async t=>{
  const root=await directory(t);
  await assert.rejects(databaseSnapshot(manifest(root),undefined,{requireCurrentSchema:true}),/当前数据库不存在/);
  assert.deepEqual(await readdir(root),[]);
});

test("较旧快照助手不能把新增检查标志当作备份路径或伪装通过检查",async t=>{
  const root=await directory(t);await mkdir(join(root,"node"));
  await writeFile(join(root,"node","database-snapshot.mjs"),`
import {writeFileSync} from 'node:fs';import {join} from 'node:path';
if(process.argv[3])writeFileSync(join(process.argv[2],'unexpected-backup'),'bad-target');
console.log(JSON.stringify({exists:true,version:${LATEST_DATABASE_VERSION},backup:process.argv[3]||null}));
if(process.connected)process.disconnect();`);
  await assert.rejects(databaseSnapshot({...manifest(root),directory:root},undefined,{requireCurrentSchema:true}),/未确认无备份升级/);
  assert.deepEqual(await readdir(root),["node"]);
});

async function activationFixture(t,{legacy=false,running=true}={}){
  const f=await databaseFixture(t,{version:LATEST_DATABASE_VERSION-1,legacy}),requests=[],secret=token();
  const config=join(f.root,"node.json"),stagedConfig=join(f.root,"staged.json");
  // Invalid service basename ensures that even a regression reaching service
  // control cannot operate a real system unit from this integration fixture.
  const unitFile=join(f.root,"test-unit-with-no-service-suffix");
  let accepting=true;
  const status={nodeId:"edge",release:"old-commit",components:[]};
  const server=http.createServer((req,res)=>{
    requests.push(req.url);res.setHeader("content-type","application/json");
    if(req.url==="/status"){res.end(JSON.stringify(running?status:null));return;}
    assert.equal(req.headers.authorization,`Bearer ${secret}`);
    if(req.url==="/maintenance/begin"){accepting=false;res.end('{"paused":true}');return;}
    if(req.url==="/maintenance/resume"){accepting=true;res.end('{"paused":false}');return;}
    res.writeHead(404).end();
  });
  const port=await freePort();await new Promise(resolve=>server.listen(port,"127.0.0.1",resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  await writeFile(join(f.root,"cluster.json"),JSON.stringify(cluster()));
  await writeFile(join(f.root,"secrets.env"),`QUAYMESH_CLUSTER_TOKEN=${secret}\n`);
  const configuration=JSON.stringify({schemaVersion:1,id:"edge",stateDir:f.root,adminPort:port,
    capabilities:{worker:true},mesh:{enabled:false,address:"127.0.0.2"},secretsFile:"./secrets.env"});
  await writeFile(config,configuration);await writeFile(stagedConfig,configuration);await writeFile(unitFile,"original-service");
  const previous={version:1,nodeId:"edge",sourceCommit:"old-commit",adminPort:port,unitFile};
  const recordFile=join(f.root,"installation.json");await writeFile(recordFile,JSON.stringify(previous));
  const prepared={...f.manifest,version:1,nodeId:"edge",sourceCommit:"new-commit",configDir:f.root,
    config,stagedConfig,unitFile,adminPort:port,platform:"linux"};
  const manifestFile=join(f.root,"prepared.json");await writeFile(manifestFile,JSON.stringify(prepared));
  return {...f,manifestFile,requests,accepting:()=>accepting,protectedFiles:[config,unitFile,recordFile,f.file]};
}

test("activate无备份预检失败在停服务前释放本次暂停，原配置、安装记录、数据库保留",async t=>{
  for(const legacy of [false,true]){
    const f=await activationFixture(t,{legacy}),before=await Promise.all(f.protectedFiles.map(file=>readFile(file)));
    await assert.rejects(activateInstallation(f.manifestFile,{backup:false}),legacy?/旧 Agent/:/相同数据库版本/);
    assert.equal(f.accepting(),true);
    assert.deepEqual(f.requests,["/status","/maintenance/begin","/maintenance/resume"]);
    assert.deepEqual(await Promise.all(f.protectedFiles.map(file=>readFile(file))),before);
    assert.equal((await readdir(f.root)).some(name=>name.startsWith("rollback-")||name==="installation-transition.json"),false);
  }
});

test("旧服务未运行时预检失败不启动服务或进入回退",async t=>{
  const f=await activationFixture(t,{running:false});
  await assert.rejects(activateInstallation(f.manifestFile,{backup:false}),/相同数据库版本/);
  assert.deepEqual(f.requests,["/status"]);
});

test("CLI activate --no-backup真实传到只读预检并恢复暂停",async t=>{
  const f=await activationFixture(t);
  await assert.rejects(main(["activate","--prepared",f.manifestFile,"--no-backup"]),/无备份升级检查失败.*相同数据库版本/);
  assert.equal(f.accepting(),true);
  assert.deepEqual(f.requests,["/status","/maintenance/begin","/maintenance/resume"]);
  assert.equal((await readdir(f.root)).includes("rollback-core.sqlite"),false);
});

test("backup选项必须为显式布尔值",async()=>{
  for(const backup of ["false",0,null])await assert.rejects(activateInstallation("not-read.json",{backup}),/backup 必须是布尔值/);
});

test("无备份仍保留schema及preserve回退边界，恢复记录准确标明没有备份",async t=>{
  const f=await databaseFixture(t),snapshot=await databaseSnapshot(f.manifest,undefined,{requireCurrentSchema:true});
  const input={manifest:{stateDir:f.root,sourceCommit:"new-commit"},previous:{sourceCommit:"old-commit"},
    transition:{id:"owned-attempt",phase:"validating"},snapshot,current:{version:LATEST_DATABASE_VERSION},error:new Error("candidate failed")};
  await enforceInstallationRollbackBoundary(input);
  const transitionFile=join(f.root,"installation-transition.json");
  await assert.rejects(readFile(transitionFile),{code:"ENOENT"});
  for(const options of [{historyPolicy:"preserve"},{current:{version:LATEST_DATABASE_VERSION+1}}]){
    await assert.rejects(enforceInstallationRollbackBoundary({...input,...options}),/本次未创建备份/);
    const saved=JSON.parse(await readFile(transitionFile,"utf8"));
    assert.equal(saved.phase,"recovery_required");
    assert.deepEqual(saved.database,snapshot);
    assert.equal(saved.previousCommit,"old-commit");
  }
});
