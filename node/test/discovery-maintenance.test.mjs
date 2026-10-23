import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { once } from "node:events";
import { McpRelay } from "../relay.mjs";
import { waitRunning } from "../install.mjs";

async function listen(t, handler) {
  const server=http.createServer(handler);
  server.listen(0,"127.0.0.1");await once(server,"listening");
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  return {server,port:server.address().port};
}

test("维护期允许真实发现读取并在本地挑战无认证启动探测，所有业务保持关闭",async t=>{
  const requests=[];
  const documents={
    "/.well-known/oauth-protected-resource/mcp":{resource:"https://agent.example/mcp",authorization_servers:["https://agent.example/"]},
    "/.well-known/oauth-authorization-server":{issuer:"https://agent.example/",token_endpoint:"https://agent.example/token"},
  };
  const origin=await listen(t,(req,res)=>{
    requests.push({method:req.method,path:req.url});
    const doc=documents[req.url];
    res.writeHead(req.url==="/.well-known/oauth-protected-resource"?404:200,{"content-type":"application/json"});
    res.end(JSON.stringify(doc??{forwarded:true}));
  });
  const relay=await new McpRelay({origin:`http://127.0.0.1:${origin.port}`,port:0}).start();
  t.after(()=>relay.close());
  const url=`http://127.0.0.1:${relay.port}`;
  relay.setAccepting(false);
  for(const [path,doc] of Object.entries(documents)){
    const response=await fetch(url+path);
    assert.equal(response.status,200);assert.deepEqual(await response.json(),doc);
  }
  const fallback=await fetch(url+"/.well-known/oauth-protected-resource");
  assert.equal(fallback.status,404);await fallback.text();
  const before=requests.length;
  for(const [method,path] of [["GET","/mcp"],["POST","/mcp"],["POST","/mcp/"]]){
    const response=await fetch(url+path,{method,...(method==="POST"?{body:'{"method":"tools/call","params":{"name":"exec_command"}}'}:{})});
    assert.equal(response.status,401);
    assert.match(response.headers.get("www-authenticate"),/^Bearer(?: |$)/);
    assert.equal((await response.json()).error,"authentication_required");
  }
  assert.equal(requests.length,before,"未认证探测不得转发，即使正文声称执行工具");
  for(const [method,path,authorization] of [
    ["POST","/mcp","Bearer fixture"],["GET","/mcp","Bearer fixture"],["POST","/mcp",""],
    ["POST","/register"],["POST","/token"],["GET","/authorize"],["DELETE","/mcp"],
    ["GET","/mcp/other"],["POST","/.well-known/oauth-protected-resource/mcp"],
    ["GET","/.well-known/unrelated"],
  ]){
    const response=await fetch(url+path,{method,headers:authorization===undefined?{}:{authorization}});
    assert.equal(response.status,503,`${method} ${path}`);await response.text();
  }
  assert.equal(requests.length,before,"维护中的业务不能到达源服务");
  assert.equal(relay.activeRequests,0);
  const health=await fetch(url+"/readyz");assert.equal(health.status,200);await health.text();
  relay.setAccepting(true);
  const resumed=await fetch(url+"/mcp",{method:"POST",headers:{authorization:"Bearer fixture"},body:"{}"});
  assert.equal(resumed.status,200);assert.equal((await resumed.json()).forwarded,true);
  assert.equal(requests.at(-1).path,"/mcp");
});

function ready(id,pid=101){return {id,pid,state:"ready",processState:"running",startedAt:1,restarts:0,
  observedAt:Date.now(),error:null,probeError:null,crashLoop:false};}

test("发现组件缺失、重复、陈旧或失败时不能仅凭 Core ready 提交安装",async t=>{
  for(const variant of ["missing","duplicate","starting","stale","probeError","crashLoop"]){
    await t.test(variant,async child=>{
      let resumed=0;
      const endpoint=await listen(child,(req,res)=>{
        res.setHeader("content-type","application/json");
        if(req.url==="/maintenance/resume"){resumed++;res.end("{}");return;}
        let discovery=ready("discovery",201);
        if(variant==="starting")discovery.state="starting";
        if(variant==="stale")discovery.observedAt=Date.now()-30000;
        if(variant==="probeError")discovery.probeError="oauth discovery HTTP 503";
        if(variant==="crashLoop")discovery.crashLoop=true;
        const extra=variant==="missing"?[]:variant==="duplicate"?[discovery,{...discovery}]:[discovery];
        res.end(JSON.stringify({nodeId:"fixture",release:"commit",capabilities:{discovery:true},
          components:[ready("core"),...extra]}));
      });
      await assert.rejects(waitRunning({nodeId:"fixture",sourceCommit:"commit",adminPort:endpoint.port},
        "fixture-secret",150,{stableMs:0}),/discovery/);
      assert.equal(resumed,0);
    });
  }
});

test("发现组件重新启动会重置共同稳定窗口，Core 不变也不能提前验收",async t=>{
  let polls=0,resumed=0;
  const endpoint=await listen(t,(req,res)=>{
    res.setHeader("content-type","application/json");
    if(req.url==="/maintenance/resume"){resumed++;res.end("{}");return;}
    polls++;
    const discovery=ready("discovery",polls===1?201:202);
    discovery.startedAt=polls===1?1:2;discovery.restarts=polls===1?0:1;
    res.end(JSON.stringify({nodeId:"fixture",release:"commit",capabilities:{discovery:true},
      components:[ready("core"),discovery]}));
  });
  const status=await waitRunning({nodeId:"fixture",sourceCommit:"commit",adminPort:endpoint.port},
    "fixture-secret",3000,{stableMs:100});
  assert.equal(status.components[1].pid,202);assert.ok(polls>=3);assert.equal(resumed,1);
});

test("未启用发现且没有独立出口进程的节点只等待真实托管组件",async t=>{
  const endpoint=await listen(t,(_req,res)=>{
    res.setHeader("content-type","application/json");
    res.end(JSON.stringify({nodeId:"fixture",release:"commit",capabilities:{discovery:false,egress:true},
      components:[ready("core")]}));
  });
  const status=await waitRunning({nodeId:"fixture",sourceCommit:"commit",adminPort:endpoint.port},
    "fixture-secret",1000,{stableMs:0,resume:false});
  assert.equal(status.components.length,1);
});

