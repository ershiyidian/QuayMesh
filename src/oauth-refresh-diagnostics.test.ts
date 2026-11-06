import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InvalidGrantError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { loadConfig } from "./config.js";
import { SingleUserOAuthProvider, type OAuthRefreshDiagnostic } from "./oauth-provider.js";
import { SqliteOAuthStore } from "./oauth-store.js";
import { createServer } from "./server.js";
import { writeTestQuayMeshConfig } from "./test-support/config.test.js";

test("refresh diagnostics distinguish missing grants from root and MCP resource mismatch without credentials", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "quaymesh-refresh-diagnostics-"));
  const mcpUrl = new URL("https://agent.example.com/mcp");
  const rootResource = new URL("/", mcpUrl);
  const config = {
    ownerToken: "private-owner-token",
    accessTokenTtlSeconds: 3600,
    refreshTokenTtlSeconds: 2592000,
    scopes: ["quaymesh"],
    allowedResourceUrls: [rootResource.href],
    allowedRedirectHosts: ["oauth-redirect.googleusercontent.com"],
  };
  const events: OAuthRefreshDiagnostic[] = [];
  const store = new SqliteOAuthStore(directory);
  let provider = new SingleUserOAuthProvider(config, mcpUrl, directory, (event) => events.push(event));
  t.after(async () => {
    provider.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const client = store.registerClient({
    client_name: "Account linking",
    redirect_uris: ["https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-example"],
    token_endpoint_auth_method: "client_secret_post",
    client_secret: "private-client-secret",
  }, config.allowedRedirectHosts);
  const refreshToken = "private-retained-refresh-token";
  const unknownToken = "private-unknown-refresh-token";
  const hash = (token: string) => createHash("sha256").update(token).digest("base64url");
  const grant = { clientId: client.client_id, scopes: config.scopes,
    resource: rootResource.href, expiresAt: Math.floor(Date.now() / 1000) + 3600 };
  store.saveRefreshToken(hash(refreshToken), grant);

  await assert.rejects(provider.exchangeRefreshToken(client, unknownToken), InvalidGrantError);
  await assert.rejects(provider.exchangeRefreshToken(client, refreshToken, undefined, mcpUrl), InvalidGrantError);
  const privateResource = new URL("/mcp?private=private-resource-query", mcpUrl);
  await assert.rejects(provider.exchangeRefreshToken(client, refreshToken, undefined, privateResource), InvalidGrantError);
  assert.deepEqual(store.getRefreshToken(hash(refreshToken)), grant);

  const renewed = await provider.exchangeRefreshToken(client, refreshToken);
  assert.equal(renewed.refresh_token, refreshToken);
  provider.close();
  provider = new SingleUserOAuthProvider(config, mcpUrl, directory, (event) => events.push(event));
  const retried = await provider.exchangeRefreshToken(client, refreshToken);
  assert.equal(retried.refresh_token, refreshToken);
  assert.notEqual(retried.access_token, renewed.access_token);
  assert.equal((await provider.verifyAccessToken(retried.access_token)).resource?.href, rootResource.href);
  const identity = { clientId: client.client_id, refreshPolicy: "google_persistent" };
  assert.deepEqual(events, [
    { ...identity, outcome: "rejected", reason: "unknown_grant" },
    { ...identity, outcome: "rejected", reason: "resource_mismatch" },
    { ...identity, outcome: "rejected", reason: "resource_mismatch" },
    { ...identity, outcome: "succeeded", reason: "renewed" },
    { ...identity, outcome: "succeeded", reason: "renewed" },
  ]);
  const log = JSON.stringify(events);
  for (const secret of [config.ownerToken, client.client_secret!, refreshToken, unknownToken,
    hash(refreshToken), hash(unknownToken), renewed.access_token, retried.access_token,
    privateResource.href, "private-resource-query"]) {
    assert.equal(log.includes(secret), false);
  }
});

for (const mode of ["alias-pair", "single-alias", "allow-list-only"] as const) {
  test(`HTTP Google authorization retains its resource across root and MCP refreshes: ${mode}`, { timeout: 30_000 }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "quaymesh-refresh-http-"));
    const rootResource = "https://gemini.example.com/";
    const mcpResource = new URL("/mcp", rootResource).href;
    const otherRoot = "https://other.example.com/";
    const otherMcp = new URL("/mcp", otherRoot).href;
    const resources = [rootResource, mcpResource, otherRoot, otherMcp];
    const config = loadConfig(writeTestQuayMeshConfig(join(directory, "config"), {
      server: { publicBaseUrl: "https://coordinator.example.com" },
      storage: { stateDir: join(directory, "state") },
      workspaces: { allowedRoots: [directory] },
      oauth: {
        allowedResourceUrls: resources,
        resourceAliases: mode === "alias-pair" ? resources : mode === "single-alias" ? [mcpResource] : [],
        allowedRedirectHosts: ["oauth-redirect.googleusercontent.com"],
      },
      logging: { level: "silent" },
    }));
    const events: Record<string, unknown>[] = [];
    const store = new SqliteOAuthStore(config.stateDir);
    const boot = async () => {
      const runtime = createServer(config, { diagnostics: {
        record(event, fields) { if (event === "oauth_refresh" && fields) events.push(fields); },
      } });
      await runtime.ready;
      const listener = runtime.app.listen(0, "127.0.0.1");
      await once(listener, "listening");
      const address = listener.address();
      assert.ok(address && typeof address !== "string");
      return {
        base: `http://127.0.0.1:${address.port}`,
        async close() {
          await runtime.close();
          listener.closeAllConnections();
          await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
        },
      };
    };
    let running: Awaited<ReturnType<typeof boot>> | undefined;
    t.after(async () => {
      await running?.close();
      store.close();
      await rm(directory, { recursive: true, force: true });
    });
    running = await boot();
    const redirectUri = "https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-http-test";
    const registration = await fetch(`${running.base}/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [redirectUri], token_endpoint_auth_method: "client_secret_post",
        grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(registration.status, 201, await registration.clone().text());
    const client = await registration.json() as OAuthClientInformationFull;
    assert.ok(client.client_secret);
    const credentials = { client_id: client.client_id, client_secret: client.client_secret };
    const form = (path: string, fields: Record<string, string>) => fetch(`${running!.base}${path}`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields), redirect: "manual", signal: AbortSignal.timeout(5000),
    });
    const authorize = async (resource: string, exchangeResource = resource) => {
      const verifier = "quaymesh-real-oauth-resource-contract-verifier-0123456789";
      const approval = await form("/authorize", {
        client_id: client.client_id, redirect_uri: redirectUri, response_type: "code",
        code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
        scope: "quaymesh", resource, state: "resource-contract", owner_token: config.oauth.ownerToken,
      });
      assert.equal(approval.status, 302, await approval.clone().text());
      const code = new URL(approval.headers.get("location")!).searchParams.get("code");
      assert.ok(code);
      const exchange = await form("/token", { ...credentials, grant_type: "authorization_code", code,
        code_verifier: verifier, redirect_uri: redirectUri, resource: exchangeResource });
      assert.equal(exchange.status, 200, await exchange.clone().text());
      return await exchange.json() as OAuthTokens;
    };
    const tokens = await authorize(mcpResource);
    const refreshToken = tokens.refresh_token;
    assert.ok(refreshToken);
    const refreshHash = createHash("sha256").update(refreshToken).digest("base64url");
    const refresh = (resource: string) => form("/token", {
      ...credentials, grant_type: "refresh_token", refresh_token: refreshToken, resource,
    });
    for (const resource of [rootResource, mcpResource, rootResource]) {
      const reply = await refresh(resource);
      if (mode !== "alias-pair" && resource === rootResource) {
        assert.equal(reply.status, 400);
        assert.equal((await reply.json() as { error: string }).error, "invalid_grant");
      } else {
        assert.equal(reply.status, 200, await reply.clone().text());
        assert.equal((await reply.json() as OAuthTokens).refresh_token, refreshToken);
      }
      assert.equal(store.getRefreshToken(refreshHash)?.resource, mcpResource);
    }
    if (mode === "alias-pair") {
      for (const resource of [otherRoot, otherMcp, `${rootResource}other`, `${mcpResource}/child`,
        `${rootResource}?private=query`, `${mcpResource}?private=query`, `${rootResource}#fragment`,
        "https://user@gemini.example.com/", "http://gemini.example.com/"]) {
        const reply = await refresh(resource);
        assert.equal(reply.status, 400, resource);
        assert.equal((await reply.json() as { error: string }).error, "invalid_grant");
      }
      const reverse = await authorize(rootResource, mcpResource);
      assert.ok(reverse.refresh_token);
      assert.equal(store.getRefreshToken(createHash("sha256").update(reverse.refresh_token).digest("base64url"))?.resource, rootResource);
      await running.close();
      running = undefined;
      running = await boot();
      const resumed = await refresh(rootResource);
      assert.equal(resumed.status, 200, await resumed.clone().text());
      const resumedTokens = await resumed.json() as OAuthTokens;
      assert.equal(resumedTokens.refresh_token, refreshToken);
      const initialized = await fetch(`${running.base}/mcp`, {
        method: "POST", headers: { Authorization: `Bearer ${resumedTokens.access_token}`,
          "content-type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
          protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "resource-contract", version: "1" },
        } }), signal: AbortSignal.timeout(5000),
      });
      assert.equal(initialized.status, 200);
      assert.match(await initialized.text(), /"serverInfo"/);
    }
    assert.ok(events.some((event) => event.outcome === "succeeded" && event.reason === "renewed"));
    assert.equal(events.some((event) => event.outcome === "succeeded" && event.reason === "renewed_resource_alias"), mode === "alias-pair");
    assert.ok(events.every((event) => event.clientId === client.client_id && event.refreshPolicy === "google_persistent"));
    assert.ok(events.some((event) => event.outcome === "rejected" && event.reason === "resource_mismatch"));
  });
}
