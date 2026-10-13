import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import { readOptionalJson, writeJson } from "./files.mjs";
import { validateCluster, CAPABILITIES, check, hostUrl } from "./config.mjs";

const MAX_BODY = 2 * 1024 * 1024;
async function readBody(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error("请求过大"), { status: 413 });
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function respond(res, status, value) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}
function validToken(received, expected) {
  const a = Buffer.from(received || ""), b = Buffer.from(`Bearer ${expected}`);
  return a.length === b.length && timingSafeEqual(a, b);
}
function publicNode(value) {
  check(value && typeof value === "object", "节点信息无效");
  check(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.id), "节点 ID 无效");
  check(typeof value.instanceId === "string" && value.instanceId.length >= 16, "节点实例 ID 无效");
  check(isIP(value.address) !== 0, "节点虚拟 IP 无效");
  check(Number.isInteger(value.peerPort) && value.peerPort >= 1 && value.peerPort <= 65535, "节点端口无效");
  check(value.capabilities && CAPABILITIES.every(key => typeof value.capabilities[key] === "boolean"), "节点能力无效");
  return {
    id: value.id, instanceId: value.instanceId, nickname: String(value.nickname || value.id).slice(0, 120),
    address: value.address, peerPort: value.peerPort, endpoint: hostUrl(value.address, value.peerPort),
    capabilities: Object.fromEntries(CAPABILITIES.map(key => [key, value.capabilities[key]])),
    release: String(value.release || "unknown").slice(0, 80),
    components: Array.isArray(value.components) ? value.components.map(component => ({
      id: String(component.id), state: String(component.state), pid: component.pid || null,
      restarts: component.restarts || 0, error: component.error ? String(component.error).slice(0, 300) : null,
    })) : [],
    discovery: value.discovery ? { ready: value.discovery.ready === true, lastSuccessAt: value.discovery.lastSuccessAt || null,
      lastError: value.discovery.lastError ? String(value.discovery.lastError).slice(0, 300) : null } : null,
    startedAt: value.startedAt || null,
  };
}

export class RegistryServer {
  constructor({ cluster, token, stateDir, host = "0.0.0.0", port, leaseMs = 20000 }) {
    this.cluster = validateCluster(cluster); this.token = token; this.stateDir = stateDir;
    this.host = host; this.port = port ?? cluster.coordinator.apiPort; this.leaseMs = leaseMs;
    this.nodes = new Map(); this.revision = 1; this.configRevision = 1; this.queue = Promise.resolve();
    this.clients = new Set(); this.connections = new Set(); this.configQueue = Promise.resolve();
    this.persistedRevision = 0; this.persistError = null; this.dirty = false; this.onlineIds = "";
    this.server = http.createServer((req, res) => {
      void this.handle(req, res).catch(error => {
        if (!res.headersSent) respond(res, error.status || 400, { error: error.message });
        else res.destroy(error);
      });
    });
    this.server.on("connection", socket => {
      this.connections.add(socket); socket.once("close", () => this.connections.delete(socket));
    });
  }
  async start() {
    const saved = await readOptionalJson(join(this.stateDir, "registry.json"));
    if (saved) {
      check(saved.clusterId === this.cluster.id, "节点目录的集群 ID 不一致");
      this.revision = saved.revision || 1; this.persistedRevision = this.revision;
      for (const node of saved.nodes || []) this.nodes.set(node.id, { ...node, lastSeenAt: 0 });
    }
    const configuration = await readOptionalJson(join(this.stateDir, "cluster-authority.json"));
    if (configuration) { this.cluster = validateCluster(configuration.cluster); this.configRevision = configuration.revision; }
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, this.host, () => { this.server.off("error", reject); resolve(); });
    });
    this.port = this.server.address().port;
    this.timer = setInterval(() => {
      this.publish();
      if (this.dirty) void this.persist().catch(error => { this.persistError = error.message; });
    }, 5000);
    this.timer.unref();
    return this;
  }
  snapshot() {
    const now = Date.now();
    return { clusterId: this.cluster.id, revision: this.revision, observedAt: now, configRevision: this.configRevision,
      nodes: [...this.nodes.values()].sort((a,b) => a.id.localeCompare(b.id)).map(node => ({
        ...node, online: now - node.lastSeenAt < this.leaseMs,
      })) };
  }
  publish() {
    const online = [...this.nodes.values()].filter(node => Date.now() - node.lastSeenAt < this.leaseMs)
      .map(node => node.id).sort().join("\n");
    if (online !== this.onlineIds) { this.onlineIds = online; this.revision++; this.dirty = true; }
    const payload = `id: ${this.revision}\nevent: membership\ndata: ${JSON.stringify(this.snapshot())}\n\n`;
    for (const res of this.clients) {
      if (res.writableLength > 1024 * 1024) { res.destroy(); this.clients.delete(res); }
      else res.write(payload);
    }
  }
  persist() {
    const operation = this.queue.then(async () => {
      const revision = this.revision;
      const nodes = [...this.nodes.values()];
      await writeJson(join(this.stateDir, "registry.json"), { clusterId:this.cluster.id, revision, nodes });
      this.persistedRevision = revision; this.persistError = null;
      this.dirty = this.revision !== revision;
    });
    this.queue = operation.catch(error => { this.persistError = error.message; this.dirty = true; });
    return operation;
  }
  async handle(req, res) {
    const url = new URL(req.url, "http://registry.local");
    if (url.pathname === "/healthz" && req.method === "GET") {
      respond(res, this.persistError ? 503 : 200, { ok: !this.persistError, service: "quaymesh-registry",
        revision:this.revision, persistedRevision:this.persistedRevision, error:this.persistError }); return;
    }
    if (!validToken(req.headers.authorization, this.token)) {
      respond(res, 401, { error: "unauthorized" }); return;
    }
    if (url.pathname === "/v1/membership" && req.method === "GET") {
      respond(res, 200, this.snapshot()); return;
    }
    if (url.pathname === "/v1/events" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.flushHeaders();
      this.clients.add(res); req.once("close", () => this.clients.delete(res));
      // 每条通知携带完整的轻量目录，重连从当前版本继续。
      res.write(`id: ${this.revision}\nevent: membership\ndata: ${JSON.stringify(this.snapshot())}\n\n`);
      return;
    }
    if (url.pathname === "/v1/cluster" && req.method === "GET") {
      respond(res, 200, { revision: this.configRevision, cluster: this.cluster }); return;
    }
    if (url.pathname === "/v1/cluster" && req.method === "PUT") {
      const request = await readBody(req);
      const operation = this.configQueue.then(async () => {
      if (request.expectedRevision !== this.configRevision) {
        respond(res, 409, { error: "config_revision_changed", revision: this.configRevision }); return;
      }
      const next = validateCluster(request.cluster);
      check(next.id === this.cluster.id, "集群 ID 不能修改");
      check(JSON.stringify(next.coordinator) === JSON.stringify(this.cluster.coordinator), "Coordinator 端点请通过节点安装配置更新");
      check(next.tokenEnv === this.cluster.tokenEnv, "认证变量名不能在线修改");
      const revision = this.configRevision + 1;
      await writeJson(join(this.stateDir, "cluster-authority.json"), { revision, cluster: next });
      this.cluster = next; this.configRevision = revision; this.revision++; this.publish();
      respond(res, 200, { revision }); return;
      });
      this.configQueue = operation.catch(() => {});
      await operation;
      return;
    }
    if (url.pathname === "/v1/heartbeat" && req.method === "POST") {
      const node = publicNode(await readBody(req));
      check(node.capabilities.coordinator === (node.id === this.cluster.coordinator.id), "Coordinator 身份不一致");
      const previous = this.nodes.get(node.id);
      if (previous && previous.instanceId !== node.instanceId && Date.now() - previous.lastSeenAt < this.leaseMs) {
        respond(res, 409, { error: "node_id_in_use", nodeId: node.id }); return;
      }
      for (const other of this.nodes.values()) {
        if (other.id !== node.id && other.address === node.address && Date.now() - other.lastSeenAt < this.leaseMs) {
          respond(res, 409, { error: "mesh_address_in_use", nodeId: other.id }); return;
        }
      }
      const identity = value => value && ({ id:value.id, instanceId:value.instanceId, nickname:value.nickname,
        address:value.address, peerPort:value.peerPort, capabilities:value.capabilities, release:value.release });
      const changed = !isDeepStrictEqual(identity(previous), identity(node));
      this.nodes.set(node.id, { ...node, firstSeenAt:previous?.firstSeenAt || Date.now(), lastSeenAt:Date.now() });
      this.dirty = true;
      if (changed) this.revision++;
      this.publish();
      if (changed || this.persistError) await this.persist();
      respond(res, 200, { ...this.snapshot(), cluster: this.cluster }); return;
    }
    respond(res, 404, { error: "not_found" });
  }
  async close() {
    clearInterval(this.timer);
    for (const client of this.clients) client.end();
    for (const socket of this.connections) socket.destroy();
    await new Promise(resolve => this.server.close(() => resolve()));
    await this.queue;
    await this.configQueue;
    if (this.dirty) await this.persist();
  }
}
