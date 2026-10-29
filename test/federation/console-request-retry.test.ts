import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { dispatchConsoleRequest, type ConsoleHttpRequest } from "../../src/federation/console-request.js";
import { dispatchPeerRequest } from "../../src/federation/read-retry.js";
import { NodeUnavailableError, PeerTransport } from "../../src/federation/transport.js";
import type { ConsoleReply, FederationConfig } from "../../src/federation/types.js";

function config(nodeId: string): FederationConfig {
  return {
    enabled: true, nodeId, nickname: nodeId, coordinatorId: "cloud", host: "127.0.0.1", port: 0,
    tokenEnv: "QUAYMESH_CLUSTER_TOKEN", priority: 0, peers: [], roots: [], heartbeatMs: 300, rpcTimeoutMs: 5000,
    capabilities: { coordinator: nodeId === "cloud", worker: nodeId !== "cloud", discovery: false,
      egress: false, meshRelay: false, desktopUi: false, consoleRelay: nodeId !== "cloud" },
    egress: { enabled: false, listenPort: 0, proxyUrl: "http://127.0.0.1:7890", controllerSecretEnv: "MIHOMO_SECRET",
      probeUrl: "https://example.test/", probeIntervalMs: 15_000, recoveryDelayMs: 1000, inheritProxy: false },
  };
}

async function until(check: () => boolean, timeout = 6000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Real peer connection did not settle");
    await delay(20);
  }
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "qm-console-request-retry-"));
  const marker = join(directory, "mutations.txt"), httpRequests: string[] = [];
  let target: PeerTransport | undefined;
  const http = createServer((request, response) => {
    void (async () => {
      httpRequests.push(request.method!);
      if (request.method === "POST") {
        await appendFile(marker, "applied\n");
        // The mutation happened on the real HTTP target before its RPC receipt was lost.
        target!.links.get("relay")!.close();
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ nodes: [{ id: "cloud", online: true }] }));
    })().catch(error => { response.destroy(error); });
  });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  assert.ok(address && typeof address !== "string");
  const targetConfig = config("cloud"), callerConfig = config("relay"), token = randomUUID();
  targetConfig.peers = [{ id: "relay", url: "" }];
  target = new PeerTransport(targetConfig, token, async (method, params, peer) => {
    assert.equal(method, "console.request");
    return dispatchConsoleRequest(address.port, peer, params);
  }, () => {});
  await target.start();
  callerConfig.peers = [{ id: "cloud", url: `http://127.0.0.1:${target.address}` }];
  const caller = new PeerTransport(callerConfig, token, () => null, () => {});
  t.after(async () => {
    await caller.close(); await target!.close();
    http.closeAllConnections();
    await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  await caller.start();
  await until(() => Boolean(caller.links.get("cloud")?.connected && target!.links.get("relay")?.connected));
  const request = (method: string) => {
    const params: ConsoleHttpRequest = { method, path: "/console/api/workbench/fleet/status", headers: {} };
    const adapter = () => {
      const link = caller.links.get("cloud");
      return link && { get connected() { return link.connected; },
        call: (timeoutMs: number) => link.call<ConsoleReply>("console.request", params, timeoutMs),
        close: () => link.close() };
    };
    return dispatchPeerRequest<ConsoleReply>({ node: "cloud", method: "console.request", params,
      timeoutMs: 5000, rpcTimeoutMs: 5000, getLink: adapter,
      waitForLink: async waitMs => { await caller.waitForLink("cloud", waitMs); return adapter(); },
    });
  };
  const disconnect = () => {
    const old = caller.links.get("cloud")!;
    old.close();
    assert.equal(old.connected, false);
    return old;
  };
  return { caller, target, httpRequests, marker, request, disconnect };
}

test("console relay GET and HEAD recover a real peer reconnect before reading HTTP", { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  for (const method of ["GET", "HEAD"]) {
    const old = f.disconnect();
    const reply = await f.request(method);
    assert.equal(reply.status, 200);
    assert.notEqual(f.caller.links.get("cloud"), old);
    assert.equal(f.httpRequests.filter(value => value === method).length, 1);
    if (method === "GET") assert.deepEqual(JSON.parse(reply.body as string), { nodes: [{ id: "cloud", online: true }] });
  }
});

test("console relay POST is never sent while disconnected and never replayed after a lost receipt", { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  f.disconnect();
  await assert.rejects(f.request("POST"), NodeUnavailableError);
  assert.deepEqual(f.httpRequests, []);
  await assert.rejects(readFile(f.marker, "utf8"), { code: "ENOENT" });
  await until(() => Boolean(f.caller.links.get("cloud")?.connected && f.target.links.get("relay")?.connected));
  await assert.rejects(f.request("POST"));
  await until(() => Boolean(f.caller.links.get("cloud")?.connected && f.target.links.get("relay")?.connected));
  assert.equal(await readFile(f.marker, "utf8"), "applied\n");
  assert.deepEqual(f.httpRequests, ["POST"]);
});
