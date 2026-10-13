import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { ServerConfig } from "./config.js";
import { createProjectConsoleRouter } from "./project-console-router.js";
import { openDatabase } from "./db/client.js";

test("console sessions slide, cap, expire, and revoke only when asked", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "quaymesh-console-session-"));
  const state = join(root, "state");
  const assetDirectory = join(root, "ui");
  mkdirSync(assetDirectory, { recursive: true });
  writeFileSync(join(assetDirectory, "console.html"), "<!doctype html><title>session</title>");
  let time = Date.parse("2026-09-25T00:00:00Z");
  const ttl = 30 * 24 * 60 * 60;
  const config = { stateDir: state, allowedRoots: [root], publicBaseUrl: "https://controlled.example",
    oauth: { ownerToken: "fixture-owner-token-not-real" },
    console: { enabled: true, allowRemote: false, sessionTtlSeconds: ttl } } as ServerConfig;
  const consoleApi = createProjectConsoleRouter(config, { assetDirectory, clock: () => time });
  const app = express();
  app.use("/console", consoleApi.router);
  const http = app.listen(0, "127.0.0.1");
  await once(http, "listening");
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  t.after(async () => {
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    consoleApi.close();
    rmSync(root, { recursive: true, force: true });
  });
  const request = (path: string, options: RequestInit = {}) => fetch(base + "/console" + path, options);
  const login = async () => {
    const response = await request("/api/login", { method: "POST", headers: { "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({ password: "fixture-owner-token-not-real" }) });
    assert.equal(response.status, 200);
    const body = await response.json() as { csrf: string };
    const header = response.headers.get("set-cookie")!;
    assert.match(header, /HttpOnly/);
    assert.match(header, /SameSite=Strict/);
    assert.equal(header.includes("Secure"), false);
    assert.equal(header.includes("fixture-owner-token"), false);
    return { cookie: header.split(";")[0]!, csrf: body.csrf, header };
  };
  const first = await login();
  const second = await login();
  const db = openDatabase(state);
  try {
    const rows = db.sqlite.prepare("select token_hash, csrf, expires_at from console_sessions").all() as { token_hash: string; csrf: string; expires_at: number }[];
    assert.equal(rows.length, 2);
    assert.equal(JSON.stringify(rows).includes("fixture-owner-token"), false);
    const logout = await request("/api/logout", { method: "POST", headers: { Cookie: first.cookie, Origin: base, "X-QuayMesh-CSRF": first.csrf } });
    assert.equal(logout.status, 200);
    assert.equal((db.sqlite.prepare("select count(*) as n from console_sessions").get() as { n: number }).n, 1);
    const other = await request("/api/session", { headers: { Cookie: second.cookie } });
    assert.equal(other.status, 200);

    db.sqlite.prepare("update console_sessions set expires_at=? where token_hash!=''").run(time + 6 * 24 * 60 * 60 * 1000);
    const renewed = await request("/api/session", { headers: { Cookie: second.cookie } });
    assert.equal(renewed.status, 200);
    assert.match(renewed.headers.get("set-cookie") ?? "", new RegExp(`Max-Age=${ttl}`));
    const expires = (db.sqlite.prepare("select expires_at from console_sessions").get() as { expires_at: number }).expires_at;
    assert.equal(expires, time + ttl * 1000);

    const third = await login();
    const revoked = await request("/api/sessions/revoke-all", { method: "POST", headers: { Cookie: third.cookie, Origin: base, "X-QuayMesh-CSRF": third.csrf } });
    assert.equal(revoked.status, 200);
    assert.equal((await revoked.json() as { revoked: number }).revoked >= 1, true);
    assert.equal((db.sqlite.prepare("select count(*) as n from console_sessions").get() as { n: number }).n, 0);
    assert.equal((await request("/api/session", { headers: { Cookie: third.cookie } })).status, 401);

    time += 60_000;
    const filler = db.sqlite.prepare("insert into console_sessions(token_hash,csrf,expires_at,created_at,last_used_at) values(?,?,?,?,?)");
    const stamp = new Date(time).toISOString();
    for (let i = 0; i < 256; i++) filler.run(`hash-${i}`, `csrf-${i}`, time + ttl * 1000, stamp, stamp);
    const limited = await request("/api/login", { method: "POST", headers: { "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({ password: "fixture-owner-token-not-real" }) });
    assert.equal(limited.status, 429);
    time += ttl * 1000 + 1;
    const afterExpiry = await login();
    assert.equal((db.sqlite.prepare("select count(*) as n from console_sessions where expires_at<=?").get(time) as { n: number }).n, 0);
    assert.ok(afterExpiry.cookie.startsWith("qm_console_session="));
  } finally {
    db.close();
  }
});
