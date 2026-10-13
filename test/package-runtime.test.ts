import assert from "node:assert/strict";
import test from "node:test";
import { readFile,access,mkdtemp,rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync=promisify(execFile),root=fileURLToPath(new URL("..",import.meta.url));
test("构建后的实际Core、SQLite、命令入口和静态卡片可以独立加载",async()=>{
  const require=createRequire(join(root,"package.json"));
  for(const module of ["./dist/server.js","@modelcontextprotocol/sdk/client/index.js","better-sqlite3","cross-spawn"])
    await access(require.resolve(module));
  await import("../dist/server.js");
  const {openDatabase}=await import("../dist/db/client.js");
  const {LATEST_DATABASE_VERSION}=await import("../dist/db/migrations.js");
  const state=await mkdtemp(join(tmpdir(),"quaymesh-package-test-"));
  try{
    const database=openDatabase(state);
    try{
      assert.equal(database.sqlite.prepare("SELECT max(version) AS version FROM qm_schema_migrations").get().version,LATEST_DATABASE_VERSION);
      assert.equal(database.sqlite.pragma("integrity_check",{simple:true}),"ok");
    }finally{database.close();}
  }finally{await rm(state,{recursive:true,force:true});}
  const html=await readFile(join(root,"dist","ui-card","workspace-app.html"),"utf8");
  assert.match(html,/<html/);assert.match(html,/QuayMesh/i);
  const help=await execFileAsync(process.execPath,[join(root,"bin","quaymesh.js"),"--help"],{cwd:root,timeout:10000});
  assert.match(help.stdout,/activate/);assert.match(help.stdout,/install/);
});
