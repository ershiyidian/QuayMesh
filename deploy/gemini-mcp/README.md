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
  registered callback URIs, Owner authorization, long OAuth state,
  PKCE token issuance, MCP initialize, tools/list and a read-only
  federated tool call; it revokes its disposable tokens afterward.

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

Check `https://139-196-215-153.sslip.io/.well-known/oauth-authorization-server`
and `/mcp` from outside the cluster, then choose Add custom app in
Gemini Connected Apps, paste the URL, leave Client ID/secret empty, and
approve through the QuayMesh Owner password page. The Google Account must
be eligible for custom Connected Apps.

The DNS alias is managed by the public sslip.io service. Availability is
dependent on their DNS service; switching to a user-owned domain later
only requires changing the endpoint/issuer and reconnecting the client.
