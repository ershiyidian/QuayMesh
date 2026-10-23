import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validateNode, loadNodeConfig } from "../config.mjs";
import { compileCore, componentPlans, easyTierConfig } from "../compile.mjs";
import { internalEnvironment, restrictedEnvironment } from "../environment.mjs";
import { createSite } from "../site.mjs";
import { systemdUnit } from "../install.mjs";
import { cluster, directory, token, nodeConfig } from "./helpers.mjs";

test("同一配置模型支持云端和组合能力，云端禁用外网组件",async t=>{
  const root=await directory(t);const c=cluster();
  const cloud=validateNode({schemaVersion:1,id:"cloud",stateDir:root,capabilities:{coordinator:true,meshRelay:true},
    mesh:{address:"127.0.0.1",mode:"no-tun",listeners:["udp://0.0.0.0:11010"]},network:{externalAccess:false}},c,root);
  const env={QUAYMESH_CLUSTER_TOKEN:token(),QUAYMESH_MESH_SECRET:token(),HTTPS_PROXY:"http://127.0.0.1:1",OPENAI_API_KEY:token()};
  const plans=componentPlans(cloud,c,env,{root,generatedDir:root,configDir:root,release:"test"});
  assert.deepEqual(plans.map(plan=>plan.id),["mesh","core"]);
  assert.equal(plans[1].env.OPENAI_API_KEY,undefined);
  assert.equal(plans[1].env.HTTPS_PROXY,undefined);
  assert.equal(plans[1].env.QUAYMESH_INSTALL_TRANSITION_FILE,join(root,"installation-transition.json"));
  const compiled=compileCore(cloud,c,{root,tokenFile:join(root,"token"),ownerToken:token(),membershipFile:join(root,"nodes"),statusFile:join(root,"status")});
  assert.equal(compiled.runtime.subagents.enabled,false);
  assert.equal(compiled.runtime.federation.egress.enabled,false);
  assert.equal(compiled.runtime.ui.enabled,true);
  assert.equal(compiled.runtime.federation.capabilities.coordinator,true);
  assert.throws(()=>validateNode({...cloud,capabilities:{coordinator:true,discovery:true}},c,root),/关闭外网/);
});

test("三个发现端使用同一 HTTP origin 和通道，保留独立工作区",async t=>{
  const root=await directory(t);
  const c=cluster({discovery:{resourceUrl:"https://example.invalid/mcp"}});
  const env={QUAYMESH_CLUSTER_TOKEN:token(),QUAYMESH_MESH_SECRET:token(),QUAYMESH_TUNNEL_ID:"tunnel_test",QUAYMESH_TUNNEL_API_KEY:token()};
  const values=["s1","s2","desktop"].map((id,index)=>{
    const node=validateNode({schemaVersion:1,id,stateDir:join(root,id),capabilities:{worker:true,discovery:true,egress:true},
      mesh:{mode:"no-tun",address:`127.0.0.${index+2}`},network:{proxyUrl:"http://127.0.0.1:7890"},
      roots:[{id:"work",path:root}]},c,root);
    return componentPlans(node,c,env,{root,generatedDir:root,configDir:root,release:"0.1.0"}).find(plan=>plan.id==="discovery");
  });
  assert.equal(new Set(values.map(plan=>plan.env.MCP_SERVER_URL)).size,1);
  assert.equal(values[0].env.CONTROL_PLANE_POLL_CHANNELS,"main,harpoon");
  assert.equal(values[0].env.MCP_SERVER_URL,"http://127.0.0.1:17676/mcp");
  assert.equal(values[0].env.HTTPS_PROXY,"http://127.0.0.1:7890");
});

test("no-TUN 配置使用多个 peer 和回环 SOCKS",async t=>{
  const root=await directory(t);
  const c=cluster({mesh:{networkName:"lab",peers:["udp://127.0.0.1:11010","tcp://127.0.0.1:11011"]}});
  const n=nodeConfig(root,"edge",{mesh:{mode:"no-tun",address:"127.0.0.2"}});
  const text=easyTierConfig(n,c);
  assert.equal((text.match(/\[\[peer\]\]/g)||[]).length,2);
  assert.match(text,/no_tun = true/);
  assert.match(text,/socks5:\/\/127\.0\.0\.1:17690/);
  assert.match(text,/\$\{QUAYMESH_MESH_SECRET\}/);
});

test("生成的站点文件可由同一加载器读取，密钥独立保存",async t=>{
  const root=await directory(t);const site=join(root,"site");
  await createSite({directory:site,peer:"udp://127.0.0.1:11010"});
  const cloud=await loadNodeConfig(join(site,"cloud.json"),{});
  const s2=await loadNodeConfig(join(site,"worker.json"),{});
  assert.equal(cloud.node.network.externalAccess,false);
  assert.equal(s2.node.mesh.mode,"no-tun");
  assert.equal(s2.env.QUAYMESH_CLUSTER_TOKEN,cloud.env.QUAYMESH_CLUSTER_TOKEN);
  const raw=await readFile(join(site,"cluster.json"),"utf8");
  assert.equal(raw.includes(cloud.env.QUAYMESH_CLUSTER_TOKEN),false);
});

test("systemd 安装命令保存路径参数，关闭错误配置",()=>{
  const unit=systemdUnit({nodeExecutable:"/opt/node",entrypoint:"/home/a b/bin/quaymesh.js",configFile:"/home/a b/site.json",directory:"/home/a b"});
  assert.match(unit,/"\/home\/a b\/bin\/quaymesh\.js" run --config "\/home\/a b\/site\.json"/);
  assert.match(unit,/^WorkingDirectory=\/home\/a\\x20b$/m);
  assert.match(unit,/KillMode=mixed/);
  assert.throws(()=>validateNode({schemaVersion:1,id:"edge",capabilities:{worker:true},mesh:{address:"127.0.0.2"},adminPort:7676},cluster()),/端口发生冲突/);
  assert.throws(()=>validateNode({schemaVersion:1,id:"edge",capabilities:{madeUp:true}},cluster()),/不是有效配置/);
});
