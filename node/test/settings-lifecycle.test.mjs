import assert from "node:assert/strict";
import test from "node:test";
import {join} from "node:path";
import {writeFile,readFile,mkdir} from "node:fs/promises";
import {directory,cluster,token,freePort,until} from "./helpers.mjs";
import {loadSettingsAuthority,applySettingsPatch,publicSettings} from "../settings.mjs";
import {compileCore} from "../compile.mjs";
import {QuayMeshNode} from "../app.mjs";

async function fixture(t){
  const root=await directory(t),config=join(root,"node.json"),state=join(root,"state"),key=token();
  await mkdir(state,{recursive:true});
  await writeFile(join(root,"cluster.json"),JSON.stringify(cluster()));
  await writeFile(join(root,"secrets.env"),`QUAYMESH_CLUSTER_TOKEN=${key}\n`);
  const node={schemaVersion:1,id:"edge",nickname:"edge",clusterFile:join(root,"cluster.json"),secretsFile:join(root,"secrets.env"),
    stateDir:state,capabilities:{worker:true},network:{externalAccess:false},mesh:{enabled:false,address:"127.0.0.2"},
    roots:[{id:"main",nickname:"Main",path:root,enabled:true,tags:["test"]}]};
  await writeFile(config,JSON.stringify(node));
  return {root,config,node,key};
}

test("CF01-CF04：用户 roots、禁用状态、昵称、优先级在持久配置重读后仍存在",async t=>{
  const f=await fixture(t),initial=await loadSettingsAuthority(f.config);
  assert.equal(initial.node.settingsRevision,1);
  const roots=[...initial.node.roots,{id:"game",nickname:"game",path:join(f.root,"temporarily-offline"),tags:["school"],description:"保留离线路径",enabled:false}];
  const saved=await applySettingsPatch(f.config,{nickname:"中文设备",priority:27,roots,egress:{enabled:false}}, {expectedRevision:1});
  assert.equal(saved.node.settingsRevision,2);
  const reloaded=await loadSettingsAuthority(f.config);
  assert.equal(reloaded.node.nickname,"中文设备");
  assert.equal(reloaded.node.roots.length,2);
  assert.equal(reloaded.node.roots[1].enabled,false);
  assert.equal(reloaded.node.roots[1].tags[0],"school");
  assert.equal(publicSettings(reloaded).priority,27);
  assert.equal(reloaded.node.network.externalAccess,false,"控制台不能偷偷开启节点公网能力");
  const runtime=compileCore(reloaded.node,reloaded.cluster,{root:f.root,tokenFile:join(f.root,"cluster.token"),ownerToken:"this-is-long-enough-for-owner",membershipFile:join(f.root,"membership.json"),statusFile:join(f.root,"node-status.json")}).runtime;
  assert.equal(runtime.federation.priority,27);
  assert.equal(runtime.federation.roots[1].enabled,false);
  assert.equal(runtime.workspaces.allowedRoots.length,1,"禁用的 root 不进入执行权限");
  await assert.rejects(()=>applySettingsPatch(f.config,{nickname:"旧窗口"},{expectedRevision:1}),/修订冲突/);
  assert.equal((await loadSettingsAuthority(f.config)).node.nickname,"中文设备");
});

test("CF05：明确非法修改不会写入持久设置",async t=>{
  const f=await fixture(t),before=await readFile(f.config,"utf8");
  await assert.rejects(()=>applySettingsPatch(f.config,{externalAccess:true},{expectedRevision:1}),/不是可编辑设置/);
  await assert.rejects(()=>applySettingsPatch(f.config,{egress:{enabled:true}},{expectedRevision:1}),/禁止无外网节点/);
  await assert.rejects(()=>applySettingsPatch(f.config,{roots:[{id:"duplicate",path:f.root},{id:"duplicate",path:f.root}]},{expectedRevision:1}),/重复/);
  assert.equal(await readFile(f.config,"utf8"),before);
});

test("CF08：同时保存同一 revision 只允许一个请求成功，另一请求不会覆盖结果",async t=>{
  const f=await fixture(t);
  const results=await Promise.allSettled([
    applySettingsPatch(f.config,{nickname:"first-concurrent-save"},{expectedRevision:1}),
    applySettingsPatch(f.config,{nickname:"second-concurrent-save"},{expectedRevision:1}),
  ]);
  const succeeded=results.filter(result=>result.status==="fulfilled");
  const rejected=results.filter(result=>result.status==="rejected");
  assert.equal(succeeded.length,1);
  assert.equal(rejected.length,1);
  assert.equal(rejected[0].reason?.code,"CONFIG_REVISION_CONFLICT");
  const current=await loadSettingsAuthority(f.config);
  assert.equal(current.node.settingsRevision,2);
  assert.equal(current.node.nickname,succeeded[0].value.node.nickname);
});

test("CF06：真实 Node 管理 HTTP 保存和修订冲突；未经认证不能读写",async t=>{
  const f=await fixture(t),port=await freePort();
  const raw=JSON.parse(await readFile(f.config,"utf8"));raw.adminPort=port;
  await writeFile(f.config,JSON.stringify(raw));
  const config=await loadSettingsAuthority(f.config);
  const node=new QuayMeshNode(config);
  node.token=f.key;
  node.supervisor={snapshot:()=>[],close:async()=>{}};
  node.applySettingsRevision=async revision=>{
    const authority=await loadSettingsAuthority(f.config);
    assert.equal(authority.node.settingsRevision,revision);
    node.config={...config,node:authority.node};node.pendingSettingsRevision=null;
    return revision;
  };
  await node.startAdmin();
  t.after(()=>node.close());
  const url=`http://127.0.0.1:${port}/settings`;
  assert.equal((await fetch(url)).status,401);
  const headers={Authorization:`Bearer ${f.key}`};
  assert.equal((await fetch(url,{headers})).status,200);
  const roots=[...config.node.roots,{id:"school",nickname:"学校",path:join(f.root,"not-mounted"),description:"暂时离线",enabled:false,tags:["study"]}];
  const saved=await fetch(url,{method:"POST",headers:{...headers,"Content-Type":"application/json"},
    body:JSON.stringify({expectedRevision:1,settings:{roots}})});
  assert.equal(saved.status,200);
  assert.equal((await saved.json()).savedRevision,2);
  await until(async()=> (await (await fetch(url,{headers})).json()).appliedRevision,revision=>revision===2);
  const again=await fetch(url,{method:"POST",headers:{...headers,"Content-Type":"application/json"},
    body:JSON.stringify({expectedRevision:1,settings:{nickname:"stale"}})});
  assert.equal(again.status,409);
  assert.match((await again.json()).error,/修订冲突/);
  assert.equal((await loadSettingsAuthority(f.config)).node.roots[1].enabled,false);
});

test("CF07：长任务仍活跃时设置保持 pending，不进入维护、不打断进程",async t=>{
  const f=await fixture(t),node=new QuayMeshNode(await loadSettingsAuthority(f.config));
  let prepared=false,paused=false;
  node.canApplySettings=async()=>false;
  node.prepare=async()=>{prepared=true;throw new Error("SHOULD_NOT_PREPARE");};
  node.beginMaintenance=async()=>{paused=true;throw new Error("SHOULD_NOT_PAUSE");};
  assert.equal(await node.applySettingsRevision(2),null);
  assert.equal(prepared,false);
  assert.equal(paused,false);
});
