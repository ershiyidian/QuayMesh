import { mkdtemp, rm, access, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// 从发行包自己的 package.json 解析依赖，验证解压后的依赖入口真实可用。
const here = dirname(fileURLToPath(import.meta.url));
const bundle = resolve(here, "..");
const require = createRequire(join(bundle, "package.json"));
const entry = require.resolve("./dist/server.js");
await access(entry);
const packageRoot = require.resolve("@modelcontextprotocol/sdk/client/index.js");
await access(packageRoot);

// 发行包若带 release.json，一并检查提交身份字段。
const release = JSON.parse(await readFile(join(bundle, "release.json"), "utf8"));
if (!/^[0-9a-f]{40}$/.test(String(release.sourceCommit || ""))) throw new Error("release.json 缺少有效 sourceCommit");
if (typeof release.uncommittedSource !== "boolean") throw new Error("release.json 缺少 uncommittedSource");
if (release.uncommittedSource) throw new Error("release.json 标记源码存在未提交修改");
for(const path of [
  "docs/PYTHON_WORKFLOW.md","docs/TOOL_CONTRACT.md",
  "scripts/analysis/summarize-quaymesh-log.py","scripts/analysis/aggregate-json-reports.py",
  "scripts/analysis/analysis_common.py",
  "scripts/recover-workspace-roots.mjs",
  "node/cutover-preflight.mjs",
  ...(process.platform==="win32" ? ["scripts/windows-easytier-cutover.ps1"] : []),
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
      result: "PASS",
    }, null, 2));
  } finally { database.close(); }
} finally { await rm(directory,{recursive:true,force:true}); }
