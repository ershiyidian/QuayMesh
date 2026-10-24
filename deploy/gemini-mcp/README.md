# Gemini Web → QuayMesh MCP

This is a second public MCP endpoint. The original OpenAI MCP tunnel,
authorization clients, five node identities, and Console are unchanged.

- Gemini URL: `https://139-196-215-153.sslip.io/mcp`
- Public DNS: free `sslip.io` hostname resolving to the existing Alibaba Cloud IPv4
- TLS termination: Caddy 2.11.7 running as the `quaymesh` user on Home
- TLS certificate: Let's Encrypt automatic issuance and renewal, no custom domain purchase
- Alibaba Cloud: TCP sockets on 80 and 443 forwarded to Home via EasyTier
- Home: Caddy HTTP 28080 / TLS 28443 → loopback public MCP gateway 29176 → existing Coordinator loopback 27676
- Google authorization: existing QuayMesh DCR, S256 PKCE, owner password and SQLite OAuth tables
- Publicly permitted paths: `/mcp`, `/.well-known/oauth-protected-resource`, `/.well-known/oauth-protected-resource/mcp`,
  `/.well-known/oauth-authorization-server`, `/register`, `/authorize`, `/token`, `/revoke`, `/introspect`

The gateway rejects Console and internal management requests, forwards the
OAuth owner's grant to the existing server, and emits a public HTTPS OAuth
metadata document instead of the internal 127.0.0.1 resource URL.

Gemini Web integration compatibility:

- The public MCP endpoint is still `/mcp`, but OAuth Protected Resource
  Metadata declares the origin `https://139-196-215-153.sslip.io` as the
  resource, matching the successfully connected Coding Tools MCP reference.
- The unauthenticated Bearer challenge points to
  `/.well-known/oauth-protected-resource` and advertises realm `QuayMesh`.
- The Home Coordinator accepts both the public origin and its `/mcp`
  endpoint as OAuth resource aliases; the existing ChatGPT resource remains.
- Dynamic client registration accepts six Google relay callback hostnames:
  the base `oauth-redirect.googleusercontent.com` and numbered variants.
  Variant callbacks require HTTPS and the Google user-bound custom-MCP path.
- `home-issuer-compat-upgrade.sh` performs the controlled Coordinator
  restart to activate the resource-alias change, with the old systemd unit
  retained for automatic rollback if the new Core fails readiness checks.
- `smoke-test.mjs` exercises the real public HTTPS endpoint with six
  registered sandbox/test/production callback URIs (each using /r/ and /a/),
  confidential client credentials issued through DCR, Owner authorization,
  long OAuth state, PKCE token issuance, MCP initialize, tools/list and a read-only
  federated tool call; it revokes its disposable tokens afterward.

The Google web app registers as `OpenAuth` with six redirect URIs and
`token_endpoint_auth_method=client_secret_post`. The old QuayMesh host
allowlist accepted numbered oauth-redirect hosts but rejected Google's
`oauth-redirect-sandbox` and `oauth-redirect-test` hosts and /a/ paths.
That produced `POST /register HTTP 400` with
`Client redirect_uri is not allowed for this QuayMesh server`.
The host validator now allows only the observed Google relay hosts, HTTPS,
and `/r/user_bound_custom-mcp-...` or `/a/user_bound_custom-mcp-...`
callback paths. The MCP SDK mints a random `client_secret` for
`client_secret_post`. The full six-callback confidential-client smoke
flow now passes and revokes the test credentials using that secret.

Gemini's connector may also probe the issuer discovery document at
`/.well-known/oauth-authorization-server/mcp`; the gateway serves the
same RFC 8414 metadata there. Browser-based discovery from the Gemini
web origin has explicit CORS headers and preflight support without opening
management or Console endpoints. Caddy serves only HTTP/1.1 and HTTP/2,
since its local port 28443 must not be advertised as a public HTTP/3 port.
The public MCP adapter is deployed independently from the Coordinator
release at `gemini-mcp-ingress-20261024/public-mcp.mjs`.

Add the following to the Home Coordinator's `/home/quaymesh/.config/quaymesh-coordinator/node.json`:

```json
"publicMcp": {
  "url": "https://139-196-215-153.sslip.io/mcp",
  "allowedRedirectHosts": ["oauth-redirect.googleusercontent.com"]
}
```

The additional MCP URL becomes a second OAuth resource alias, and the
Google redirect is allowlisted by exact hostname. Existing ChatGPT resource
aliases remain authorized. Keep the Caddy/Gemini Node service on Home;
never make Alibaba Cloud initiate a Google or Let's Encrypt request.

## Stable free Gemini endpoint

Tailscale Funnel now provides a fixed HTTPS host:
`https://quaymesh-mcp-home.tail2e51e6.ts.net/mcp`.
On the Home Gateway it runs in an isolated userspace `tailscaled` service
using a separate state and socket, so it cannot alter EasyTier routes.
The public Funnel points only to the loopback Gemini adapter on port 29177.
The original `sslip.io` adapter stays on port 29176 with its own config.

The Coordinator config supports `publicMcp.legacyUrls`, keeping the previous
public OAuth resources and ChatGPT tunnel alias when changing the primary
resource to `ts.net`. `home-tsnet-upgrade.sh` validates the dual resources,
uses an already-verified online SQLite backup, switches the Home Coordinator
in an independent service, and restores the old unit/config on failure.
The production Funnel is pinned to Tailscale 1.102.4 after an upstream
1.104.2 TLS-handshake regression was reproduced; avoid switching client
versions without an external HTTPS test.

The userspace `tailscaled` systemd service must pass both its private
`--state` file and explicit `--statedir` directory. Omitting
`--statedir` caused `no TailscaleVarRoot` and prevented automatic
certificate issuance. The service does not enable TUN, DNS changes, route
acceptance, or an exit node. Keep the separate state directory private and
preserve it across upgrades or restarts.

### Verified migration, 2026-10-24

- Funnel serves HTTPS 443 from the fixed `ts.net` address to
  `127.0.0.1:29177` on the Home Gateway.
- The original `sslip.io` adapter uses a separate immutable node-config
  copy to keep its issuer unchanged after Coordinator configuration updates.
- Home Coordinator release `190b01bad9f31de02a97af6ec514295638caf9f6`
  includes the new primary ts.net OAuth resource, the old sslip.io root
  and /mcp resources, and the original OpenAI discovery alias.
- `home-tsnet-upgrade.sh` used a verified SQLite online backup,
  performed a controlled Coordinator restart and completed with
  `TSNET_COORDINATOR_UPGRADE_OK`.
- Desktop, outside the Home Tailscale daemon, received HTTP 200 for
  OAuth metadata and HTTP 401 for anonymous MCP over valid HTTPS.
- `smoke-test-tsnet.mjs` ran via the existing Home HTTPS proxy with
  `NODE_USE_ENV_PROXY=1`, passing DCR, six Google callback URIs,
  Owner consent, long OAuth state, PKCE issuance, MCP initialization,
  discovery of 32 tools and a real read-only workspace call. Disposable
  test tokens were revoked and the test-client registration was removed.
- Actual Gemini Web account-side connection still requires verification.

### Gemini workspace discovery and cloud-node routing

Gemini was observed to call `workspace_catalog` and receive a full 7 KB
`structuredContent` catalog but conclude that no worker roots existed.
The old MCP text block said only that a result was available in structured
form; some model clients do not read that structured result reliably.
The Coordinator now returns the exact exported `root_id` values and online
worker names in both the structured reply and human-readable text. An
unmatched query explicitly lists the available alternatives.

The Cloud Coordinator has no worker filesystem or shell capability.
Opening an arbitrary path such as `/tmp/healthcheck` without a `root_id`
therefore failed with a generic execution error. The MCP tool descriptions
now instruct clients to select `desktop/main`, `s1/data`, `s2/data`,
`home-gateway/reports` or another exported root. An unrouteable request
returns `WORKSPACE_ROOT_REQUIRED` with the exact available IDs and
`retry_hint=fix_input`, before any directory is created.

The `start_session` workspaces field counts roots attached to that task,
not all available cluster roots. Its response now explains this distinction.
Additive session/bootstrap tool annotations are explicitly non-destructive;
Gemini may still require per-action approval for write operations.

The versioned Coordinator release `64aa30259436a60b4a6ed1edac9f9f4d446b8472`
was deployed with `home-worker-catalog-upgrade.sh` and an online SQLite
backup. Production validation from the public `ts.net` domain confirmed
six exported roots in both reply shapes, a real open of
`home-gateway/reports`, a directory listing on that worker, and an
actionable rejection of an unrouteable absolute path.

Check `https://139-196-215-153.sslip.io/.well-known/oauth-authorization-server`
and `/mcp` from outside the cluster, then choose Add custom app in
Gemini Connected Apps, paste the URL, leave Client ID/secret empty, and
approve through the QuayMesh Owner password page. The Google Account must
be eligible for custom Connected Apps.

The DNS alias is managed by the public sslip.io service. Availability is
dependent on their DNS service; switching to a user-owned domain later
only requires changing the endpoint/issuer and reconnecting the client.
