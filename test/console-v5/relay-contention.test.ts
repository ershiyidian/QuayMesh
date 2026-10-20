import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import Database from "better-sqlite3";
// @ts-expect-error 本机 Relay 是纯 ESM 脚本，无类型声明
import { McpRelay } from "../../node/relay.mjs";
import { databasePath } from "../../src/db/client.js";
import { holdSqliteWriteLock } from "../../src/test-support/sqlite-lock.js";
import type { ConsoleReply } from "../../src/federation/types.js";
import { createRealTestServer, freePort, type RealTestServer } from "../session-card/server-fixture.js";
import { until } from "../tool-contract/fixture.js";

test("真实 Console 中继在两端持写锁时读取新鲜认证会话并保留鉴权和修改准入", { timeout: 40_000 }, async t => {
  const previous = process.env.QUAYMESH_CLUSTER_TOKEN, token = randomUUID();
  process.env.QUAYMESH_CLUSTER_TOKEN = token;
  const servers: RealTestServer[] = [], databases: Database.Database[] = [];
  const locks: Awaited<ReturnType<typeof holdSqliteWriteLock>>[] = [];
  let relay: McpRelay | undefined;
  t.after(async () => {
    try {
      await Promise.allSettled(locks.map(lock => lock.release()));
      for (const database of databases) database.close();
      await relay?.close();
      for (const server of servers.reverse()) await server.dispose();
    } finally {
      if (previous === undefined) delete process.env.QUAYMESH_CLUSTER_TOKEN;
      else process.env.QUAYMESH_CLUSTER_TOKEN = previous;
    }
  });
  const cloudPort = await freePort();
  const cloud = await createRealTestServer({ git: false, federation: {
    nodeId: "cloud", nickname: "协调端", capabilities: { coordinator: true, worker: false, discovery: false,
      egress: false, meshRelay: true, desktopUi: false, consoleRelay: false }, priority: 100,
    port: cloudPort, ingressPort: await freePort(), peers: [{ id: "edge", url: "" }],
  } });
  servers.push(cloud);
  const edge = await createRealTestServer({ git: false, federation: {
    nodeId: "edge", nickname: "边缘节点", capabilities: { coordinator: false, worker: true, discovery: false,
      egress: false, meshRelay: false, desktopUi: false, consoleRelay: true }, priority: 0,
    port: await freePort(), ingressPort: await freePort(), peers: [{ id: "cloud", url: `http://127.0.0.1:${cloudPort}` }],
  } });
  servers.push(edge);
  await until(() => cloud.running.federation!.nodes().some(node => node.id === "edge" && node.online)
    && edge.running.federation!.nodes().some(node => node.id === "cloud" && node.online));
  relay = await new McpRelay({ origin: `http://127.0.0.1:${cloudPort}`, port: 0,
    consoleRpc: (request: unknown) => edge.running.federation!.request("cloud", "console.request", request),
  }).start();
  const base = `http://127.0.0.1:${relay.port}`;
  const json = async (url: string, init?: RequestInit): Promise<{ status: number; body: any }> => {
    const response = await fetch(url, init);
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await json(base + "/console/api/session", { headers: { origin: base } })).status, 401);
  const login = await fetch(base + "/console/api/login", { method: "POST", headers: { origin: base, "content-type": "application/json" },
    body: JSON.stringify({ password: "test-owner-token-that-is-long-enough" }) });
  assert.equal(login.status, 200, await login.clone().text());
  const { csrf } = await login.json() as { csrf: string };
  assert.ok(csrf);
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const headers = { cookie, origin: base };
  const logout = (withCsrf: boolean) => ({ method: "POST", headers: { ...headers, "content-type": "application/json",
    ...(withCsrf ? { "x-quaymesh-csrf": csrf } : {}) }, body: "{}" });
  assert.equal((await json(base + "/console/api/logout", logout(false))).status, 403);
  const internal = (request: Record<string, unknown>, authorized = true) => json(edge.baseUrl + "/internal/quaymesh/console", {
    method: "POST", headers: { "content-type": "application/json", ...(authorized ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ nodeId: "cloud", request }),
  });
  const getSession = { method: "GET", path: "/console/api/session", headers };
  assert.equal((await internal(getSession, false)).status, 401);
  await assert.rejects(cloud.running.federation!.request("edge", "console.request", getSession), /CONSOLE_RELAY_CAPABILITY_REQUIRED/u);
  for (const server of servers) databases.push(new Database(databasePath(server.config.stateDir), { readonly: true, fileMustExist: true }));
  const sessionCount = () => (databases[0].prepare("SELECT count(*) AS n FROM console_sessions").get() as { n: number }).n;
  const beforeSessions = sessionCount();
  for (const server of servers) locks.push(await holdSqliteWriteLock(databasePath(server.config.stateDir), 3000));
  const released = locks.map(() => false);
  locks.forEach((lock, index) => { void lock.done.then(() => { released[index] = true; }, () => { released[index] = true; }); });
  const versions = databases.map(database => database.pragma("data_version", { simple: true }));
  const started = performance.now();
  const [browser, forwarded, legacy, head, anonymous, untrusted] = await Promise.all([
    json(base + "/console/api/session", { headers }),
    internal(getSession),
    edge.running.federation!.request<ConsoleReply>("cloud", "console", { method: "GET", path: "/overview" }),
    internal({ ...getSession, method: "HEAD" }),
    json(base + "/console/api/session", { headers: { origin: base } }),
    internal(getSession, false),
  ]);
  const elapsedMs = performance.now() - started;
  assert.deepEqual(released, [false, false], "观察必须在 cloud 和 edge 的独立 writer 都仍持锁时完成");
  assert.ok(elapsedMs < 1200, `console_observation_ms=${elapsedMs}`);
  assert.equal(browser.status, 200); assert.equal(browser.body.authenticated, true);
  assert.equal(forwarded.status, 200); assert.equal(forwarded.body.status, 200);
  assert.equal(JSON.parse(forwarded.body.body).authenticated, true);
  assert.equal(legacy.status, 200); assert.equal((legacy.body as any).nodes[0].nodeId, "cloud");
  // 只旁路读请求的占用登记，不扩展下游 API 的方法支持。
  assert.equal(head.status, 200); assert.equal(head.body.status, 405);
  assert.equal(anonymous.status, 401); assert.equal(untrusted.status, 401);
  assert.deepEqual(databases.map(database => database.pragma("data_version", { simple: true })), versions);
  await Promise.all(locks.map(lock => lock.release()));
  locks.length = 0;

  await cloud.running.execution.pauseAsync("Console admission fixture");
  await edge.running.execution.pauseAsync("Console admission fixture");
  const refusedBrowser = await json(base + "/console/api/logout", logout(true));
  assert.equal(refusedBrowser.status, 503);
  assert.equal(refusedBrowser.body.error, "coordinator_unavailable");
  assert.match(String(refusedBrowser.body.message), /Console admission fixture/u);
  const refusedInternal = await internal({ method: "POST", path: "/console/api/logout",
    headers: { ...headers, "content-type": "application/json", "x-quaymesh-csrf": csrf }, body: "{}" });
  assert.equal(refusedInternal.status, 502);
  assert.equal(refusedInternal.body.code, "CONSOLE_REQUEST_FAILED");
  assert.match(String(refusedInternal.body.message), /Console admission fixture/u);
  await assert.rejects(edge.running.federation!.request("cloud", "console", { method: "POST", path: "/missing" }), { code: "NODE_ADMISSION_PAUSED" });
  assert.equal(sessionCount(), beforeSessions, "被拒绝的 logout 不得删除认证会话");
  assert.equal((await json(base + "/console/api/session", { headers })).status, 200);
  t.diagnostic(JSON.stringify({ writer_lock_ms: 3000, console_observation_ms: elapsedMs,
    entrypoints: ["relay", "internal_forward", "legacy_console"], authenticated_sessions: beforeSessions,
    commits_while_locked: 0, paused_mutations_rejected: 3 }));
});
