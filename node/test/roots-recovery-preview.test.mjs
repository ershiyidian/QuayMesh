import assert from "node:assert/strict";
import test from "node:test";
import {join} from "node:path";
import {mkdir,writeFile,readFile} from "node:fs/promises";
import {directory} from "./helpers.mjs";
import {previewWorkspaceRoots} from "../../scripts/recover-workspace-roots.mjs";

test("CF09：只读预览历史 roots，有证据但不直接扩大 allowedRoots",async t=>{
  const root=await directory(t),cfg=join(root,"node.json"),state=join(root,"state");
  await writeFile(cfg,JSON.stringify({id:"desktop",roots:[{id:"main",path:"E:/QuayMesh"}]}));
  const folder=join(state,"generated","config-10-old","core");await mkdir(folder,{recursive:true});
  await writeFile(join(folder,"config.jsonc"),JSON.stringify({federation:{roots:[
    {id:"main",path:"E:/QuayMesh"},{id:"game",nickname:"game",path:"E:/game",enabled:true},
    {id:"pc-home",nickname:"pc-home",path:"C:/Users/example",enabled:false},
  ]}}));
  const report=await previewWorkspaceRoots(cfg,state);
  assert.equal(report.readOnly,true);assert.equal(report.requiresExplicitApproval,true);
  assert.deepEqual(report.missing.map(item=>item.id),["game","pc-home"]);
  assert.equal(report.missing[1].enabled,false);
  assert.equal(report.conflicts.length,0);
  assert.equal(report.evidence.length,1);
});

test("CF10：同 ID 不同路径或权限的旧生成配置不会按 mtime 擅自恢复",async t=>{
  const root=await directory(t),cfg=join(root,"node.json"),state=join(root,"state");
  await writeFile(cfg,JSON.stringify({id:"desktop",roots:[{id:"main",path:"E:/QuayMesh"}]}));
  for(const [name,path,enabled] of [["config-1-old","E:/game",true],["config-2-new","D:/game",true],["config-3-new","D:/game",false]]){
    const folder=join(state,"generated",name,"core");
    await mkdir(folder,{recursive:true});
    await writeFile(join(folder,"config.jsonc"),JSON.stringify({federation:{roots:[{id:"game",path,nickname:"game",enabled}]}}));
  }
  const before=await readFile(cfg,"utf8");
  const report=await previewWorkspaceRoots(cfg,state);
  assert.equal(report.missing.length,0);
  assert.equal(report.conflicts.length,1);
  assert.equal(report.conflicts[0].disposition,"AMBIGUOUS_HISTORY_REQUIRES_REVIEW");
  assert.equal(report.conflicts[0].historicalVariants.length,3);
  assert.equal(await readFile(cfg,"utf8"),before);
});
