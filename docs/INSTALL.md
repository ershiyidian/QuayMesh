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

When a Linux account runs both a coordinator and a worker, give them separate configuration directories, state directories, ports, systemd services, and release directories (`--prefix`). For the coordinator, use `install --config /path/site/cloud.json --config-dir /path/coordinator-config --prefix /path/coordinator-releases/RELEASE --service-name quaymesh-coordinator.service`. The worker can keep `quaymesh-node.service`. Upgrades reuse the service name saved in each installation record.

`mesh.mode: "no-tun"` uses a local SOCKS5 connection to the virtual network. `mesh.mode: "tun"` uses a system network adapter. Set `mesh.enabled: false` when an existing network supplies the configured node addresses.

For OpenAI tunnel discovery, set `QUAYMESH_TUNNEL_ID` and `QUAYMESH_TUNNEL_API_KEY` in your shell and add `--resource-url YOUR_TUNNEL_RESOURCE_URL` to `init-site`. Discovery nodes use the same tunnel resource and coordinator.

## Upgrade

From the new package:

```bash
./runtime/node bin/quaymesh.js install --config /path/to/current/node.json --no-start
./runtime/node bin/quaymesh.js activate --prepared /path/returned/prepared.json
```

The first command creates a versioned installation and returns `manifestFile`. The second switches the service when its current work allows it. The installation record retains the previous version for recovery.

Use the installed `node.json`, or pass its original `--config-dir` when using another configuration file; omitted service options inherit the recorded user/system scope, service account, and unit path, while explicit changes to that identity are rejected.

Activation pauses admission and waits for accepted commands, agent turns, transfers, and open egress tunnels to close. A tunnel remains active until its client closes it; an idle period does not authorize terminating a model connection. If drain times out, the current service remains running.

The prepared release is verified with its own Node runtime and installed SQLite dependency, including 500 native close/garbage-collection cycles. Activation takes a consistent SQLite backup by default, records `installation-transition.json`, and requires the same Core process to remain ready for 60 seconds before resuming work. A manager restart preserves this pause. `status` shows an unfinished transition so it can be recovered deliberately.

When a database copy is explicitly unwanted, select `--no-backup` for the activation:

```bash
./runtime/node bin/quaymesh.js activate --prepared /path/returned/prepared.json --no-backup
```

`install --config /path/to/current/node.json --no-backup` also supports this option when preparing and activating together. With `--no-start`, specify `--no-backup` again on the later `activate` command; preparation does not save an activation policy. The programmatic equivalent is `activateInstallation(manifestFile, { backup: false })`.

This mode opens the existing database read-only with the candidate's SQLite runtime and requires its recorded version to equal the candidate's required version, with no pending legacy Agent repair. A missing database, version mismatch, or required repair rejects activation before stopping the old service and releases this attempt's maintenance pause. It creates no database backup; admission drain, maintenance lease checks, rollback boundaries, and the 60-second stability window remain in effect. Release preparation still writes the selected installation directory; use `--prefix` to choose a drive with space. Ordinary state and configuration updates continue in their configured locations.

For the separately reviewed **unified schema 16 → 19** migration, explicitly choose forward-only activation when no database backup is wanted:

```bash
./runtime/node bin/quaymesh.js activate --prepared /path/returned/prepared.json --no-backup --forward-only
```

The programmatic form is `activateInstallation(manifestFile, { backup: false, migrationPolicy: "forward-only" })`. This policy accepts only a complete unified 1–16 migration history and a target requiring schema 19; it rejects missing, mixed, unknown, and other source versions. Plain `--no-backup` keeps the same-schema rule, and activation with backups retains its existing behavior. Preparation does not save either activation policy, so repeat the explicit options after `--no-start`.

The read-only plan rejects existing foreign-key violations before stopping the service. It records the three indexes added by 17; the three nullable `TEXT` columns added to each of `execution_claims` and `execution_waiters`, plus one index, in 18; and the five tables and six indexes added by 19. It also records the candidate's final legacy Agent repair: when `thinking` exists, it may add up to 13 missing columns and `local_agent_turns`, and fills `effort` from `thinking` only where `effort IS NULL AND thinking IS NOT NULL`. Existing non-null effort values are preserved.

After the ordinary service stop and the existing maintenance checks, the operator opens the existing database with the candidate's SQLite addon, starts one outer `IMMEDIATE` transaction, calls the candidate's actual migration function, and validates the result before committing. Validation checks the old schema objects and table row counts, migration history, nullable identity additions, empty new tables, legacy repair, and foreign keys. It creates no database copy or replacement tables and does not hash all business rows. Row counts and foreign-key checks can read substantial data; the helper has a three-minute execution budget and the operator waits for it to exit. A timeout or lost receipt does **not** prove rollback: failure recovery reads the actual schema version. Once schema 19 has committed, any activation failure preserves the database and `recovery_required` marker and does not automatically restart the incompatible schema-16 binary. Admission, stop-domain review, all four maintenance lease stages, and the stability window are unchanged.

After the verified commit, the validating transition's `database` field records the current schema 19 so the immutable candidate can apply its ordinary startup budget. `databaseBeforeMigration` retains the original schema-16 plan. The installer still uses that original version for its rollback decision; a later `recovery_required` marker keeps schema 16 in `database` and reports the actual schema separately as `currentDatabaseVersion`.

An independent reviewed operator can activate an already prepared immutable release using that release's runtime:

```bash
/path/to/prepared/runtime/node /path/to/reviewed-operator/bin/quaymesh.js \
  activate --prepared /path/returned/prepared.json --no-backup --forward-only
```

The migration helper is loaded from the operator's `node/` directory; it loads the actual migration functions and SQLite dependency from the prepared manifest's `directory`. The prepared release does not need to contain the new helper and is not modified. Existing external maintenance providers are still supplied to `activateInstallation` programmatically; this option does not replace or bypass them.

The backup uses a fixed read snapshot so background bookkeeping cannot restart the copy. It aborts after 60 seconds without copied-page progress; the total budget is 60 seconds plus the snapshot size at 4 MiB/s, capped at 30 minutes. A failed backup stops only its own child process and waits for it to exit before abandoning activation; the current service remains running and no migration begins.

When the recorded backup requires a schema upgrade to the matching target release, Core startup receives 30 seconds plus the actual backup size at 4 MiB/s, capped at 30 minutes. Activation adds the unchanged 60-second stability check and 30 seconds for service startup. Ordinary startup, reinstalls without a schema change, downgrades, and recovery markers retain the normal 30-second Core deadline. Node status reports the selected startup budget.

For the default `prove` policy, rollback is automatic only while the database schema remains compatible. If a failed upgrade has changed the schema, the installer preserves the new database, any created backup, and transition record instead of starting an incompatible previous binary. Check any recorded backup and every process using the state directory before restoring data. Existing command pipes, PTYs, and model streams remain owned by their original processes; upgrade waits for them to finish.

With `historyPolicy: "preserve"`, activation requires a reviewed external maintenance provider and retains unresolved execution history and claims without declaring them physically complete or idle. After any stop attempt, failure keeps `recovery_required`, the database, any created backup, and lease; it does not automatically start the previous binary even when the schema is compatible. Review the retained state and current process identities before further recovery. See [upgrading while preserving unresolved history](operations/PRESERVE-HISTORY-UPGRADES.md).

When initiating a Windows upgrade from a QuayMesh command, prepare the release first, then start the independent activation task:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\node\windows-activate.ps1 -PreparedManifest C:\path\returned\prepared.json
```

The command returns a `resultPath`. Windows Task Scheduler owns the activation process, so closing the old Host's process group does not kill the installer. The task verifies the prepared identity and native runtime, then delegates admission, durable-work drain, backup, and stable readiness to the installer. The installer's physical-quiescence check recognizes valid execution proofs while preserving unresolved historical results; active or unproven work keeps the current service running. Its result and transcript remain under `stateDir/activations/`. A committed release remains running if a later status check fails. Use an elevated session to register the task for a TUN node.

New release manifests contain SHA-256 hashes of Node, the dependency lock file, and the SQLite addon actually loaded during verification. Activation compares them with the running Core's process-bound identity for the full readiness window. `active-release.json` retains the original activation time when the same release restarts and records the current process's `startedAt` separately.

## Inspect a node

```bash
./runtime/node bin/quaymesh.js status --config /path/to/node.json
./runtime/node bin/quaymesh.js doctor --config /path/to/node.json
./runtime/node bin/quaymesh.js restart --config /path/to/node.json --component discovery
```

`status` reports the running release, component states, cluster connection, and configuration revision. Component logs are stored under `stateDir/logs/`.

Component status includes the last exit code/signal separately from readiness probe errors. A component with repeated rapid exits remains degraded until it has passed readiness continuously for 60 seconds; it is excluded from gateway selection during that interval. New gateway configurations default to a 60-second recovery delay. Existing explicitly configured delays are preserved.

During mixed-version operation, an older manager with at least three recorded Core restarts must show a ready Core, fresh observations, and a stable process/peer connection for at least five minutes before it can serve new gateway connections. Historical restart counts stop excluding it after that window. Existing model streams continue on their original gateway.

Continue with [configuration](CONFIGURATION.md) and [tasks](TASKS.md).
