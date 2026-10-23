import assert from "node:assert/strict";
import test from "node:test";
import { createServer, connect, type Socket } from "node:net";
import { probeProxy, EgressListener } from "../../src/federation/egress.js";

async function proxyFixture(t: test.TestContext, handler: (socket: Socket) => void): Promise<number> {
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket); socket.on("error", () => {}); socket.on("close", () => sockets.delete(socket)); handler(socket);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return (server.address() as { port: number }).port;
}

test("真实代理探测区分 CONNECT 拒绝、等待隧道超时与目标 HTTP 失败", async t => {
  const denied = await proxyFixture(t, socket => socket.once("data", () => socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")));
  await assert.rejects(probeProxy(`http://127.0.0.1:${denied}`, "http://example.invalid/", 1000), { code: "EGRESS_TUNNEL_REJECTED", phase: "proxy_tunnel" });
  const stalled = await proxyFixture(t, socket => socket.on("data", () => {}));
  await assert.rejects(probeProxy(`http://127.0.0.1:${stalled}`, "http://example.invalid/", 100), { code: "EGRESS_PROBE_TIMEOUT", phase: "proxy_tunnel" });
  const badTarget = await proxyFixture(t, socket => socket.once("data", () => {
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    socket.once("data", () => socket.end("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n"));
  }));
  await assert.rejects(probeProxy(`http://127.0.0.1:${badTarget}`, "http://example.invalid/", 1000), { code: "EGRESS_TARGET_HTTP_ERROR", phase: "target_http" });
  const earlyClose = await proxyFixture(t, socket => socket.once("data", () => socket.end("HTTP/1.1 200 Connection Established\r\n\r\n")));
  await assert.rejects(probeProxy(`http://127.0.0.1:${earlyClose}`, "http://example.invalid/", 1000), { code: "EGRESS_TARGET_CLOSED", phase: "target_http" });
});

test("出口建立失败返回安全分类并保留阶段，响应不包含异常正文", async t => {
  const observations: Array<{ code?: string; phase?: string }> = [];
  const listener = new EgressListener(0, async () => { throw Object.assign(new Error("sensitive fixture text"), {
    code: "NODE_ADMISSION_PAUSED", phase: "gateway_admission",
  }); }, error => observations.push(error));
  await listener.start(); t.after(() => listener.close());
  const response = await new Promise<string>((resolve, reject) => {
    const socket = connect(listener.address, "127.0.0.1"); let text = "";
    socket.on("connect", () => socket.write("CONNECT example.invalid:443 HTTP/1.1\r\n\r\n"));
    socket.on("data", chunk => { text += chunk; }); socket.on("error", reject); socket.on("end", () => { socket.end(); resolve(text); });
  });
  assert.match(response, /503 Service Unavailable/);
  assert.match(response, /X-QuayMesh-Error: NODE_ADMISSION_PAUSED/);
  assert.doesNotMatch(response, /sensitive fixture/);
  assert.equal(observations[0].phase, "gateway_admission");
});
