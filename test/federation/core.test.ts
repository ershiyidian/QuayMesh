import { test } from "node:test";
import assert from "node:assert/strict";
import { Duplex } from "node:stream";
import { createServer, connect } from "node:net";
import { PeerTransport, NodeUnavailableError, RpcRequestTimeoutError, bridge } from "../../src/federation/transport.js";
import { workspaceHandle, parseWorkspaceHandle, selectRoot, catalog, chooseGateway, routedResult } from "../../src/federation/routing.js";
import { EgressListener, dialTcp, proxyEnvironment } from "../../src/federation/egress.js";
import type { FederationConfig, NodeView } from "../../src/federation/types.js";

export function config(id: string): FederationConfig {
  return { enabled: true, coordinatorId: "cloud", nodeId: id, nickname: id, capabilities: {coordinator:false,worker:true,discovery:true,egress:true,meshRelay:false,desktopUi:false,consoleRelay:false}, priority: 100,
    host: "127.0.0.1", port: 0, tokenEnv: "QUAYMESH_CLUSTER_TOKEN", peers: [], roots: [],
    heartbeatMs: 300, rpcTimeoutMs: 5000,
    egress: { enabled: false, listenPort: 0, proxyUrl: "http://127.0.0.1:7890", controllerSecretEnv: "MIHOMO_SECRET",
      probeUrl: "https://www.gstatic.com/generate_204", probeIntervalMs: 15_000, recoveryDelayMs: 1000, inheritProxy: true } };
}
async function until(predicate: () => boolean, timeout = 6000): Promise<void> {
  const end = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > end) throw new Error("condition timed out"); await new Promise((resolve) => setTimeout(resolve, 20)); }
}
async function pair() {
  const ca = config("server"); const cb = config("desktop");
  ca.peers = [{ id: "desktop", url: "" }];
  const calls: string[] = [];
  const service = async (_service: string, _meta: unknown, stream: Duplex) => {
    stream.on("error", () => {});
    stream.on("data", (chunk: Buffer) => stream.write(Buffer.from(chunk).reverse()));
    stream.on("end", () => stream.end());
  };
  const a = new PeerTransport(ca, "test-cluster-secret-123456", async (method, params) => { calls.push(`a:${method}`); return { at: "server", ...params }; }, service);
  await a.start();
  cb.peers = [{ id: "server", url: `http://127.0.0.1:${a.address}` }];
  const b = new PeerTransport(cb, "test-cluster-secret-123456", async (method, params) => { calls.push(`b:${method}`); return { at: "desktop", ...params }; }, service);
  await b.start(); await until(() => a.links.has("desktop") && b.links.has("server"));
  return { a, b, calls, close: async () => { await b.close(); await a.close(); } };
}

test("outbound NAT connection supports concurrent RPC in both directions", async () => {
  const p = await pair();
  try {
    const values = await Promise.all(Array.from({ length: 40 }, (_, n) => n % 2 ? p.a.links.get("desktop")!.call("read", { n }) : p.b.links.get("server")!.call("read", { n })));
    values.forEach((value: any, n) => { assert.equal(value.n, n); assert.equal(value.at, n % 2 ? "desktop" : "server"); });
  } finally { await p.close(); }
});
test("independent byte streams work through the same outbound connection in both directions", async () => {
  const p = await pair();
  try {
    for (const link of [p.a.links.get("desktop")!, p.b.links.get("server")!]) {
      const stream = await link.openStream("test");
      const output = new Promise<Buffer>((resolve) => stream.once("data", resolve));
      stream.write(Buffer.from("abcdef"));
      assert.equal((await output).toString(), "fedcba"); stream.destroy();
    }
  } finally { await p.close(); }
});
test("disconnected mutation is not retried on the desktop", async () => {
  const p = await pair();
  try {
    const old = p.b.links.get("server")!; await p.a.close(); await until(() => !old.connected);
    await assert.rejects(old.call("apply_patch", { patch: "x" }), NodeUnavailableError);
    assert.equal(p.calls.length, 0);
  } finally { await p.close(); }
});
test("peer reconnect restores calls with the same node identity", async () => {
  const p = await pair();
  try {
    const old = p.b.links.get("server")!;
    old.close();
    await until(() => Boolean(p.b.links.get("server")?.connected && p.b.links.get("server") !== old));
    assert.deepEqual(await p.b.links.get("server")!.call("read", { n: 7 }), { at: "server", n: 7 });
  } finally { await p.close(); }
});
test("one request timeout keeps the shared link available for heartbeats and other calls", async () => {
  const ca = config("a"); ca.peers = [{ id: "b", url: "" }];
  const cb = config("b");
  let bAddress = 0;
  const a = new PeerTransport(ca, "timeout-token", () => "a", () => {});
  await a.start();
  bAddress = a.address;
  cb.peers = [{ id: "a", url: `http://127.0.0.1:${bAddress}` }];
  const b = new PeerTransport(cb, "timeout-token", async (method) => {
    if (method === "slow") await new Promise((resolve) => setTimeout(resolve, 100));
    return method === "slow" ? "slow" : "fast";
  }, () => {});
  await b.start();
  try {
    await until(() => Boolean(a.links.get("b")?.connected && b.links.get("a")?.connected));
    const link = a.links.get("b")!;
    await assert.rejects(link.call("slow", {}, 10), RpcRequestTimeoutError);
    assert.equal(link.connected, true);
    assert.equal(await link.call("fast", {}, 1000), "fast");
  } finally {
    await b.close(); await a.close();
  }
});
test("peer identity and cluster token are checked before registration", async () => {
  const ca = config("a"); ca.peers = [{ id: "b", url: "" }];
  const a = new PeerTransport(ca, "right", () => null, () => {}); await a.start();
  const cb = config("b"); cb.peers = [{ id: "a", url: `http://127.0.0.1:${a.address}` }];
  const b = new PeerTransport(cb, "wrong", () => null, () => {}); await b.start();
  try { await new Promise((r) => setTimeout(r, 200)); assert.equal(a.links.size, 0); assert.equal(b.links.size, 0); }
  finally { await b.close(); await a.close(); }
});
test("simultaneous peer dials converge on one connection", async () => {
  const ca = config("a"); const cb = config("b"); ca.peers = [{ id: "b", url: "" }]; cb.peers = [{ id: "a", url: "" }];
  const a = new PeerTransport(ca, "token", () => "a", () => {}); const b = new PeerTransport(cb, "token", () => "b", () => {});
  await a.start(); await b.start();
  try {
    a.updatePeers([{ id: "b", url: `http://127.0.0.1:${b.address}` }]); b.updatePeers([{ id: "a", url: `http://127.0.0.1:${a.address}` }]);
    await until(() => a.links.has("b") && b.links.has("a"));
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(a.links.size, 1); assert.equal(b.links.size, 1);
    assert.equal(await a.links.get("b")!.call("test", {}), "b");
  } finally { await a.close(); await b.close(); }
});
function node(id: string, online = true, priority = 100): NodeView {
  return { id, online, nickname: id, capabilities: {coordinator:false,worker:true,discovery:true,egress:true,meshRelay:false,desktopUi:false,consoleRelay:false}, priority,
    roots: [{ id: "code", nickname: "项目代码", description: "VLA experiments", tags: ["vla"], path: "/data/code", enabled: true }],
    platform: "linux", tools: ["read", "exec_command"], providers: [], egress: { enabled: true, healthy: true },
    health: { activeCalls: 0, cpuCount: 2, load: [], memoryFree: 0, memoryTotal: 0, uptime: 0, gpus: [] }, updatedAt: Date.now() };
}
test("workspace handles are stable across gateways and preserve node identity", () => {
  const handle = workspaceHandle("campus-s2", "ws:12/34");
  assert.deepEqual(parseWorkspaceHandle(handle), { node: "campus-s2", local: "ws:12/34" });
  assert.equal(parseWorkspaceHandle("local-workspace"), undefined);
  const result: any = routedResult({ content: [{ type: "text", text: "Use ws_123" }], structuredContent: { workspace_id: "ws_123" } }, "s2", { textReferences: true });
  assert.equal(result.structuredContent.workspace_id, "qm:s2:ws_123"); assert.equal(result.content[0].text, "Use qm:s2:ws_123");
});
test("nested session members route workspace handles by their owning node", () => {
  const result = routedResult({ workspaces: [
    { node_id: "desktop", workspace_id: "ws_desktop" },
    { node_id: "campus-s2", workspace_id: "ws_s2" },
  ] }, "campus-s1") as any;
  assert.equal(result.workspaces[0].workspace_id, "qm:desktop:ws_desktop");
  assert.equal(result.workspaces[1].workspace_id, "qm:campus-s2:ws_s2");
});
test("catalog exposes semantic root metadata while ambiguous nicknames ask for root_id", () => {
  const nodes = [node("s1"), node("s2", false)];
  assert.equal(selectRoot(nodes, "s2/code").node.id, "s2");
  assert.throws(() => selectRoot(nodes, "项目代码"), /多个节点/);
  assert.equal((catalog(nodes, "vla", false).workspaces as any[]).length, 1);
});
test("gateway prefers server, falls back to desktop, and delays recovery failback", () => {
  const nodes = [node("server", true, 200), node("desktop", true, 100)];
  assert.equal(chooseGateway(nodes)?.id, "server"); nodes[0].online = false;
  assert.equal(chooseGateway(nodes)?.id, "desktop"); nodes[0].online = true; nodes[0].egress.healthySince = 1000;
  assert.equal(chooseGateway(nodes, 1500, 1000, "desktop")?.id, "desktop");
  assert.equal(chooseGateway(nodes, 2500, 1000, "desktop")?.id, "server");
  nodes[0].egress.healthy = false; assert.equal(chooseGateway(nodes)?.id, "desktop");
});
test("one local proxy carries binary traffic with backpressure", async () => {
  const echo = createServer((socket) => socket.pipe(socket)); await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
  const port = (echo.address() as { port: number }).port;
  const proxy = new EgressListener(0, () => dialTcp("127.0.0.1", port)); await proxy.start();
  const socket = connect(proxy.address, "127.0.0.1");
  try {
    const bytes = Buffer.alloc(4 * 1024 * 1024, 123);
    const received: Buffer[] = []; let size = 0;
    const result = new Promise<Buffer>((resolve) => socket.on("data", (chunk) => { const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); received.push(buffer); size += buffer.length; if (size === bytes.length) resolve(Buffer.concat(received)); }));
    socket.write(bytes); assert.deepEqual(await result, bytes);
  } finally { socket.destroy(); await proxy.close(); await new Promise<void>((r) => echo.close(() => r())); }
});
test("proxy environment preserves CC Switch localhost and existing exclusions", () => {
  const env = proxyEnvironment(17890, { NO_PROXY: "example.local", HOME: "/home/user" }, ["10.0.0.2"]);
  assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:17890"); assert.match(env.NO_PROXY!, /127.0.0.1/); assert.match(env.NO_PROXY!, /example.local/); assert.equal(env.HOME, "/home/user");
});

test("gateway recovery delay also covers network reconnection and unified proxy eligibility", () => {
  const server = node("server", true, 200), desktop = node("desktop", true, 100);
  server.egress.healthySince = 1; server.onlineSince = 1000;
  assert.equal(chooseGateway([server, desktop], 1500, 1000, "desktop")?.id, "desktop");
  assert.equal(chooseGateway([server, desktop], 2500, 1000, "desktop")?.id, "server");
  server.egress.enabled = false;
  assert.equal(chooseGateway([server, desktop])?.id, "desktop");
});

test("混合版本中的旧 crash loop 网关经过稳定窗口后才能重新承载新流", () => {
  const now = 1_000_000;
  const server = node("server", true, 300), desktop = node("desktop", true, 100);
  server.components = [{ id: "core", state: "ready", restarts: 3340, startedAt: now - 1000, observedAt: now }];
  server.onlineSince = now - 1000;
  assert.equal(chooseGateway([server, desktop], now, 60_000, "server")?.id, "desktop");
  server.components[0].observedAt = now + 300_000;
  assert.equal(chooseGateway([server, desktop], now + 300_000, 60_000, "desktop")?.id, "server");
  server.components[0].state = "degraded";
  assert.equal(chooseGateway([server, desktop], now + 300_000, 60_000, "server")?.id, "desktop");
  server.components[0].state = "ready";
  server.components[0].startedAt = now + 300_000;
  assert.equal(chooseGateway([server, desktop], now + 301_000, 60_000, "desktop")?.id, "desktop");
  server.components[0].startedAt = now - 1000;
  assert.equal(chooseGateway([server, desktop], now + 360_000, 60_000, "desktop")?.id, "desktop", "陈旧探针不提供稳定证据");
  server.components[0].observedAt = now + 360_000;
  assert.equal(chooseGateway([server, desktop], now + 360_000, 60_000, "desktop")?.id, "server", "历史重启次数不会永久禁选");
});

test("agent continuation hints and console links carry the node while literal file contents stay untouched", () => {
  const raw = JSON.stringify({ workspaceId: "ws_123", nextAction: { workspaceId: "ws_123" }, consolePath: "/console/?project=p&run=r", response: "literal ws_123" });
  const value = { content: [{ type: "text", text: raw }] };
  const routed = routedResult(value, "s2", { jsonText: true }) as any;
  const data = JSON.parse(routed.content[0].text);
  assert.equal(data.workspaceId, "qm:s2:ws_123"); assert.equal(data.nextAction.workspaceId, "qm:s2:ws_123");
  assert.equal(data.response, "literal ws_123"); assert.match(data.consolePath, /node=s2/);
  assert.equal((routedResult(value, "s2") as any).content[0].text, raw);
});
