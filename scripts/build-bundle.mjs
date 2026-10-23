import { readFile,mkdir,cp,access,rm,writeFile,readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname,resolve,join } from "node:path";
import { fileURLToPath } from "node:url";
import { platformName } from "../node/compile.mjs";
import { parse, stringify } from "yaml";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

const root=fileURLToPath(new URL("..",import.meta.url));
const pkg=JSON.parse(await readFile(join(root,"package.json"),"utf8"));
const label=platformName();
if (!["linux-x64","linux-arm64","windows-x64"].includes(label)) throw new Error(`不支持的发行平台：${label}`);
const components=JSON.parse(await readFile(join(root,"components.lock.json"),"utf8"));
const packageRequire=createRequire(join(root,"package.json"));
const sqlitePackage=packageRequire("better-sqlite3/package.json");
if (process.versions.node !== components.node) throw new Error(`发行构建需要 Node.js ${components.node}`);
const exe=name=>name+(process.platform==="win32"?".exe":"");
function run(command,args,cwd=root){
  return new Promise((done,reject)=>{
    const child=spawn(command,args,{cwd,stdio:"inherit",shell:false});
    child.once("error",reject);
    child.once("close",code=>code===0?done():reject(new Error(`${command} 退出码 ${code}`)));
  });
}
function capture(command,args,cwd=root){
  return new Promise((done,reject)=>{
    const child=spawn(command,args,{cwd,stdio:["ignore","pipe","pipe"],shell:false});
    let out="",err="";
    child.stdout.on("data",chunk=>{out+=chunk;});
    child.stderr.on("data",chunk=>{err+=chunk;});
    child.once("error",reject);
    child.once("close",code=>code===0?done(out.trim()):reject(new Error(`${command} 退出码 ${code}：${err.trim()}`)));
  });
}
// release.json 必须记录真实 Git 提交；多个 0.1.0 构建靠 sourceCommit 区分。
async function sourceIdentity(){
  let commit=null,dirty=null;
  try {
    commit=await capture("git",["rev-parse","HEAD"],root);
    dirty=(await capture("git",["status","--porcelain"],root)).length>0;
  } catch(error){
    throw new Error(`发行构建需要 QuayMesh Git 仓库：${error.message}`);
  }
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`Git 提交格式无效：${commit}`);
  if (dirty) throw new Error("发行构建要求源码工作区干净，请先提交或还原改动");
  return {sourceCommit:commit,uncommittedSource:dirty};
}
const pnpm=process.env.npm_execpath;
if(!pnpm)throw new Error("请使用 pnpm build:bundle 运行");
const runPnpm=(args,cwd=root)=>pnpm.toLowerCase().endsWith(".exe")
  ? run(pnpm,args,cwd)
  : run(process.execPath,[pnpm,...args],cwd);
const identity=await sourceIdentity();
const output=join(root,"releases",`quaymesh-${pkg.version}-${identity.sourceCommit.slice(0,12)}-${label}`);
const present=await access(output).then(()=>true,error=>{if(error.code==="ENOENT")return false;throw error;});
if(present)throw new Error(`发行目录已存在，请保留现有发行并选择新的源码提交：${output}`);
await run(process.execPath,[join(root,"scripts","build.mjs")]);
for(const name of ["easytier-core","tunnel-client"])await access(join(root,"components",label,exe(name)));
if(process.platform==="win32"){
  await run("powershell.exe",["-NoProfile","-ExecutionPolicy","Bypass","-File",join(root,"scripts","build-windows.ps1")]);
}
await mkdir(output,{recursive:true});
for(const name of ["bin","node","dist","schema","components","package.json","pnpm-lock.yaml","pnpm-workspace.yaml","components.lock.json","README.md","docs","examples","skills","LICENSE","NOTICE","THIRD_PARTY_NOTICES.md","third_party"]){
  await cp(join(root,name),join(output,name),{recursive:true,dereference:true});
}
await mkdir(join(output,"scripts"),{recursive:true});
await cp(join(root,"scripts","analysis"),join(output,"scripts","analysis"),{recursive:true,dereference:true});
await cp(join(root,"scripts","recover-workspace-roots.mjs"),join(output,"scripts","recover-workspace-roots.mjs"));
if(process.platform==="win32")await cp(join(root,"scripts","windows-easytier-cutover.ps1"),join(output,"scripts","windows-easytier-cutover.ps1"));
await mkdir(join(output,"runtime"),{recursive:true});
await cp(process.execPath,join(output,"runtime",exe("node")));
const release={version:pkg.version,platform:label,createdAt:new Date().toISOString(),
  node:process.versions.node,nodeAbi:process.versions.modules,dependencies:{"better-sqlite3":sqlitePackage.version},
  sourceCommit:identity.sourceCommit,uncommittedSource:identity.uncommittedSource,components};
await writeFile(join(output,"release.json"),JSON.stringify(release,null,2)+"\n");
const installPackage=JSON.parse(await readFile(join(output,"package.json"),"utf8"));
delete installPackage.scripts.postinstall;
await writeFile(join(output,"package.json"),JSON.stringify(installPackage,null,2)+"\n");
// 发行暂存目录改用 hoisted 依赖布局，保证 ZIP 解压后仍有可解析的依赖入口。
const workspaceFile=join(output,"pnpm-workspace.yaml");
const workspace=parse(await readFile(workspaceFile,"utf8"));
workspace.nodeLinker="hoisted";
await writeFile(workspaceFile,stringify(workspace),"utf8");
await runPnpm(["install","--prod","--frozen-lockfile"],output);
// 只记录发行目录实际装载的二进制，避免源码安装与 hoisted 发行布局混淆。
const bundleRequire=createRequire(join(output,"package.json"));
const BundleDatabase=bundleRequire("better-sqlite3");
const probe=new BundleDatabase(":memory:");probe.prepare("SELECT 1").get();probe.close();
const nativePaths=new Set();
const visited=new Set();
function loadedNative(module){
  if(!module||visited.has(module.id))return;
  visited.add(module.id);
  if(module.filename?.endsWith(".node"))nativePaths.add(module.filename);
  for(const child of module.children??[])loadedNative(child);
}
loadedNative(bundleRequire.cache[bundleRequire.resolve("better-sqlite3")]);
if(nativePaths.size!==1)throw new Error("无法唯一确认发行实际加载的 SQLite 原生模块");
const hash=async path=>createHash("sha256").update(await readFile(path)).digest("hex");
const runtime={nodeSha256:await hash(join(output,"runtime",exe("node"))),packageLockSha256:await hash(join(output,"pnpm-lock.yaml"))};
const nativeDependencies={"better-sqlite3":{version:bundleRequire("better-sqlite3/package.json").version,sha256:await hash([...nativePaths][0])}};
const payloadEntries=(await readdir(output)).filter(name=>name!=="release.json"&&name!==".git").sort();
await writeFile(join(output,"release.json"),JSON.stringify({...release,runtime,nativeDependencies,payloadEntries},null,2)+"\n");
await run(join(output,"runtime",exe("node")),[join(output,"node","verify-installed.mjs")],output);
await run(process.execPath,[join(root,"scripts","archive-directory.mjs"),output]);
console.log(`发行目录：${output}`);
console.log(`源码提交：${identity.sourceCommit}`);
