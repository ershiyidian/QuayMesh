import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RegistryServer } from "../registry.mjs";
import { MembershipClient } from "../membership.mjs";
import { ComponentSupervisor } from "../supervisor.mjs";
import { McpRelay } from "../relay.mjs";
import { SourceErrors } from "../source-errors.mjs";
import { componentPlans, compileCore } from "../compile.mjs";
import { validateNode } from "../config.mjs";
import { requestJson, requestText } from "../network.mjs";
import { directory, token, cluster, nodeConfig, until, freePort } from "./helpers.mjs";

test("目录真实写入失败后返回错误，修复文件系统后下一次心跳重新保存", async t => {
  const root = await directory(t), key = token(), configuration = cluster();
  const registry = await new RegistryServer({cluster:configuration,token:key,stateDir:root,host:"127.0.0.1",port:0}).start();
  t.after(() => registry.close());
  const path = join(root,"registry.json");
  await mkdir(path);
  const node = nodeConfig(root);
  const body = {id:node.id,instanceId:randomUUID(),address:node.mesh.address,peerPort:node.peerPort,capabilities:node.capabilities};
  const send = () => requestJson(`http://127.0.0.1:${registry.port}/v1/heartbeat`,{method:"POST",token:key,body});
  await assert.rejects(send);
  assert.ok(registry.persistError);
  await rm(path,{recursive:true});
  const saved = await send();
  assert.equal(saved.nodes[0].id,node.id);
  assert.equal(JSON.parse(await readFile(path,"utf8")).nodes[0].id,node.id);
  assert.equal(registry.persistError,null);
  const revision = saved.revision;
  assert.equal((await send()).revision,revision);
});

test("收到新集群配置只记录期望值，未经应用确认不会覆盖启动配置", async t => {
  const root = await directory(t), key = token();
  const registry = await new RegistryServer({cluster:cluster(),token:key,stateDir:join(root,"registry"),host:"127.0.0.1",port:0}).start();
  t.after(() => registry.close());
  const initial = cluster({coordinator:{id:"cloud",address:"127.0.0.1",apiPort:registry.port}});
  registry.cluster = initial;
  const node = nodeConfig(join(root,"node"));
  const snapshot = join(node.stateDir,"cluster.snapshot.json");
  await mkdir(node.stateDir,{recursive:true});
  await writeFile(snapshot,JSON.stringify({revision:1,cluster:initial}));
  let desired = 0;
  const client = await new MembershipClient({node,cluster:initial,token:key,release:"test",intervalMs:30,
    onConfiguration:async(_next,revision) => {desired=revision;}}).start();
  t.after(() => client.close());
  await until(() => desired,value => value === 1);
  await requestJson(`http://127.0.0.1:${registry.port}/v1/cluster`,{method:"PUT",token:key,
    body:{expectedRevision:1,cluster:{...initial,discovery:{...initial.discovery,localPort:node.adminPort}}}});
  await until(() => desired,value => value === 2);
  assert.equal(JSON.parse(await readFile(snapshot,"utf8")).revision,1);
});

test("就绪检查失败保持原进程，其他组件的探测不会等待它", async t => {
  const root = await directory(t);
  const mode = join(root,"mode"); await writeFile(mode,"ready");
  const script = join(root,"component.mjs");
  await writeFile(script,"setInterval(()=>{},1000); process.on('SIGTERM',()=>process.exit(0));\n");
  let fastChecks = 0, slowActive = false, fastDuringSlow = 0, mostFastDuringSlow = 0;
  const server = http.createServer(async(req,res) => {
    if (req.url === "/slow") {
      const state = await readFile(mode,"utf8"); slowActive = true; fastDuringSlow = 0;
      setTimeout(() => { slowActive = false; res.writeHead(state === "ready" ? 200 : 503).end(); },180);
    } else {
      fastChecks++;
      if (slowActive) mostFastDuringSlow = Math.max(mostFastDuringSlow,++fastDuringSlow);
      res.end("ok");
    }
  });
  await new Promise(resolve => server.listen(0,"127.0.0.1",resolve));
  t.after(() => new Promise(resolve => {server.closeAllConnections();server.close(resolve);}));
  const base = `http://127.0.0.1:${server.address().port}`;
  const probe = path => async() => {
    const response = await requestText(base+path,{timeoutMs:2500});
    if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
  };
  const supervisor = new ComponentSupervisor({logDir:root,intervalMs:20});
  supervisor.define(["slow","fast"].map(id => ({id,command:process.execPath,args:[script],env:{...process.env},requires:[],ready:probe('/'+id)})));
  supervisor.on("fault",error=>{throw error;});
  await supervisor.start(); t.after(() => supervisor.close());
  await supervisor.waitReady(new Set(["slow","fast"]));
  await until(() => mostFastDuringSlow,value => value >= 2);
  const pid = supervisor.snapshot().find(value=>value.id==="slow").pid;
  await writeFile(mode,"failed");
  await until(() => supervisor.snapshot().find(value=>value.id==="slow"),value=>value.state==="degraded");
  assert.ok(fastChecks>=2);
  assert.equal(supervisor.snapshot().find(value=>value.id==="slow").pid,pid);
  await writeFile(mode,"ready");
  await supervisor.waitReady(new Set(["slow"]));
  assert.equal(supervisor.snapshot().find(value=>value.id==="slow").error,null);
});

test("Console规范URL、带版本静态缓存、HEAD和多个cookie保持真实HTTP语义", async t => {
  const root = await directory(t);
  await mkdir(join(root,"assets"));
  await writeFile(join(root,"console.html"),'<script src="./assets/console-abcdefgh.js"></script>');
  await writeFile(join(root,"assets","console-abcdefgh.js"),'window.quaymesh=true;');
  const source = http.createServer((_req,res) => {
    res.setHeader("set-cookie",["one=1; Path=/","two=2; Path=/"]);
    res.end("ok");
  });
  const sourcePort=await freePort();
  await new Promise(resolve=>source.listen(sourcePort,"127.0.0.1",resolve));
  t.after(()=>new Promise(resolve=>source.close(resolve)));
  const origin = `http://127.0.0.1:${source.address().port}`;
  const relay = await new McpRelay({origin,port:await freePort(),
    consoleAssetDir:root,consoleRpc:async request => {
      const response=await fetch(origin+request.path,{method:request.method,headers:request.headers,signal:request.signal});
      return {status:response.status,headers:{"set-cookie":response.headers.getSetCookie()},body:await response.text()};
    }}).start();
  t.after(()=>relay.close());
  const base = `http://127.0.0.1:${relay.port}`;
  const redirect = await fetch(base+'/console?view=one',{redirect:"manual"});
  assert.equal(redirect.status,303);assert.equal(redirect.headers.get("location"),"/console/?view=one");
  const html = await fetch(base+'/console/');assert.match(await html.text(),/\.\/assets\//);
  const asset = await fetch(base+'/console/assets/console-abcdefgh.js');
  assert.match(asset.headers.get("cache-control"),/immutable/);assert.match(await asset.text(),/quaymesh/);
  const unchanged = await fetch(base+'/console/assets/console-abcdefgh.js',{headers:{"if-none-match":asset.headers.get("etag")}});
  assert.equal(unchanged.status,304);
  const head = await fetch(base+'/console/assets/console-abcdefgh.js',{method:"HEAD"});assert.equal(await head.text(),"");
  const api = await fetch(base+'/console/api/read');assert.equal(api.headers.getSetCookie().length,2);await api.text();
  relay.setAccepting(false);
  assert.equal((await fetch(base+'/mcp',{method:"POST",body:"{}"})).status,401);
  assert.equal((await fetch(base+'/mcp',{method:"POST",headers:{authorization:"Bearer test"},body:"{}"})).status,503);
  assert.equal((await fetch(base+'/readyz')).status,200);
});

test("当前错误按来源恢复，历史错误保留恢复时间", () => {
  const errors = new SourceErrors();errors.fail("core",new Error("core timeout"));errors.fail("discovery",new Error("poll failed"));
  errors.recover("core");
  assert.deepEqual(errors.snapshot().current.map(value=>value.source),["discovery"]);
  assert.ok(errors.snapshot().history.find(value=>value.source==="core").recoveredAt);
});

test("组件参数和配置内容生效，配置revision本身不触发Core重启", async t => {
  const root = await directory(t), configuration = cluster({discovery:{resourceUrl:"https://test.invalid/mcp"}});
  const node = validateNode({schemaVersion:1,id:"edge",stateDir:root,mesh:{enabled:false,address:"127.0.0.2"},capabilities:{worker:true,discovery:true,consoleRelay:true},components:{
    tunnel:{executable:process.execPath,args:["run","--flag"],environment:{CUSTOM_SETTING:"value"}},
  }},configuration,root);
  const env = {[configuration.tokenEnv]:token(),[configuration.discovery.tunnelIdEnv]:"tunnel_real_identity",[configuration.discovery.apiKeyEnv]:token()};
  const options = {root,generatedDir:root,configDir:root,release:"one"};
  const first=componentPlans({...node,configRevision:1},configuration,env,options);
  const second=componentPlans({...node,configRevision:2},configuration,env,options);
  assert.deepEqual(first,second);
  const tunnel=first.find(value=>value.id==="discovery");assert.deepEqual(tunnel.args,["run","--flag"]);assert.equal(tunnel.env.CUSTOM_SETTING,"value");
  const local=nodeConfig(root,"edge",{network:{externalAccess:false},capabilities:{worker:true}});
  const core=compileCore(local,configuration,{root,tokenFile:join(root,"token"),ownerToken:token(),membershipFile:join(root,"members"),statusFile:join(root,"status")});
  assert.equal(core.runtime.subagents.enabled,false);assert.equal(core.runtime.federation.egress.enabled,false);
});
