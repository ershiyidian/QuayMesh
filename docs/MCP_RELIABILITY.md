# MCP reliability recovery contracts and experiments

[English](MCP_RELIABILITY.md) · [简体中文](zh-CN/MCP_RELIABILITY.md) · [Home](../README.md)

This engineering record covers the reliability changes investigated on 2026-10-19.
It combines source review with disposable SQLite databases, child processes, MCP handlers, and local HTTP connections.
See [Execution lifecycle](RELIABILITY.md) and [Architecture](ARCHITECTURE.md) for the wider system model.

## Scope and evidence

The source baseline was `d452b51`. The experiments used Node.js 24.21.0, MCP server/Node adapter packages 2.0.0, and the official MCP client SDK 1.29.0.
The repository's supported development setup also pins pnpm 11.25.0; see [Contributing](../CONTRIBUTING.md).
Measurements below describe individual local experiments. They are not hosted-client latency targets.

A request crosses several independently observable boundaries: MCP ingress, admission, durable operation recording,
worker execution, response transmission, and the host's consumption of that response.
QuayMesh records server-side completion and keeps `hostAcknowledgment: "unknown"` when there is no host receipt.
Host messages such as “Thinking failed” or “message delivery time out” do not identify which boundary failed.

### Validation snapshot

| Experiment | Observed result | Scope / remaining check |
| --- | --- | --- |
| Silent SSE before priming | First body byte at **5008.478 ms**, containing the SDK keepalive | Real Node HTTP; SDK keepalive interval was 5000 ms |
| Primed SSE, direct connection | First byte at **10.862 ms** | Real Node HTTP; gated tool had not completed |
| Primed SSE, streaming proxy | First byte at **3.690 ms** | Real forwarding proxy on loopback |
| Independent calls and observer disconnect | Passed | Twelve fast calls alongside a gated call; another call after observer disconnect |
| Paused 8 MiB response | Cancellation arrived once; the first test checked reader unlocking too early | Test now awaits actual Node handler cleanup; **final TCP rerun pending** |
| First combined HTTP matrix | **9/11** passed | Cleanup observation and SDK text-only error assertions corrected; integrated rerun pending |
| Agent polling under a real SQLite lock | Old process exited with code 1; fixed process survived and completed the original operation | Same PID, durable result, retry and tracker restoration; event counts checked |
| Synchronous SQLite contention | Append took **5007.875 ms**; a 10 ms timer fired after **5009.010 ms** | Default `busy_timeout=5000`; extra timer delay **4999.010 ms** |
| Periodic ledger reconciliation under a real lock | Passed, **1/1** | Real error code, same process, original operation converged after lock release |
| Idle task liveness | Passed over real HTTP | Stalled presentation stops timing; the next call reuses the original task/run |
| Output schema and handler contracts | Passed, **10/10** handler tests | Official JSON Schema validator; valid success, typed error, and recursive success cases |
| Official SDK discovery and file-error recovery | Passed, **1/1** | Normal `Client.listTools()` and `Client.callTool()` through the transport's official fetch interface and actual handler; real ENOENT then a successful file read; no TCP listener |
| Admission retry, local suite | Passed, **7/7** | Includes two real processes competing for one operation key |
| Admission retry, two-node HTTP | Passed, **2/2**, about **941 ms** and **379 ms** | Admission worktree, raw SDK requests; final integrated standard `callTool` matrix pending |
| Integrated local regression suite | Passed, **80/80**, **30.42 s** | Session, migration, execution coordinator, and real periodic-reconciler subprocess tests |
| Old v5 database-opening code against v6 | Rejected as an unsupported database version | Real temporary database; mixed-version coordinator/worker operation remains untested |

Integrated type checking, the full build, and source checks passed. The final standard SDK/TCP and Node lifecycle matrices remain separate pending gates.
The execution environment's automatic permission review repeatedly reached capacity or its deadline before starting those commands. The pending gates require a completed permission review; their outcome is not recorded as a test failure or a pass.

## Failure chains and repair contracts

### 1. A background write failure must not terminate Core

The original agent timer retained `poll(...).finally(...)` without observing rejection.
Polling awaited `agentEvent()`, whose event append could fail with `SQLITE_BUSY`.
The resulting unhandled rejection could terminate the process and break otherwise unrelated MCP requests.

WAL and a 5000 ms busy timeout were already configured.
The old event transaction read task/revision state before its first write, using a deferred transaction.
Another writer could invalidate the read snapshot before the transaction tried to upgrade to a writer.
Increasing the busy timeout alone does not repair that transaction ordering or the missing rejection boundary.

The [agent tracker](../src/session/agent-operations.ts) now observes both success and failure, retains the durable identity,
and retries observation/finalization with capped backoff. It does not relaunch provider work.
Shutdown cancels scheduled polls and waits for pending ones; a failing diagnostic callback cannot escape the timer boundary.
The [event store](../src/session/store.ts) acquires the writer reservation with `transaction.immediate()` before reading revisions.

The observation's source ID is stable for the operation and observed agent state.
This also covers a transaction that committed before a change listener failed: retrying or restoring the tracker does not append the same event twice.
An unavailable agent record remains an explicit unknown result; it is not translated into a successful completion.

The tests exercise both lock-before-write and failure-after-commit paths with real SQLite connections.
They verify one `agent_changed` event, one terminal operation event, retained provider output, and restoration from persistent identity.
The fast tracker fixture shortens its own busy timeout; the separate default-timeout experiment measures the remaining five-second stall.

### 2. Periodic reconciliation needs its own exception boundary

[WorkRunReconciler](../src/work-run-reconciler.ts) executes synchronous database work from an interval callback.
The periodic callback now catches failures, reports them, and leaves the ledger available for the next cycle.
Its diagnostic callback is independently guarded. Startup recovery remains a distinct, stricter path.
Periodic reconciliation does not repeat startup sweeps that could interrupt work owned by the current process.

[Server wiring](../src/server.ts) sends `work_run_reconcile_failed` through `ServerDiagnostics` when available,
including bounded error identity and stack locations in the persistent diagnostic log.
The subprocess test receives the real SQLite error through the same callback and IPC.
This avoids depending on an execution environment that discarded asynchronous child stderr despite successful write callbacks.

### 3. Establish SSE transport promptly without inventing progress

The Node adapter can have a response ready while its headers remain buffered until a body chunk is written.
For a silent operation, the previous first chunk was the SDK's periodic keepalive, approximately five seconds later.

[SSE priming](../src/mcp-sse-response.ts) inserts the legal comment `: connected\n\n` at the start of an SSE body.
The SDK Node adapter remains the sole response writer. The wrapper uses one reader and pull-driven forwarding with `highWaterMark: 0`.
It preserves status and response headers, removes the obsolete content length, and forwards cancellation and source failures.
It creates no progress notification, success receipt, or additional heartbeat timer.

The priming comment says only that this response stream has been established.
It does not acknowledge durable admission, tool completion, or receipt by the host.
A synchronously blocked event loop cannot create or transmit that first chunk; SQLite isolation remains separate work.

The slow-consumer experiment exposed a test observation race: entering `source.cancel()` preceded the wrapper's `finally` cleanup.
The corrected test waits for the real Node handler to finish before asserting that the source reader is unlocked.
It retains the checks for limited upstream consumption, independent calls, exactly one cancellation, and no adapter errors.

### 4. Error results must survive discovery and output validation

[The modern adapter](../src/mcp-modern-server.ts) publishes an output schema admitting the success shape and the typed error envelope.
Zod generates the union and its recursive references; a success object's child cannot become an error envelope merely because the root permits one.
The original runtime success validator remains unchanged.
The SDK's `isError` branch handles genuine errors; an error-shaped object with missing or false `isError` still fails success validation.

QuayMesh's typed envelope carries `error_code`, `effect`, `retry_hint`, and optional operation/owner identifiers and details.
Readable `content` and `isError: true` remain present. SDK protocol or validation errors can have text without `structuredContent`.
The [official-client regression](../src/mcp-sdk-error-contract.test.ts) calls `listTools()` to cache the SDK's actual output validators, then uses normal `callTool()`.
A real `readFile` ENOENT retains `isError: true` and its `ENOENT` / `not_started` / `fix_input` envelope; creating the file then produces a valid strict success result.
The transport's documented fetch interface passes actual Request/Response objects through the real handler without a TCP listener.
The separate TCP file-error test covers SDK text-only errors. Its corrected assertions and the integrated two-node standard-client admission matrix still require their final network rerun.

[Ingress diagnostics](../src/mcp-request-diagnostics.ts) now inspect the canonical structured error fields before legacy text fallbacks.
HTTP completion, JSON-RPC errors, tool errors, and uninspected responses retain separate outcomes.
Diagnostics record allowlisted classifications, byte counts, and fingerprints; they do not copy tool arguments or output bodies into error records.

### 5. Retry a proven admission refusal under the original operation

An operation key must preserve the identity of accepted work while allowing a temporary refusal to be reconsidered.
The [admission predicate](../src/session/outcome.ts) requires a stored `failed` result with `effect: not_started`,
`retry_hint: retry_later`, and either `EXECUTION_CONFLICT` or `NODE_ADMISSION_PAUSED`.
Unknown, partially executed, cancelled, completed, and permanent failures do not start another attempt.

A new transport request can create the next eligible attempt under the same operation ID and original active task.
Owner, session, member, task, operation key, and arguments remain bound to the original scope.
Replaying the original transport request returns its original attempt and immutable receipt.
A new task or session cannot inherit the old operation merely by supplying the same key.

The [store](../src/session/store.ts) changes the operation-key pointer transactionally and records `retry_of_invocation_id`.
An immediate transaction, a compare-and-swap update, and a unique retry-successor index select one winner under contention.
Old invocation updates and late finalizers are fenced; ledger reopening belongs to the new attempt's request identity.
Coordinator forwarding retains the operation ID even if worker admission rejected before creating any worker invocation.

Review of this new attempt model found two additional reader omissions: agent restoration could see an old terminal attempt,
and recovery details could stop at an old finished event. Both now select the current attempt consistently with activity/projection code.
These were findings from reviewing the new change, not evidence of those multi-attempt defects in the deployed baseline.
Historical attempts and events remain available as evidence rather than being deleted to make the current view look correct.

### 6. Idle liveness is a read model, not an invented terminal state

An expired run lease without active background work does not mean the user's task completed or was cancelled.
After the existing silence threshold, the [task view](../src/task-view.ts) and console classification expose a stalled state and stop its clock.
Read-only inspection must not renew the lease, acquire an execution claim, or rewrite the stored run.
The HTTP regression verifies repeated inspection, zero active-task accounting, and reuse of the same task/run on the next command.
Active children and unresolved outcomes keep their existing protection and reconciliation rules.

## Reproduce the checks

Use the pinned runtime and an isolated checkout. The fixtures create temporary state and close their databases, processes, and sockets.
Network tests require permission to bind loopback ports. A sandbox refusal is an unexecuted test, not a passing result.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
```

Integrated local regression suite and handler contracts:

```sh
pnpm exec node --import tsx --test --test-isolation=none --test-concurrency=1 \
  src/session/*.test.ts src/db/migrations.test.ts src/execution-coordinator.test.ts \
  test/reliability-background.test.ts
pnpm exec node --import tsx --test --test-isolation=none \
  src/mcp-modern-server.test.ts src/mcp-sdk-error-contract.test.ts
```

Real transport, task liveness, and two-node contracts:

```sh
pnpm exec node --import tsx --test --test-isolation=none --test-concurrency=1 \
  src/mcp-sse-response.test.ts src/mcp-request-diagnostics.test.ts \
  test/reliability-liveness.test.ts \
  test/tool-contract/error-receipt.test.ts test/tool-contract/admission-retry.test.ts
pnpm test:node
```

For a focused slow-consumer rerun, add `--test-name-pattern='^a paused real HTTP'` and select only `src/mcp-sse-response.test.ts`.
Record runtime version, commit, command, transport mode, and actual pass/fail counts with the retained test output.
Keep individual first-byte measurements separate from percentile measurements over repeated workloads.

The standalone [SQLite event-loop measurement](../test/reliability-system/sqlite-event-loop.ts) uses a separate connection holding a real writer lock:

```sh
pnpm exec node --import tsx test/reliability-system/sqlite-event-loop.ts
```

Its recorded run used SQLite 3.53.1 and left one event after releasing the lock and retrying.
It reports timings without a machine-dependent pass threshold and removes its temporary database in `finally`.

## Database upgrade and release boundaries

[Schema v6](../src/db/invocation-attempt-schema.ts) adds task identity and attempt linkage while retaining historical receipts.
Migration fills task identity only from existing run links with matching scope. Insufficient historical evidence remains unresolved.
Opening a database runs the [version check and migrations](../src/db/migrations.ts).
The actual old v5 migration-code probe rejected a v6 database with “不支持的 QuayMesh 数据库版本：6”.

All processes sharing one state directory must switch coherently; additive columns do not make an older binary accept a newer schema version.
For separate coordinator and worker databases, upgrading workers before the coordinator is the rollout order suggested by the source contracts.
Mixed-version coordinator/worker behavior still requires its own matrix; the passing two-node tests used matching implementations.

The following mixed-version outcomes are **source-based expectations, not completed network experiments**:

| Combination | Expected limitation |
| --- | --- |
| Old coordinator, new worker | The coordinator can replay its cached refusal without creating a new attempt |
| New coordinator, old worker | The worker can replay its old refusal; if no earlier worker invocation exists, its old ID derivation can disagree with the coordinator |

There is no new retry-feature negotiation gate. Pause admission and drain work before switching each node's shared-state components.
Already-open old database connections do not automatically stop at migration; stop those processes before the switch.
After every hop is upgraded, run a same-key retry canary before reopening general admission.

Take a consistent pre-upgrade backup and retain the corresponding release/configuration as one recovery set.
Restoring an earlier ledger does not undo file changes or external effects produced after that backup.
Once new work has run, prefer a forward fix that preserves its evidence; any database restore needs explicit reconciliation of those effects.
An unknown outcome, missing task identity, or incomplete legacy error receipt is not sufficient evidence to unlock automatic retry.

## Next design stages

### Stage 1: finish integrated acceptance

Run the final standard SDK matrix after discovery, including typed business errors, normal reads, and admission retries.
Repeat the corrected paused-consumer test and retain the real transport-cleanup observation.
Add a separate mixed-version release matrix covering every process that opens shared state and both coordinator/worker directions.
Use the existing fault fixtures as release gates, with the original operation ID and single external effect as core assertions.

### Stage 2: remove synchronous SQLite stalls from request handling

Move contended database work behind a bounded worker-thread or process interface with connections owned by that execution context.
Coordinate all writers, including background agent bookkeeping; moving only one caller leaves other blocking paths intact.
Keep transactions short, make queue saturation observable, and include admission waiting in the request's deadline budget.
An in-memory queue entry must not be reported as durable acceptance before its operation identity is committed.

Measure held-writer, large-query, event serialization, checkpoint, and snapshot workloads independently.
During a five-second held writer, verify that transport heartbeats and independent read-only receipt requests remain responsive.
After release, verify original IDs, one side effect, bounded queue growth, and graceful shutdown.
Use bounded diagnostic APIs and explicit file scopes for investigation; generic shell commands retain their real resource claims.

### Stage 3: make long hosted turns recoverable

Treat the host wait, HTTP response, operation execution, and output retention as separate budgets.
Return a durable operation reference promptly, keep observation calls bounded, and resume output by cursor.
Propagate the remaining deadline across hops; record admission, preparation, execution, and response timing separately.
Losing an observer should release its stream; cancelling execution remains an explicit operation-level action.

Persist checkpoints containing current operation references, output cursors, decisions, and the next safe action.
Recovery should query the original operation/key before proposing another side effect.
Keep error schemas discoverable and responses bounded; retain large immutable output behind references instead of repeating it in every poll.
Report real tool activity and known execution state. Transport comments and card refreshes must not manufacture work progress or host acknowledgment.

