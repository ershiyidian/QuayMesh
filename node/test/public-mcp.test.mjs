import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createPublicMcpIngress } from "../public-mcp.mjs";

async function fixture(t, handler) {
  const origin = createServer(handler);
  origin.listen(0, "127.0.0.1");
  await once(origin, "listening");
  const upstream = "http://127.0.0.1:" + origin.address().port;
  const ingress = await createPublicMcpIngress({
    publicUrl: "https://139-196-215-153.sslip.io/mcp",
    upstream, port: 0,
  }).start();
  const base = "http://127.0.0.1:" + ingress.server.address().port;
  t.after(async () => {await ingress.close(); await new Promise(resolve => origin.close(resolve));});
  return { base };
}

test("公网元数据完整采用 HTTPS 原点，内部 loopback 地址从不泄漏", async t => {
  const {base} = await fixture(t, (_req,res) => res.writeHead(502).end());
  const resource = await fetch(base+"/.well-known/oauth-protected-resource/mcp");
  assert.equal(resource.status, 200);
  assert.deepEqual((await resource.json()).authorization_servers, ["https://139-196-215-153.sslip.io"]);
  const root = await (await fetch(base+"/.well-known/oauth-protected-resource")).json();
  assert.equal(root.resource, "https://139-196-215-153.sslip.io/mcp");
  const meta = await (await fetch(base+"/.well-known/oauth-authorization-server")).json();
  assert.equal(meta.issuer,"https://139-196-215-153.sslip.io");
  assert.equal(meta.registration_endpoint,"https://139-196-215-153.sslip.io/register");
  assert.deepEqual(meta.code_challenge_methods_supported,["S256"]);
  assert.doesNotMatch(JSON.stringify({root,meta}),/127\.0\.0\.1/);
  const pathAware = await fetch(base+"/.well-known/oauth-authorization-server/mcp");
  assert.equal(pathAware.status,200);
  assert.deepEqual(await pathAware.json(),meta);
});

test("Gemini web OAuth discovery supports CORS with exposed 401 challenge and browser preflight",async t=>{
  const {base}=await fixture(t,(_req,res)=>{
    res.writeHead(401,{"www-authenticate":'Bearer resource_metadata="http://127.0.0.1:17676/.well-known/oauth-protected-resource/mcp"'}).end();
  });
  const headers={"Origin":"https://gemini.google.com"};
  for(const path of ["/mcp","/.well-known/oauth-protected-resource/mcp",
    "/.well-known/oauth-authorization-server","/.well-known/oauth-authorization-server/mcp"]) {
    const response=await fetch(base+path,{method:"GET",headers});
    assert.equal(response.headers.get("access-control-allow-origin"),"https://gemini.google.com");
    assert.match(response.headers.get("access-control-expose-headers")??"",/WWW-Authenticate/);
  }
  for(const path of ["/register","/token","/mcp"]) {
    const response=await fetch(base+path,{method:"OPTIONS",
      headers:{...headers,"Access-Control-Request-Method":"POST",
        "Access-Control-Request-Headers":"content-type,authorization"}});
    assert.equal(response.status,204,path);
    assert.equal(response.headers.get("access-control-allow-origin"),"https://gemini.google.com");
    assert.match(response.headers.get("access-control-allow-headers")??"",/Authorization/);
  }
  const hostile=await fetch(base+"/register",{method:"OPTIONS",
    headers:{"Origin":"https://attacker.example"}});
  assert.equal(hostile.headers.get("access-control-allow-origin"),null);
  assert.equal(hostile.status,404);
  const secret=await fetch(base+"/console/api",{method:"OPTIONS",headers});
  assert.equal(secret.status,404);
});

test("MCP 401 保留真实认证失败，同时把 resource_metadata 指向公网", async t => {
  const {base} = await fixture(t, (req,res) => {
    assert.equal(req.headers.host,"127.0.0.1:"+req.socket.localPort);
    res.writeHead(401,{ "www-authenticate":'Bearer scope="quaymesh", resource_metadata="http://127.0.0.1:17676/.well-known/oauth-protected-resource/mcp"' }).end();
  });
  const res = await fetch(base+"/mcp",{method:"POST",headers:{"content-type":"application/json"},body:"{}"});
  assert.equal(res.status,401);
  const header=res.headers.get("www-authenticate");
  assert.match(header,/https:\/\/139-196-215-153\.sslip\.io\/\.well-known\/oauth-protected-resource\/mcp/);
  assert.doesNotMatch(header,/127\.0\.0\.1/);
  assert.doesNotMatch(header,/invalid_token|error_description/);
});

test("Bearer token failure preserves invalid_token while empty authorization uses an OAuth discovery challenge",async t=>{
  const {base}=await fixture(t, (req,res)=>{
    res.writeHead(401,{"www-authenticate":
      'Bearer error="invalid_token", error_description="Invalid token", scope="quaymesh", resource_metadata="http://127.0.0.1:17676/.well-known/oauth-protected-resource/mcp"'}).end();
  });
  const challenge=await fetch(base+"/mcp",{method:"HEAD"});
  assert.equal(challenge.status,401);
  assert.doesNotMatch(challenge.headers.get("www-authenticate"),/invalid_token/);
  const invalid=await fetch(base+"/mcp",{method:"HEAD",headers:{Authorization:"Bearer invalid"}});
  assert.equal(invalid.status,401);
  const failedHeader=invalid.headers.get("www-authenticate");
  assert.match(failedHeader,/error="invalid_token"/);
  assert.match(failedHeader,/https:\/\/139-196-215-153\.sslip\.io\/\.well-known/);
});

test("公网严禁 console、internal、以及不在白名单中的 RPC 路径", async t => {
  let calls=0;
  const {base} = await fixture(t,(_req,res)=>{calls++;res.writeHead(200).end("leak");});
  for(const path of ["/console","/console/api/v4/overview","/internal/quaymesh/idle","/readyz","/garbage","/%2e%2e/console/"]) {
    const res = await fetch(base+path);
    assert.equal(res.status,404,path);
  }
  assert.equal(calls,0);
});

test("DCR 请求被透传，重复注册会按固定配额限流",async t=>{
  let count=0;
  const {base}=await fixture(t,async(req,res)=>{
    if(req.url==="/register"&&req.method==="POST") {
      count++;
      let buf="";
      for await(const part of req)buf+=part;
      res.writeHead(201,{"content-type":"application/json"}).end(buf);return;
    }
    res.writeHead(404).end();
  });
  for(let i=0;i<13;i++){
    const res=await fetch(base+"/register",{method:"POST",headers:{"content-type":"application/json"},body:'{"client_name":"Gemini"}'});
    assert.equal(res.status,i<12?201:429);
    if(i<12) assert.equal((await res.json()).client_name,"Gemini");
  }
  assert.equal(count,12);
});

test("Gemini OAuth POST 的 Google 回调使用安全页面导航，普通回调仍然 302",async t=>{
  const {base}=await fixture(t,(_req,res)=>{
    res.writeHead(302,{Location:"https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-test?code=abc&state=xyz"});
    res.end();
  });
  const response=await fetch(base+"/authorize",{method:"POST",body:"owner_token=x",redirect:"manual"});
  assert.equal(response.status,200);
  assert.equal(response.headers.get("cache-control"),"no-store");
  const html=await response.text();
  assert.match(html,/<meta http-equiv="refresh"/);
  assert.match(html,/code=abc&amp;state=xyz/);
  assert.doesNotMatch(html,/<script/);
});

test("Gemini 1112 字符的 state 在授权页面与回调之间完整保留",async t=>{
  const state="s".repeat(1112);
  const {base}=await fixture(t,(_req,res)=>{
    res.writeHead(302,{Location:"https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-test?code=abc&state="+state});
    res.end();
  });
  const response=await fetch(base+"/authorize",{method:"POST",body:"owner_token=x",redirect:"manual"});
  assert.equal(response.status,200);
  const html=await response.text();
  const link=html.match(/<a rel="noreferrer" href="([^"]+)"/)?.[1];
  assert.ok(link);
  const decoded=new URL(link.replaceAll("&amp;","&"));
  assert.equal(decoded.searchParams.get("state"),state);
});

test("公网不转发客户端 Cookie，也不转发无关头部",async t=>{
  const {base}=await fixture(t,(req,res)=>{
    assert.equal(req.headers.cookie,undefined);
    assert.equal(req.headers.authorization,"Bearer test");
    assert.equal(req.headers["x-forwarded-host"],undefined);
    res.writeHead(200,{"content-type":"application/json"}).end('{"ok":true}');
  });
  const res=await fetch(base+"/mcp",{method:"POST",
    headers:{"authorization":"Bearer test","cookie":"secret=leak","x-forwarded-host":"fake.example","content-type":"application/json"},body:"{}"});
  assert.equal(res.status,200);
  assert.deepEqual(await res.json(),{ok:true});
});
