# Bounded reads and task state

[English](bounded-read-architecture.md) · [简体中文](bounded-read-architecture.zh-CN.md)

This replaces the temporary detail limitations in [Console read isolation v1](console-read-isolation-v1.md). The service keeps execution admission, control and durable writes in Core. Console reconstruction, MCP workspace status and background snapshot composition run in separate read processes.

## Ownership and capacity

All three readers use `src/console-workbench/read-process.ts`; lifecycle rules belong there, not in route-specific process managers.

| Owner | Reader and fixed worker | Runtime diagnostic |
| --- | --- | --- |
| Console module pool | `isolated-queries.ts` → `read-worker.ts` | `console_read` |
| SessionRuntime | `session/status-reader.ts` → `status-read-worker.ts` | `mcp_status_read` |
| SessionProjector, created on demand | `session/projection-reader.ts` → `projection-read-worker.ts` | `session_projection_read` |

Each pool allows one active request and eight queued requests. Its 5,000 ms deadline starts at enqueue and includes waiting, startup, query execution and delivery. Request JSON is limited to 64 KiB, response envelopes to 8 MiB, and the child heap to 192 MiB. The three pools have separate capacity; a normal Core therefore runs at most three active read processes.

A healthy child serves one framed request at a time and is reused. Responses must match the request ID. After 30 seconds idle it is terminated; idle handles are unreferenced so they do not keep the owner alive. Timeout, cancellation, malformed framing or a crashed child terminates only the owned reader. Its active slot stays occupied until OS `close`, even when the caller has already received an error. Cancelling queued work does not terminate another request's reader.

Workers receive a fixed system-environment allow-list, not credentials or `NODE_OPTIONS`. They enable readonly database mode before loading query modules: no migration, journal reconfiguration, state repair, execution runtime or listener. The protocol accepts fixed operations and validated identities, never caller SQL, module names or arbitrary paths.

## Read and publish contracts

Console details, files, patches, command output, project sessions and audit records use dedicated readonly implementations. Parent-side checks still bind Owner, Task, member, workspace and change-capture identity. Existing write authorization and receipts stay in the write path. An older node without a required isolated route returns an upgrade/read error; it must not fall back to the blocking synchronous route.

MCP workspace status selects a bounded final event window before serialization and preserves operation identities, retry state and current process handles. Member activity uses a scoped SQL query instead of one full-history scan followed by a query for every execution.

Background projection performs full composition and revert eligibility reads in its child. A remote member can be composed from saved data but must never trigger local filesystem or claim checks. Before publication, and again after acquiring the write lock, the parent verifies current identity, revision and capture generation/sequence. The complete read/policy/publication attempt has a 5-second budget, or the caller's shorter budget. Failure preserves the last confirmed snapshot; there is no synchronous fallback or late write after cancellation/shutdown.

## Console behavior

Normal loading and refreshing are progress states. Failed or expired evidence is an attention state. A successful page fetch does not renew a node's old observation time or prove that a task is still executing.

Partial details retain previously read records with their original read time and a visible historical label. Unknown counts remain unknown. Unconfirmed evidence cannot enable acceptance, reversion or completion actions. Pending details get bounded supplementary reads, including in manual-refresh mode. The detail header has its own refresh control for narrow windows.

Command output distinguishes failed, incomplete, expired and confirmed empty output. Retry preserves the byte-cursor contract and previously read output; an error is never converted to empty success.

Task display and resource ownership remain distinct. Thirty minutes without actual progress removes an unobserved Task from the current-activity group. Fresh execution evidence can keep a silent training job current. Polling and peer messages do not renew progress. A display timeout does not kill a process, close a Task or release a claim. Claim recovery requires matching durable completion evidence; see [local API activity semantics](../local-user-api-cli.md).

## Maintenance and regression checks

Extend a fixed readonly operation and its validator when adding a read. Reuse the common process engine and keep writes outside it. Carry node/workspace/Task/operation identity across asynchronous boundaries. Preserve errors and original observation times rather than supplying successful zero values.

Diagnostics contain fixed route, phase, child PID, elapsed milliseconds and result code, not command bodies or secrets. The common engine emits `start`, `finish` and `timeout`; runtime adapters attach the category above. Use these timings to distinguish a queued read, worker startup and a failed response from execution or heartbeat health.

Relevant regression groups:

- `test/console-v5/console-read-process.test.ts`, `console-read-worker.test.ts`, `isolated-read-routing.test.ts`: lifecycle, readonly access and mixed-version routing.
- `test/console-v5/readonly-*.test.ts`, `console-read-detail.test.ts`: details, saved artifacts, audit and project sessions.
- `test/session-card/status-read.test.ts`, `projection-read.test.ts`: native SQLite stalls, parent responsiveness, cancellation, scope and publication races.
- `src/session/session-store.test.ts`, `finalization-budget.test.ts`: saved snapshots, remote members and bounded finalization.
- `test/console-v5/experience.browser.spec.ts`: real browser partial-state retention, supplement/retry and narrow-window interactions.

Run the repository's pinned Node/pnpm typecheck and build before these compiled-worker checks. Use real temporary databases, files, child processes and local connections. The containment boundary limits damage from slow reads; it does not establish the cause of every historical freeze.
