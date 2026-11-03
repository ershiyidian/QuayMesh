import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { validateNode } from "../config.mjs";
import { compileCore, componentPlans } from "../compile.mjs";
import { cluster, directory } from "./helpers.mjs";

const publicUrl="https://gemini.example.ts.net/mcp";
const linux={skip:process.platform!=="linux"};

test("Funnel 正式组件使用现有动态出口与持久身份，公网适配器通过本机 relay 转发",linux,async t=>{
  const root=await directory(t),c=cluster();
  const node=validateNode({schemaVersion:1,id:"edge",stateDir:root,capabilities:{worker:true},
    mesh:{enabled:false,address:"127.0.0.2"},network:{externalAccess:true,proxyUrl:"http://127.0.0.1:7890"},
    publicMcp:{url:publicUrl,funnel:{controlProxyPort:17892}},consoleSettings:{egress:{listenPort:17891}},
    components:{tailscale:{executable:join(root,"bin","tailscaled")}}},c,root);
  const plans=componentPlans(node,c,{OPENAI_API_KEY:"private"},
    {root,generatedDir:root,configDir:root,release:"test"});
  const ingress=plans.find(value=>value.id==="public-mcp"),funnel=plans.find(value=>value.id==="funnel");
  assert.equal(node.publicMcp.listenPort,29177);
  assert.equal(node.publicMcp.funnel.stateDir,join(root,"tailscale"));
  assert.deepEqual(ingress.args,[join(root,"node","public-mcp.mjs"),"--public-url",publicUrl,
    "--upstream",`http://127.0.0.1:${c.discovery.localPort}`,"--port","29177"]);
  assert.equal(ingress.env.OPENAI_API_KEY,undefined);
  assert.equal(funnel.command,join(root,"bin","tailscaled"));
  assert.equal(funnel.env.HTTPS_PROXY,"http://127.0.0.1:17892");
  const {runtime}=compileCore(node,c,{root,tokenFile:join(root,"token"),ownerToken:"test-owner-token-1234"});
  assert.equal(runtime.federation.egress.listenPort,17891);
  assert.equal(runtime.federation.egress.controlListenPort,17892);
  assert.ok(funnel.args.includes(`--state=${join(root,"tailscale","tailscaled.state")}`));
  assert.ok(funnel.args.includes(`--socket=${join(root,"tailscale","tailscaled.sock")}`));
  assert.deepEqual(funnel.requires,["public-mcp","core"]);
  assert.equal(plans.some(value=>value.id==="discovery"),false);
  assert.doesNotThrow(()=>validateNode(node,c,root));
});

test("Funnel 校验实际可达的外网与端口冲突，未配置入口的节点没有新增依赖",linux,async t=>{
  const root=await directory(t),c=cluster();
  const base={schemaVersion:1,id:"edge",stateDir:root,capabilities:{worker:true},
    mesh:{enabled:false,address:"127.0.0.2"},publicMcp:{url:publicUrl,funnel:{}}};
  assert.throws(()=>validateNode({...base,network:{externalAccess:false}},c,root),/需要允许.*外网/);
  for(const listenPort of [c.discovery.localPort,17890,17889])
    assert.throws(()=>validateNode({...base,publicMcp:{...base.publicMcp,listenPort}},c,root),/端口发生冲突/);
  assert.throws(()=>validateNode({...base,publicMcp:{url:publicUrl,funnel:{controlProxyPort:17890}}},c,root),/端口发生冲突/);
  assert.throws(()=>validateNode({...base,publicMcp:{url:publicUrl,funnel:{controlProxyPort:0}}},c,root),/controlProxyPort/);
  assert.throws(()=>validateNode({...base,publicMcp:{url:"https://gemini.example.ts.net:8443/mcp",funnel:{}}},c,root),/HTTPS 443/);
  assert.throws(()=>validateNode({...base,components:{tailscale:{args:["--state=elsewhere"]}}},c,root),/args/);
  const node=validateNode({...base,publicMcp:undefined},c,root);
  const plans=componentPlans(node,c,{}, {root,generatedDir:root,configDir:root,release:"test"});
  assert.deepEqual(plans.map(value=>value.id),["core"]);
  const {runtime}=compileCore(node,c,{root,tokenFile:join(root,"token"),ownerToken:"test-owner-token-1234"});
  assert.equal(runtime.federation.egress.controlListenPort,undefined);
});

test("显式关闭动态出口时不创建控制代理，Funnel 使用已配置的外网代理",linux,async t=>{
  const root=await directory(t),c=cluster();
  const node=validateNode({schemaVersion:1,id:"edge",stateDir:root,capabilities:{worker:true},
    mesh:{enabled:false,address:"127.0.0.2"},network:{externalAccess:true,proxyUrl:"http://127.0.0.1:7890"},
    publicMcp:{url:publicUrl,funnel:{}},consoleSettings:{egress:{enabled:false}}},c,root);
  const plans=componentPlans(node,c,{}, {root,generatedDir:root,configDir:root,release:"test"});
  assert.equal(plans.find(value=>value.id==="funnel").env.HTTPS_PROXY,"http://127.0.0.1:7890");
  assert.deepEqual(plans.find(value=>value.id==="funnel").requires,["public-mcp"]);
  const {runtime}=compileCore(node,c,{root,tokenFile:join(root,"token"),ownerToken:"test-owner-token-1234"});
  assert.equal(runtime.federation.egress.enabled,false);
  assert.equal(runtime.federation.egress.controlListenPort,undefined);
});
