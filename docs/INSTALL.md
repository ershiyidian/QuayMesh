# Installation

[English](INSTALL.md) · [简体中文](zh-CN/INSTALL.md) · [Home](../README.md)

## Packages

Download a Windows x64 or Linux x64 archive from [Releases](https://github.com/ershiyidian/QuayMesh/releases). Extract it into a directory of your choice. The archive includes the Node.js runtime, Core, Console, networking components, and production dependencies.

Install Git on machines that will use Git workspaces. Linux service installation uses systemd. The Windows desktop application uses Microsoft Edge WebView2.

## Run on one machine

The included `examples/local.json` combines the coordinator, worker, and console relay in one process group. It uses loopback addresses and the `~/quaymesh-projects` directory.

From the extracted package, run:

```bash
mkdir -p ~/quaymesh-projects
./runtime/node bin/quaymesh.js init-site --directory ./site --inventory ./examples/local.json
./runtime/node bin/quaymesh.js run --config ./site/local.json
```

On Windows, use PowerShell:

```powershell
New-Item -ItemType Directory -Force "$HOME\quaymesh-projects"
.\runtime\node.exe .\bin\quaymesh.js init-site --directory .\site --inventory .\examples\local.json
.\runtime\node.exe .\bin\quaymesh.js run --config .\site\local.json
```

Open `http://127.0.0.1:17676/console/`. The login password is the generated `QUAYMESH_OWNER_TOKEN` in `site/secrets.local.env`. Keep that file with your local configuration.

Edit the `roots` array in `site/local.json` to expose your own project directories. Each entry has an ID and a path:

```json
{
  "roots": [
    {
      "id": "projects",
      "nickname": "Projects",
      "path": "~/quaymesh-projects"
    }
  ]
}
```

Stop the foreground process with Ctrl+C before installing it as a background service.

## Install a background service

Linux:

```bash
./runtime/node bin/quaymesh.js install --config /absolute/path/site/local.json
systemctl --user status quaymesh-node.service
```

For startup before login, an administrator can enable the account's user services:

```bash
sudo loginctl enable-linger YOUR_USER
```

Windows:

```powershell
.\runtime\node.exe .\bin\quaymesh.js install --config C:\QuayMeshSite\local.json
```

To use the tray and desktop window, add `"desktopUi": true` to the node's `capabilities` before installation. The installer registers a `QuayMesh` scheduled task for the current user. TUN networking requires an administrator terminal.

For a Linux system service, create the service account, set an accessible `stateDir`, and install with:

```bash
sudo ./runtime/node bin/quaymesh.js install \
  --system --service-user quaymesh \
  --config /etc/quaymesh-site/worker.json
```

## Connect an MCP client

The local relay exposes `http://127.0.0.1:17676/mcp`. Configure an HTTP MCP client with this endpoint and complete the owner authorization flow.

For ChatGPT, provide an HTTPS MCP endpoint through a reverse proxy or OpenAI Secure MCP Tunnel. In ChatGPT's app settings, create an app with that endpoint and complete QuayMesh's OAuth sign-in. The available app actions follow your ChatGPT workspace settings.

OpenAI maintains the current [connection instructions](https://developers.openai.com/apps-sdk/deploy/connect-chatgpt) and [developer-mode guide](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt).

## Connect multiple machines

Prepare a coordinator and one or more workers. The coordinator provides the shared MCP endpoint and task directory. Workers expose their own project roots.

Create a site using your coordinator's reachable EasyTier address:

```bash
./runtime/node bin/quaymesh.js init-site \
  --directory ./site \
  --peer udp://YOUR_COORDINATOR_ADDRESS:11010
```

This generates `cluster.json`, `cloud.json`, `worker.json`, and a credentials file for each node. Configure worker project roots, then copy each node's configuration, its credentials file, and the shared cluster configuration to that machine.

Install the coordinator first, followed by the workers:

```bash
./runtime/node bin/quaymesh.js install --config /path/site/cloud.json
./runtime/node bin/quaymesh.js install --config /path/site/worker.json
```

Additional nodes use distinct IDs and network addresses. The files under `examples/` illustrate Linux and Windows worker settings. A custom inventory passed to `init-site --inventory` can generate all node configurations together.

`mesh.mode: "no-tun"` uses a local SOCKS5 connection to the virtual network. `mesh.mode: "tun"` uses a system network adapter. Set `mesh.enabled: false` when an existing network supplies the configured node addresses.

For OpenAI tunnel discovery, set `QUAYMESH_TUNNEL_ID` and `QUAYMESH_TUNNEL_API_KEY` in your shell and add `--resource-url YOUR_TUNNEL_RESOURCE_URL` to `init-site`. Discovery nodes use the same tunnel resource and coordinator.

## Upgrade

From the new package:

```bash
./runtime/node bin/quaymesh.js install --config /path/to/current/node.json --no-start
./runtime/node bin/quaymesh.js activate --prepared /path/returned/prepared.json
```

The first command creates a versioned installation and returns `manifestFile`. The second switches the service when its current work allows it. The installation record retains the previous version for recovery.

## Inspect a node

```bash
./runtime/node bin/quaymesh.js status --config /path/to/node.json
./runtime/node bin/quaymesh.js doctor --config /path/to/node.json
./runtime/node bin/quaymesh.js restart --config /path/to/node.json --component discovery
```

`status` reports the running release, component states, cluster connection, and configuration revision. Component logs are stored under `stateDir/logs/`.

Continue with [configuration](CONFIGURATION.md) and [tasks](TASKS.md).
