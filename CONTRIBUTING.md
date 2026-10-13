# Contributing

[English](CONTRIBUTING.md) · [简体中文](docs/zh-CN/CONTRIBUTING.md) · [Home](README.md)

Contributions to QuayMesh can improve the runtime, console, provider integrations, documentation, or platform packaging. Open an issue to describe a problem, or submit a pull request with a focused change.

## Set up the source

Use Node.js **24.21.0**, the version recorded in `components.lock.json`, and pnpm **11.25.0**.

```bash
git clone https://github.com/ershiyidian/QuayMesh.git
cd QuayMesh
corepack enable
pnpm install --frozen-lockfile
pnpm build
```

Native dependencies use the toolchain for the operating system on which they are installed.

## Run a development instance

```bash
pnpm dev:seed
pnpm dev
```

The setup command creates `.quaymesh-dev/` with a local configuration, database, project directory, and available port. The command prints the console URL. Stop the development process before running `pnpm dev:reset`.

## Build platform packages

QuayMesh builds each platform package on its target operating system.

```bash
pnpm build:components --source
pnpm build:bundle
```

The source component build uses the archives in `third_party/sources/`. The versions of Node.js, Rust, Go, EasyTier, and tunnel-client are recorded in `components.lock.json`.

Linux builds use a C/C++ compiler, pkg-config, OpenSSL development files, and the protobuf compiler. Windows builds use .NET 10 SDK and the .NET Framework 4.8 compiler.

Existing EasyTier and tunnel-client programs can be imported:

```bash
pnpm build:components --easytier /path/easytier-core --tunnel /path/tunnel-client
pnpm build:bundle
```

The output directory is `releases/quaymesh-<version>-<commit>-<platform>/`. It contains `release.json`, the runtime, application files, production dependencies, and component sources.

## Check a change

Run the checks relevant to the modified code:

```bash
pnpm typecheck
pnpm test:node
pnpm build
```

Focused TypeScript tests can be run with `pnpm exec tsx --test <test-file>`. Use real temporary files, SQLite databases, child processes, and local connections for integration coverage.

For interface changes, inspect the resulting page at desktop and narrow widths. Documentation images should come from an isolated instance containing public example projects.

## Source organization

See [architecture](docs/ARCHITECTURE.md#source-map) for the directory map. Keep node supervision in `node/`, Core behavior in `src/`, and interface code in `src/ui/`.

Retain node, workspace, task, and operation IDs across asynchronous work. Keep user configuration and provider credentials in the runtime's configuration and state locations.

## Submit a contribution

Describe the change, its user-visible effect, and the checks you ran. Keep unrelated changes in separate pull requests. Update both English and Simplified Chinese documentation when changing a public workflow.

Preserve the attribution and license notices for reused source. Contributions to QuayMesh are distributed under its MIT license, with third-party components retaining their respective licenses.
