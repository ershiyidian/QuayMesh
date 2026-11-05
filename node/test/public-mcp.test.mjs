import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { createPublicMcpIngress, PUBLIC_MCP_PROBE_USER_AGENT } from "../public-mcp.mjs";
import { QuayMeshNode } from "../app.mjs";

const entry = fileURLToPath(new URL("../public-mcp.mjs", import.meta.url));

async function fixture(t, handler, options = {}) {
  const origin = createServer(handler);
  origin.listen(0, "127.0.0.1");
  await once(origin, "listening");
  const upstream = "http://127.0.0.1:" + origin.address().port;
  const ingress = await createPublicMcpIngress({
    publicUrl: "https://139-196-215-153.sslip.io/mcp",
    upstream, port: 0, ...options,
  }).start();
  const base = "http://127.0.0.1:" + ingress.server.address().port;
  t.after(async () => {
    ingress.server.closeAllConnections(); origin.closeAllConnections();
    await ingress.close(); await new Promise(resolve => origin.close(resolve));
  });
  return { base };
}

async function startCli(t, args) {
  const child = spawn(process.execPath, [entry, ...args], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const lines = createInterface({ input: child.stdout });
  let stderr = "";
  child.stderr.on("data", data => { stderr += data; });
  const observed = Promise.withResolvers();
  child.on("message", event => {
    if (event.type === "public-mcp-request" && event.path === "/mcp") observed.resolve(event);
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM"); await exited;
    }
    lines.close();
  });
  const port = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", code => reject(new Error(`Public MCP exited ${code}: ${stderr}`)));
    lines.on("line", line => {
      const match = /listening on 127\.0\.0\.1:(\d+)/.exec(line);
      if (match) resolve(Number(match[1]));
    });
  });
  return { child, base: `http://127.0.0.1:${port}`, observed: observed.promise };
}

test("公网元数据完整采用 HTTPS 原点，内部 loopback 地址从不泄漏", async t => {
  const {base} = await fixture(t, (_req,res) => res.writeHead(502).end());
  const resource = await fetch(base+"/.well-known/oauth-protected-resource/mcp");
  assert.equal(resource.status, 200);
  assert.deepEqual((await resource.json()).authorization_servers, ["https://139-196-215-153.sslip.io"]);
  const root = await (await fetch(base+"/.well-known/oauth-protected-resource")).json();
  assert.equal(root.resource, "https://139-196-215-153.sslip.io");
  assert.deepEqual(root.bearer_methods_supported,["header"]);
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
  assert.match(header,/https:\/\/139-196-215-153\.sslip\.io\/\.well-known\/oauth-protected-resource/);
  assert.doesNotMatch(header,/oauth-protected-resource\/mcp/);
  assert.match(header,/realm="QuayMesh"/);
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

test("正式组件与旧配置均可启动真实入口，并通过 IPC 上报请求", { timeout: 10000 }, async t => {
  const origin = createServer((req, res) => {
    req.resume(); res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
  });
  origin.listen(0, "127.0.0.1"); await once(origin, "listening");
  t.after(async () => { origin.closeAllConnections(); await new Promise(resolve => origin.close(resolve)); });
  const upstream = `http://127.0.0.1:${origin.address().port}`;
  const publicUrl = "https://gemini.example/mcp";
  const dir = await mkdtemp(join(tmpdir(), "quaymesh-public-mcp-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = join(dir, "node.json");
  await writeFile(config, JSON.stringify({ capabilities: { coordinator: true },
    publicMcp: { url: publicUrl }, corePort: origin.address().port }));
  for (const [name, args] of [
    ["explicit", ["--public-url", publicUrl, "--upstream", upstream]],
    ["config", ["--config", config]],
  ]) await t.test(name, async t => {
    const { base, child, observed } = await startCli(t, [...args, "--port", "0"]);
    const meta = await (await fetch(base+"/.well-known/oauth-protected-resource")).json();
    assert.equal(meta.resource, "https://gemini.example");
    const startedAt = Date.now();
    const response = await fetch(base+"/mcp?state=query-private", { method: "POST",
      headers: { authorization: "Bearer header-private", "user-agent": "Google" }, body: "body-private" });
    assert.deepEqual(await response.json(), { ok: true });
    const event = await observed;
    assert.equal(event.outcome, "completed");
    assert.equal(event.status, 200);
    assert.equal(event.agent, "Google");
    assert.ok(Date.parse(event.startedAt) >= startedAt);
    assert.ok(Date.parse(event.finishedAt) >= Date.parse(event.startedAt));
    assert.ok(Date.parse(event.finishedAt) <= Date.now());
    assert.ok(event.ms >= 0);
    assert.doesNotMatch(JSON.stringify(event), /query-private|header-private|body-private/);
    const disconnected = once(child, "disconnect"); child.disconnect(); await disconnected;
    const afterDisconnect = await fetch(base+"/mcp", { method: "POST", body: "{}" });
    assert.deepEqual(await afterDisconnect.json(), { ok: true });
    assert.equal((await fetch(base+"/readyz")).status, 404);
  });
});

test("CLI 拒绝未知参数、冲突模式和无效监听或上游地址", () => {
  const explicit = ["--public-url", "https://gemini.example/mcp", "--upstream", "http://127.0.0.1:12345"];
  for (const [args, expected] of [
    [[...explicit, "--unknown"], /Unknown option/],
    [[...explicit, "extra"], /Unexpected argument/],
    [[...explicit, "--config", "unused.json"], /Use either/],
    [["--public-url", "https://gemini.example/mcp"], /Provide --config/],
    [[...explicit, "--port", "NaN"], /Port must/],
    [[...explicit, "--port", "65536"], /Port must/],
    [["--public-url", "https://gemini.example/mcp", "--upstream", "http://example.com"], /loopback origin/],
    [["--public-url", "https://gemini.example/mcp", "--upstream", "http://127.0.0.1:12345/mcp"], /loopback origin/],
  ]) {
    const result = spawnSync(process.execPath, [entry, ...args], { encoding: "utf8", timeout: 3000 });
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expected);
  }
});

test("客户端中止正在上传的请求时仅记录一条无凭据结果，并关闭上游", { timeout: 5000 }, async t => {
  const arrived = Promise.withResolvers(), aborted = Promise.withResolvers(), logged = Promise.withResolvers();
  const events = [];
  const { base } = await fixture(t, req => {
    req.once("data", arrived.resolve);
    req.once("aborted", aborted.resolve);
    req.on("error", () => {});
  }, { onRequest: event => { events.push(event); logged.resolve(event); } });
  const client = request(base+"/mcp?access_token=query-private", { method: "POST",
    headers: { authorization: "Bearer header-private", cookie: "secret=cookie-private" } });
  client.on("error", () => {});
  client.write("body-private");
  await arrived.promise;
  client.destroy();
  const [event] = await Promise.all([logged.promise, aborted.promise]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events.length, 1);
  assert.equal(event.outcome, "client_aborted");
  assert.equal(event.status, null);
  assert.doesNotMatch(JSON.stringify(event), /query-private|header-private|cookie-private|body-private/);
});

test("上游在响应中途断开时记录真实中断，finish 和 close 不重复记账", { timeout: 5000 }, async t => {
  const logged = Promise.withResolvers();
  const events = [];
  let upstreamReply;
  const { base } = await fixture(t, (req, res) => {
    req.resume(); upstreamReply = res;
    res.on("error", () => {});
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: first\n\n");
  }, { onRequest: event => { events.push(event); logged.resolve(event); } });
  const incoming = await new Promise((resolve, reject) => {
    const client = request(base+"/mcp", resolve);
    client.on("error", reject); client.end();
  });
  incoming.on("error", () => {});
  await once(incoming, "data");
  const aborted = new Promise(resolve => incoming.once("aborted", resolve));
  upstreamReply.destroy(new Error("upstream-private-detail"));
  const [event] = await Promise.all([logged.promise, aborted]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events.length, 1);
  assert.equal(event.outcome, "upstream_closed");
  assert.equal(event.status, 200);
  assert.doesNotMatch(JSON.stringify(event), /upstream-private-detail/);
});

test("仅省略明确的本机成功探测，空客户端标识和经过代理的发现请求仍留痕", async t => {
  const events = [];
  const { base } = await fixture(t, (req, res) => {
    req.resume(); res.writeHead(200).end("ok");
  }, { onRequest: event => events.push(event) });
  const path = "/.well-known/oauth-protected-resource";
  const probeHeaders = { "user-agent": PUBLIC_MCP_PROBE_USER_AGENT };
  const probe = await fetch(base+path, { headers: probeHeaders });
  assert.equal(probe.status, 200); await probe.text();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events.length, 0);
  for (const [url, headers] of [
    [path, { "user-agent": "" }],
    [path, { ...probeHeaders, "x-forwarded-for": "203.0.113.1" }],
    [path+"?state=query-private", probeHeaders],
    ["/mcp", probeHeaders],
  ]) {
    const response = await fetch(base+url, { headers });
    assert.equal(response.status, 200); await response.text();
  }
  assert.equal(events.length, 4);
  assert.equal(events[0].agent, "");
  assert.equal(events[3].path, "/mcp");
  assert.doesNotMatch(JSON.stringify(events), /query-private/);
});

test("授权错误只记录标准代码，有限解析不改变响应内容和其他流量", async t => {
  for (const [name, path, status, contentType, body, expected] of [
    ["refresh failure", "/token", 400, "application/json; charset=utf-8",
      JSON.stringify({error:"invalid_grant",error_description:"description-private",refresh_token:"refresh-private"}), "invalid_grant"],
    ["unknown error", "/token", 400, "application/json", '{"error":"code-private"}', undefined],
    ["malformed json", "/token", 400, "application/json", '{"error":"invalid_grant",broken-private', undefined],
    ["bounded capture", "/token", 400, "application/json",
      JSON.stringify({error:"invalid_grant",error_description:"large-private".repeat(500)}), undefined],
    ["non json", "/token", 502, "text/plain", '{"error":"invalid_grant"}', undefined],
    ["successful token", "/token", 200, "application/json", '{"access_token":"access-private"}', undefined],
    ["MCP response", "/mcp", 400, "application/json", '{"error":"invalid_grant","body":"mcp-private"}', undefined],
  ]) await t.test(name, async t => {
    const logged = Promise.withResolvers();
    const { base } = await fixture(t, (req, res) => {
      req.resume(); res.writeHead(status, { "content-type": contentType });
      res.write(body.slice(0, 12));
      setImmediate(() => res.end(body.slice(12)));
    }, { onRequest: logged.resolve });
    const response = await fetch(base+path, {method:"POST",body:"request-private"});
    assert.equal(response.status, status);
    assert.equal(await response.text(), body);
    const event = await logged.promise;
    assert.equal(event.oauthError, expected);
    assert.equal(event.outcome, "completed");
    assert.doesNotMatch(JSON.stringify(event), /description-private|refresh-private|code-private|broken-private|large-private|access-private|mcp-private|request-private/);
  });
});

test("入口状态保留授权失败时间，后续成功清除当前授权错误且不改变组件就绪", async t => {
  const stateDir = await mkdtemp(join(tmpdir(), "quaymesh-token-status-"));
  t.after(() => rm(stateDir, {recursive:true,force:true}));
  const node = new QuayMeshNode({revision:1,node:{stateDir,corePort:0,
    publicMcp:{url:"https://gemini.example/mcp",funnel:{}}}});
  node.supervisor = {snapshot:()=>[
    {id:"public-mcp",state:"ready",lastReadyAt:1}, {id:"funnel",state:"ready",lastReadyAt:1},
  ]};
  let tokenStatus = 400, lastEvent;
  const { base } = await fixture(t, (req, res) => {
    req.resume();
    const status = req.url === "/token" ? tokenStatus : 200;
    res.writeHead(status, {"content-type":"application/json"})
      .end(status === 400 ? '{"error":"invalid_grant"}' : '{"ok":true}');
  }, {onRequest:event=>{
    lastEvent = event;
    node.recordPublicMcpRequest({type:"public-mcp-request",...event});
  }});
  await (await fetch(base+"/token", {method:"POST",body:"refresh-private"})).text();
  const failed = node.publicMcpStatus();
  assert.equal(failed.ready, true);
  assert.equal(failed.lastTokenStatus, 400);
  assert.equal(failed.lastTokenError, "invalid_grant");
  assert.equal(failed.lastTokenRequestAt, Date.parse(lastEvent.finishedAt));
  assert.equal(failed.lastTokenFailureAt, failed.lastTokenRequestAt);
  assert.equal(failed.lastTokenSuccessAt, null);

  await (await fetch(base+"/mcp", {method:"POST",body:"{}"})).text();
  assert.equal(node.publicMcpStatus().lastTokenError, "invalid_grant");
  assert.equal(node.publicMcpStatus().lastStatus, 200);
  tokenStatus = 200;
  await (await fetch(base+"/token", {method:"POST",body:"refresh-private"})).text();
  const recovered = node.publicMcpStatus();
  assert.equal(recovered.ready, true);
  assert.equal(recovered.lastTokenStatus, 200);
  assert.equal(recovered.lastTokenError, null);
  assert.equal(recovered.lastTokenSuccessAt, Date.parse(lastEvent.finishedAt));
  assert.equal(recovered.lastTokenRequestAt, recovered.lastTokenSuccessAt);
  assert.equal(recovered.lastTokenFailureAt, failed.lastTokenFailureAt);
});
