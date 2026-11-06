import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import express from "express";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { openDatabase } from "./db/client.js";
import { SingleUserOAuthProvider } from "./oauth-provider.js";
import { SqliteOAuthStore } from "./oauth-store.js";

const day = 86_400;
const redirectUri = "https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-lifetime-test";
const resource = "https://agent.example.com/mcp";
const hash = (value: string) => createHash("sha256").update(value).digest("base64url");

test("startup retains valid Google client secrets and preserves all other credentials and grants", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "quaymesh-client-upgrade-"));
  const database = openDatabase(directory);
  let store: SqliteOAuthStore | undefined;
  t.after(async () => {
    store?.close();
    database.close();
    await rm(directory, { recursive: true, force: true });
  });
  const now = Math.floor(Date.now() / 1000);
  const original: OAuthClientInformationFull = {
    client_id: "valid-google", client_id_issued_at: now - 20 * day,
    client_name: "Existing account linking", client_secret: "existing-google-secret",
    client_secret_expires_at: now + 10 * day, token_endpoint_auth_method: "client_secret_post",
    redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"], scope: "quaymesh",
  };
  const clients: OAuthClientInformationFull[] = [
    original,
    { ...original, client_id: "expired-google", client_secret_expires_at: now - 1 },
    { ...original, client_id: "expiry-boundary-google", client_secret_expires_at: now },
    { ...original, client_id: "persistent-google", client_secret_expires_at: 0 },
    { ...original, client_id: "unspecified-google", client_secret_expires_at: undefined },
    { ...original, client_id: "secretless-google", client_secret: undefined },
    { ...original, client_id: "public-google", client_secret: undefined, token_endpoint_auth_method: "none" },
    { ...original, client_id: "ordinary-client", redirect_uris: ["http://localhost/callback"] },
  ];
  const insert = database.sqlite.prepare("insert into oauth_clients (client_id, client_json, issued_at) values (?, ?, ?)");
  for (const client of clients) insert.run(client.client_id, JSON.stringify(client), client.client_id_issued_at);
  for (const table of ["oauth_access_tokens", "oauth_refresh_tokens"]) {
    database.sqlite.prepare(`insert into ${table} (token_hash, client_id, scopes_json, expires_at, resource) values (?, ?, ?, ?, ?)`)
      .run(hash(table), original.client_id, JSON.stringify(["quaymesh"]), now + 90 * day, resource);
  }
  const snapshot = () => ({
    clients: database.sqlite.prepare("select * from oauth_clients order by client_id").all() as Array<{ client_id: string; client_json: string; issued_at: number }>,
    access: database.sqlite.prepare("select * from oauth_access_tokens").all(),
    refresh: database.sqlite.prepare("select * from oauth_refresh_tokens").all(),
  });
  const before = snapshot();
  store = new SqliteOAuthStore(directory);
  const after = snapshot();
  assert.deepEqual(after.access, before.access);
  assert.deepEqual(after.refresh, before.refresh);
  for (const previous of before.clients) {
    const current = after.clients.find((row) => row.client_id === previous.client_id)!;
    if (current.client_id === original.client_id) {
      assert.equal(current.issued_at, previous.issued_at);
      assert.deepEqual(JSON.parse(current.client_json), { ...original, client_secret_expires_at: 0 });
    } else {
      assert.deepEqual(current, previous);
    }
  }
  store.close();
  store = new SqliteOAuthStore(directory);
  assert.deepEqual(snapshot(), after);
});

test("SDK registration and token endpoints retain Google linking past 30 days with authentication and revocation", { timeout: 15_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "quaymesh-client-http-"));
  const config = { ownerToken: "test-owner", accessTokenTtlSeconds: 3600, refreshTokenTtlSeconds: 90 * day,
    scopes: ["quaymesh"], allowedResourceUrls: [resource], allowedRedirectHosts: ["oauth-redirect.googleusercontent.com"] };
  const provider = new SingleUserOAuthProvider(config, new URL(resource), directory);
  const store = new SqliteOAuthStore(directory);
  const app = express();
  app.use(mcpAuthRouter({ provider, issuerUrl: new URL("http://localhost"), baseUrl: new URL("http://localhost"),
    resourceServerUrl: new URL(resource), scopesSupported: config.scopes }));
  const listener = app.listen(0, "127.0.0.1");
  t.after(async () => {
    listener.closeAllConnections();
    await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
    provider.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  await once(listener, "listening");
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const register = async (uri: string) => {
    const response = await fetch(`${base}/register`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [uri], token_endpoint_auth_method: "client_secret_post" }),
      signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 201, await response.clone().text());
    return await response.json() as OAuthClientInformationFull;
  };
  const google = await register(redirectUri);
  const ordinary = await register("http://localhost/callback");
  assert.ok(google.client_secret);
  assert.equal(google.client_secret_expires_at, 0);
  assert.deepEqual(store.getClient(google.client_id), google);
  const issuedAt = ordinary.client_id_issued_at!;
  assert.equal(ordinary.client_secret_expires_at, issuedAt + 30 * day);
  const refreshToken = "test-retained-google-refresh";
  store.saveRefreshToken(hash(refreshToken), { clientId: google.client_id, scopes: config.scopes,
    resource, expiresAt: issuedAt + 90 * day });
  const credentials = { client_id: google.client_id, client_secret: google.client_secret };
  const form = (path: string, fields: Record<string, string>) => fetch(`${base}${path}`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields), signal: AbortSignal.timeout(5000),
  });
  const request = { ...credentials, grant_type: "refresh_token", refresh_token: refreshToken, resource };
  t.mock.method(Date, "now", () => (issuedAt + 31 * day) * 1000);
  const wrongSecret = await form("/token", { ...request, client_secret: "wrong-secret" });
  assert.equal(wrongSecret.status, 400);
  assert.equal((await wrongSecret.json() as { error: string }).error, "invalid_client");
  const refreshed = await form("/token", request);
  assert.equal(refreshed.status, 200, await refreshed.clone().text());
  assert.equal((await refreshed.json() as OAuthTokens).refresh_token, refreshToken);
  const ordinaryExpired = await form("/token", { ...request, client_id: ordinary.client_id, client_secret: ordinary.client_secret! });
  assert.equal(ordinaryExpired.status, 400);
  assert.equal((await ordinaryExpired.json() as { error_description: string }).error_description, "Client secret has expired");
  const revoked = await form("/revoke", { ...credentials, token: refreshToken, token_type_hint: "refresh_token" });
  assert.equal(revoked.status, 200);
  await revoked.text();
  assert.equal(store.getRefreshToken(hash(refreshToken)), undefined);
  const afterRevocation = await form("/token", request);
  assert.equal(afterRevocation.status, 400);
  assert.equal((await afterRevocation.json() as { error: string }).error, "invalid_grant");
});

