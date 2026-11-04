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

## Files between a Gemini VM, Library, and workers

The MCP tools carry file bytes across the VM boundary. Gemini's native file tools read a Library file into its VM, or save a reconstructed VM file to Library. QuayMesh writes and reads the selected worker workspace.

| Direction | Method | Limit |
| --- | --- | --- |
| VM or Library to worker | Read the file in the VM, base64 encode it, and call `download_artifact` with `file.content_base64` | 1 MiB of decoded bytes per file |
| Worker to VM or Library | Call `read` with `encoding: "base64"`, decode each page, and append its bytes to the VM file | Up to 16,384 bytes per page |
| Larger files | Upload to an explicitly selected Google Drive folder, then use its file ID with `download_artifact` or the bundled Drive CLI | MCP: the worker's artifact size limit and a five-minute download budget; CLI: streamed files |

A complete MCP JSON request is limited to 2 MiB. Base64 expands the file, so inline reception deliberately stops at 1 MiB. `download_artifact` creates a new path and verifies the supplied `size` and `sha256` when present. The existing destination is preserved on failure.

Example inline input:

```json
{
  "workspace_id": "the-selected-workspace",
  "path": "input/example.bin",
  "file": {
    "content_base64": "AP8BAg==",
    "file_name": "example.bin",
    "size": 4
  }
}
```

For binary reads, start `response_offset` at zero and use the returned `response_page.next_offset` until it is null. Offsets and `response_page.total_code_points` are byte counts in base64 mode. `result_sha256` describes that page's decoded bytes. Decode each page separately before appending; base64 pages may contain padding. Keep the source file stable during the transfer.

For Drive reception, pass `file: { "gdrive_file_id": "the-drive-file-id", "file_name": "archive.zip" }`. Public link sharing works without a token. Private downloads use `GDRIVE_ACCESS_TOKEN` from the destination worker's service environment, with permission to read that file. Tokens stay out of MCP arguments. Default file downloads use the worker's dynamic QuayMesh egress when enabled; otherwise they honor its HTTP proxy environment. Redirected content requests do not receive the Google API bearer token.

A Google Drive download through MCP has one five-minute network deadline, including redirects and the response body. For a large file or a slow connection, run the bundled `pull` command on the destination worker with a suitable `--timeout-ms`, for example `--timeout-ms 1800000` for thirty minutes. The CLI streams the file directly to its selected new path; its pull command restarts a failed download from the beginning.

### Bundled Drive CLI

Run the CLI with the release's pinned Node runtime:

```bash
./runtime/node scripts/gdrive-bridge.mjs pull --file-id DRIVE_FILE_ID --out archive.zip
./runtime/node scripts/gdrive-bridge.mjs push --file archive.zip --folder-id DRIVE_FOLDER_ID
./runtime/node scripts/gdrive-bridge.mjs encode --file small.bin
./runtime/node scripts/gdrive-bridge.mjs decode --base64 AP8BAg== --out example.bin
```

For an installed worker, add `GDRIVE_ACCESS_TOKEN` to the file selected by `node.json` → `secretsFile`. Node loads that file into the Core environment; installation preserves the configured secrets file across upgrades. Keep its existing access restrictions and other entries. Standalone CLI commands use the local process environment for private downloads and uploads. Push requires an explicit `--folder-id` or `GDRIVE_FOLDER_ID`; there is no built-in personal folder. Missing authorization is reported before uploading. Credentials are never accepted as CLI arguments.

Push uses Google's resumable upload protocol with 8 MiB file-backed chunks. A lost response triggers a status query, then resumes from the server's confirmed offset, with a bounded retry count. Pull streams into a temporary file and publishes a new output only after completion and any requested SHA-256 check. `--timeout-ms` sets each network request's deadline (default 300,000 ms). `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` are honored; `--proxy` selects an explicit HTTP proxy. Commands launched through QuayMesh inherit its managed proxy when configured.

`encode` and `decode` handle files up to 1 MiB. Larger VM transfers use the paged MCP read or Drive flow above. Google authorization and Library publication remain native host actions; the CLI does not create Google consent or publish a Library file.

Upgrade the coordinator and every worker that will read or receive these files. The earlier `584819d` tool schema lacks binary read and the new artifact references. The existing Gemini HTTPS ingress URL and retained Tailscale identity continue to be used.
