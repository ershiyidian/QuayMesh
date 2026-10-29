import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { databaseSnapshot } from "../install.mjs";
import { snapshotDatabase } from "../database-snapshot.mjs";
import { directory } from "./helpers.mjs";

const releaseRoot=fileURLToPath(new URL("../../",import.meta.url));
const manifest=stateDir=>({nodeExecutable:process.execPath,directory:releaseRoot,stateDir});

async function childFixture(t,program){
  const root=await directory(t);await mkdir(join(root,"node"));
  await writeFile(join(root,"node","database-snapshot.mjs"),`
import {writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
writeFileSync(join(process.argv[2],'child.pid'),String(process.pid));
const report=remainingPages=>process.send({type:'database_snapshot_progress',version:6,pageSize:4096,totalPages:4096,remainingPages});
const finish=()=>{report(0);console.log(JSON.stringify({exists:true,version:6,backup:resolve(process.argv[3])}));process.disconnect();};
${program}
`);
  return {root,manifest:{...manifest(root),directory:root},target:join(root,"rollback.sqlite")};
}
async function assertChildExited(root){
  const pid=Number(await readFile(join(root,"child.pid"),"utf8"));
  assert.throws(()=>process.kill(pid,0),error=>error.code==="ESRCH","The snapshot Promise must not settle while its child is alive.");
}

test("快照监控允许大数据库持续推进超过无进展时限，保留最终JSON回执",async t=>{
  const f=await childFixture(t,`report(4096);let remaining=4096;const timer=setInterval(()=>{
    remaining-=512;if(remaining<=0){clearInterval(timer);finish();}else report(remaining);
  },100);`);
  const started=performance.now();
  const result=await databaseSnapshot(f.manifest,f.target,{stallTimeoutMs:500,maxTimeoutMs:4000});
  assert.equal(result.version,6);assert.equal(result.backup,f.target);
  assert.ok(performance.now()-started>500);await assertChildExited(f.root);
});

test("快照监控的重复或倒退页数不续期，失败等待真实子进程结束",async t=>{
  const f=await childFixture(t,`report(4096);let ticks=0;setInterval(()=>report([4000,3800,4000,3800,3800][ticks++%5]),40);
process.on('SIGTERM',()=>setTimeout(()=>{writeFileSync(join(process.argv[2],'child-stopped'),'closed');process.exit(0);},80));`);
  await assert.rejects(databaseSnapshot(f.manifest,f.target,{stallTimeoutMs:400,maxTimeoutMs:3000}),
    error=>error.code==="DATABASE_SNAPSHOT_STALLED");
  await assertChildExited(f.root);
  if(process.platform!=="win32")assert.equal(await readFile(join(f.root,"child-stopped"),"utf8"),"closed");
});

test("快照监控的大小预算存在绝对总上限，进度不能无限延期",async t=>{
  const f=await childFixture(t,`report(4096);let remaining=4096;setInterval(()=>report(--remaining),30);`);
  await assert.rejects(databaseSnapshot(f.manifest,f.target,{stallTimeoutMs:500,maxTimeoutMs:800}),
    error=>error.code==="DATABASE_SNAPSHOT_DEADLINE");
  await assertChildExited(f.root);
});

test("快照监控拒绝复制途中改写源大小来延长预算",async t=>{
  const f=await childFixture(t,`report(4096);setTimeout(()=>process.send({type:'database_snapshot_progress',pageSize:4096,totalPages:8192,remainingPages:8000}),50);setInterval(()=>{},1000);`);
  await assert.rejects(databaseSnapshot(f.manifest,f.target,{stallTimeoutMs:500,maxTimeoutMs:2000}),/源快照已改变/);
  await assertChildExited(f.root);
});

test("首次安装无数据库仍能完成快照检查",async t=>{
  const root=await directory(t);
  assert.deepEqual(await databaseSnapshot(manifest(root),join(root,"rollback.sqlite")),{exists:false,version:0});
});

async function realDatabase(t){
  const {default:Database}=await import("better-sqlite3");
  const root=await mkdtemp(join(tmpdir(),"quaymesh-backup-"));await mkdir(join(root,"core"));
  const writer=new Database(join(root,"core","quaymesh.sqlite"));
  t.after(async()=>{try{writer.close();}finally{await rm(root,{recursive:true,force:true});}});
  writer.pragma("journal_mode=WAL");
  writer.exec(`CREATE TABLE qm_schema_migrations(version INTEGER);INSERT INTO qm_schema_migrations VALUES(6);
    CREATE TABLE work(value TEXT);INSERT INTO work VALUES('retained');CREATE TABLE padding(value BLOB);
    WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<256)
      INSERT INTO padding SELECT zeroblob(32768) FROM n;`);
  return {Database,root,writer};
}

test("真实WAL并发连接每批提交仍备份同一版本和内容，原生子进程也完成相同协议",async t=>{
  const {Database,root,writer}=await realDatabase(t),target=join(root,"rollback.sqlite");
  let commits=0,previous=Infinity,initial;
  const mutate=writer.transaction(()=>{
    commits++;writer.prepare("UPDATE qm_schema_migrations SET version=?").run(6+commits);
    writer.prepare("UPDATE work SET value=?").run("later-"+commits);
  });
  const result=await snapshotDatabase(root,target,value=>{
    initial??=value;
    assert.equal(value.totalPages,initial.totalPages);
    assert.ok(value.remainingPages<=previous,"The pinned source must not restart after the other connection commits.");
    previous=value.remainingPages;
    assert.ok(commits<Math.ceil(initial.totalPages/100)+10,"A repeated copy must fail this test instead of running indefinitely.");
    mutate(); // A real separate SQLite connection commits between native backup steps.
  });
  assert.ok(commits>3);assert.equal(result.version,6);
  const saved=new Database(target,{readonly:true});
  try{
    assert.equal(saved.pragma("quick_check",{simple:true}),"ok");
    assert.equal(saved.prepare("SELECT version FROM qm_schema_migrations").pluck().get(),6);
    assert.equal(saved.prepare("SELECT value FROM work").pluck().get(),"retained");
  }finally{saved.close();}
  assert.equal(writer.prepare("SELECT version FROM qm_schema_migrations").pluck().get(),6+commits);
  assert.equal(writer.pragma("wal_checkpoint(TRUNCATE)")[0].busy,0,"The read transaction is released after success.");
  const childResult=await databaseSnapshot(manifest(root),join(root,"child-rollback.sqlite"));
  assert.equal(childResult.version,6+commits);
});

test("真实备份中止后释放源读事务且不写源数据库",async t=>{
  const {root,writer}=await realDatabase(t);
  await assert.rejects(snapshotDatabase(root,join(root,"interrupted.sqlite"),value=>{
    if(value.remainingPages<value.totalPages)throw new Error("test interruption after actual copied pages");
  }),/after actual copied pages/);
  assert.equal(writer.pragma("wal_checkpoint(TRUNCATE)")[0].busy,0);
  assert.equal(writer.prepare("SELECT version FROM qm_schema_migrations").pluck().get(),6);
  assert.equal(writer.prepare("SELECT value FROM work").pluck().get(),"retained");
});
