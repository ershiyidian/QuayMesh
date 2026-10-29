import assert from "node:assert/strict";
import test from "node:test";
import {join} from "node:path";
import {mkdir,readFile,writeFile} from "node:fs/promises";
import {cluster,directory,token} from "./helpers.mjs";
import {copyReleasePayload,preserveLatestNodeSettings,releasePayloadEntries,installationServiceName,
  installationServiceIdentity,prepareInstallation,systemdUnit} from "../install.mjs";

const payload=["bin","node","dist","schema","skills","package.json","node_modules","components","runtime","components.lock.json","docs","scripts","README.md"];

test("同机协调节点和执行节点的安装记录保留各自服务，升级不误选默认服务",()=>{
  const worker={unitFile:"/home/test/.config/systemd/user/quaymesh-node.service"};
  const coordinator={unitFile:"/home/test/.config/systemd/user/quaymesh-coordinator.service"};
  assert.equal(installationServiceName(worker),"quaymesh-node.service");
  assert.equal(installationServiceName(coordinator),"quaymesh-coordinator.service");
  assert.equal(installationServiceName(undefined,"quaymesh-coordinator.service"),"quaymesh-coordinator.service");
  assert.throws(()=>installationServiceName(coordinator,"quaymesh-node.service"),/沿用/);
  assert.throws(()=>installationServiceName(undefined,"../quaymesh-node.service"),/有效/);
});

test("升级省略选项保留服务范围、专用账户和完整 unit 路径",()=>{
  const installed={user:false,serviceUser:"quaymesh",unitFile:"/etc/systemd/system/quaymesh-coordinator.service"};
  const identity=installationServiceIdentity(installed,{platform:"linux"});
  assert.deepEqual(identity,installed);
  assert.deepEqual(installationServiceIdentity(installed,{platform:"linux",user:false,serviceUser:"quaymesh"}),installed);
  for(const requested of [{user:true},{serviceUser:"root"},{serviceUser:null},{serviceUser:""}])
    assert.throws(()=>installationServiceIdentity(installed,{platform:"linux",...requested}),/沿用.*范围和运行账户/);
  const unit=systemdUnit({...identity,nodeExecutable:"/opt/quaymesh/runtime/node",entrypoint:"/opt/quaymesh/bin/quaymesh.js",
    configFile:"/etc/quaymesh/cloud/node.json",directory:"/opt/quaymesh"});
  assert.match(unit,/^User=quaymesh$/m);
  assert.match(unit,/^WantedBy=multi-user.target$/m);
  const defaults=installationServiceIdentity(undefined,{platform:"linux"});
  assert.equal(defaults.user,true);
  assert.equal(defaults.serviceUser,null);
  assert.equal(installationServiceName(defaults),"quaymesh-node.service");
  assert.throws(()=>installationServiceIdentity(defaults,{platform:"linux",user:false}),/沿用/);
  assert.throws(()=>installationServiceIdentity(undefined,{platform:"linux",serviceUser:"quaymesh"}),/--system/);
});

test("已安装配置定位原记录，拒绝服务范围变更前不准备发行",async t=>{
  const dir=await directory(t),config=join(dir,"node.json"),recordFile=join(dir,"installation.json");
  await writeFile(join(dir,"cluster.json"),JSON.stringify(cluster()));
  await writeFile(join(dir,"secrets.env"),`QUAYMESH_CLUSTER_TOKEN=${token()}\n`);
  await writeFile(config,JSON.stringify({schemaVersion:1,id:"edge",stateDir:join(dir,"state"),
    capabilities:{worker:true},mesh:{enabled:false,address:"127.0.0.2"},secretsFile:"./secrets.env"}));
  const installed={version:1,nodeId:"edge",config,user:false,serviceUser:null,unitFile:"/etc/systemd/system/quaymesh-edge.service"};
  await writeFile(recordFile,JSON.stringify(installed));
  await assert.rejects(()=>prepareInstallation(config,{platform:"linux",user:true,root:join(dir,"missing-release")}),/沿用.*范围和运行账户/);
  assert.deepEqual(JSON.parse(await readFile(recordFile,"utf8")),installed);
});

test("PK01-PK04：发行单清单完整复制并保留 docs/scripts 文件",async t=>{
  const dir=await directory(t),source=join(dir,"bundle"),target=join(dir,"installed");
  await mkdir(source);await mkdir(target);
  for(const name of payload){
    const path=join(source,name);
    if(name.endsWith(".json")||name.endsWith(".md"))await writeFile(path,name);
    else {await mkdir(path,{recursive:true});await writeFile(join(path,"file.txt"),name);}
  }
  await mkdir(join(source,"docs"),{recursive:true});
  await mkdir(join(source,"scripts","analysis"),{recursive:true});
  await writeFile(join(source,"docs","PYTHON_WORKFLOW.md"),"Python");
  await writeFile(join(source,"scripts","analysis","summarize-quaymesh-log.py"),"print('ok')");
  await writeFile(join(source,"release.json"),JSON.stringify({sourceCommit:"a".repeat(40),payloadEntries:payload}));
  const files=await copyReleasePayload(source,target,{payloadEntries:payload});
  assert.ok(files.includes("docs"));assert.ok(files.includes("scripts"));
  assert.equal(await readFile(join(target,"docs","PYTHON_WORKFLOW.md"),"utf8"),"Python");
  assert.equal(await readFile(join(target,"scripts","analysis","summarize-quaymesh-log.py"),"utf8"),"print('ok')");
});

test("PK05：非法、缺项或重复发行清单明确失败",()=>{
  for(const bad of [["../secret"],payload.filter(x=>x!=="docs"),[...payload,"node"],payload.map(x=>x==="node"?"../../outside":x)]){
    assert.throws(()=>releasePayloadEntries({payloadEntries:bad}),/缺少|非法|重复/);
  }
});

test("CF08/PK06：prepare 后用户继续保存 roots，activate 使用最新修订且保留新 runtime",async t=>{
  const dir=await directory(t),staged=join(dir,"staged.json"),live=join(dir,"node.json");
  await writeFile(staged,JSON.stringify({id:"desktop",nodeRuntime:"D:/new/node.exe",settingsRevision:2,
    nickname:"old",roots:[{id:"main",path:"D:/old"}],consoleSettings:{priority:40}}));
  await writeFile(live,JSON.stringify({id:"desktop",nodeRuntime:"D:/old/node.exe",settingsRevision:3,
    nickname:"new",roots:[{id:"main",path:"D:/new"},{id:"game",path:"D:/game",enabled:false}],consoleSettings:{priority:55}}));
  await preserveLatestNodeSettings(staged,live,"desktop",2);
  const result=JSON.parse(await readFile(staged,"utf8"));
  assert.equal(result.nodeRuntime,"D:/new/node.exe");
  assert.equal(result.settingsRevision,3);
  assert.equal(result.roots[1].id,"game");
  assert.equal(result.consoleSettings.priority,55);
  await assert.rejects(()=>preserveLatestNodeSettings(staged,live,"cloud",2),/另一节点/);
  await assert.rejects(()=>preserveLatestNodeSettings(staged,live,"desktop",4),/回退/);
});
