# Console read isolation v1 and process exit supervision

This document describes the November 1, 2026 containment release. It covers the shipped, one-request reader process and the supervisor lifecycle fix. Full detail reconstruction and a reusable reader process are not part of this contract.

## Fixed read boundary

Authenticated Console GETs use the fixed `/workbench/isolated-v1/...` node protocol. Its allow-list covers metadata, run lists and summaries, Task indexes, session titles, overview/usage, calls/events, and Task message state. It is not an interface for SQL, arbitrary files, modules, or shell commands. Existing Owner/mesh authentication and workspace authorization still apply.

Each read runs in a separate Node child. The child enables the one-way `useReadonlyDatabases()` mode before loading the query modules. SQLite uses `readonly: true`, `fileMustExist: true`, `query_only = ON`, and a 1,000 ms lock timeout. This path does not create/chmod the state directory, change journal settings, or migrate the schema. An absent or incompatible database produces a read failure; the reader must not repair it. The fixed reader does not start a `SessionRuntime`, capture jobs, command execution, or another listener.

The parent enforces these limits from `src/console-workbench/read-process.ts`:

| Limit | Value | Meaning |
| --- | --- | --- |
| Active reads | 1 | Per Core reader pool |
| Queued reads | 8 | An additional request is rejected as busy |
| Read deadline | 5,000 ms | Starts on enqueue; includes queueing, process startup, query, and result delivery |
| Request size | 64 KiB | UTF-8 serialized request |
| Result size | 8 MiB | Serialized worker response, including its envelope |

The deadline is a parent timer, so a synchronous SQLite or filesystem stall in the child cannot prevent it firing. On timeout/cancellation the parent terminates only that read's `ChildProcess`. It retains the active slot until child `close`; repeated failures must not create an unlimited number of replacement processes. No Task process, process group, or request-supplied PID is a termination target. Worker environment inheritance is explicitly restricted and excludes model credentials, QuayMesh secrets, and `NODE_OPTIONS`.

## Shared refresh and cancellation

`WorkbenchFeed` shares one pending refresh per node/resource and preserves the last successful value and its original observation time. A screen normally waits at most 1,200 ms per read wave, then receives loading/refreshing or partial data while the shared refresh continues. Opening a page does not renew old evidence. A failed refresh keeps the previous data, reports the error, and uses the existing retry backoff; it does not become a successful empty result.

Node-local read routes inherit their own HTTP abort signal and can cancel their isolated read. Owner aggregate routes do not attach one browser request's signal to the shared feed refresh. Closing one browser request therefore does not cancel work needed by other views. A continuing local refresh still has the reader's 5-second deadline; remote requests retain their separate transport deadline. These are different budgets.

## Mixed versions and temporary limits

The fixed GET path is selected before local or remote dispatch. If an older node lacks the versioned route, return `node_read_upgrade_required`, retain available cached data, and request a node update. **Never retry the older synchronous read route.** A missing run/file/command reported by an implemented endpoint remains its business error, not an upgrade diagnosis. This read failure alone does not mark the node's execution or heartbeat as stopped.

This release returns only saved summaries for full run/Task detail: `complete: false`, explicitly pending/missing detail, and evidence-dependent actions disabled. Empty detail arrays are unconfirmed, not proof of zero files, commands, or agents. File detail, patch, command output, workspace session history, and audit reads remain temporarily unavailable. Message state is confirmed only by its separate authoritative read; unavailable state must not mean zero pending messages.

Write receipts and POST actions are outside the isolated reader protocol. Receipt handling may reconcile a write, so a GET-shaped receipt request is not automatically safe to move into a readonly child. Their existing authorization, idempotency, execution admission, and maintenance rules remain in their original paths.

## Supervisor lifecycle

`node/supervisor.mjs` treats the OS child `exit` as proof that this Core generation ended. It records that exit once and uses the existing restart/backoff policy. `close` only releases that generation's stream/log references: a surviving descendant may keep inherited stdout/stderr open long after its parent exits. A late `close`, spawn/error callback, or health-probe result cannot replace the new generation's state; callbacks check the actual `ChildProcess` identity.

An unhealthy but still-live Core is not automatically killed by this change. On an authorized stop, confirmed parent exit cancels the fallback termination timer. Surviving descendants are not killed merely to close log pipes. The shared rolling-log writer stays valid across generations. Stop makes a bounded attempt to drain that generation's stdio and flush the log, with one 250 ms total budget; exceeding it returns without destroying inherited pipes. Log tails beyond that budget are not guaranteed flushed before caller shutdown.

## Maintenance references

- `src/console-workbench/read-protocol.ts`, `read-worker.ts`, `read-process.ts`: allow-list, child execution, and limits.
- `src/db/client.ts`: readonly database mode; `isolated-routes.ts`, `router.ts`, and `feed.ts`: version gate, request cancellation, and shared refresh.
- `test/console-v5/console-read-process.test.ts`, `console-read-worker.test.ts`, and `isolated-read-routing.test.ts`: timeout/queue, readonly, and routing regressions.
- `node/test/supervisor-exit-lifecycle.test.mjs`: real inherited pipes, late close/probe results, failed spawn, and bounded final log drain. Run it together with the existing supervisor, maintenance, and upgrade tests using the repository's pinned Node toolchain.

The isolation bounds the impact of slow reads; it does not by itself identify which query or I/O caused a historical node freeze. Diagnostics report fixed route, phase, reader PID, elapsed time, and result code rather than query data or secrets.
