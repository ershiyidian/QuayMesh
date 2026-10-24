import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

const base = "https://139-196-215-153.sslip.io";
const resource = base;
const endpoint = base + "/mcp";
const callback = "https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-quaymesh-smoke";
const ownerFile = "/home/quaymesh/.local/state/quaymesh-coordinator/owner.json";
const owner = JSON.parse(await readFile(ownerFile, "utf8")).token;
const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
// Gemini Web 的 OAuth state 实测可超过 1 KB；确保授权中继逐字节保留。
const state = randomBytes(834).toString("base64url");
assert.equal(state.length, 1112);

function assertResponse(response, status, stage) {
  assert.equal(response.status, status, stage + ": HTTP " + response.status);
}
function params(values) { return new URLSearchParams(values); }
function mcpSummary(text) {
  const events = text.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
  return events.length ? events.at(-1) : JSON.parse(text);
}

const metadataResponse = await fetch(base + "/.well-known/oauth-authorization-server");
assertResponse(metadataResponse, 200, "OAuth metadata");
const metadata = await metadataResponse.json();
assert.equal(metadata.issuer, base);
assert.equal(metadata.registration_endpoint, base + "/register");
assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
const protectedResource = await (await fetch(base+"/.well-known/oauth-protected-resource")).json();
assert.equal(protectedResource.resource, resource);
assert.deepEqual(protectedResource.bearer_methods_supported,["header"]);
console.log("Trusted HTTPS metadata and PKCE: PASS");

const registerResponse = await fetch(base + "/register", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ client_name: "QuayMesh Gemini compatibility smoke",
    redirect_uris: ["oauth-redirect-sandbox","oauth-redirect-test","oauth-redirect"].flatMap(host =>
      ["r","a"].map(part => `https://${host}.googleusercontent.com/${part}/user_bound_custom-mcp-quaymesh-smoke`)),
    response_types: ["code"],
    grant_types: ["authorization_code", "refresh_token"], token_endpoint_auth_method: "client_secret_post" }),
});
assertResponse(registerResponse, 201, "Dynamic client registration");
const client = await registerResponse.json();
assert.match(client.client_id, /^quaymesh-/);
assert.ok(client.client_secret && client.client_secret.length >= 32);
assert.equal(client.token_endpoint_auth_method, "client_secret_post");
console.log("Google relay redirect registration: PASS");

const authorization = {
  client_id: client.client_id, response_type: "code", redirect_uri: callback,
  code_challenge: challenge, code_challenge_method: "S256",
  scope: "quaymesh", state, resource,
};
const authPage = await fetch(base + "/authorize?" + params(authorization));
assertResponse(authPage, 200, "Authorization page");
assert.match(await authPage.text(), /Owner password/);
const consent = await fetch(base + "/authorize", {
  method: "POST", redirect: "manual",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: params({ ...authorization, owner_token: owner }),
});
assertResponse(consent, 200, "Gemini Google relay consent");
const consentHtml = await consent.text();
const href = consentHtml.match(/<a rel="noreferrer" href="([^"]+)"/)?.[1];
assert.ok(href, "Gemini callback must have an HTML continuation");
const codeUrl = new URL(href.replaceAll("&amp;", "&"));
assert.equal(codeUrl.hostname, "oauth-redirect.googleusercontent.com");
assert.equal(codeUrl.searchParams.get("state"), state);
const code = codeUrl.searchParams.get("code");
assert.ok(code);
console.log("Owner consent, OAuth code and Google callback handoff: PASS");

const tokenResponse = await fetch(base + "/token", {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: params({ grant_type: "authorization_code", client_id: client.client_id,
    code, redirect_uri: callback, code_verifier: verifier, client_secret: client.client_secret, resource }),
});
assertResponse(tokenResponse, 200, "OAuth token exchange");
const token = await tokenResponse.json();
assert.ok(token.access_token && token.refresh_token);
console.log("PKCE authorization-code exchange: PASS");

async function mcp(method, paramsValue, id) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "authorization": "Bearer " + token.access_token,
      "content-type": "application/json",
      "accept": "application/json, text/event-stream",
      "mcp-protocol-version": "2025-11-25",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params: paramsValue }),
  });
  assertResponse(response, 200, method);
  return mcpSummary(await response.text());
}

try {
  const initialize = await mcp("initialize", {
    protocolVersion: "2025-11-25", capabilities: {},
    clientInfo: { name: "QuayMesh Gemini smoke", version: "1.0.0" },
  }, 1);
  assert.ok(initialize.result?.serverInfo, "MCP initialize did not return server info");
  console.log("Authenticated MCP initialize: PASS");

  const toolList = await mcp("tools/list", {}, 2);
  assert.ok(Array.isArray(toolList.result?.tools) && toolList.result.tools.length >= 10);
  assert.ok(toolList.result.tools.some(t => t.name === "workspace_catalog"));
  console.log("Gemini-visible tools: " + toolList.result.tools.length + " PASS");

  const read = await mcp("tools/call", {
    name: "workspace_catalog", arguments: { include_offline: true },
  }, 3);
  assert.equal(Boolean(read.error), false);
  assert.ok(read.result, "MCP tool call returned no result");
  const available = read.result.structuredContent?.workspaces;
  assert.ok(Array.isArray(available) && available.length >= 6,
    "The real Gemini OAuth MCP client must see the federated worker roots");
  assert.ok(available.some(root => root.root_id === "desktop/main"));
  assert.ok(available.some(root => root.root_id === "s2/data"));
  const readable = read.result.content?.find(item => item.type === "text")?.text ?? "";
  assert.match(readable, /desktop\/main/);
  assert.match(readable, /s2\/data/);
  console.log("Gemini text-only workspace catalog: " + available.length + " worker roots PASS");

  const invalidPath = await mcp("tools/call", {
    name: "open_workspace", arguments: { path: "/tmp/gemini-fabricated-health-check", create_directory: true },
  }, 4);
  assert.equal(invalidPath.result?.isError, true);
  const explanation = invalidPath.result?.content?.find(item => item.type === "text")?.text ?? "";
  assert.match(explanation, /WORKSPACE_ROOT_REQUIRED/);
  assert.match(explanation, /desktop\/main/);
  console.log("Unroutable absolute path now suggests exported roots: PASS");
  console.log("Real read-only federated tool invocation: PASS");
} finally {
  await Promise.all([
    token.access_token, token.refresh_token,
  ].map(async tokenValue => {
    const response = await fetch(base + "/revoke", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params({ client_id: client.client_id, client_secret: client.client_secret, token: tokenValue }),
    });
    assert.equal(response.status, 200);
  }));
  console.log("Smoke-test credentials revoked");
}
