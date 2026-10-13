import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createAgent, requestJson } from "./network.mjs";
import { readOptionalJson, writeJson } from "./files.mjs";
import { hostUrl, validateCluster, check } from "./config.mjs";

export class MembershipClient {
  constructor({ node, cluster, token, release, intervalMs = 5000, onConfiguration, status = () => ({}) }) {
    this.node = node; this.cluster = cluster; this.token = token; this.release = release; this.intervalMs = intervalMs;
    this.onConfiguration = onConfiguration; this.status = status; this.stopped = true; this.failures = 0;
    this.state = { connected: false, lastSuccessAt: null, error: null };
    this.url = new URL(hostUrl(cluster.coordinator.address, cluster.coordinator.apiPort));
    this.agent = createAgent(this.url, { socksUrl: node.mesh.enabled && node.mesh.mode === "no-tun"
      ? `socks5://127.0.0.1:${node.mesh.socksPort}` : undefined });
  }
  async start() {
    let identity = await readOptionalJson(join(this.node.stateDir, "identity.json"));
    if (!identity) {
      identity = { nodeId: this.node.id, instanceId: randomUUID() };
      await writeJson(join(this.node.stateDir, "identity.json"), identity);
    }
    check(identity.nodeId === this.node.id, "状态目录属于另一个节点");
    this.identity = identity; this.startedAt = Date.now(); this.stopped = false;
    this.inflight = this.tick();
    return this;
  }
  async tick() {
    if (this.stopped) return;
    const controller = new AbortController(); this.controller = controller;
    try {
      const result = await requestJson(new URL("/v1/heartbeat", this.url), {
        method: "POST", token: this.token, agent: this.agent, signal: controller.signal, timeoutMs: 6000,
        body: { id: this.node.id, instanceId: this.identity.instanceId, nickname: this.node.nickname,
          address: this.node.mesh.address, peerPort: this.node.peerPort, capabilities: this.node.capabilities,
          release: this.release, startedAt: this.startedAt, ...this.status() },
      });
      check(result.clusterId === this.cluster.id, "收到其他集群的节点目录");
      const cluster = validateCluster(result.cluster);
      if (this.desiredRevision !== result.configRevision) {
        await this.onConfiguration?.(cluster, result.configRevision);
        this.desiredRevision = result.configRevision;
      }
      const directory = { clusterId:result.clusterId, revision:result.revision,
        coordinatorId:this.cluster.coordinator.id, nodes:result.nodes.map(({id,nickname,address,peerPort,endpoint,capabilities,online,release}) =>
          ({id,nickname,address,peerPort,endpoint,capabilities,online,release})) };
      if (!isDeepStrictEqual(this.directory,directory)) {
        await writeJson(join(this.node.stateDir,"membership.json"),{...directory,observedAt:result.observedAt});
        this.directory = directory;
      }
      this.failures = 0;
      this.state = { connected: true, lastSuccessAt: Date.now(), error: null };
    } catch (error) {
      if (!this.stopped) this.state = { ...this.state, connected: false, error: error.message };
      this.failures++;
    } finally {
      if (!this.stopped) {
        const delay = this.failures ? Math.min(15000, this.intervalMs * 2 ** Math.min(this.failures - 1, 3)) : this.intervalMs;
        this.timer = setTimeout(() => { this.inflight = this.tick(); }, delay);
      }
    }
  }
  async close() {
    this.stopped = true; clearTimeout(this.timer); this.controller?.abort(); this.agent.destroy();
    await this.inflight;
  }
}
