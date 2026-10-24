import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
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

test("页面、版本资源和 API 经同一真实 Coordinator 连接提供，保留缓存、HEAD、登录与 CSRF", { timeout: 60_000 }, async (t) => {
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

  const relay = await new McpRelay({
    origin: `http://127.0.0.1:${cloudPort}`,
    port: 0,
    consoleRpc: (request: unknown) => edge.running.federation!.request("cloud", "console.request", request),
  }).start();
  t.after(async () => { await relay.close(); });

  const base = `http://127.0.0.1:${relay.port}`;

  const expected = await (await fetch(`${cloud.baseUrl}/console/`)).text();
  const page = await fetch(`${base}/console/`);
  assert.equal(page.status, 200);
  assert.equal(await page.text(), expected, "入口 HTML 必须与提供 API 的协调器完全一致");
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.match(page.headers.get("content-security-policy") || "", /script-src 'self'/);
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  assert.equal(await (await fetch(`${base}/console/console.html`)).text(), expected, "原有页面地址仍可打开");
  const assets = [...expected.matchAll(/(?:src|href)="(\.\/assets\/[^"?#]+)"/g)].map(match => match[1]);
  assert.ok(assets.some(path => path.endsWith(".js")));
  assert.ok(assets.some(path => /\.(?:png|ico|woff2?)$/.test(path)), "构建应包含用于核对二进制转发的图标或字体");
  for (const path of assets) {
    const actual = await fetch(new URL(path, base + "/console/"));
    const source = await fetch(new URL(path, cloud.baseUrl + "/console/"));
    assert.equal(actual.status, 200, path);
    assert.equal(actual.headers.get("content-type"), source.headers.get("content-type"));
    const bytes = Buffer.from(await actual.arrayBuffer());
    assert.deepEqual(bytes, Buffer.from(await source.arrayBuffer()), path);
    assert.match(actual.headers.get("cache-control") || "", /immutable/);
    const head = await fetch(new URL(path, base + "/console/"), { method: "HEAD" });
    assert.equal(head.status, 200); assert.equal(head.headers.get("content-length"), String(bytes.length));
    assert.equal(await head.text(), "");
    const unchanged = await fetch(new URL(path, base + "/console/"), { headers: { "if-none-match": actual.headers.get("etag")! } });
    assert.equal(unchanged.status, 304); assert.equal(await unchanged.text(), "");
  }
  const hidden = await fetch(`${base}/console/assets/.private`);
  assert.equal(hidden.status, 403);
  assert.deepEqual(await hidden.json(), { code: "CONSOLE_REQUEST_REJECTED" });
  const missing = await fetch(`${base}/console/assets/missing.js`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { code: "CONSOLE_REQUEST_REJECTED" });
  assert.equal((await fetch(`${base}/console/assets/missing.js`, { method: "PUT" })).status, 405);

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
