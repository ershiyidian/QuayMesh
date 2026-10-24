import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { RegistryServer } from "../registry.mjs";
import { MembershipClient } from "../membership.mjs";
import { requestJson } from "../network.mjs";
import { validateCluster, validateNode } from "../config.mjs";
import { cluster, directory, token, nodeConfig, until, freePort } from "./helpers.mjs";

test("真实节点注册、配置发布、冲突检测和重启恢复",async t=>{
  const root=await directory(t);const secret=token();
  let server=await new RegistryServer({cluster:cluster(),token:secret,stateDir:root,host:"127.0.0.1",port:0,leaseMs:1500}).start();
  t.after(async()=>server.close());
  let origin=`http://127.0.0.1:${server.port}`;
  await assert.rejects(requestJson(origin+"/v1/membership"),/HTTP 401/);
  const n=nodeConfig(root);
  const heartbeat={id:"edge",instanceId:token(),address:"127.0.0.2",peerPort:7680,capabilities:n.capabilities};
  const first=await requestJson(origin+"/v1/heartbeat",{method:"POST",token:secret,body:heartbeat});
  assert.equal(first.nodes[0].online,true);
  await assert.rejects(requestJson(origin+"/v1/heartbeat",{method:"POST",token:secret,body:{...heartbeat,instanceId:token()}}),/node_id_in_use/);
  const next=cluster({egress:{priorities:{edge:400}}});
  await requestJson(origin+"/v1/cluster",{method:"PUT",token:secret,body:{expectedRevision:1,cluster:next}});
  await assert.rejects(requestJson(origin+"/v1/cluster",{method:"PUT",token:secret,body:{expectedRevision:1,cluster:next}}),/HTTP 409/);
  await server.close();
  server=await new RegistryServer({cluster:cluster(),token:secret,stateDir:root,host:"127.0.0.1",port:0}).start();
  origin=`http://127.0.0.1:${server.port}`;
  const restored=await requestJson(origin+"/v1/cluster",{token:secret});
  assert.equal(restored.revision,2);
  assert.equal(restored.cluster.egress.priorities.edge,400);
  assert.equal((await requestJson(origin+"/v1/membership",{token:secret})).nodes[0].id,"edge");
});

test("真实 MembershipClient 持久化目录与公共配置，断线保留已知数据",async t=>{
  const root=await directory(t);const secret=token();
  const port=await freePort();
  const c=validateCluster({...cluster(),coordinator:{...cluster().coordinator,apiPort:port}});
  const registry=await new RegistryServer({cluster:c,token:secret,stateDir:join(root,"cloud"),host:"127.0.0.1"}).start();
  const n=nodeConfig(join(root,"edge"));let version=0;
  const client=await new MembershipClient({node:n,cluster:c,token:secret,release:"0.1.0",intervalMs:100,
    onConfiguration:async(_,revision)=>{version=revision;}}).start();
  t.after(async()=>{await client.close();await registry.close();});
  await until(()=>client.state,state=>state.connected);
  const saved=JSON.parse(await readFile(join(n.stateDir,"membership.json"),"utf8"));
  assert.equal(saved.nodes[0].id,"edge");
  assert.equal(version,1);
  await registry.close();
  await until(()=>client.state,state=>!state.connected);
  assert.equal(JSON.parse(await readFile(join(n.stateDir,"membership.json"),"utf8")).nodes[0].id,"edge");
});

test("中继后的 Coordinator 在目录中公布公网监听端口，不暴露本机端口",async t=>{
  const root=await directory(t),secret=token(),port=await freePort();
  const c=validateCluster({...cluster(),coordinator:{...cluster().coordinator,apiPort:port}});
  const registry=await new RegistryServer({cluster:c,token:secret,stateDir:join(root,'registry'),host:'127.0.0.1'}).start();
  const cloud=validateNode({schemaVersion:1,id:c.coordinator.id,stateDir:join(root,'cloud'),
    capabilities:{coordinator:true},mesh:{enabled:false,address:c.coordinator.address},
    network:{externalAccess:false},peerPort:27680,corePort:27676,registryPort:27681,adminPort:27677},c,root);
  const client=await new MembershipClient({node:cloud,cluster:c,token:secret,release:'test',intervalMs:500}).start();
  try {
    await until(()=>client.state,state=>state.connected);
    const reply=await requestJson(`http://127.0.0.1:${port}/v1/membership`,{token:secret});
    assert.equal(reply.nodes.find(node=>node.id===c.coordinator.id).peerPort,c.coordinator.peerPort);
  } finally {await client.close();await registry.close();}
});

test("目录 SSE 发出实际注册变更，并可从当前目录重新连接",async t=>{
  const root=await directory(t);const secret=token();
  const registry=await new RegistryServer({cluster:cluster(),token:secret,stateDir:root,host:"127.0.0.1",port:0}).start();
  t.after(()=>registry.close());let events="";
  const req=http.get(`http://127.0.0.1:${registry.port}/v1/events`,{headers:{authorization:`Bearer ${secret}`}},res=>{
    assert.equal(res.statusCode,200);res.on("data",chunk=>{events+=chunk.toString();});
  });
  t.after(()=>req.destroy());
  await until(()=>events,text=>text.includes("event: membership"));
  const n=nodeConfig(root);
  await requestJson(`http://127.0.0.1:${registry.port}/v1/heartbeat`,{method:"POST",token:secret,
    body:{id:"edge",instanceId:token(),address:"127.0.0.2",peerPort:7680,capabilities:n.capabilities}});
  await until(()=>events,text=>text.includes('"id":"edge"'));
  req.destroy();
});

test("两个并发配置发布只接受一次相同版本的修改",async t=>{
  const root=await directory(t),secret=token();
  const registry=await new RegistryServer({cluster:cluster(),token:secret,stateDir:root,host:"127.0.0.1",port:0}).start();
  t.after(()=>registry.close());
  const url=`http://127.0.0.1:${registry.port}/v1/cluster`;
  const results=await Promise.allSettled([300,400].map(priority=>requestJson(url,{method:"PUT",token:secret,
    body:{expectedRevision:1,cluster:cluster({egress:{priorities:{edge:priority}}})}})));
  assert.equal(results.filter(value=>value.status==="fulfilled").length,1);
  assert.equal(results.filter(value=>value.status==="rejected").length,1);
  assert.equal((await requestJson(url,{token:secret})).revision,2);
});
