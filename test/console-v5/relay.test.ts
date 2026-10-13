import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { mkdir, cp } from "node:fs/promises";
import { join } from "node:path";
// @ts-expect-error 本机 Relay 是纯 ESM 脚本，无类型声明
import { McpRelay } from "../../node/relay.mjs";
import { createRealTestServer, freePort } from "../session-card/server-fixture.js";

const TOKEN = "console-relay-cluster-token-2026";
const OWNER = "test-owner-token-that-is-long-enough";

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 15000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("TIMEOUT: " + label);
    await delay(50);
  }
}

test("浏览器经本机 Relay 访问 Coordinator Console：静态文件本地提供，登录与 CSRF 经 federation RPC", { timeout: 60_000 }, async (t) => {
  const previous = process.env.QUAYMESH_CLUSTER_TOKEN;
  process.env.QUAYMESH_CLUSTER_TOKEN = TOKEN;
  t.after(() => { if (previous === undefined) delete process.env.QUAYMESH_CLUSTER_TOKEN; else process.env.QUAYMESH_CLUSTER_TOKEN = previous; });

  const cloudPort = await freePort();
  const cloud = await createRealTestServer({
    prefix: "quaymesh-relay-cloud-",
    federation: {
      nodeId: "cloud", nickname: "协调端",
      capabilities: { coordinator: true, worker: false, discovery: false, egress: false, meshRelay: true, desktopUi: false, consoleRelay: false },
      priority: 100, port: cloudPort, ingressPort: await freePort(), peers: [{ id: "edge", url: "" }],
    },
  });
  t.after(() => cloud.dispose());

  const edgePort = await freePort();
  const edge = await createRealTestServer({
    prefix: "quaymesh-relay-edge-",
    federation: {
      nodeId: "edge", nickname: "边缘节点",
      capabilities: { coordinator: false, worker: true, discovery: false, egress: false, meshRelay: false, desktopUi: false, consoleRelay: true },
      priority: 0, port: edgePort, ingressPort: await freePort(), peers: [{ id: "cloud", url: `http://127.0.0.1:${cloudPort}` }],
    },
  });
  t.after(() => edge.dispose());

  await until(() => cloud.running.federation!.nodes().some((n) => n.id === "edge" && n.online), 15000, "edge online");
  await until(() => edge.running.federation!.nodes().some((n) => n.id === "cloud" && n.online), 15000, "cloud online");

  const assetDir = join(cloud.root, "console-assets");
  await mkdir(assetDir, { recursive: true });
  await cp(join(process.cwd(),'dist','ui'),assetDir,{recursive:true});
  const relay = await new McpRelay({
    origin: `http://127.0.0.1:${cloudPort}`,
    port: 0,
    consoleRpc: (request: unknown) => edge.running.federation!.request("cloud", "console.request", request),
    consoleAssetDir: assetDir,
  }).start();
  t.after(async () => { await relay.close(); });

  const base = `http://127.0.0.1:${relay.port}`;

  const page = await fetch(`${base}/console/console.html`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /QuayMesh/);

  const anon = await fetch(`${base}/console/api/session`, { headers: { origin: base } });
  assert.equal(anon.status, 401, "未登录访问应被拒绝");

  const login = await fetch(`${base}/console/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ password: OWNER }),
  });
  assert.equal(login.status, 200, await login.clone().text());
  const session = await login.json() as { csrf?: string };
  assert.ok(session.csrf, "登录应返回 CSRF");
  const setCookie = login.headers.get("set-cookie") || "";
  assert.match(setCookie, /qm_console_session=/);
  const cookie = setCookie.split(";")[0];

  const authed = await fetch(`${base}/console/api/session`, { headers: { cookie, origin: base } });
  assert.equal(authed.status, 200, await authed.clone().text());

  const noCsrf = await fetch(`${base}/console/api/logout`, { method: "POST", headers: { cookie, origin: base, "content-type": "application/json" }, body: "{}" });
  assert.equal(noCsrf.status, 403, "缺少 CSRF 的 POST 应被拒绝");
});
