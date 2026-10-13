import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { requestDiscoveryReady, requestText } from "../network.mjs";

async function start(handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

test("发现端就绪适配接受真实纯文本 ready", async t => {
  const { server, url } = await start((req, res) => {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("ready");
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const result = await requestDiscoveryReady(`${url}/readyz`);
  assert.equal(result.ready, true);
  assert.equal(result.body, "ready");
});

test("发现端就绪适配接受带认证说明的 ready", async t => {
  const { server, url } = await start((req, res) => {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" })
      .end("ready (mcp initialize requires auth: unauthorized)");
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const result = await requestDiscoveryReady(`${url}/readyz`);
  assert.equal(result.ready, true);
  assert.match(result.body, /^ready \(/);
});

test("发现端就绪适配拒绝 HTTP 503", async t => {
  const { server, url } = await start((req, res) => {
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" }).end("oauth discovery pending");
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  await assert.rejects(requestDiscoveryReady(`${url}/readyz`), /HTTP 503/);
});

test("发现端就绪适配拒绝任意非空正文", async t => {
  const { server, url } = await start((req, res) => {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("starting");
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  await assert.rejects(requestDiscoveryReady(`${url}/readyz`), /无法识别/);
});

test("发现端就绪适配保留连接失败原因", async () => {
  await assert.rejects(requestDiscoveryReady("http://127.0.0.1:1/readyz", { timeoutMs: 500 }));
});

test("requestText 不做 JSON 解析并可保留原始正文", async t => {
  const { server, url } = await start((req, res) => {
    res.writeHead(200).end("{\"not\":\"parsed\"}");
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const reply = await requestText(`${url}/readyz`);
  assert.equal(reply.status, 200);
  assert.equal(reply.text, "{\"not\":\"parsed\"}");
});
