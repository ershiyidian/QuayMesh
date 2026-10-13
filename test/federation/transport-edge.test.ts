import assert from "node:assert/strict";
import test from "node:test";
import { PeerTransport } from "../../src/federation/transport.js";
import type { FederationConfig } from "../../src/federation/types.js";

function config(id: string): FederationConfig {
  return {
    nodeId: id,
    nickname: id,
    capabilities: {coordinator:false,worker:true,discovery:true,egress:true,meshRelay:false,desktopUi:false,consoleRelay:false},
    priority: 100,
    host: "127.0.0.1",
    port: 0,
    heartbeatMs: 500,
    rpcTimeoutMs: 2000,
    peers: [],
    egress: { enabled: false },
    roots: [],
  };
}

async function until(fn: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error("until timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("transport preserves peerId and link reason on close without credentials", async () => {
  const ca = config("server");
  const cb = config("desktop");
  ca.peers = [{ id: "desktop", url: "" }];
  const a = new PeerTransport(ca, "secret-token-xyz", () => "ok", () => {});
  await a.start();

  cb.peers = [{ id: "server", url: `http://127.0.0.1:${a.address}` }];
  const offlineEvents: any[] = [];
  a.on("offline", (peerId, info) => offlineEvents.push({ peerId, info }));

  const b = new PeerTransport(cb, "secret-token-xyz", () => "ok", () => {});
  await b.start();

  try {
    await until(() => Boolean(a.links.get("desktop")?.connected && b.links.get("server")?.connected));
    const linkB = b.links.get("server")!;
    assert.equal(linkB.connected, true);

    linkB.close("test_manual_disconnect");
    await until(() => offlineEvents.length > 0);
    const event = offlineEvents[0];
    assert.equal(event.peerId, "desktop");
    assert.ok(event.info);
    assert.equal(typeof event.info.linkId, "string");
    assert.ok(
      event.info.reason.includes("session_goaway") ||
      event.info.reason.includes("control_close") ||
      event.info.reason.includes("test_manual_disconnect") ||
      event.info.reason.includes("session_error")
    );
    assert.ok(!JSON.stringify(event).includes("secret-token-xyz"));
  } finally {
    await b.close();
    await a.close();
  }
});

test("multiple frames accumulating in receive buffer do not trigger frame_too_large unless an individual frame exceeds limit", async () => {
  const ca = config("server");
  const cb = config("desktop");
  ca.peers = [{ id: "desktop", url: "" }];
  const received: string[] = [];
  const a = new PeerTransport(ca, "token", (method, params) => {
    received.push(`${method}`);
    return "ok";
  }, () => {});
  await a.start();

  cb.peers = [{ id: "server", url: `http://127.0.0.1:${a.address}` }];
  const b = new PeerTransport(cb, "token", () => "ok", () => {});
  await b.start();

  try {
    await until(() => Boolean(a.links.get("desktop")?.connected && b.links.get("server")?.connected));
    const linkB = b.links.get("server")!;

    // Send 10 notifications quickly
    for (let i = 0; i < 10; i++) {
      linkB.notify(`call_${i}`, { data: "x".repeat(1000) });
    }

    await until(() => received.length === 10);
    assert.equal(received.length, 10);
    assert.equal(linkB.connected, true);
  } finally {
    await b.close();
    await a.close();
  }
});
