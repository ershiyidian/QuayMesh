import assert from "node:assert/strict";
import test from "node:test";
import { createServer as createHttpServer, request } from "node:http";
import { createServer, connect, type Server } from "node:net";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Duplex } from "node:stream";
import { FederationRuntime, type FederationHooks } from "../../src/federation/runtime.js";
import { federationConfigSchema } from "../../src/federation/schema.js";
import { PeerTransport, bridge } from "../../src/federation/transport.js";
import { connectProxy, probeProxy } from "../../src/federation/egress.js";
import { ExecutionCoordinator } from "../../src/execution-coordinator.js";
import type { FederationConfig, NodeManifest } from "../../src/federation/types.js";

const token = "temporary-control-egress-regression-token";
async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  return (server.address() as { port: number }).port;
}
async function freePort(): Promise<number> {
  const server = createServer(), port = await listen(server);
  await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
async function until(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 8000;
  while (!check()) {
    if (performance.now() >= deadline) throw new Error("control egress transition timed out");
    await delay(10);
  }
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function networkFixture(t: test.TestContext, label: string) {
  const sockets = new Set<Duplex>();
  const keep = (socket: Duplex) => {
    sockets.add(socket); socket.on("error", () => {}); socket.once("close", () => sockets.delete(socket));
  };
  const target = createHttpServer((_req, res) => res.writeHead(204).end());
  target.on("connection", keep);
  const echo = createServer(socket => { keep(socket); socket.on("data", bytes => socket.write(bytes)); });
  const proxy = createHttpServer();
  proxy.on("connect", (req, client, head) => {
    keep(client);
    const address = new URL("http://" + req.url);
    const upstream = connect(Number(address.port), address.hostname); keep(upstream);
    client.once("close", () => upstream.destroy());
    upstream.once("error", () => client.destroy());
    upstream.once("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\nX-Fixture-Gateway: " + label + "\r\n\r\n");
      if (head.length) upstream.write(head); bridge(client, upstream);
    });
  });
  const [targetPort, echoPort, proxyPort] = await Promise.all([listen(target), listen(echo), listen(proxy)]);
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all([target, echo, proxy].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  });
  return { proxyUrl: "http://127.0.0.1:" + proxyPort, probeUrl: "http://127.0.0.1:" + targetPort + "/", echoPort };
}
async function tunnel(t: test.TestContext, port: number, targetPort: number) {
  return new Promise<{ socket: Duplex; gateway: string | string[] | undefined }>((resolve, reject) => {
    const pending = request({ host: "127.0.0.1", port, method: "CONNECT",
      path: "127.0.0.1:" + targetPort, agent: false, timeout: 3000 });
    pending.once("error", reject); pending.once("timeout", () => pending.destroy(new Error("CONNECT deadline")));
    pending.once("connect", (res, socket, head) => {
      socket.on("error", () => {}); t.after(() => socket.destroy());
      if (res.statusCode !== 200) {
        socket.destroy(); reject(Object.assign(new Error("CONNECT rejected " + res.statusCode),
          { status: res.statusCode, code: res.headers["x-quaymesh-error"] })); return;
      }
      if (head.length) socket.unshift(head);
      resolve({ socket, gateway: res.headers["x-fixture-gateway"] });
    });
    pending.end();
  });
}
async function exchange(socket: Duplex, text: string) {
  const received = once(socket, "data"); socket.write(text);
  assert.equal((await received)[0].toString(), text);
}
async function runtimeFixture(t: test.TestContext, id: string, network: Awaited<ReturnType<typeof networkFixture>>,
  options: { peers?: FederationConfig["peers"]; gateway?: boolean; control?: boolean; paused?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "qm-control-egress-"));
  const config = federationConfigSchema.parse({ enabled: true, nodeId: id, coordinatorId: id,
    host: "127.0.0.1", port: await freePort(), capabilities: { worker: true, egress: options.gateway ?? true },
    roots: [], peers: options.peers ?? [], priority: options.gateway === false ? 0 : 10, heartbeatMs: 1000,
    egress: { enabled: true, listenPort: await freePort(), controlListenPort: options.control === false ? undefined : await freePort(),
      proxyUrl: network.proxyUrl, probeUrl: network.probeUrl, recoveryDelayMs: 0 } });
  const hooks: FederationHooks = { stateDir: root, httpPort: 7676, ingressPort: 0, publicBaseUrl: "http://127.0.0.1:7676",
    providers: () => [], prepareOpen: async input => input, checkWorkspace: async () => {},
    console: async () => ({ status: 200, body: {} }), settings: () => ({}), updateSettings: async () => {},
    mihomoImport: async () => null, mihomoRead: async () => "", resolveProxy: async () => config.egress.proxyUrl,
    artifactStat: async () => ({ size: 0 }), artifactRead: async () => { throw new Error("unused"); }, artifactWrite: async () => {} };
  const runtime = new FederationRuntime(config, token, hooks);
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); });
  if (options.paused) runtime.execution.pause("node-maintenance");
  await runtime.start();
  if (options.gateway !== false) await until(() => runtime.nodes()[0].egress.healthy);
  return runtime;
}

test("受管控制出口必须启用动态出口并使用独立端口", () => {
  assert.equal(federationConfigSchema.safeParse({ egress: { controlListenPort: 17889 } }).success, false);
  assert.equal(federationConfigSchema.safeParse({ egress: { enabled: true, controlListenPort: 17890 } }).success, false);
  assert.equal(federationConfigSchema.safeParse({ egress: { enabled: true, controlListenPort: 17889 } }).success, true);
});

test("安装暂停期间唯一本机出口可建立真实控制连接，普通出口和模型准入保持关闭", { timeout: 15000 }, async t => {
  const network = await networkFixture(t, "local");
  const runtime = await runtimeFixture(t, "local", network, { paused: true });
  assert.equal(runtime.gateway(), undefined);
  const control = await tunnel(t, runtime.config.egress.controlListenPort!, network.echoPort);
  assert.equal(control.gateway, "local"); await exchange(control.socket, "control-before-resume");
  assert.equal(runtime.execution.admissionStatus().accepting, false);
  assert.equal(runtime.execution.admissionStatus().idle, true);
  assert.equal(runtime.status().activeControlEgressConnections, 1);
  await assert.rejects(tunnel(t, runtime.config.egress.listenPort, network.echoPort), { status: 503 });
  await assert.rejects(runtime.openNodeStream("local", "egress"), { code: "NODE_ADMISSION_PAUSED" });
  let invoked = false; runtime.handlers.set("apply_patch", () => { invoked = true; return {}; });
  await assert.rejects(runtime.invokeLocal("apply_patch", {}, {}), { code: "NODE_ADMISSION_PAUSED" });
  assert.equal(invoked, false);
  const controlPort = runtime.config.egress.controlListenPort!;
  runtime.config.egress.enabled = false;
  await (runtime as unknown as { configureEgress(): Promise<void> }).configureEgress();
  await until(() => control.socket.destroyed);
  await assert.rejects(tunnel(t, controlPort, network.echoPort), { code: "ECONNREFUSED" });
});

test("新远端识别真实联邦控制流且不占业务排空，远端暂停后拒绝新流并释放控制连接", { timeout: 20000 }, async t => {
  const network = await networkFixture(t, "remote");
  const gateway = await runtimeFixture(t, "gateway", network, { control: false, peers: [{ id: "client", url: "" }] });
  const client = await runtimeFixture(t, "client", network, { paused: true, gateway: false,
    peers: [{ id: "gateway", url: "http://127.0.0.1:" + gateway.transport.address }] });
  await until(() => client.nodes().some(node => node.id === "gateway" && node.online && node.egress.healthy));
  const control = await tunnel(t, client.config.egress.controlListenPort!, network.echoPort);
  assert.equal(control.gateway, "remote"); await exchange(control.socket, "remote-control");
  assert.equal(client.execution.admissionStatus().idle, true);
  assert.equal(gateway.execution.admissionStatus().idle, true);
  assert.equal(gateway.status().activeControlEgressConnections, 1);
  gateway.execution.pause("node-maintenance"); gateway.refreshAdmission();
  await until(() => client.nodes().some(node => node.id === "gateway" && node.egress.draining === true));
  await until(() => control.socket.destroyed && gateway.status().activeControlEgressConnections === 0);
  await assert.rejects(tunnel(t, client.config.egress.controlListenPort!, network.echoPort), { status: 503 });
  assert.equal(client.execution.admissionStatus().accepting, false);
});

async function legacyGateway(t: test.TestContext, network: Awaited<ReturnType<typeof networkFixture>>) {
  const root = await mkdtemp(join(tmpdir(), "qm-legacy-control-egress-"));
  const execution = new ExecutionCoordinator(root);
  const config = federationConfigSchema.parse({ enabled: true, nodeId: "legacy", coordinatorId: "legacy",
    capabilities: { worker: true, egress: true }, priority: 100, peers: [{ id: "client", url: "" }] });
  config.port = 0;
  await probeProxy(network.proxyUrl, network.probeUrl);
  const manifest = (): NodeManifest => ({ id: config.nodeId, nickname: "legacy", capabilities: config.capabilities,
    priority: 100, roots: [], platform: process.platform, tools: [], providers: [],
    egress: { enabled: true, healthy: true, draining: !execution.admissionState().accepting },
    health: { cpuCount: 1, load: [], memoryTotal: 1, memoryFree: 1, uptime: 1, gpus: [], activeCalls: 0 }, updatedAt: Date.now() });
  // The pre-control-listener receiver deliberately ignores all stream metadata.
  // Authentication, HTTP/2, TCP proxying and the blocking SQLite lease are real.
  const transport = new PeerTransport(config, token, method => {
    if (method === "hello") return { manifest: manifest() };
    if (method === "manifest") return null;
    throw new Error("unexpected legacy RPC " + method);
  }, async (service, _metadata, stream) => {
    assert.equal(service, "egress"); stream.on("error", () => {});
    const lease = execution.beginWork({ kind: "egress" });
    stream.once("close", () => lease.release());
    try {
      const proxy = await lease.run(() => connectProxy(network.proxyUrl));
      if (stream.destroyed) proxy.destroy(); else bridge(stream, proxy);
    } catch (error) { lease.release(); throw error; }
  });
  t.after(async () => { await transport.close(); await execution.close(); await rm(root, { recursive: true, force: true }); });
  await transport.start();
  const publish = () => { for (const link of transport.links.values()) link.notify("manifest", manifest()); };
  return { transport, execution, publish };
}

test("旧远端进入维护时只断受管流并改选本机，既有业务流继续，迟到控制连接也不阻塞旧节点", { timeout: 25000 }, async t => {
  const remoteNetwork = await networkFixture(t, "legacy"), localNetwork = await networkFixture(t, "local");
  const legacy = await legacyGateway(t, remoteNetwork);
  const client = await runtimeFixture(t, "client", localNetwork,
    { peers: [{ id: "legacy", url: "http://127.0.0.1:" + legacy.transport.address }] });
  await until(() => client.gateway()?.id === "legacy");
  const ordinary = await tunnel(t, client.config.egress.listenPort, remoteNetwork.echoPort);
  const control = await tunnel(t, client.config.egress.controlListenPort!, remoteNetwork.echoPort);
  assert.equal(ordinary.gateway, "legacy"); assert.equal(control.gateway, "legacy");
  await exchange(ordinary.socket, "accepted-business"); await exchange(control.socket, "managed-control");
  assert.equal(legacy.execution.admissionStatus().activeWork, 2);
  client.execution.pause("node-maintenance"); client.refreshAdmission();
  legacy.execution.pause("node-maintenance"); legacy.publish();
  await until(() => control.socket.destroyed && legacy.execution.admissionStatus().activeWork === 1);
  assert.equal(ordinary.socket.destroyed, false); await exchange(ordinary.socket, "business-survives-drain");
  ordinary.socket.destroy();
  await until(() => legacy.execution.admissionStatus().idle && client.execution.admissionStatus().idle);
  const replacement = await tunnel(t, client.config.egress.controlListenPort!, localNetwork.echoPort);
  assert.equal(replacement.gateway, "local"); await exchange(replacement.socket, "control-reselected");
  assert.equal(client.execution.admissionStatus().accepting, false);
  assert.equal(client.execution.admissionStatus().idle, true);
  legacy.execution.resume(); legacy.publish();
  await until(() => client.nodes().some(node => node.id === "legacy" && node.egress.draining === false));
  const link = client.transport.links.get("legacy")!, original = link.openStream.bind(link);
  const opened = deferred(), deliver = deferred(); t.after(deliver.resolve);
  t.mock.method(link, "openStream", async (...args: Parameters<typeof link.openStream>) => {
    const stream = await original(...args); opened.resolve(); await deliver.promise; return stream;
  });
  const rejected = assert.rejects(tunnel(t, client.config.egress.controlListenPort!, remoteNetwork.echoPort),
    { status: 503, code: "EGRESS_GATEWAY_DRAINING" });
  await opened.promise;
  legacy.execution.pause("node-maintenance"); legacy.publish();
  await until(() => client.nodes().some(node => node.id === "legacy" && node.egress.draining === true));
  deliver.resolve(); await rejected;
  await until(() => legacy.execution.admissionStatus().idle);
  await exchange(replacement.socket, "healthy-control-unchanged");
});

