import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import net from "node:net";
import http from "node:http";
import { createHash } from "node:crypto";
import { RegistryServer } from "../registry.mjs";
import { McpRelay } from "../relay.mjs";
import { requestJson, connectSocket, createAgent } from "../network.mjs";
import { cluster, directory, token, freePort } from "./helpers.mjs";

test("两个实际入口访问同一个服务，停止一个入口后另一个继续响应",async t=>{
  const root=await directory(t);
  const origin=await new RegistryServer({cluster:cluster(),token:token(),stateDir:root,host:"127.0.0.1",port:0}).start();
  const upstream=`http://127.0.0.1:${origin.port}`;
  const first=await new McpRelay({origin:upstream,port:await freePort()}).start();
  const second=await new McpRelay({origin:upstream,port:await freePort()}).start();
  t.after(async()=>{await first.close();await second.close();await origin.close();});
  assert.equal((await requestJson(`http://127.0.0.1:${first.port}/healthz`)).service,"quaymesh-registry");
  assert.equal((await requestJson(`http://127.0.0.1:${second.port}/healthz`)).service,"quaymesh-registry");
  await first.close();
  assert.equal((await requestJson(`http://127.0.0.1:${second.port}/healthz`)).ok,true);
  const blocked=await fetch(`http://127.0.0.1:${second.port}/v1/cluster`);
  assert.equal(blocked.status,404);
});

test("实际源服务不可达时入口返回503并保留后续恢复能力",async t=>{
  const root=await directory(t);const port=await freePort();
  const relay=await new McpRelay({origin:`http://127.0.0.1:${port}`,port:await freePort()}).start();
  t.after(()=>relay.close());
  await assert.rejects(requestJson(`http://127.0.0.1:${relay.port}/healthz`),/503/);
  const origin=await new RegistryServer({cluster:cluster(),token:token(),stateDir:root,host:"127.0.0.1",port}).start();
  t.after(()=>origin.close());
  assert.equal((await requestJson(`http://127.0.0.1:${relay.port}/healthz`)).ok,true);
});

test("明确配置 SOCKS 时代理连接失败直接返回错误",async t=>{
  const root=await directory(t);
  const origin=await new RegistryServer({cluster:cluster(),token:token(),stateDir:root,host:"127.0.0.1",port:0}).start();
  t.after(()=>origin.close());
  const unavailable=await freePort();
  const url=new URL(`http://127.0.0.1:${origin.port}/healthz`);
  const agent=createAgent(url,{socksUrl:`socks5://127.0.0.1:${unavailable}`,timeoutMs:250});
  t.after(()=>agent.destroy());
  await assert.rejects(requestJson(url,{agent,timeoutMs:1000}));
  assert.equal((await requestJson(url)).ok,true);
});

test("连接取消会释放实际TCP连接",async t=>{
  const port=await freePort();const abort=new AbortController();abort.abort();
  await assert.rejects(connectSocket("127.0.0.1",port,{signal:abort.signal}),/abort/i);
});

test("MCP 长 SSE 响应经真实 HTTP 转发后保留保活帧及终态", async t => {
  const http = await import("node:http");
  const { once } = await import("node:events");
  const origin = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.flushHeaders();
    const timer = setInterval(() => res.write(": alive\n\n"), 20);
    res.once("close", () => clearInterval(timer));
    setTimeout(() => { clearInterval(timer);res.end('data: {"result":"ok"}\n\n'); }, 135);
  });
  origin.listen(0, "127.0.0.1"); await once(origin, "listening");
  const relay = await new McpRelay({ origin: `http://127.0.0.1:${origin.address().port}`, port: await freePort() }).start();
  t.after(async () => { await relay.close(); await new Promise(resolve => origin.close(resolve)); });
  const response = await fetch(`http://127.0.0.1:${relay.port}/mcp`, { method: "POST", body: "{}" });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.ok(text.match(/: alive/g)?.length >= 3);
  assert.match(text, /data: .*"ok"/);
  assert.equal(relay.activeRequests, 0);
});

test("上游半途断开 SSE 时下游立即失败，绝不记录成功", async t => {
  const http = await import("node:http");
  const { once } = await import("node:events");
  const origin = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(": started\n\n");
    setTimeout(() => res.destroy(), 30);
  });
  origin.listen(0, "127.0.0.1"); await once(origin, "listening");
  let successes = 0;
  const relay = await new McpRelay({ origin: `http://127.0.0.1:${origin.address().port}`, port: await freePort(),
    onSuccess: () => { successes += 1; } }).start();
  t.after(async () => { await relay.close(); await new Promise(resolve => origin.close(resolve)); });
  const response = await fetch(`http://127.0.0.1:${relay.port}/mcp`, { method: "POST", body: "{}" });
  assert.equal(response.status, 200);
  await assert.rejects(response.text(), /terminated|aborted|premature/i);
  assert.equal(successes, 0);
  for (let attempt = 0; relay.activeRequests !== 0 && attempt < 20; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(relay.activeRequests, 0);
});

test("持续 SSE 心跳不会延长最终结果期限", async t => {
  const http=await import("node:http");const {once}=await import("node:events");
  const failures=[];let successes=0;
  const origin=http.createServer((_req,res)=>{
    res.writeHead(200,{"content-type":"text/event-stream"});res.write(": connected\n\n");
    const timer=setInterval(()=>res.write(": alive\n\n"),10);res.once("close",()=>clearInterval(timer));
  });
  origin.listen(0,"127.0.0.1");await once(origin,"listening");
  const relay=await new McpRelay({origin:`http://127.0.0.1:${origin.address().port}`,port:await freePort(),mcpResponseTimeoutMs:150,
    onError:error=>failures.push(error),onSuccess:()=>successes++}).start();
  t.after(async()=>{await relay.close();await new Promise(resolve=>origin.close(resolve));});
  const response=await fetch(`http://127.0.0.1:${relay.port}/mcp`,{method:"POST",body:"{}"});
  await assert.rejects(response.text(),/terminated|aborted|premature/i);
  assert.equal(failures[0]?.code,"MCP_RESPONSE_TIMEOUT");assert.equal(successes,0);
});

test("控制台入口断开后保留登录并自动重试，恢复后取得协调器新页面", async t => {
  const port = await freePort();
  let version = "first", seenCookie = "";
  let origin = http.createServer((req, res) => {
    seenCookie = req.headers.cookie || "";
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(`<h1>${version}</h1>`);
  });
  const start = () => new Promise(resolve => origin.listen(port, "127.0.0.1", resolve));
  const stop = async () => { origin.closeAllConnections(); await new Promise(resolve => origin.close(resolve)); };
  await start();
  const relay = await new McpRelay({ origin: `http://127.0.0.1:${port}`, port: await freePort(), consoleRpc: async request => {
    const reply = await fetch(`http://127.0.0.1:${port}${request.path}`, { method: request.method, headers: request.headers, signal: request.signal });
    return { status: reply.status, headers: Object.fromEntries(reply.headers), body: await reply.text() };
  } }).start();
  t.after(async () => { await relay.close(); await stop(); });
  const url = `http://127.0.0.1:${relay.port}/console/?entry=local`;
  const headers = { cookie: "qm_console_session=kept" };
  assert.equal(await (await fetch(url, { headers })).text(), "<h1>first</h1>");
  await stop();
  const disconnected = await fetch(url, { headers });
  assert.equal(disconnected.status, 503);
  assert.equal(disconnected.headers.get("set-cookie"), null);
  const html = await disconnected.text();
  assert.match(html, /控制台暂未连接/);
  assert.match(html, /<button type="button" id="reconnect"/);
  const script = html.match(/<script>(.*?)<\/script>/s)?.[1];
  assert.ok(script);
  assert.match(script, /location\.reload\(\)/);
  assert.ok(disconnected.headers.get("content-security-policy").includes(`script-src 'sha256-${createHash("sha256").update(script).digest("base64")}'`));
  assert.doesNotMatch(html, /<form|http-equiv="refresh"/);
  version = "second";
  await start();
  assert.equal(await (await fetch(url, { headers })).text(), "<h1>second</h1>");
  assert.equal(seenCookie, headers.cookie);
});

test("浏览器取消控制台读取时终止 RPC，节点不记录连接故障", async t => {
  const failures = [];
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const relay = await new McpRelay({ origin: "http://127.0.0.1:1", port: await freePort(), onError: error => failures.push(error),
    consoleRpc: request => new Promise((_resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
      started();
    }),
  }).start();
  t.after(() => relay.close());
  const controller = new AbortController();
  const request = fetch(`http://127.0.0.1:${relay.port}/console/api/session`, { signal: controller.signal });
  await ready; controller.abort();
  await assert.rejects(request, { name: "AbortError" });
  for (let attempt = 0; relay.activeRequests > 0 && attempt < 20; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(relay.activeRequests, 0);
  assert.deepEqual(failures, []);
});
