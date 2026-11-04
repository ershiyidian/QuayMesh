import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import http2 from "node:http2";
import net from "node:net";
import test from "node:test";
import { SocksClient } from "socks";
import { connectSocket, createAgent, requestJson } from "../network.mjs";

async function fixture(t, http1 = false) {
  const sessions = new Set();
  const server = http1
    ? http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ready: true }));
    })
    : http2.createServer();
  if (!http1) {
    server.on("session", session => {
      sessions.add(session);
      session.on("error", () => {});
      session.once("close", () => sessions.delete(session));
    });
    server.on("stream", stream => {
      stream.on("error", () => {});
      void (async () => {
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        stream.respond({ ":status": 200 });
        stream.end(Buffer.concat(chunks));
      })().catch(error => stream.destroy(error));
    });
  }
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const sockets = new Set();
  let coalescedBytes = 0;
  const proxy = net.createServer(downstream => {
    sockets.add(downstream);
    downstream.on("error", () => {});
    downstream.once("close", () => sockets.delete(downstream));
    let incoming = Buffer.alloc(0), greeting = true;
    const handshake = chunk => {
      incoming = Buffer.concat([incoming, chunk]);
      if (greeting) {
        if (incoming.length < 2 || incoming.length < 2 + incoming[1]) return;
        incoming = incoming.subarray(2 + incoming[1]);
        greeting = false;
        downstream.write(Buffer.from([5, 0]));
      }
      if (incoming.length < 4) return;
      const atyp = incoming[3];
      const length = atyp === 1 ? 10 : atyp === 4 ? 22 : incoming.length >= 5 ? 7 + incoming[4] : Infinity;
      if (incoming.length < length) return;
      downstream.off("data", handshake);
      downstream.pause();
      const extra = incoming.subarray(length);
      const upstream = net.connect({ host: "127.0.0.1", port: server.address().port });
      sockets.add(upstream);
      upstream.on("error", () => downstream.destroy());
      upstream.once("close", () => { sockets.delete(upstream); downstream.destroy(); });
      downstream.once("close", () => upstream.destroy());
      const deliver = initial => {
        coalescedBytes += initial.length;
        downstream.write(Buffer.concat([Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]), initial]));
        upstream.pipe(downstream);
        downstream.pipe(upstream);
        if (extra.length) upstream.write(extra);
        downstream.resume();
      };
      // 把真实服务端 SETTINGS 与 SOCKS 成功应答放入同一次 TCP 写入。
      if (http1) upstream.once("connect", () => deliver(Buffer.alloc(0)));
      else upstream.once("data", deliver);
    };
    downstream.on("data", handshake);
  });
  await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    for (const session of sessions) session.destroy();
    await Promise.all([new Promise(resolve => proxy.close(resolve)), new Promise(resolve => server.close(resolve))]);
  });
  return { port: server.address().port, socksUrl: `socks5://127.0.0.1:${proxy.address().port}`,
    get coalescedBytes() { return coalescedBytes; } };
}

test("SOCKS 握手与 HTTP/2 SETTINGS 合包后保留小正文、大正文和 Unicode", { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const socket = await connectSocket("127.0.0.1", f.port, { socksUrl: f.socksUrl, timeoutMs: 1000 });
  const client = http2.connect(`http://127.0.0.1:${f.port}`, { createConnection: () => socket });
  const errors = [];
  client.on("error", error => errors.push(error));
  t.after(() => client.destroy());
  await once(client, "connect");
  const payloads = [
    Buffer.from("small reply"),
    Buffer.alloc(672486, 120),
    Buffer.from("任务🌊é𠮷🙂/编辑与路径".repeat(16384)),
  ];
  for (const payload of payloads) {
    const stream = client.request({ ":method": "POST", ":path": "/echo" });
    stream.end(payload);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), payload);
  }
  assert.ok(f.coalescedBytes > 0);
  assert.deepEqual(errors, []);
});

test("HTTP/1 Agent 经 SOCKS 交接后继续读取真实 JSON 响应", { timeout: 5000 }, async t => {
  const f = await fixture(t, true);
  const url = new URL(`http://127.0.0.1:${f.port}/healthz`);
  const agent = createAgent(url, { socksUrl: f.socksUrl });
  t.after(() => agent.destroy());
  assert.deepEqual(await requestJson(url, { agent, timeoutMs: 1000 }), { ready: true });
});

for (const failure of ["error", "close", "abort"]) {
  test(`SOCKS Socket 交接期间 ${failure} 会拒绝并释放连接`, { timeout: 5000 }, async t => {
    const f = await fixture(t);
    const controller = new AbortController();
    const reason = new Error("handoff fixture");
    const original = SocksClient.createConnection;
    let socket;
    t.mock.method(SocksClient, "createConnection", async options => {
      const result = await original.call(SocksClient, options);
      socket = result.socket;
      socket.on("error", () => {});
      setImmediate(() => {
        if (failure === "abort") controller.abort(reason);
        else socket.destroy(failure === "error" ? reason : undefined);
      });
      return result;
    });
    await assert.rejects(connectSocket("127.0.0.1", f.port,
      { socksUrl: f.socksUrl, timeoutMs: 1000, signal: controller.signal }),
    error => failure === "close" ? error instanceof Error : error === reason);
    assert.equal(socket.destroyed, true);
  });
}
