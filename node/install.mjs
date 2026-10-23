import { cp, mkdir, access, chmod, readFile, readdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { loadNodeConfig, defaultConfigDir, secret } from "./config.mjs";
import { writeJson, atomicWrite, readOptionalJson } from "./files.mjs";
import { requestJson } from "./network.mjs";
import { restrictedEnvironment } from "./environment.mjs";
import { packageRoot } from "./app.mjs";
import { componentPlans } from "./compile.mjs";

const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
const REQUIRED_RELEASE_ENTRIES=["bin","node","dist","schema","skills","package.json","node_modules","components","runtime","release.json","components.lock.json","docs","scripts"];

export function releasePayloadEntries(release){
  const files=Array.isArray(release.payloadEntries)&&release.payloadEntries.length
    ? [...release.payloadEntries,"release.json"]
    : [...REQUIRED_RELEASE_ENTRIES,"LICENSE","NOTICE","THIRD_PARTY_NOTICES.md"];
  if(files.some(name=>typeof name!=="string"||!name||name.startsWith(".")||name.includes("/")||name.includes("\\")||name===".."))
    throw new Error("发行清单包含非法路径");
  if(new Set(files).size!==files.length)throw new Error("发行清单包含重复文件");
  for(const name of REQUIRED_RELEASE_ENTRIES)if(!files.includes(name))throw new Error(`发行缺少必要内容：${name}`);
  return files;
}

export async function preserveLatestNodeSettings(stagedConfig,configFile,expectedNodeId,settingsRevisionAtPrepare=1){
  const currentNode=await readOptionalJson(configFile);
  if(!currentNode)return false;
  if(currentNode.id!==expectedNodeId)throw new Error("正式配置在准备后被另一节点占用");
  if((currentNode.settingsRevision??1)<settingsRevisionAtPrepare)throw new Error("正式配置修订回退，禁止覆盖");
  const staged=JSON.parse(await readFile(stagedConfig,"utf8"));
  for(const key of ["nickname","roots","settingsRevision","consoleSettings"]){
    if(Object.hasOwn(currentNode,key))staged[key]=currentNode[key];
    else delete staged[key];
  }
  staged.settingsRevision=currentNode.settingsRevision??1;
  await writeJson(stagedConfig,staged);
  return true;
}

export async function copyReleasePayload(root,target,release){
  const files=releasePayloadEntries(release);
  for(const name of files)await access(join(root,name));
  for(const name of files)await cp(join(root,name),join(target,name),{recursive:true,dereference:true,errorOnExist:true,force:false});
  return files;
}
function run(command, args, options = {}) {
  return new Promise((resolveRun,reject) => {
    const child = spawn(command,args,{stdio:"inherit",shell:false,...options});
    child.once("error",reject);
    child.once("close",code => code === 0 ? resolveRun() : reject(new Error(`${command} 退出码 ${code}`)));
  });
}
function quote(text) {
  if (/[\r\n\0]/.test(text)) throw new Error("服务参数包含换行");
  return `"${text.replaceAll("\\","\\\\").replaceAll('"','\\"').replaceAll("%","%%")}"`;
}
function unitPath(text) {
  if (!text.startsWith("/") || /[\r\n]/.test(text) || text.includes(String.fromCharCode(0))) {
    throw new Error("systemd 工作目录需要绝对路径");
  }
  return text.replaceAll("\\","\\x5c").replaceAll(" ","\\x20").replaceAll("\t","\\x09").replaceAll("%","%%");
}
export function systemdUnit({nodeExecutable,entrypoint,configFile,directory,serviceUser,user = true}) {
  if (serviceUser && !/^[a-z_][a-z0-9_-]*[$]?$/.test(serviceUser)) throw new Error("服务用户名称无效");
  return ["[Unit]","Description=QuayMesh Node","After=network-online.target","Wants=network-online.target","",
    "[Service]","Type=simple",`WorkingDirectory=${unitPath(directory)}`,
    `ExecStart=${quote(nodeExecutable)} ${quote(entrypoint)} run --config ${quote(configFile)}`,
    ...(serviceUser ? [`User=${serviceUser}`] : []),
    "Restart=on-failure","RestartSec=3","TimeoutStopSec=90","KillMode=mixed","UMask=0077","",
    "[Install]",`WantedBy=${user ? "default.target" : "multi-user.target"}`,""].join("\n");
}

export async function prepareInstallation(file, {root=packageRoot,prefix,user=true,serviceUser,
  configDir,platform=process.platform} = {}) {
  if (!["linux","win32"].includes(platform)) throw new Error(`安装器尚不支持 ${platform}`);
  if (user && serviceUser) throw new Error("专用服务用户需要 --system");
  const loaded = await loadNodeConfig(file);
  configDir ||= serviceUser ? join("/etc/quaymesh",loaded.node.id) : defaultConfigDir();
  if (serviceUser) {
    if (platform !== "linux") throw new Error("专用系统用户安装适用于 Linux");
    await run("id",[serviceUser]);
    if (loaded.node.stateDir === "/root" || loaded.node.stateDir.startsWith("/root/")) {
      throw new Error("专用用户需要可访问的 stateDir，例如 /var/lib/quaymesh");
    }
  }
  const release = await readOptionalJson(join(root,"release.json"));
  if (!release?.sourceCommit || release.uncommittedSource) throw new Error("安装需要已经提交源码的完整发行包");
  const expectedPlatform = `${platform === "win32" ? "windows" : platform}-${process.arch}`;
  if (release.platform !== expectedPlatform) throw new Error(`发行平台 ${release.platform} 与本机 ${expectedPlatform} 不同`);
  const base = serviceUser ? "/opt/quaymesh" : platform === "win32" ? join(process.env.LOCALAPPDATA || homedir(),"QuayMesh") : join(homedir(),".local","share","quaymesh");
  const target = resolve(prefix || join(base,"releases",`${release.sourceCommit}-${release.platform}`));
  if (target === resolve(root)) throw new Error("安装目录必须与发行来源目录分开");
  const existing = await readdir(target).catch(error => { if(error.code === "ENOENT") return []; throw error; });
  if (existing.length) throw new Error(`发行目录已存在，不能覆盖：${target}`);
  const stage = join(resolve(configDir),"installations",randomUUID());
  const configFile=join(resolve(configDir),"node.json");
  const existingNode=await readOptionalJson(configFile);
  if(existingNode&&existingNode.id!==loaded.node.id)throw new Error("已有持久节点配置属于其他节点，拒绝覆盖");
  const effective=existingNode?await loadNodeConfig(configFile):loaded;
  let prepared = false;
  await mkdir(target,{recursive:true});
  try {
    await copyReleasePayload(root,target,release);
    const executable = join(target,"runtime",platform === "win32" ? "node.exe" : "node");
    await access(executable);
    await run(executable,[join(target,"node","verify-installed.mjs")],{cwd:target,env:restrictedEnvironment(process.env)});
    await mkdir(stage,{recursive:true,mode:0o700});
    const clusterFile = join(stage,"cluster.json");
    await writeJson(clusterFile,effective.cluster);
    const savedNode = {...effective.rawNode,clusterFile,
      settingsRevision:effective.node.settingsRevision,
      stateDir:effective.node.stateDir,roots:effective.node.roots,
      components:effective.node.components,nodeRuntime:executable};
    if (effective.node.secretsFile) {
      const secrets = join(stage,"secrets.env");
      await atomicWrite(secrets,await readFile(effective.node.secretsFile),0o600);
      savedNode.secretsFile = secrets;
    }
    const stagedConfig = join(stage,"node.json");
    await writeJson(stagedConfig,savedNode);
    await loadNodeConfig(stagedConfig);
    const unitFile = platform === "linux" ? join(user ? join(homedir(),".config","systemd","user") : "/etc/systemd/system","quaymesh-node.service") : null;
    const manifest = {version:1,nodeId:loaded.node.id,directory:target,config:configFile,stagedConfig,
      configDir:resolve(configDir),stateDir:effective.node.stateDir,adminPort:effective.node.adminPort,
      nodeExecutable:executable,entrypoint:join(target,"bin","quaymesh.js"),
      sourceCommit:release.sourceCommit,platform,user,serviceUser:serviceUser || null,unitFile,
      settingsRevisionAtPrepare:savedNode.settingsRevision??1,
      desktopUi:effective.node.capabilities.desktopUi,preparedAt:new Date().toISOString()};
    if (platform === "linux") await atomicWrite(join(stage,"quaymesh-node.service"),systemdUnit({...manifest,configFile}),0o644);
    const manifestFile = join(stage,"prepared.json");
    await writeJson(manifestFile,manifest); prepared = true;
    return {...manifest,manifestFile};
  } finally {
    if (!prepared) { await rm(target,{recursive:true,force:true}); await rm(stage,{recursive:true,force:true}); }
  }
}

async function registeredService(manifest,start) {
  if (manifest.platform === "linux") {
    await atomicWrite(manifest.unitFile,systemdUnit({...manifest,configFile:manifest.config}),0o644);
    if (manifest.serviceUser) {
      await run("id",[manifest.serviceUser]);
      for (const path of [manifest.configDir,manifest.stateDir]) {
        await mkdir(path,{recursive:true});
        await run("chown",["-R",manifest.serviceUser,path]);
      }
    }
    await run("systemctl",[...(manifest.user?["--user"]:[]),"daemon-reload"]);
    if (start) await run("systemctl",[...(manifest.user?["--user"]:[]),"enable","--now","quaymesh-node.service"]);
  } else {
    await run("powershell.exe",["-NoProfile","-ExecutionPolicy","Bypass","-File",join(manifest.directory,"node","windows-install.ps1"),
      "-NodeExecutable",manifest.nodeExecutable,"-EntryPoint",manifest.entrypoint,
      "-Config",manifest.config,"-Directory",manifest.directory,
      ...(manifest.desktopUi?["-DesktopUi"]:[]),...(start?["-Start"]:[])]);
  }
}
async function stopService(manifest) {
  if (manifest.platform === "linux") await run("systemctl",[...(manifest.user?["--user"]:[]),"stop","quaymesh-node.service"]);
  else {
    if (manifest.desktopUi) await run(join(manifest.directory,"components","windows-x64","QuayMesh.Host.exe"),["--exit"]);
    await run("powershell.exe",["-NoProfile","-ExecutionPolicy","Bypass","-File",join(manifest.directory,"node","windows-stop.ps1")]);
  }
}
async function runningStatus(port) {
  try { return await requestJson(`http://127.0.0.1:${port}/status`,{timeoutMs:2500}); }
  catch (error) { if (error.code === "ECONNREFUSED") return null; throw error; }
}
export async function waitRunning(manifest,token,timeoutMs,{stableMs=60000,resume=true}={}) {
  const deadline = performance.now()+timeoutMs;
  const release=manifest.directory?await readOptionalJson(join(manifest.directory,"release.json")):undefined;
  const fingerprints=Boolean(release?.runtime||release?.nativeDependencies);
  const configuration=manifest.config?await loadNodeConfig(manifest.config):undefined;
  const requiredIds=new Set(configuration?componentPlans(configuration.node,configuration.cluster,configuration.env,{
    root:manifest.directory,generatedDir:join(configuration.node.stateDir,"generated"),
    configDir:join(configuration.node.stateDir,"generated","core"),release:manifest.sourceCommit,
  }).map(plan=>plan.id):["core"]);
  requiredIds.add("core");
  let stableSince=0,identity,lastFailure;
  while (performance.now()<deadline) {
    const state = await runningStatus(manifest.adminPort).catch(error=>{
      if(["ECONNRESET","ECONNREFUSED","ETIMEDOUT","ECONNABORTED"].includes(error.code))return null;
      throw error;
    });
    const core=state?.components?.find(value=>value.id==="core");
    const components=Array.isArray(state?.components)?state.components:[];
    // Compatibility for callers without a configuration manifest: once
    // observed, a component cannot disappear from this verification window.
    if(!configuration){
      for(const value of components)requiredIds.add(value.id);
      if(state?.capabilities?.discovery)requiredIds.add("discovery");
    }
    const required=[...requiredIds].sort().map(id=>({id,matches:components.filter(value=>value.id===id)}));
    const unready=required.filter(({matches})=>{
      const value=matches[0];
      return matches.length!==1||value.state!=="ready"||value.processState!=="running"||
        !Number.isInteger(value.pid)||value.pid<=0||!Number.isInteger(value.restarts)||value.restarts<0||
        !Number.isFinite(value.startedAt)||value.startedAt<=0||
        !Number.isFinite(value.observedAt)||Date.now()-value.observedAt>20000||
        value.observedAt-Date.now()>5000||value.crashLoop||value.error||value.probeError;
    });
    if(unready.length)lastFailure="必要组件未就绪："+unready.map(({id,matches})=>
      id+"("+((matches.length===1?matches[0].state:matches.length?"duplicate":"missing")||"unknown")+")").join(", ");
    let activeRelease,coreIdentityMatches=true;
    if(fingerprints){
      activeRelease=await readOptionalJson(join(manifest.stateDir,"core","active-release.json"));
      const actual=activeRelease?.runtime;
      const expected=release.nativeDependencies?.["better-sqlite3"];
      coreIdentityMatches=activeRelease?.commit===manifest.sourceCommit&&activeRelease.pid===core?.pid&&
        actual?.nodeVersion===release.node&&actual?.nodeAbi===release.nodeAbi&&
        actual?.sqlitePackageVersion===expected?.version&&actual?.sqliteNativeSha256===expected?.sha256&&
        actual?.nodeSha256===release.runtime?.nodeSha256&&actual?.packageLockSha256===release.runtime?.packageLockSha256&&
        typeof actual?.sqliteNativeSha256==="string"&&/^[0-9a-f]{64}$/.test(actual.sqliteNativeSha256);
      if(!coreIdentityMatches)lastFailure="Core 进程身份、Node 或 SQLite 实际指纹与发行清单不符";
    }
    if (state?.nodeId===manifest.nodeId && state.release===manifest.sourceCommit &&
      !unready.length && coreIdentityMatches) {
      const nextIdentity=JSON.stringify(required.map(({id,matches:[value]})=>[id,value.pid,value.startedAt,value.restarts]));
      if(identity!==nextIdentity){identity=nextIdentity;stableSince=performance.now();}
      lastFailure=undefined;
      if(performance.now()-stableSince>=stableMs){
        if(resume)await requestJson(`http://127.0.0.1:${manifest.adminPort}/maintenance/resume`,{method:"POST",token,timeoutMs:10000});
        return {...state,...(activeRelease?{activeCoreRelease:activeRelease}:{})};
      }
    }else{identity=undefined;stableSince=0;}
    await sleep(500);
  }
  throw new Error(`新发行服务没有在规定时间内报告正确身份和就绪状态${lastFailure?`：${lastFailure}`:""}`);
}

function databaseSnapshot(manifest,target) {
  return new Promise((resolveSnapshot,reject)=>{
    const child=spawn(manifest.nodeExecutable,[join(manifest.directory,"node","database-snapshot.mjs"),manifest.stateDir,...(target?[target]:[])],
      {stdio:["ignore","pipe","inherit"],shell:false,windowsHide:true,env:restrictedEnvironment(process.env)});
    let output="";
    child.stdout.on("data",chunk=>{output+=chunk;if(output.length>65536)child.kill();});
    child.once("error",reject);
    child.once("close",code=>{
      if(code!==0){reject(new Error(`数据库升级前检查失败，退出码 ${code}`));return;}
      try{resolveSnapshot(JSON.parse(output));}catch(error){reject(error);}
    });
  });
}

export async function activateInstallation(manifestFile,{timeoutMs=180000}={}) {
  const manifest = JSON.parse(await readFile(resolve(manifestFile),"utf8"));
  if (manifest.version!==1) throw new Error("安装记录版本无效");
  await preserveLatestNodeSettings(manifest.stagedConfig,manifest.config,manifest.nodeId,manifest.settingsRevisionAtPrepare??1);
  const loaded = await loadNodeConfig(manifest.stagedConfig);
  const token = secret(loaded.env,loaded.cluster.tokenEnv,24);
  const recordFile = join(manifest.configDir,"installation.json");
  const previous = await readOptionalJson(recordFile);
  const running = await runningStatus(previous?.adminPort ?? manifest.adminPort);
  if (running && running.nodeId!==manifest.nodeId) throw new Error("该管理端口属于其他节点");
  if (running && !previous) throw new Error("当前服务尚无安装记录；请在独立维护窗口停止它，再激活已准备的发行包");
  if (previous && previous.nodeId!==manifest.nodeId) throw new Error("安装目录属于其他节点");
  const oldConfig = await readFile(manifest.config).catch(error => { if(error.code==="ENOENT")return null;throw error; });
  const oldUnit = manifest.unitFile ? await readFile(manifest.unitFile).catch(error => {if(error.code==="ENOENT")return null;throw error;}) : null;
  let stopped = false, stopAttempted = false, maintenanceBegun = false, activationCommitted=false;
  const transitionFile=join(manifest.stateDir,"installation-transition.json");
  const priorTransition=await readOptionalJson(transitionFile);
  if(priorTransition)throw new Error(`已有未收口的发行切换 ${priorTransition.sourceCommit}；请先核对安装记录与数据库备份。`);
  let snapshot;
  try {
    if (running) {
      await requestJson(`http://127.0.0.1:${previous.adminPort}/maintenance/begin`,{method:"POST",token,timeoutMs:35000});
      maintenanceBegun = true;
    }
    snapshot=await databaseSnapshot(manifest,join(dirname(resolve(manifestFile)),"rollback-core.sqlite"));
    await writeJson(transitionFile,{id:randomUUID(),sourceCommit:manifest.sourceCommit,previousCommit:previous?.sourceCommit??null,
      startedAt:new Date().toISOString(),ownerPid:process.pid,database:snapshot,phase:"validating"});
    if(running){
      stopAttempted = true;
      await stopService(previous); stopped = true;
    }
    await atomicWrite(manifest.config,await readFile(manifest.stagedConfig));
    await registeredService(manifest,true);
    const status = await waitRunning(manifest,token,timeoutMs,{resume:false});
    await writeJson(recordFile,{...manifest,activatedAt:new Date().toISOString(),pid:status.components.find(value=>value.id==="core")?.pid});
    await writeJson(join(manifest.configDir,"previous-installation.json"),previous??null);
    activationCommitted=true;
    await rm(transitionFile,{force:true});
    await requestJson(`http://127.0.0.1:${manifest.adminPort}/maintenance/resume`,{method:"POST",token,timeoutMs:10000});
    return {directory:manifest.directory,config:manifest.config,sourceCommit:manifest.sourceCommit,activated:true};
  } catch (error) {
    if(activationCommitted)throw new Error("发行已经验证并提交，恢复准入尚待确认；保留当前服务，请查询管理端状态。",{cause:error});
    if (stopAttempted || stopped || !running) {
      try {
        const active = await runningStatus(manifest.adminPort);
        if (active?.nodeId === manifest.nodeId) await stopService(manifest);
        const current=await databaseSnapshot(manifest);
        if(snapshot && current.version!==snapshot.version){
          await writeJson(transitionFile,{sourceCommit:manifest.sourceCommit,previousCommit:previous?.sourceCommit??null,
            database:snapshot,currentDatabaseVersion:current.version,phase:"recovery_required",error:String(error)});
          throw new Error(`数据库已从 ${snapshot.version} 升级到 ${current.version}，保留新版数据和备份 ${snapshot.backup}；旧版本无法自动启动，请完成升级恢复。`);
        }
        if (oldConfig) await atomicWrite(manifest.config,oldConfig); else await rm(manifest.config,{force:true});
        if (oldUnit) await atomicWrite(manifest.unitFile,oldUnit,0o644);
        await rm(transitionFile,{force:true});
        if (previous) { await registeredService(previous,true); await waitRunning(previous,token,timeoutMs); }
        else if (manifest.unitFile) {
          await rm(manifest.unitFile,{force:true});
          await run("systemctl",[...(manifest.user?["--user"]:[]),"daemon-reload"]);
        } else await run("powershell.exe",["-NoProfile","-ExecutionPolicy","Bypass","-File",join(manifest.directory,"node","windows-stop.ps1"),"-Unregister"]);
      } catch (recovery) { throw new AggregateError([error,recovery],"发行切换失败，恢复未完成"); }
    } else if (maintenanceBegun && running) {
      await rm(transitionFile,{force:true});
      await requestJson(`http://127.0.0.1:${previous.adminPort}/maintenance/resume`,{method:"POST",token,timeoutMs:10000});
    }
    throw error;
  }
}

export async function installNode(file,options={}) {
  const prepared = await prepareInstallation(file,options);
  if (options.start===false) return {...prepared,activated:false};
  return activateInstallation(prepared.manifestFile);
}
