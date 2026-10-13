import assert from "node:assert/strict";
import test from "node:test";
import {join} from "node:path";
import {mkdir,readFile,writeFile} from "node:fs/promises";
import {directory} from "./helpers.mjs";
import {copyReleasePayload,preserveLatestNodeSettings,releasePayloadEntries} from "../install.mjs";

const payload=["bin","node","dist","schema","skills","package.json","node_modules","components","runtime","components.lock.json","docs","scripts","README.md"];

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
