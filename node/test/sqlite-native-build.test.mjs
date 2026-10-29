import assert from "node:assert/strict";
import test from "node:test";
import {access,copyFile,cp,link,lstat,mkdir,mkdtemp,readFile,rm,writeFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import {createRequire} from "node:module";
import {join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {tmpdir} from "node:os";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {collectNativeBuildInputs,copySqliteNativeArtifact,installSqliteNativeReceipt,verifySqliteNativePackage} from "../../scripts/build-sqlite-native.mjs";

const project=fileURLToPath(new URL("../..",import.meta.url));
const sha=value=>createHash("sha256").update(value).digest("hex");
const hash=async file=>sha(await readFile(file));

test("SQLite 原生回执可跨目录消费，真实加载通过后仍拒绝来源、字节及 ELF 不匹配",{
  skip:process.platform!=="linux"||!["x64","arm64"].includes(process.arch),timeout:120000,
},async t=>{
  const root=await mkdtemp(join(tmpdir(),"quaymesh-native-receipt-"));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const input=await collectNativeBuildInputs(project),r=createRequire(join(project,"package.json")),Database=r("better-sqlite3");
  const database=new Database(":memory:");database.prepare("SELECT 1").get();database.close();
  const stack=[r.cache[r.resolve("better-sqlite3")]],seen=new Set(),native=new Set();
  while(stack.length){const module=stack.pop();if(!module||seen.has(module))continue;seen.add(module);
    if(module.filename.endsWith(".node"))native.add(module.filename);stack.push(...module.children);}
  assert.equal(native.size,1);const originalNative=[...native][0];
  const bundle=join(root,"bundle"),sqlite=join(bundle,"node_modules","better-sqlite3");
  await mkdir(sqlite,{recursive:true});
  for(const name of ["package.json","components.lock.json","pnpm-lock.yaml"])await copyFile(join(project,name),join(bundle,name));
  for(const name of ["package.json","binding.gyp","src","deps","lib"])
    await cp(join(input.sqliteDirectory,name),join(sqlite,name),{recursive:true,dereference:true});
  await cp(input.addonDirectory,join(bundle,"node_modules","node-addon-api"),{recursive:true,dereference:true});
  const prebuildName=`${process.platform}-${process.arch}.node`;
  await mkdir(join(sqlite,"prebuilds"));
  const shared=join(root,"store-inode.node"),target=join(sqlite,"prebuilds",prebuildName);
  await copyFile(originalNative,shared);await link(shared,target);
  const oldInfo=await lstat(shared),oldHash=await hash(shared);
  assert.equal(oldInfo.nlink,2,"夹具模拟包管理器的共享原生 inode");

  const producer=join(root,"producer");await mkdir(join(producer,"prebuilds"),{recursive:true});
  for(const name of ["package.json","lib"])await cp(join(input.sqliteDirectory,name),join(producer,name),{recursive:true});
  const artifact=join(producer,"prebuilds",prebuildName),patchelf="/usr/bin/patchelf";
  const canNormalize=await access(patchelf).then(()=>true,error=>{if(error.code==="ENOENT")return false;throw error;});
  let normalization;
  await t.test("显式移除真实 ELF 私有 RPATH，保留编译器的两个原 inode 链接",{skip:!canNormalize},async()=>{
    const built=join(root,"compiler-output.node"),twin=join(root,"compiler-object.node"),workDir=join(root,"normalize");
    await mkdir(join(workDir,"tmp"),{recursive:true});await mkdir(join(workDir,"cache"));
    await copyFile(originalNative,built);
    await promisify(execFile)(patchelf,["--set-rpath","/producer-only/private/lib",built]);
    await link(built,twin);const before=await hash(built);
    const copied=await copySqliteNativeArtifact(built,artifact,{patchelf,workDir});normalization=copied.normalization;
    assert.equal(normalization.applied,true);assert.equal(normalization.sourceSha256,before);
    assert.equal(normalization.resultSha256,await hash(artifact));assert.notEqual(normalization.resultSha256,before);
    assert.equal(await hash(built),before);assert.equal(await hash(twin),before);
    assert.equal((await lstat(built)).nlink,2);assert.equal((await lstat(artifact)).nlink,1);
  });
  if(!canNormalize)await copyFile(originalNative,artifact);
  const maxGlibc=process.report.getReport().header.glibcVersionRuntime;
  const verified=await verifySqliteNativePackage(producer,artifact,{workDir:join(root,"verification"),maxGlibc});
  assert.equal(verified.verification.result,"PASS");assert.equal(verified.verification.nativeGcCycles,500);
  const {data}=await collectNativeBuildInputs(bundle);
  const receipt={version:1,status:"verified",...data,maxGlibc,...(normalization?{normalization}:{}),
    nodeHeaders:{directory:"/producer-only/headers"},nodeGyp:{path:"/producer-only/node-gyp.js"},
    artifact:{file:join("producer","prebuilds",prebuildName),sha256:await hash(artifact),bytes:(await lstat(artifact)).size,...verified}};
  const raw=JSON.stringify(receipt,null,2)+"\n",moved=join(root,"received");await mkdir(moved);
  await cp(producer,join(moved,"producer"),{recursive:true});
  const receiptFile=join(moved,"build-receipt.json");await writeFile(receiptFile,raw);
  await rm(producer,{recursive:true});
  await assert.rejects(lstat(verified.verification.loadedNative),{code:"ENOENT"},"生产者机器的原路径无需存在");

  await t.test("匹配的可移植回执替换为独立 inode，包管理器原字节与真实查询保持正确",async()=>{
    const result=await installSqliteNativeReceipt(bundle,receiptFile);
    assert.equal(result.receiptSha256,sha(raw));assert.equal(result.maximumGlibc,maxGlibc);
    assert.equal(await hash(join(bundle,result.receiptFile)),sha(raw));
    const installed=await lstat(target);
    assert.equal(installed.nlink,1);assert.notEqual(installed.ino,oldInfo.ino);
    assert.equal((await lstat(shared)).nlink,1);assert.equal(await hash(shared),oldHash);
    assert.equal(await hash(target),receipt.artifact.sha256);
    const consumer=createRequire(join(bundle,"package.json")),ConsumerDatabase=consumer("better-sqlite3");
    const db=new ConsumerDatabase(":memory:");try{assert.equal(db.prepare("SELECT 42 AS value").get().value,42);}finally{db.close();}
    assert.ok(consumer.cache[target],"消费者默认加载器必须加载已验证的新 prebuild");
  });

  const before={info:await lstat(target),sha:await hash(target),receipt:await readFile(join(bundle,"sqlite-native-build.json"),"utf8")};
  async function rejectUnchanged(value,pattern,options){
    const file=join(moved,"rejected-receipt.json");await writeFile(file,JSON.stringify(value));
    await assert.rejects(installSqliteNativeReceipt(bundle,file,options),pattern);
    assert.equal((await lstat(target)).ino,before.info.ino);assert.equal(await hash(target),before.sha);
    assert.equal(await readFile(join(bundle,"sqlite-native-build.json"),"utf8"),before.receipt);
    assert.equal(await hash(shared),oldHash);
  }
  await t.test("Node、锁文件、依赖源码和结构化验证回执不匹配在写入前拒绝",async()=>{
    for(const key of ["nodeVersion","nodeAbi","nodeSha256","packageLockSha256"])
      await rejectUnchanged({...receipt,[key]:"different"},/does not match/);
    for(const key of ["sqliteSource","addonSource"])
      await rejectUnchanged({...receipt,[key]:{...receipt[key],sha256:"f".repeat(64)}},/does not match/);
    await rejectUnchanged({...receipt,dependencies:{...receipt.dependencies,"better-sqlite3":"wrong"}},/does not match/);
    await rejectUnchanged({...receipt,artifact:{...receipt.artifact,verification:{...verified.verification,nativeGcCycles:0}}},/completed verification/);
    for(const file of [join(bundle,"pnpm-lock.yaml"),join(sqlite,"lib","binding.js")]){
      const saved=await readFile(file);
      try{await writeFile(file,Buffer.concat([saved,Buffer.from("\n")]));await rejectUnchanged(receipt,/does not match/);}
      finally{await writeFile(file,saved);}
    }
  });
  await t.test("错误原生字节和虚假 ELF 需求不能替换已安装文件",async()=>{
    await rejectUnchanged({...receipt,artifact:{...receipt.artifact,sha256:"0".repeat(64)}},/artifact bytes/);
    await rejectUnchanged({...receipt,artifact:{...receipt.artifact,requiredGlibc:["1.0"]}},/ELF requirements/);
    await rejectUnchanged({...receipt,maxGlibc:"1.0"},/glibc baseline/);
    if(verified.neededLibraries.some(name=>/^(?:libstdc\+\+|libgcc_s)\./.test(name)))
      await rejectUnchanged({...receipt,staticCxxRuntime:true},/static C\+\+ runtime/);
    const movedArtifact=join(moved,receipt.artifact.file),saved=await readFile(movedArtifact),changed=Buffer.from(saved);changed[0]^=1;
    try{await writeFile(movedArtifact,changed);await rejectUnchanged(receipt,/artifact bytes/);}
    finally{await writeFile(movedArtifact,saved);}
  });
  await t.test("默认相对路径不能逸出回执目录，绝对旧路径需显式产物参数",async()=>{
    await rejectUnchanged({...receipt,artifact:{...receipt.artifact,file:"../outside.node"}},/escapes/);
    await rejectUnchanged({...receipt,artifact:{...receipt.artifact,file:resolve("/producer-only/native.node")}},/portable relative/);
    const extra=join(root,"wrong-artifact.node");await writeFile(extra,"not an ELF file");
    await rejectUnchanged(receipt,/artifact bytes/,{artifactFile:extra});
  });
});
