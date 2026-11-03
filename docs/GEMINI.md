# Gemini ingress

[English](GEMINI.md) · [简体中文](zh-CN/GEMINI.md) · [Installation](INSTALL.md)

QuayMesh can manage a fixed HTTPS MCP endpoint for Gemini on a Linux node. The release contains the public MCP adapter; the optional Tailscale component supplies the Funnel connection. Both appear in the existing node component lifecycle as `public-mcp` and `funnel`.

## Configure the endpoint

Use a dedicated Tailscale identity authorized for the fixed `*.ts.net` address and Funnel access. Initial device login and Funnel authorization follow the [Tailscale instructions](https://tailscale.com/docs/features/tailscale-funnel). QuayMesh keeps that identity in the configured state directory.

Declare the public OAuth resource on the coordinator:

```json
{
  "publicMcp": {
    "url": "https://my-gateway.example-tailnet.ts.net/mcp",
    "allowedRedirectHosts": ["oauth-redirect.googleusercontent.com"]
  }
}
```

On the Linux node hosting the ingress, use the same public URL and enable managed Funnel:

```json
{
  "publicMcp": {
    "url": "https://my-gateway.example-tailnet.ts.net/mcp",
    "listenPort": 29177,
    "funnel": {
      "stateDir": "/var/lib/quaymesh/gemini-tailscale",
      "controlProxyPort": 17889
    }
  }
}
```

The ingress node needs external network access. A worker forwards requests through its existing MCP relay to the coordinator. The adapter only exposes MCP, OAuth authorization, and discovery routes; its local listener uses loopback. The coordinator continues to own task execution, OAuth credentials, and authorization.

`listenPort` defaults to `29177`. `funnel.stateDir` defaults to `tailscale` under the node's `stateDir`. The directory must be writable by the service account. It retains the Tailscale device identity and Funnel settings across releases. `funnel.controlProxyPort` defaults to `17889` and must not conflict with another local listener.

Linux packages can include the paired `tailscaled` and `tailscale` programs in `components/<platform>/`. An existing matching pair can instead be selected with `components.tailscale.executable` pointing to `tailscaled`; the CLI must be beside it. The selected version and official download URLs are recorded in `components.lock.json`. See [component packaging](../CONTRIBUTING.md#build-platform-packages).

## Dynamic egress and recovery

When dynamic QuayMesh egress is enabled, the managed Funnel uses a dedicated loopback control listener, normally `127.0.0.1:17889`, configured by `publicMcp.funnel.controlProxyPort`. This listener uses the same dynamic egress selection and routes as ordinary traffic. The ordinary workload listener remains `127.0.0.1:17890`, or the configured `consoleSettings.egress.listenPort`. New connections follow the currently selected healthy egress node; existing healthy connections continue on their original route.

The control listener is opened only when managed Funnel and dynamic egress are enabled. It allows the Funnel control connection to recover while ordinary workload admission is paused for maintenance, so activation can verify ingress readiness before resuming work. Dynamic exit selection continues to apply to both listeners.

The component probes the dedicated Tailscale instance and its Funnel configuration. A running process with a persistently stalled control connection becomes unhealthy and can be restarted independently. The next connection uses the current dynamic egress route. Login requirements and external network outages remain visible in component status; they do not trigger immediate restart loops.

Restarting `funnel` retains its state directory, hostname, and existing authorization. Core and accepted task execution keep running. A healthy egress change does not itself restart the public ingress.

## Upgrade an existing standalone ingress

Prepare a normal QuayMesh release containing the optional Tailscale pair. When upgrading from a release that does not understand managed Funnel configuration, first activate that release with the existing node configuration. Add `publicMcp.funnel` only after the first activation succeeds, so the rollback release also understands the new configuration. Keep the public URL and coordinator resource declaration unchanged.

Before activation drains the old node, stop the old standalone adapter and Tailscale services if they use its dynamic egress. Preserve their configuration and service definitions for rollback, and disable their automatic startup before managed Funnel takes over. After Tailscale stops, retain its whole state directory or copy every regular file and directory with permissions preserved into the new persistent `funnel.stateDir`; do not copy `tailscaled.sock`. Keep the original state as a rollback copy. Never run both daemons with the same identity.

Back up the node configuration, add the managed Funnel settings to the installed `node.json`, then use `install --config /path/to/node.json --prefix /path/to/new-empty-release-directory --no-start` and `activate --prepared <manifestFile>`. The installer supports preparing the same source commit again at a new empty prefix and preserves the recorded service identity. It uses the current installed node configuration when preparing an existing installation. Both activations retain the normal admission drain, process checks, database backup, and stability checks.

Verify the retained Tailscale device identity, public OAuth metadata, and a real Gemini MCP request before retiring the old service definitions. Subsequent releases use the normal node installation and activation workflow; the ingress code and component definitions come from that release.

## Inspect and recover

```bash
./runtime/node bin/quaymesh.js status --config /path/to/node.json
./runtime/node bin/quaymesh.js doctor --config /path/to/node.json
./runtime/node bin/quaymesh.js restart --config /path/to/node.json --component funnel
```

Inspect `public-mcp` and `funnel` separately in component status. Their readiness observation time and probe errors describe the local adapter and tunnel state. Logs are stored in `stateDir/logs/public-mcp.log` and `stateDir/logs/funnel.log`.

For an end-to-end check, read the public OAuth metadata and retry a Gemini MCP call. An anonymous `/mcp` request normally receives the OAuth `401` challenge; the adapter's request log records the subsequent authenticated client response. Request logs omit query strings, authorization values, and cookies.
