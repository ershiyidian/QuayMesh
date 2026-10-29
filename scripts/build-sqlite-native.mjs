import {access,copyFile,cp,lstat,mkdir,open,readFile,readdir,realpath,rename,statfs,writeFile} from "node:fs/promises";
import {constants,createReadStream} from "node:fs";
import {createHash,randomUUID} from "node:crypto";
import {createRequire} from "node:module";
import {dirname,join,resolve,sep,isAbsolute} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import {parseArgs} from "node:util";
import {spawn} from "node:child_process";

const sourceEntries=["package.json","binding.gyp","src","deps","lib"];
const digest=value=>createHash("sha256").update(value).digest("hex");
const json=async file=>JSON.parse(await readFile(file,"utf8"));
async function hash(file){const value=createHash("sha256");for await(const chunk of createReadStream(file))value.update(chunk);return value.digest("hex");}
const versionOrder=(left,right)=>{const a=left.split(".").map(Number),b=right.split(".").map(Number);for(let i=0;i<Math.max(a.length,b.length);i++)if((a[i]??0)!==(b[i]??0))return(a[i]??0)-(b[i]??0);return 0;};
async function tree(directory,paths){
  const files=[];
  async function visit(name){const file=join(directory,name),info=await lstat(file);
    if(info.isSymbolicLink())throw new Error(`Native source contains a symbolic link: ${name}`);
    if(info.isDirectory()){for(const child of (await readdir(file)).sort())await visit(join(name,child));}
    else if(info.isFile())files.push({path:name,bytes:info.size,sha256:await hash(file)});
    else throw new Error(`Unexpected native source entry: ${name}`);
  }
  for(const name of paths)await visit(name);return {sha256:digest(JSON.stringify(files)),files};
}

export async function collectNativeBuildInputs(packageRoot){
  if(process.platform!=="linux"||!["x64","arm64"].includes(process.arch))throw new Error("SQLite source bundles require Linux x64 or arm64.");
  packageRoot=await realpath(packageRoot);
  const pkg=await json(join(packageRoot,"package.json")),components=await json(join(packageRoot,"components.lock.json"));
  if(process.versions.node!==components.node)throw new Error(`Native build requires the pinned Node.js ${components.node}.`);
  const require=createRequire(join(packageRoot,"package.json"));
  const sqliteDirectory=dirname(require.resolve("better-sqlite3/package.json"));
  const sqlite=await json(join(sqliteDirectory,"package.json"));
  if(sqlite.version!==pkg.dependencies?.["better-sqlite3"])throw new Error("Installed SQLite does not match the pinned dependency.");
  const addonDirectory=dirname(createRequire(join(sqliteDirectory,"package.json")).resolve("node-addon-api/package.json"));
  const addon=await json(join(addonDirectory,"package.json"));
  return {sqliteDirectory,addonDirectory,data:{platform:`${process.platform}-${process.arch}`,
    nodeVersion:process.versions.node,nodeAbi:process.versions.modules,nodeSha256:await hash(process.execPath),
    packageLockSha256:await hash(join(packageRoot,"pnpm-lock.yaml")),
    dependencies:{"better-sqlite3":sqlite.version,"node-addon-api":addon.version},
    sqliteSource:await tree(sqliteDirectory,sourceEntries),addonSource:await tree(addonDirectory,["."])}};
}

function environment(workDir){
  const env={...process.env,PATH:dirname(process.execPath)+":"+process.env.PATH,LC_ALL:"C"};
  for(const name of ["NODE_OPTIONS","NODE_PATH","LD_PRELOAD","LD_LIBRARY_PATH"])delete env[name];
  if(workDir)Object.assign(env,{TMPDIR:join(workDir,"tmp"),TMP:join(workDir,"tmp"),TEMP:join(workDir,"tmp"),
    npm_config_cache:join(workDir,"cache","npm"),npm_config_devdir:join(workDir,"cache","node-gyp"),
    npm_config_update_notifier:"false",PYTHONDONTWRITEBYTECODE:"1",PYTHONPYCACHEPREFIX:join(workDir,"cache","python"),
    XDG_CACHE_HOME:join(workDir,"cache","xdg"),CCACHE_DIR:join(workDir,"cache","ccache"),SCCACHE_DIR:join(workDir,"cache","sccache")});
  return env;
}
async function run(command,args,{cwd,env=environment(),timeoutMs=60000,logFile,onStep}={}){
  const entry={command,args,cwd,startedAt:new Date().toISOString()};await onStep?.(entry);
  const result=await new Promise(done=>{
    const child=spawn(command,args,{cwd,env,stdio:["ignore","pipe","pipe"],shell:false,detached:true});
    let out="",err="",failure,force;
    const signal=kind=>{if(child.pid)try{process.kill(-child.pid,kind);}catch(error){if(error.code!=="ESRCH")failure??=error;}};
    const stop=error=>{if(failure)return;failure=error;signal("SIGTERM");force=setTimeout(()=>signal("SIGKILL"),1000);};
    const timer=setTimeout(()=>stop(new Error("Owned native build or verification child timed out.")),timeoutMs);
    child.stdout.on("data",chunk=>{out+=chunk;if(Buffer.byteLength(out)>8*1024*1024)stop(new Error("Native stdout exceeded its bound."));});
    child.stderr.on("data",chunk=>{err+=chunk;if(Buffer.byteLength(err)>8*1024*1024)stop(new Error("Native stderr exceeded its bound."));});
    child.once("error",error=>{failure??=error;});
    child.once("close",(code,signal)=>{clearTimeout(timer);clearTimeout(force);done({out,err,code,signal,failure});});
  });
  Object.assign(entry,{finishedAt:new Date().toISOString(),exitCode:result.code,signal:result.signal});
  if(logFile){await writeFile(logFile,result.out+"\n"+result.err,{flag:"wx",mode:0o600});Object.assign(entry,{logFile,logSha256:await hash(logFile)});}
  await onStep?.(entry);
  if(result.failure)throw result.failure;
  if(result.code!==0)throw new Error(`${command} exited ${result.code}${logFile?`; inspect ${logFile}`:`: ${result.err.slice(-2000)}`}`);
  return result.out.trim();
}
async function inspectNative(artifactFile,maxGlibc,options={}){
  if(!/^\d+\.\d+$/.test(maxGlibc??""))throw new Error("An explicit maximum glibc version is required.");
  const versions=await run("readelf",["--version-info",artifactFile],options);
  const requiredGlibc=[...new Set([...versions.matchAll(/\bGLIBC_(\d+(?:\.\d+)+)/g)].map(match=>match[1]))].sort(versionOrder);
  if(!requiredGlibc.length||versionOrder(requiredGlibc.at(-1),maxGlibc)>0)throw new Error("Native artifact exceeds the requested glibc baseline.");
  const dynamic=await run("readelf",["-d",artifactFile],{...options,logFile:undefined});
  if(/\((?:RPATH|RUNPATH)\)/.test(dynamic)||/Shared library: \[libsqlite3/.test(dynamic))throw new Error("Native artifact has a private runtime path or external SQLite dependency.");
  const neededLibraries=[...dynamic.matchAll(/Shared library: \[([^\]]+)\]/g)].map(match=>match[1]);
  if(options.staticCxxRuntime&&neededLibraries.some(name=>/^(?:libstdc\+\+|libgcc_s)\./.test(name)))
    throw new Error("Requested static C++ runtime still depends on a shared C++ or GCC runtime.");
  return {requiredGlibc,neededLibraries,requiredGlibcxx:[...new Set([...versions.matchAll(/\bGLIBCXX_(\d+(?:\.\d+)+)/g)].map(match=>match[1]))].sort(versionOrder)};
}

export async function verifySqliteNativePackage(packageDirectory,artifactFile,{workDir,maxGlibc,onStep,staticCxxRuntime=false}={}){
  await mkdir(join(workDir,"tmp"),{recursive:true});await mkdir(join(workDir,"cache"),{recursive:true});
  const env=environment(workDir),elf=await inspectNative(artifactFile,maxGlibc,{cwd:workDir,env,onStep,staticCxxRuntime});
  const probe=`const {createRequire}=require('node:module'),fs=require('node:fs'),path=require('node:path');
const root=process.argv[1],artifact=process.argv[2],r=createRequire(path.join(root,'package.json')),Database=r('./lib');
const file=path.join(process.argv[3],'native-probe.sqlite');let seed=new Database(file);seed.exec('CREATE TABLE probe(value INTEGER);INSERT INTO probe VALUES(42)');
const sqliteVersion=seed.prepare('SELECT sqlite_version() AS version').get().version;seed.close();seed=null;
for(let i=0;i<500;i++){let db=i%2?new Database(file,{readonly:true,fileMustExist:true}):new Database(':memory:');let statement=db.prepare(i%2?'SELECT value FROM probe':'SELECT 42 AS value');if(statement.get().value!==42)throw new Error('Native query mismatch');db.close();db=null;statement=null;global.gc();}
const loaded=Object.keys(r.cache).filter(file=>file.endsWith('.node'));if(loaded.length!==1||fs.realpathSync(loaded[0])!==fs.realpathSync(artifact))throw new Error('Default loader selected another native artifact');
fs.unlinkSync(file);console.log(JSON.stringify({result:'PASS',nativeGcCycles:500,sqliteVersion,loadedNative:loaded[0],nodeVersion:process.versions.node,nodeAbi:process.versions.modules}));`;
  const verification=JSON.parse(await run(process.execPath,["--expose-gc","-e",probe,packageDirectory,artifactFile,workDir],
    {cwd:workDir,env,timeoutMs:120000,onStep}));
  return {...elf,verification};
}

async function independentCopy(source,target,expectedSha256){
  const temporary=target+".tmp-"+randomUUID();
  await copyFile(source,temporary,constants.COPYFILE_EXCL);
  const info=await lstat(temporary);
  if(!info.isFile()||info.nlink!==1||await hash(temporary)!==expectedSha256)throw new Error("Native copy differs from its verified input.");
  const handle=await open(temporary,"r");try{await handle.sync();}finally{await handle.close();}
  await rename(temporary,target);
}

export async function copySqliteNativeArtifact(source,target,{patchelf,workDir,onStep}={}){
  if(resolve(source)===resolve(target))throw new Error("Native normalization requires a new private copy.");
  await access(target).then(()=>{throw new Error("Native normalization target already exists.");},error=>{if(error.code!=="ENOENT")throw error;});
  const sourceSha256=await hash(source);await independentCopy(source,target,sourceSha256);
  if(!patchelf)return {sha256:sourceSha256};
  const options={cwd:workDir,env:environment(workDir),onStep};
  const tool=await realpath(patchelf),toolSha256=await hash(tool),toolVersion=await run(tool,["--version"],options);
  const before=await run("readelf",["-d",target],options),applied=/\((?:RPATH|RUNPATH)\)/.test(before);
  if(applied)await run(tool,["--remove-rpath",target],options);
  const after=applied?await run("readelf",["-d",target],options):before;
  const libraries=value=>[...value.matchAll(/Shared library: \[([^\]]+)\]/g)].map(match=>match[1]);
  if(/\((?:RPATH|RUNPATH)\)/.test(after)||JSON.stringify(libraries(before))!==JSON.stringify(libraries(after)))
    throw new Error("RPATH removal changed native dependencies or left a private runtime path.");
  const info=await lstat(target);
  if(!info.isFile()||info.nlink!==1)throw new Error("Normalized native artifact is not a private regular file.");
  const sha256=await hash(target);
  return {sha256,normalization:{operation:"remove_rpath",applied,sourceSha256,resultSha256:sha256,
    tool:{path:tool,version:toolVersion,sha256:toolSha256},neededLibraries:libraries(after)}};
}

export async function installSqliteNativeReceipt(packageRoot,receiptFile,{artifactFile}={}){
  const raw=await readFile(receiptFile),receipt=JSON.parse(raw),input=await collectNativeBuildInputs(packageRoot),data=input.data;
  if(receipt.version!==1||receipt.status!=="verified"||receipt.platform&&receipt.platform!==data.platform
    ||["nodeVersion","nodeAbi","nodeSha256","packageLockSha256"].some(key=>receipt[key]!==data[key])
    ||["better-sqlite3","node-addon-api"].some(key=>receipt.dependencies?.[key]!==data.dependencies[key])
    ||receipt.sqliteSource?.sha256!==data.sqliteSource.sha256||receipt.addonSource?.sha256!==data.addonSource.sha256)
    throw new Error("Native receipt does not match this bundle's runtime, dependency lock, or package sources.");
  const artifact=receipt.artifact,verified=artifact?.verification;
  if(!/^[a-f0-9]{64}$/.test(artifact?.sha256??"")||!Number.isSafeInteger(artifact?.bytes)||artifact.bytes<1
    ||verified?.result!=="PASS"||verified.nativeGcCycles!==500||verified.nodeVersion!==data.nodeVersion||verified.nodeAbi!==data.nodeAbi)
    throw new Error("Native receipt lacks completed verification.");
  if(artifactFile===undefined){
    const directory=resolve(dirname(receiptFile));
    if(typeof artifact.file!=="string"||isAbsolute(artifact.file))throw new Error("Pass a portable relative artifact path or an explicit --sqlite-native-artifact.");
    artifactFile=resolve(directory,artifact.file);
    if(!artifactFile.startsWith(directory+sep))throw new Error("Native artifact path escapes its receipt directory.");
  }else artifactFile=resolve(artifactFile);
  const info=await lstat(artifactFile);
  if(!info.isFile()||info.nlink!==1||info.size!==artifact.bytes||await hash(artifactFile)!==artifact.sha256)
    throw new Error("Native artifact bytes do not match the verified receipt.");
  const elf=await inspectNative(artifactFile,receipt.maxGlibc,{staticCxxRuntime:receipt.staticCxxRuntime===true});
  if(JSON.stringify(elf.requiredGlibc)!==JSON.stringify(artifact.requiredGlibc)
    ||JSON.stringify(elf.requiredGlibcxx)!==JSON.stringify(artifact.requiredGlibcxx))throw new Error("Native ELF requirements do not match the receipt.");
  const root=await realpath(packageRoot),sqlite=await realpath(input.sqliteDirectory);
  if(!sqlite.startsWith(root+sep))throw new Error("The target SQLite package must be inside the private bundle.");
  const prebuilds=join(sqlite,"prebuilds");await mkdir(prebuilds,{recursive:true});
  if(await realpath(prebuilds)!==prebuilds)throw new Error("The target prebuild directory must not be a symbolic link.");
  const target=join(prebuilds,`${process.platform}-${process.arch}.node`);
  await independentCopy(artifactFile,target,artifact.sha256);
  const provenanceFile="sqlite-native-build.json";await writeFile(join(root,provenanceFile),raw,{flag:"wx",mode:0o644});
  return {receiptFile:provenanceFile,receiptSha256:digest(raw),maximumGlibc:receipt.maxGlibc};
}

export async function buildSqliteNative({packageRoot,workDir,nodeGyp,nodeHeaders,python,cc,cxx,maxGlibc,patchelf,staticCxxRuntime=false}){
  packageRoot=await realpath(packageRoot);workDir=resolve(workDir);
  const input=await collectNativeBuildInputs(packageRoot),parent=await realpath(dirname(workDir));
  if(parent===input.sqliteDirectory||parent.startsWith(input.sqliteDirectory+sep))throw new Error("Native work directory must be outside the installed SQLite package.");
  if(!/^\d+\.\d+$/.test(maxGlibc??""))throw new Error("An explicit maximum glibc version is required.");
  for(const file of [nodeGyp,python,cc,cxx,join(nodeHeaders,"include","node","node.h")])await access(file);
  const gyp=await json(join(dirname(dirname(nodeGyp)),"package.json"));
  if(gyp.name!=="node-gyp")throw new Error("Pass the installed node-gyp JavaScript entrypoint.");
  const header=await readFile(join(nodeHeaders,"include","node","node_version.h"),"utf8");
  const headerVersion=["MAJOR","MINOR","PATCH"].map(part=>header.match(new RegExp("#define NODE_"+part+"_VERSION\\s+(\\d+)"))?.[1]).join(".");
  if(headerVersion!==process.versions.node)throw new Error("Node headers must exactly match the pinned runtime.");
  const disk=await statfs(parent,{bigint:true}),sourceBytes=[...input.data.sqliteSource.files,...input.data.addonSource.files].reduce((sum,file)=>sum+file.bytes,0);
  if(disk.bavail*disk.bsize<2n*1024n**3n+BigInt(sourceBytes)*4n)throw new Error("Native build needs source/object space and 2 GiB free headroom.");
  await mkdir(workDir,{mode:0o700});
  for(const name of ["tmp","cache","logs"])await mkdir(join(workDir,name));
  const linkFlags=staticCxxRuntime?["-static-libstdc++","-static-libgcc"]:[];
  const receipt={version:1,status:"building",startedAt:new Date().toISOString(),...input.data,maxGlibc,staticCxxRuntime,
    runtimeGlibc:process.report.getReport().header.glibcVersionRuntime,
    nodeGyp:{path:nodeGyp,version:gyp.version,sha256:await hash(nodeGyp)},
    nodeHeaders:{directory:nodeHeaders,version:headerVersion,sha256:(await tree(nodeHeaders,["include/node"])).sha256},steps:[]};
  const receiptFile=join(workDir,"build-receipt.json"),save=()=>writeFile(receiptFile,JSON.stringify(receipt,null,2)+"\n",{mode:0o600});
  const onStep=async entry=>{if(!receipt.steps.includes(entry))receipt.steps.push(entry);await save();};
  const env={...environment(workDir),CC:cc,CXX:cxx,PYTHON:python,CFLAGS:"",CXXFLAGS:"",LDFLAGS:linkFlags.join(" "),GYP_DEFINES:""};
  const command=(name,executable,args,options={})=>run(executable,args,{cwd:workDir,env,onStep,logFile:join(workDir,"logs",name+".log"),...options});
  try{
    receipt.toolchain={cc:await command("cc-version",cc,["--version"]),cxx:await command("cxx-version",cxx,["--version"]),
      cxxTarget:await command("cxx-target",cxx,["-dumpmachine"]),sysroot:await command("cxx-sysroot",cxx,["-print-sysroot"]),
      python:await command("python-version",python,["--version"]),make:await command("make-version","make",["--version"]),linkFlags};
    if(!(process.arch==="x64"?/^x86_64/:/^aarch64/).test(receipt.toolchain.cxxTarget))throw new Error("Compiler architecture does not match the Node runtime.");
    const privatePackage=join(workDir,"better-sqlite3");await mkdir(privatePackage);
    for(const name of sourceEntries)await cp(join(input.sqliteDirectory,name),join(privatePackage,name),{recursive:true,dereference:false,errorOnExist:true,force:false});
    await mkdir(join(privatePackage,"node_modules"));await cp(input.addonDirectory,join(privatePackage,"node_modules","node-addon-api"),{recursive:true,dereference:false,errorOnExist:true,force:false});
    if((await tree(privatePackage,sourceEntries)).sha256!==receipt.sqliteSource.sha256
      ||(await tree(join(privatePackage,"node_modules","node-addon-api"),["."])).sha256!==receipt.addonSource.sha256)throw new Error("Private native source copy differs from the pinned inputs.");
    await command("node-gyp-build",process.execPath,[nodeGyp,"rebuild","--release","--force_build=1",`--arch=${process.arch}`,"--jobs=2",
      "--devdir="+join(workDir,"cache","node-gyp"),"--nodedir="+resolve(nodeHeaders),"--python="+resolve(python)],{cwd:privatePackage,timeoutMs:600000});
    const built=join(privatePackage,"build","Release","better_sqlite3.node"),builtInfo=await lstat(built);
    if(!builtInfo.isFile()||!((await realpath(built)).startsWith(privatePackage+sep)))throw new Error("Compiler output is not a private regular file.");
    // node-gyp may hard-link its two outputs. Copy before changing the default
    // loader path so shared source/store inodes are never modified in place.
    const prebuilds=join(privatePackage,"prebuilds");await mkdir(prebuilds);
    const artifact=join(prebuilds,`${process.platform}-${process.arch}.node`);
    const copied=await copySqliteNativeArtifact(built,artifact,{patchelf,workDir,onStep});
    if(copied.normalization)receipt.normalization=copied.normalization;
    const verification=await verifySqliteNativePackage(privatePackage,artifact,{workDir,maxGlibc,onStep,staticCxxRuntime});
    const after=await collectNativeBuildInputs(packageRoot);
    if(JSON.stringify(after.data)!==JSON.stringify(input.data)||await hash(nodeGyp)!==receipt.nodeGyp.sha256
      ||(await tree(nodeHeaders,["include/node"])).sha256!==receipt.nodeHeaders.sha256
      ||(await tree(privatePackage,sourceEntries)).sha256!==receipt.sqliteSource.sha256)
      throw new Error("Pinned build inputs changed while compiling.");
    receipt.artifact={file:join("better-sqlite3","prebuilds",`${process.platform}-${process.arch}.node`),bytes:(await lstat(artifact)).size,sha256:copied.sha256,...verification};
    receipt.status="verified";receipt.finishedAt=new Date().toISOString();await save();return {receiptFile,artifact};
  }catch(error){receipt.status="failed";receipt.error=String(error);receipt.finishedAt=new Date().toISOString();await save();throw error;}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const {values}=parseArgs({options:{...Object.fromEntries(["package-root","work-dir","node-gyp","node-headers","python","cc","cxx","max-glibc","patchelf"].map(name=>[name,{type:"string"}])),
    "static-cxx-runtime":{type:"boolean",default:false}}});
  for(const name of ["work-dir","node-gyp","node-headers","python","cc","cxx","max-glibc"])if(!values[name])throw new Error(`Missing --${name}`);
  console.log(JSON.stringify(await buildSqliteNative({packageRoot:values["package-root"]??fileURLToPath(new URL("..",import.meta.url)),
    workDir:values["work-dir"],nodeGyp:resolve(values["node-gyp"]),nodeHeaders:resolve(values["node-headers"]),
    python:resolve(values.python),cc:resolve(values.cc),cxx:resolve(values.cxx),maxGlibc:values["max-glibc"],
    patchelf:values.patchelf?resolve(values.patchelf):undefined,staticCxxRuntime:values["static-cxx-runtime"]}),null,2));
}
