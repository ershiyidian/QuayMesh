# Development notes

Read [CONTRIBUTING.md](CONTRIBUTING.md) and the code involved in the requested change.

## Structure

Node lifecycle and installation belong in `node/`. Core operations belong in `src/`. Browser interfaces belong in `src/ui/`, and Windows applications belong in `apps/`.

## Implementation

Retain node, workspace, task, and operation IDs across asynchronous work. Use standard JSON/YAML parsers and existing project libraries.

Store credentials in local configuration or process environments. Keep public examples independent of a developer's machine.

## Checks

Use `pnpm typecheck`, `pnpm build`, and the tests relevant to the changed module. Integration work uses real temporary files, databases, processes, and local connections.

Inspect rendered interface changes. Close development processes and remove temporary build inputs after the work is complete.

## Documentation

Keep English and Simplified Chinese user guides consistent. Describe supported behavior directly, with examples drawn from public configuration.
