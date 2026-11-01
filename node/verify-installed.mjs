import { mkdtemp, rm, access, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { platformName } from "./compile.mjs";
import { verifyComponentBinaries } from "./component-binaries.mjs";

if (typeof globalThis.gc !== "function") {
  const child=spawnSync(process.execPath,["--expose-gc",process.argv[1]],{stdio:"inherit",env:process.env});
  if(child.error)throw child.error;
  if(child.signal)throw new Error(`发行验证进程异常退出：${child.signal}`);
  process.exit(child.status??1);
}

// 从发行包自己的 package.json 解析依赖，验证解压后的依赖入口真实可用。
const here = dirname(fileURLToPath(import.meta.url));
const bundle = resolve(here, "..");
const componentVersions = await verifyComponentBinaries(join(bundle, "components", platformName()));
const require = createRequire(join(bundle, "package.json"));
const packageJson=JSON.parse(await readFile(join(bundle,"package.json"),"utf8"));
const lock=JSON.parse(await readFile(join(bundle,"components.lock.json"),"utf8"));
if(process.versions.node!==lock.node)throw new Error(`发行 Node 版本不符：${process.versions.node}，期望 ${lock.node}`);
const nativeVersion=require("better-sqlite3/package.json").version;
if(nativeVersion!==packageJson.dependencies["better-sqlite3"])throw new Error(`发行 SQLite 依赖版本不符：${nativeVersion}`);
const Database=require("better-sqlite3");
const nativeDirectory=await mkdtemp(join(tmpdir(),"quaymesh-native-check-"));
try{
  const file=join(nativeDirectory,"probe.sqlite");
  let seed=new Database(file);seed.exec("CREATE TABLE probe(value INTEGER);INSERT INTO probe VALUES(42)");seed.close();seed=null;
  for(let index=0;index<500;index++){
    let db=index%2?new Database(file,{readonly:true,fileMustExist:true}):new Database(":memory:");
    let statement=db.prepare(index%2?"SELECT value FROM probe":"SELECT 42 AS value");
    if(statement.get().value!==42)throw new Error("SQLite 原生查询校验失败");
    db.close();db=null;statement=null;globalThis.gc();
  }
}finally{await rm(nativeDirectory,{recursive:true,force:true});}
const modules=[require.cache[require.resolve("better-sqlite3")]],seen=new Set(),nativeFiles=new Set();
while(modules.length){
  const module=modules.pop();if(!module||seen.has(module))continue;seen.add(module);
  if(module.filename.endsWith(".node"))nativeFiles.add(module.filename);
  modules.push(...module.children);
}
if(nativeFiles.size!==1)throw new Error("无法唯一识别发行验证实际加载的 SQLite 原生模块");
async function hashFile(path){
  const hash=createHash("sha256");for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest("hex");
}
const [nodeSha256,packageLockSha256,sqliteNativeSha256]=await Promise.all([
  hashFile(process.execPath),hashFile(join(bundle,"pnpm-lock.yaml")),hashFile([...nativeFiles][0]),
]);
const entry = require.resolve("./dist/server.js");
await access(entry);
const packageRoot = require.resolve("@modelcontextprotocol/sdk/client/index.js");
await access(packageRoot);

// 发行包若带 release.json，一并检查提交身份字段。
const release = JSON.parse(await readFile(join(bundle, "release.json"), "utf8"));
if (!/^[0-9a-f]{40}$/.test(String(release.sourceCommit || ""))) throw new Error("release.json 缺少有效 sourceCommit");
if (typeof release.uncommittedSource !== "boolean") throw new Error("release.json 缺少 uncommittedSource");
if (release.uncommittedSource) throw new Error("release.json 标记源码存在未提交修改");
if(release.node&&release.node!==process.versions.node)throw new Error("运行 Node 与发行清单不符");
if(release.nodeAbi&&release.nodeAbi!==process.versions.modules)throw new Error("运行 Node ABI 与发行清单不符");
if(release.runtime||release.nativeDependencies){
  for(const [name,actual,expected] of [
    ["Node",nodeSha256,release.runtime?.nodeSha256],
    ["依赖锁",packageLockSha256,release.runtime?.packageLockSha256],
    ["SQLite 原生模块",sqliteNativeSha256,release.nativeDependencies?.["better-sqlite3"]?.sha256],
  ])if(!/^[0-9a-f]{64}$/.test(String(expected??""))||actual!==expected)throw new Error(`${name} 实际字节与发行指纹不符`);
  if(release.nativeDependencies["better-sqlite3"].version!==nativeVersion)throw new Error("SQLite 实际包版本与发行指纹不符");
}
for(const path of [
  "docs/PYTHON_WORKFLOW.md","docs/TOOL_CONTRACT.md",
  "scripts/analysis/summarize-quaymesh-log.py","scripts/analysis/aggregate-json-reports.py",
  "scripts/analysis/analysis_common.py",
  "scripts/recover-workspace-roots.mjs",
  "node/cutover-preflight.mjs",
  ...(process.platform==="win32" ? ["scripts/windows-easytier-cutover.ps1","node/windows-activate.ps1"] : []),
])await access(join(bundle,...path.split("/")));
if(Array.isArray(release.payloadEntries)){
  for(const path of ["bin","node","dist","schema","skills","node_modules","components","runtime","docs","scripts"]){
    if(!release.payloadEntries.includes(path))throw new Error(`发行清单缺少 ${path}`);
  }
}

await import("../dist/server.js");
const { openDatabase } = await import("../dist/db/client.js");
const { LATEST_DATABASE_VERSION } = await import("../dist/db/migrations.js");
const directory = await mkdtemp(join(tmpdir(),"quaymesh-install-check-"));
try {
  const database = openDatabase(directory);
  try {
    const version = database.sqlite.prepare("SELECT max(version) AS version FROM qm_schema_migrations").get().version;
    if (version !== LATEST_DATABASE_VERSION) throw new Error(`数据库版本不符：${version}`);
    if (database.sqlite.pragma("integrity_check", {simple:true}) !== "ok") throw new Error("数据库检查失败");
    console.log(JSON.stringify({
      bundle,
      sourceCommit: release.sourceCommit,
      platform: release.platform,
      databaseVersion: version,
      dependenciesResolved: true,
      nativeDependencies:{"better-sqlite3":nativeVersion},
      componentVersions,
      nodeVersion:process.versions.node,nodeModuleAbi:process.versions.modules,nativeGcCycles:500,
      runtime:{nodeSha256,packageLockSha256},sqliteNativeSha256,
      result: "PASS",
    }, null, 2));
  } finally { database.close(); }
} finally { await rm(directory,{recursive:true,force:true}); }
