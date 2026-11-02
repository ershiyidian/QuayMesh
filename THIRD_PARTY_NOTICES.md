# Third-party notices

QuayMesh uses MIT for its project code. The following components retain their respective licenses and copyright notices.

## Source attribution

| Component | Source | License and location |
| --- | --- | --- |
| DevSpace | [Waishnav/devspace](https://github.com/Waishnav/devspace) | MIT; original notice retained in `LICENSE` |
| TaskQuay lineage | [wrfgup/taskquay](https://github.com/wrfgup/taskquay) | MIT; attribution in `NOTICE` |
| OpenAI Codex adaptations | [openai/codex](https://github.com/openai/codex) | Apache-2.0; revision and adopted files in `tools/codex-reference.json` |
| Pi integration | [earendil-works/pi](https://github.com/earendil-works/pi) | MIT; integration files listed in `NOTICE` |
| EasyTier | [EasyTier/EasyTier](https://github.com/EasyTier/EasyTier) | LGPL-3.0; source archive and licenses in `third_party/` |
| OpenAI tunnel-client | [openai/tunnel-client](https://github.com/openai/tunnel-client) | Apache-2.0; source archive and licenses in `third_party/` |

The bundled component source archives provide the corresponding source used by the component build. `components.lock.json` records their selected versions.

Local source modifications, archive hashes, and regression commands are documented in [third_party/patches/README.md](third_party/patches/README.md).

## Runtime dependencies

`package.json` and `pnpm-lock.yaml` identify the application dependencies and selected versions. Platform packages include production dependencies with their package-level license files.

The runtime includes the MCP SDKs, React, Express, SQLite bindings, process libraries, provider integrations, and their dependencies.

The Claude Agent SDK is distributed with its version-specific package notices and Anthropic terms. Microsoft WebView2 components retain their Microsoft license. Node.js includes third-party notices in its license text.

## Attribution in distributions

Keep this file, `NOTICE`, `LICENSE`, and the included third-party license texts with redistributed source and platform packages.

Names and provider icons identify the corresponding integrations. Their respective owners retain their trademark rights.

## Included license texts

The release includes the Node.js license and bundled dependency notices in `third_party/licenses/node-LICENSE`. The Microsoft WebView2 SDK license is in `third_party/licenses/WebView2-LICENSE.txt`. Codex and Pi license texts are in the same directory. Runtime packages retain their individual license files under `node_modules/`.
