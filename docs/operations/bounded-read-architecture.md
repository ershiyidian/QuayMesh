# Bounded reads and task state

[English](bounded-read-architecture.md) · [简体中文](bounded-read-architecture.zh-CN.md)

This replaces the temporary detail limitations in [Console read isolation v1](console-read-isolation-v1.md). The service keeps execution admission, control and durable writes in Core. Console reconstruction, MCP workspace status and background snapshot composition run in separate read processes.

## Ownership and capacity

All four fixed read pools use `src/console-workbench/read-process.ts`; lifecycle rules belong there, not in route-specific process managers.

| Owner | Reader and fixed worker | Runtime diagnostic |
| --- | --- | --- |
| Console interactive pool | `isolated-queries.ts` → `read-worker.ts` | `console_read` |
| Console analysis pool | `isolated-queries.ts` → `read-worker.ts` | `console_read` |
| SessionRuntime | `session/status-reader.ts` → `status-read-worker.ts` | `mcp_status_read` |
| SessionProjector, created on demand | `session/projection-reader.ts` → `projection-read-worker.ts` | `session_projection_read` |

Each pool allows one active request and eight queued requests. Its 5,000 ms deadline starts at enqueue and includes waiting, startup, query execution and delivery. Request JSON is limited to 64 KiB, response envelopes to 8 MiB, and each child's V8 old-space limit is 192 MiB. The four pools have separate capacity; a normal Core therefore owns at most four read children, with at most two belonging to Console. Children start on demand rather than at pool construction.

Console routes the local `usage`, `overview-usage` and `overview` operations to the analysis pool; every other Console read uses the interactive pool. The federated homepage uses `task-state-index` in the interactive pool. A slow usage query cannot occupy the task-index, title or preview queue. Both pools retain the same bounded queue, deadline and cancellation rules. They read the same SQLite database, so a database-wide exclusive lock can still make both fail; queue isolation does not bypass database locking.

At the feed layer, each node admits at most four pending run-summary or phase-detail reads; other pending reads on that node also count against admission of new summary/detail work. This is separate from each child pool's queue limits. Successful observations and failed-read records share a hard limit of 160 cached resources. Repeated previews share pending requests, and unread detail batches take priority over refreshing an already observed prefix.

Task lists share a 1,200 ms foreground budget across index, membership and summary reads. A Task detail request has separate bounded preview windows for its Task state/summaries and its selected content page. These are waiting budgets, not an end-to-end response-time guarantee: serialization, scheduling and the bounded background read still have their own costs. Reaching a preview deadline preserves the shared background request and its original observation time; it does not start another unbounded batch or cancel another reader's work.

A healthy child serves one framed request at a time and is reused. Responses must match the request ID. After 30 seconds idle it is terminated; idle handles are unreferenced so they do not keep the owner alive. Timeout, cancellation, malformed framing or a crashed child terminates only the owned reader. Its active slot stays occupied until OS `close`, even when the caller has already received an error. Cancelling queued work does not terminate another request's reader.

Workers receive a fixed system-environment allow-list, not credentials or `NODE_OPTIONS`. They enable readonly database mode before loading query modules: no migration, journal reconfiguration, state repair, execution runtime or listener. The protocol accepts fixed operations and validated identities, never caller SQL, module names or arbitrary paths.

## Read and publish contracts

Console details, files, patches, command output, project sessions and audit records use dedicated readonly implementations. Parent-side checks still bind Owner, Task, member, workspace and change-capture identity. Existing write authorization and receipts stay in the write path. An older node without a required isolated route returns an upgrade/read error; it must not fall back to the blocking synchronous route.

The `task-state-index` operation combines phase state, saved Task lifecycle, titles and membership in one readonly SQLite transaction and one node response. It uses the same execution/acceptance classifier as the full index, including current phases, unresolved execution, finalization and the last meaningful outcome. It omits usage deltas, change evidence and checkpoint JSON. Its explicit state projection has no `tokens` or `changed` fields; missing measurements are not reported as zero or false. The isolated route is a separate capability, and an older node does not silently fall back to the full historical index.

The overview, ordinary Task lists and conversation lists use that combined state read. Only a query that needs changes or token ordering requests the full index; list summaries are then read for the selected page. A node/project scope reads its owner and configured or advertised Coordinator, then the selected Tasks' registered members. Unrelated projects on the same owner cannot add their remote members to that scope. Missing authority or a registered member keeps coverage incomplete. Standalone mode uses local authority. Project-session previews restrict project candidates in SQL before state classification and retain the saved conversation, thread, claim and review-protection fields.

Authenticated Console GET/HEAD RPCs carry cancellation through the existing `withConsoleReadSignal` asynchronous context to the owned reader. A nested route controller combines its signal with the inherited RPC signal. The HTTP relay also forwards read cancellation to `fetch`, including response-body consumption. An accepted POST keeps its durable execution and receipt when its caller stops waiting; transport cancellation does not revoke that write. Shared feed refreshes retain their own bounded lifetime and are not owned by an individual browser wait.

MCP workspace status selects a bounded final event window before serialization and preserves operation identities, retry state and current process handles. Member activity uses a scoped SQL query instead of one full-history scan followed by a query for every execution.

Background projection performs full composition and revert eligibility reads in its child. A remote member can be composed from saved data but must never trigger local filesystem or claim checks. Before publication, and again after acquiring the write lock, the parent verifies current identity, revision and capture generation/sequence. The complete read/policy/publication attempt has a 5-second budget, or the caller's shorter budget. Failure preserves the last confirmed snapshot; there is no synchronous fallback or late write after cancellation/shutdown.

## Console behavior

Normal loading and refreshing are progress states. Failed or expired evidence is an attention state. A successful page fetch does not renew a node's old observation time or prove that a task is still executing.

Partial details retain previously read records with their original read time and a visible historical label. Unknown counts remain unknown. Unconfirmed evidence cannot enable acceptance, reversion or completion actions. Pending details get bounded supplementary reads, including in manual-refresh mode. The detail header has its own refresh control for narrow windows.

Task and legacy-session detail GETs read 20 phase bodies per page by default, with a maximum of 50. Current phases come first; the Task header keeps the full indexed phase references, membership, state and revision. Cursors bind the outer Task/session reference, a phase anchor and direction. Incomplete source coverage does not produce a next-page cursor; a missing anchor produces a pending-source response while coverage is incomplete, or an expired-cursor response once the full index confirms it is gone. Single-phase detail and mutation/summary APIs keep their existing scope.

`phasePage.complete` confirms the selected page's content. `taskComplete` describes complete Task authority/index/summary coverage, and the original `complete` remains false unless this response includes the whole history. An empty page with an unconfirmed owner is not confirmed empty. The UI presents records and counts for the selected page and retains only that page's body; unselected history is available through pagination rather than shown as pending work. Acceptance, completion, patch and reversion eligibility still require complete Task evidence, every current phase's actual detail, fresh sources and confirmed change captures. A completed content page alone cannot enable them.

Command output distinguishes failed, incomplete, expired and confirmed empty output. Retry preserves the byte-cursor contract and previously read output; an error is never converted to empty success.

Task display and resource ownership remain distinct. Thirty minutes without actual progress removes an unobserved Task from the current-activity group. Fresh execution evidence can keep a silent training job current. Polling and peer messages do not renew progress. A display timeout does not kill a process, close a Task or release a claim. Claim recovery requires matching durable completion evidence; see [local API activity semantics](../local-user-api-cli.md).

## Maintenance and regression checks

Extend a fixed readonly operation and its validator when adding a read. Reuse the common process engine and keep writes outside it. Carry node/workspace/Task/operation identity across asynchronous boundaries. Preserve errors and original observation times rather than supplying successful zero values.

Diagnostics contain fixed route, phase, child PID, elapsed milliseconds and result code, not command bodies or secrets. The common engine emits `start`, `finish` and `timeout`; runtime adapters attach the category above. Use these timings to distinguish a queued read, worker startup and a failed response from execution or heartbeat health.

Relevant regression groups:

- `test/console-v5/console-read-process.test.ts`, `console-read-worker.test.ts`, `console-read-lanes.test.ts`, `isolated-read-routing.test.ts`: lifecycle, readonly access, analysis/interaction isolation and mixed-version routing.
- `src/console-workbench/task-state-index.test.ts`, `task-aggregation.test.ts`, `overview-sources.test.ts`: state/full classification parity, one-snapshot reads, progress observations, omitted historical JSON and unavailable measurements.
- `src/console-workbench/task-read-scope.test.ts`, `test/console-v5/feed-consistency.test.ts`, `readonly-project-sessions.test.ts`: bounded Task/member/project candidates, authority and missing-member coverage, page-local summaries, and phase pagination beyond the feed cache capacity.
- `test/console-v5/detail-read-budget.test.ts`, `detail-retention.test.ts`: real pending/failed detail reads, complete Task headers, selected-page retention and unknown empty pages.
- `test/federation/console-cancellation.test.ts`, `console-request-retry.test.ts`: real RPC/HTTP read cancellation, recovery on the same connection, and accepted POST persistence.
- `test/console-v5/readonly-*.test.ts`, `console-read-detail.test.ts`: details, saved artifacts, audit and project sessions.
- `test/session-card/status-read.test.ts`, `projection-read.test.ts`: native SQLite stalls, parent responsiveness, cancellation, scope and publication races.
- `src/session/session-store.test.ts`, `finalization-budget.test.ts`: saved snapshots, remote members and bounded finalization.
- `test/console-v5/experience.browser.spec.ts`: real browser partial-state retention, supplement/retry and narrow-window interactions.

Run the repository's pinned Node/pnpm typecheck and build before these compiled-worker checks. Use real temporary databases, files, child processes and local connections. The containment boundary limits damage from slow reads; it does not establish the cause of every historical freeze.

The 2026-11-01 local regression run used Node 24.22.1 and temporary data. These observations describe the fixtures, not deployed-node performance or an upgrade acceptance result:

| Fixture | Observed result |
| --- | --- |
| 99.4 MiB SQLite, 3,072 historical JSON payloads | Full index 104.3 ms; state read 51.3 ms in one run. Invalid unused history/checkpoint JSON did not break the state read; database bytes stayed unchanged. |
| Compiled readonly worker, four routes | First round 474 ms; reused worker 14 ms. The targeted seven-file suite passed all 43 checks. |
| Real 181-phase Task through SQLite and loopback HTTP | Ten content pages crossed the 160-entry cache boundary. Returning to the first page reread its 20 phase bodies rather than accumulating all historical details. |

State reads still classify the relevant saved phase rows; removing large JSON reconstruction does not make history size irrelevant. Phase pagination bounds full detail bodies, not the complete Task reference list. These checks do not measure production network latency, prove a running desktop has switched releases, or authorize restarting a node with active work.
