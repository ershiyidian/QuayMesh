# Configuration

[English](CONFIGURATION.md) · [简体中文](zh-CN/CONFIGURATION.md) · [Home](../README.md)

QuayMesh separates shared cluster settings from each machine's configuration. `init-site` creates both, together with credentials for the selected nodes.

## Configuration files

| File | Purpose |
| --- | --- |
| `cluster.json` | Coordinator address, mesh peers, tunnel settings, network-exit priorities |
| `<node>.json` | Node capabilities, project roots, local storage, component settings |
| `secrets.<node>.env` | Credentials used by that node |
| `components.lock.json` | Component and runtime versions used to build a release |

Relative paths in node configuration resolve from the configuration directory. Paths beginning with `~` resolve to the account running the node.

## Node capabilities

A single node can enable several capabilities:

| Capability | Responsibility |
| --- | --- |
| `coordinator` | Shared MCP endpoint, authorization, membership, task directory |
| `worker` | Workspace access, commands, files, coding agents |
| `discovery` | OpenAI tunnel connection to the coordinator |
| `consoleRelay` | Local browser access to the shared console |
| `desktopUi` | Windows tray and desktop window |
| `meshRelay` | EasyTier rendezvous listener |
| `egress` | Network exit available to other nodes |

The coordinator's node ID matches `cluster.coordinator.id`. Each worker has its own ID and network address.

## Project roots

`roots` defines the directories advertised by a worker:

```json
{
  "roots": [
    {
      "id": "projects",
      "nickname": "Projects",
      "path": "~/projects",
      "description": "Application source",
      "tags": ["development"]
    }
  ]
}
```

A client calls `workspace_catalog` to discover roots, then `open_workspace` with the chosen `root_id`. Subdirectories can be opened independently.

## Networking

`mesh.mode: "no-tun"` connects through EasyTier's local SOCKS5 service. `mesh.mode: "tun"` creates a system adapter. `mesh.enabled: false` uses existing network connectivity.

For a node that accesses external services directly:

```json
{
  "network": {
    "externalAccess": true,
    "inheritProxy": false
  }
}
```

To use a local HTTP proxy, add `proxyUrl` with its actual address. A managed proxy process can be configured under `components.egress` with an executable, arguments, and configuration file.

Shared `egress.priorities` assigns a preference to eligible exit nodes. Healthy nodes serve new connections according to that preference; established connections retain their selected exit.

## Coding agents

Node configuration accepts Core settings under `core`. Enable the providers installed and configured on that machine through `core.subagents`. The node's catalog reports their availability.

Provider accounts and credentials remain part of the machine's provider configuration. See [tasks and agents](TASKS.md) for the operation model.

## Storage

| Platform | Configuration | State |
| --- | --- | --- |
| Linux | `~/.config/quaymesh/` | `~/.local/state/quaymesh/` |
| Windows | `%LOCALAPPDATA%\QuayMesh\config\` | `%LOCALAPPDATA%\QuayMesh\state\` |

Set `stateDir` to place the node's database, command output, task records, and logs on a chosen volume. Project files remain in their configured roots.

Installed versions live in versioned release directories. Configuration and state are managed separately from those program files.

## Credentials

The site generator creates cluster, mesh, and owner credentials. Discovery nodes additionally receive their tunnel credentials.

Store credentials in the generated environment files or provide them through the process environment. Share each node's files with the account operating that node. Example files contain variable names and documentation values.

## Publish shared settings

After editing shared cluster configuration, run:

```bash
./runtime/node bin/quaymesh.js publish \
  --config /path/site/cloud.json \
  --cluster /path/site/cluster.json
```

Nodes retain their applied configuration revision and report any pending revision. Component changes are applied according to their dependencies and current work.

## Default ports

| Port | Service |
| --- | --- |
| `7676/TCP` | Core HTTP: MCP, OAuth, Console |
| `7680/TCP` | Worker communication |
| `7681/TCP` | Coordinator membership and shared configuration |
| `17676/TCP` | Local MCP and Console relay |
| `17677/TCP` | Local node management |
| `17690/TCP` | EasyTier SOCKS5 in no-TUN mode |
| `17890/TCP` | Worker model-proxy entry |
| `11010/UDP` | Example EasyTier rendezvous listener |
| `8080/TCP` | Tunnel-client health endpoint |

Use your host firewall to restrict cluster services to the node network. HTTPS reverse proxies and tunnel services provide the client-facing entry.

The JSON schemas under [`schema/v1/`](../schema/v1/) describe available fields.
