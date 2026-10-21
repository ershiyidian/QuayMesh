# MCP reliability recovery contracts and experiments

[English](MCP_RELIABILITY.md) · [简体中文](zh-CN/MCP_RELIABILITY.md) · [Home](../README.md)

This engineering record covers the reliability changes investigated on 2026-10-19–20.
It combines source review with disposable SQLite databases, child processes, MCP handlers, and local HTTP connections.
See [Execution lifecycle](RELIABILITY.md) and [Architecture](ARCHITECTURE.md) for the wider system model.

## Scope and evidence

The source baseline was `d452b51`. The experiments used Node.js 24.21.0, MCP server/Node adapter packages 2.0.0, and the official MCP client SDK 1.29.0.
The repository's supported development setup also pins pnpm 11.25.0; see [Contributing](../CONTRIBUTING.md).
Measurements below describe individual local experiments. They are not hosted-client latency targets.

A request crosses several independently observable boundaries: host authorization/review and dispatch, MCP ingress, admission, durable operation recording,
worker execution, response transmission, and the host's consumption of that response.
QuayMesh records server-side completion and keeps `hostAcknowledgment: "unknown"` when there is no host receipt.
Host messages such as “Thinking failed” or “message delivery time out” do not identify which boundary failed.

### Initial validation snapshot

This table retains the earlier experiments. The Windows matrices below record the later integrated run, its cleanup failures, and the successful rerun.

| Experiment | Observed result | Scope / remaining check |
| --- | --- | --- |
| Silent SSE before priming | First body byte at **5008.478 ms**, containing the SDK keepalive | Real Node HTTP; SDK keepalive interval was 5000 ms |
| Primed SSE, direct connection | First byte at **10.862 ms** | Real Node HTTP; gated tool had not completed |
| Primed SSE, streaming proxy | First byte at **3.690 ms** | Real forwarding proxy on loopback |
| Independent calls and observer disconnect | Passed | Twelve fast calls alongside a gated call; another call after observer disconnect |
| Paused 8 MiB response | Cancellation arrived once; the first test checked reader unlocking too early | Corrected cleanup observation passed in the Windows SSE suite below |
| First combined HTTP matrix | **9/11** passed | Cleanup observation and SDK text-only error assertions corrected; later Windows results recorded below |
| Agent polling under a real SQLite lock | Old process exited with code 1; fixed process survived and completed the original operation | Same PID, durable result, retry and tracker restoration; event counts checked |
| Synchronous SQLite contention | Append took **5007.875 ms**; a 10 ms timer fired after **5009.010 ms** | Default `busy_timeout=5000`; extra timer delay **4999.010 ms** |
| Periodic ledger reconciliation under a real lock | Passed, **1/1** | Real error code, same process, original operation converged after lock release |
| Idle task liveness | Passed over real HTTP | Stalled presentation stops timing; the next call reuses the original task/run |
| Output schema and handler contracts | Passed, **10/10** handler tests | Official JSON Schema validator; valid success, typed error, and recursive success cases |
| Official SDK discovery and file-error recovery | Passed, **1/1** | Normal `Client.listTools()` and `Client.callTool()` through the transport's official fetch interface and actual handler; real ENOENT then a successful file read; no TCP listener |
| Admission retry, local suite | Passed, **7/7** | Includes two real processes competing for one operation key |
| Admission retry, two-node HTTP | Passed, **2/2**, about **941 ms** and **379 ms** | Admission worktree, raw SDK requests; integrated Windows cleanup and rerun recorded below |
| Integrated local regression suite | Passed, **80/80**, **30.42 s** | Session, migration, execution coordinator, and real periodic-reconciler subprocess tests |
| Old v5 database-opening code against v6 | Rejected as an unsupported database version | Real temporary database; mixed-version coordinator/worker operation remains untested |

Earlier integrated type checking, the full build, and source checks passed.
Attempts to launch the remaining local TCP and Node matrices repeatedly ended during automatic permission review because of capacity or a review deadline. Those particular commands remained unexecuted.
The subsequent Windows run supplies the additional evidence below.

### Windows validation at `5964a6a`

The Windows run used the pinned Node.js 24.21.0 runtime and real TCP connections. Counts and measurements describe this checkout and run.

| Check | Observed result | Scope / remaining check |
| --- | --- | --- |
| TypeScript type checking | Passed | `tsc` completed on Windows |
| SSE suite | **6/6 passed** | Direct first byte **65.0885 ms**; streaming-proxy first byte **7.3658 ms**; paused 8 MiB consumer and cancellation checks passed |
| Combined `mcp-http` group | Three tests failed during database cleanup; the group process remained alive at the **240 s** runner limit | SQLite handles were still open during directory removal; corrected cleanup passed in `run-02` below |
| `session-sqlite` | **92 tests: 90 passed, 2 failed** | Both failures used the same database cleanup ordering; corrected cases passed in `run-02` |
| `recovery-federation` | **43/43 passed** | Real recovery and federation fixtures |
| Node lifecycle | **49/49 passed** | Real Node test entries |

The SSE timings are individual observations. A hosted-client timeout threshold has not been established by these measurements.
The Windows failures exposed test resource ownership: a fixture registered its directory-removing `after` hook before a test registered closure of an additional SQLite connection or WorkLedger.
The observed FIFO hook order reached directory removal with that handle still open; `EBUSY` then interrupted later cleanup and left listeners alive.
Commit `e35fcfb` moves the owned-handle cleanup into the test body's `finally`, before fixture disposal, across five tests in
[admission retry](../src/session/admission-retry.test.ts), [session store](../src/session/session-store.test.ts),
[task liveness](../test/reliability-liveness.test.ts), and [two-node admission](../test/tool-contract/admission-retry.test.ts).
The recorded failures remain part of the investigation history. The successful rerun below verifies normal process exit after the fix.

### Windows acceptance after cleanup

| Required evidence | Current record |
| --- | --- |
| Tested commit and working-tree state | Windows `run-02` started at **2026-10-19 09:38 UTC** from clean `52e8586`, containing cleanup `e35fcfb`, review/environment changes `a9ee137`, and the Windows runner |
| Runtime and completion | Node.js **24.21.0**; the three selected groups completed successfully |
| `mcp-http` | **36/36 passed**, **27.836 s**; normal exit |
| `session-sqlite` | **92/92 passed**, **72.513 s**; normal exit |
| `environment-review` | **6/6 passed**, **11.544 s**; two inspection/annotation cases and four Python workflow cases |
| Retained artifacts | [Sanitized acceptance receipt](../test/reliability-system/evidence/windows-20261019-20.json), with per-run commits, official counts, completion state, and SHA-256 of the original summaries; raw TAP and JSON events remain in the test environment |

`run-02` selected `mcp-http`, `session-sqlite`, and `environment-review`.
The earlier `43/43` recovery/federation and `49/49` Node results remain attached to `5964a6a`.
Together the two runs cover **226 distinct passing tests**, with each group's tested commit retained above.
The Windows runner and invocation are documented under [Reproduce the checks](#reproduce-the-checks).

### Restoration regression and follow-up

Windows `run-03` used clean `6df1348` on 2026-10-20 after successful type checking and a full build.
`recovery-federation` passed **43/43** in **98.777 s**, and `environment-review` passed **6/6** in **12.931 s**.
`workspace-restore` completed normally with **21 passed, one failed, and five platform skips** in **27.559 s**.
The real two-node HTTP failure occurred while reading saved command output after pruning: `SessionStore.requireCommand` still resolved the deleted directory.
Commit `27f9a25` validates the persisted canonical root identity instead. Historical reads retain owner, node, root, and operation checks; live input/cancellation still validate the current workspace before using its canonical root.
Its two real SQLite/SDK regressions passed locally, including a valid alias and rejection after the alias is retargeted. The Windows follow-up below reruns the original HTTP failure.

Review also reproduced a closed coordinator task being mirrored as active when the worker first saw it during restoration.
Commit `f0bfac9` rejects a closed task at the coordinator's `attach_workspace` forwarding boundary, after owner/session checks and before creating the worker mirror.
The two-database production-method probe first reproduced the defect and then verified refusal plus successful forwarding of a new active task.
The same scenario is included in the two-node HTTP restoration regression.

### Final affected-group Windows acceptance

`run-04` tested clean **`e3d5b5ae26797a8a64c5aee3b9b686d613120008`**, from **2026-10-20 06:31:19 UTC** to **06:35:24 UTC**, with Node.js **24.21.0**.
Type checking and the full build both completed successfully before the runner started.

| Group | Official result | Duration |
| --- | --- | --- |
| `mcp-http` | **37/37 passed** | **31.245 s** |
| `session-sqlite` | **94/94 passed** | **76.379 s** |
| `recovery-federation` | **43/43 passed** | **98.951 s** |
| `diagnostics` | **7/7 passed** | **9.854 s** |
| `workspace-restore` | **22 passed, five platform skips**, no failures | **28.425 s** |

All five groups exited normally with code 0, without timeout, cancellation, or incomplete cleanup: **203 passed and five skipped**.
The five existing Windows skips concern symlinks and passed in the earlier Linux workspace/git-worktree runs.
The real two-node restoration case passed after the historical-root fix, including the closed-task first-mirror refusal.
The diagnostic HTTP case observed authenticated ingress during an unfinished output read, then its completion; invalid identity and target-resource requests had no authenticated event.
The final SSE run measured **60.307 ms** directly and **8.235 ms** through the local streaming proxy; the paused 8 MiB case consumed 9 of 128 source chunks before cancellation and observed one cancellation.
These remain individual local measurements. The [acceptance receipt](../test/reliability-system/evidence/windows-20261019-20.json) retains all four runs and original summary hashes, including the failed runs.
The earlier Node **49/49** and environment **6/6** results retain their own commits above; they are separate evidence from this final affected-group matrix.

## Automatic permission review and requests that never reach QuayMesh

### Direct evidence and authorization

The local execution attempts in this investigation returned these reviewer errors before process creation:

```text
Automatic approval review failed: Selected model is at capacity. Please try a different model.
The automatic permission approval review did not finish before its deadline.
```

The tool error also reported that the action had not executed. Existing user authorization continued to cover the same action and scope.
Sandbox capability, the approval decision, and reviewer availability remain separate execution conditions.
[OpenAI's security documentation](https://learn.chatgpt.com/docs/agent-approvals-security) describes the extra model calls and the separate timeout outcome; an unavailable review can prevent execution without producing a completed risk decision.
The public [Guardian policy template](https://github.com/openai/codex/blob/main/codex-rs/prompts/templates/guardian/policy_template.md), reviewed on 2026-10-19, treats an explicitly requested action or a necessary implementation of that request as high authorization and evaluates its material semantics.
Repeating user consent alone supplies no evidence that reviewer capacity has recovered.

### Public mechanism and deployment limits

[OpenAI Auto-review](https://learn.chatgpt.com/docs/sandboxing/auto-review) describes a separate reviewer receiving the exact proposed action and a compact transcript of user messages, visible assistant updates, and relevant tool evidence.
The inputs exclude the main model's private chain of thought.
Documented entry points include escalated shell execution, blocked network access, writes outside configured roots, and MCP/app calls whose annotations or approval mode require review.
This creates a possible failure boundary before a process starts or an MCP request is dispatched.

The public [`ReviewModel` selection](https://github.com/openai/codex/blob/main/codex-rs/core/src/guardian/review.rs) and
[`review_session.rs`](https://github.com/openai/codex/blob/main/codex-rs/core/src/guardian/review_session.rs), reviewed on 2026-10-19, show a separate reviewer model/session and deadlines covering review preparation and waiting.
The main conversation can remain available while that dependency fails. The deployed reviewer model, capacity pool, and deadline for this session remain unconfirmed.
The fixed public version [`rust-v0.163.0-alpha.10.2`](https://github.com/openai/codex/blob/rust-v0.163.0-alpha.10.2/codex-rs/ext/guardian-reviewer/src/lib.rs) defines a 90-second review budget and at most three attempts;
its [`retry.rs`](https://github.com/openai/codex/blob/rust-v0.163.0-alpha.10.2/codex-rs/ext/guardian-reviewer/src/retry.rs) shares the original deadline across eligible transient retries. Those constants describe that version only. The retries concern review computation before execution.

[openai/codex issue #45395](https://github.com/openai/codex/issues/45395), opened on 2026-09-14, contains the same capacity message.
An October 5 user comment reports an authorized MCP action failing before delivery. This is a comparable user report in OpenAI's public repository; it supplies neither a confirmed root cause for this incident nor proof of a shared deployed service.
Official documentation establishes that the review framework can cover shell and MCP/app actions. The current local exec and browser-hosted MCP deployment relationship remains unverified.

A separate historical trace review, E13, observed three subagent calls waiting **840–1417 seconds** with no corresponding Cloud ingress in the inspected logs, while a contemporaneous main-session read completed in **179 ms**.
That evidence localizes a path-specific stall before the observed ingress. Reviewer availability is a plausible candidate for those earlier calls; their records contain no matching explicit reviewer error.
The current capacity/deadline errors establish review failure for their own local execution attempts.

### Observability across the missing-ingress boundary

Existing [server diagnostics](../src/server-diagnostics.ts) emit `server_request_started` at the HTTP boundary when request logging is enabled.
[MCP diagnostics](../src/mcp-request-diagnostics.ts) emit `mcp_exchange_started` at the MCP diagnostic boundary and retain request identity, argument fingerprints, HTTP/RPC/tool outcomes, first-byte timing, aborted state, and an unknown host acknowledgment on completion.
QuayMesh can directly measure only requests that reach one of its observable entry points.
Commit `1ee6931` adds `mcp_exchange_authenticated` after the Bearer identity and target-resource checks. This event records those two HTTP checks; tool authorization, admission, and execution have their own evidence.
The task-scoped [`read_diagnostics` projection](../src/read-diagnostics.ts) includes attributable authenticated and finished transport records, filtered by owner, time window, and task/operation identity. Unauthenticated start events stay outside this projection.
`coverage.task_transport` reports the two observed record counts and `completion: "not_inferred"`; their difference is never presented as a count of running operations.
`history_completeness` and `host_acknowledgment` remain `unknown`. Calls without safe task/operation association can be absent from the result.
The 32 MiB scan budget applies to the actual file stream, including a single oversized line. Response budgets, pagination, and the diagnostic field allowlist remain in force.
Inspect coverage and relevant ingress records before interpreting an empty result. Host-side review/dispatch correlation still requires evidence supplied by the host.

| Evidence | Attribution supported by that evidence | Additional observation needed |
| --- | --- | --- |
| Reviewer error explicitly reports no execution | That attempt stopped before execution | Host submission/review timestamps and dispatch status |
| Reverse-proxy or MCP ingress exists, with no durable invocation | Request arrived; failure can precede invocation recording | Authentication, routing, admission and database events |
| Durable operation exists and forwarding reports `REQUEST_TIMEOUT` | The request entered the backend path | Per-hop waiting, preparation, execution and response timestamps |
| Backend completion and response transmission exist | Server-side work and transmission are known | Host receipt or consumption evidence |
| No QuayMesh record and no host/edge trace | Delivery remains unknown | Upstream evidence or confirmation that the relevant logs cover the interval |

Correlate UTC submission/review events, host and edge request IDs, bounded parameter fingerprints, process-start evidence, and durable operation IDs.
Keep `review_state`, `execution_started`, and `hostAcknowledgment` separate; proposed host-side fields require actual host evidence.
Missing invocation rows alone cannot establish that a request never arrived. An already-recorded backend timeout continues to require backend investigation.
“Thinking failed” and “message delivery time out” remain symptoms spanning several boundaries.

### Mitigation and current work

Publish tool annotations that describe actual execution, observation, network and interruption capabilities, and keep environment inspection observational.
Installation, repair, or runtime acquisition uses an explicit mutating entry point covered by the task's authorization.
**Commit `a9ee137` implements the capability-annotation and Python discovery corrections; Windows `environment-review` passed 6/6 at `52e8586`.**
The [subagent surface](../src/tool-surfaces/subagents.ts) declares provider execution's network capability.
The [workspace environment](../src/workspace-environment.ts) discovers existing interpreter candidates through files and PATH, returns `verification: "not_run"`, and leaves interpreter/startup-code execution to an explicit execution entry point.

Commit `6df1348` makes [`getWorkspace`](../src/workspaces.ts) observational: a pruned managed worktree produces `WORKSPACE_RESTORE_REQUIRED`, with `effect: not_started` and the original workspace handle.
Restoration is explicit through `attach_workspace({workspace_id: originalHandle})` in the authorized session and active task. It preserves workspace/member identity and the saved staged/unstaged changes, and coalesces concurrent restoration.
The actual Git checkout-hook regression verifies that reads do not recreate the tree or run its hook; explicit restoration does, and repeated attachment of an active tree does not run it again.
Historical status and output remain readable before restoration. The follow-up above records the additional historical-root and closed-task defects found by exercising this workflow.
The Python tests cover interpreter discovery, while the workspace regressions cover this managed-worktree restoration path; other observational paths retain their existing capability contracts.

Use bounded diagnostics and explicit file scope through an existing authorized execution path.
When the reviewer explicitly reports no execution, use a bounded delayed retry and retain the original intent/key where supported.
When execution is uncertain, query the original operation before another side effect. Preserve the original review error and attempt timestamps during recovery.
Switching to an already authorized environment can supply a working execution path; the destination's own review and sandbox conditions still apply.
Accurate annotations expose the real capabilities to review, including cases that warrant additional review. Bounded observational checks and retries limit redundant calls while retaining the applicable approval policy.
Service capacity remains a host-side availability dependency, and these measures provide no guarantee about its recovery time.

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
Commit `e3d5b5a` adds a compact recovery suffix to canonical error text for consumers that only expose `content`.
It includes bounded safe-format code, effect, retry hint, and an explicitly supplied operation ID. It does not copy raw details or infer a missing ID from a message.
Repeated canonical wrapping replaces the earlier suffix, keeping the text stable. Structured errors and success validation retain their original semantics.
The SDK regression uses a static fixture operation ID to validate this contract; its actual file-read failure and subsequent successful read do not claim an executed command receipt.
The [official-client regression](../src/mcp-sdk-error-contract.test.ts) calls `listTools()` to cache the SDK's actual output validators, then uses normal `callTool()`.
A real `readFile` ENOENT retains `isError: true` and its `ENOENT` / `not_started` / `fix_input` envelope; creating the file then produces a valid strict success result.
The transport's documented fetch interface passes actual Request/Response objects through the real handler without a TCP listener.
The separate TCP file-error test covers SDK text-only errors. The Windows matrix above records subsequent network validation, including successful completion of the whole HTTP group after the SQLite fixture cleanup fix.

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

### Windows acceptance runner

The repository's [Windows runner](../test/reliability-system/windows-acceptance.cjs) verifies Node.js 24.21.0 and records the actual executable, commit, and working-tree state.
It runs test files in separate processes with concurrency one, a 120-second test-file budget, and a default 240-second group budget.
Counts come from the official root `test:summary` event. Each group retains TAP and JSON events, with its exit code, timeout and cleanup state in `summary.json`.
Normal completion follows the child's `close` event. Timeout/interruption handling targets the process tree created for that group and records the termination result.

From a checkout with the pinned dependencies installed, use PowerShell with generic local paths and a fresh output directory:

```powershell
$qmNode = "C:\Tools\node-v24.21.0-win-x64\node.exe"
$qmRepo = (Get-Location).Path
$qmResults = Join-Path $env:TEMP ("quaymesh-acceptance-" + [guid]::NewGuid().ToString("N"))
& $qmNode test/reliability-system/windows-acceptance.cjs $qmRepo $qmNode $qmResults --groups=mcp-http,session-sqlite,environment-review
```

For the final restoration/diagnostics follow-up, select `--groups=mcp-http,session-sqlite,recovery-federation,diagnostics,workspace-restore` and use a new output directory.

`environment-review` selects `src/tool-surfaces/subagents.test.ts` and `test/python-workflow.test.ts` with `--test-name-pattern=只读环境查询|真实 MCP 注解|^PY`: two inspection/annotation regressions and all four Python workflow cases.
Omit `--groups` to run all seven groups, including `diagnostics`, `workspace-restore`, `recovery-federation`, and `node`.
Archive the generated evidence before filling the final Windows table. A summary is accepted only when the group exits successfully, reports successful test counts, and has no timeout or incomplete cleanup.

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
The closed-task restoration guard becomes effective when the coordinator runs the updated implementation.

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

## Comparable WebGPT MCP projects

Sources below were checked on 2026-10-20. Project documentation, issue reports, and proposed changes have different evidence strength; their timing policies are not measured OpenAI limits.

| Project and primary source | Observed approach | QuayMesh decision |
| --- | --- | --- |
| DevSpace [issue #334](https://github.com/Waishnav/devspace/issues/334) and [PR #335](https://github.com/Waishnav/devspace/pull/335) | Lost responses after effects prompted operation-ID receipts, identical-request replay, and stale-file preconditions. The PR remained open; its receipts are process-local. | Preserve durable SQLite receipts and attempt fences. Recover the original command/input receipt before repeating effects. |
| WebCodex [troubleshooting](https://github.com/yyjeqhc/webcodex/blob/main/docs/TROUBLESHOOTING.md) | Explicitly addresses Thinking failed: observe the existing job after a host interruption. | Keep operation IDs, byte cursors, and saved checkpoints available independently of the current model turn. |
| WebCodex [MCP contract](https://github.com/yyjeqhc/webcodex/blob/main/docs/MCP.md) | Separates observation windows from execution; documents a client-specific error projection for `openai-mcp`. | Keep standard errors for now. A host compatibility change requires a controlled comparison on the affected host path. |
| WebCodex [Runner contract](https://github.com/yyjeqhc/webcodex/blob/main/docs/RUNNER.md) | Separates live process ownership, reconnect recovery, and persistent terminal receipts. | Report saved evidence and current process liveness separately; a replacement process cannot claim an old operation merely from its receipt. |
| Coding Tools MCP [runtime contract](https://github.com/xyTom/coding-tools-mcp/blob/main/docs/runtime-contract-v0.3.md) | Separates foreground yield from process lifetime, bounded output offsets, and explicit command cancellation. Older defaults could kill a command after its handle had been returned. | Audit each timeout by what it stops: observation, admission, execution, or retention. |
| Coding Tools MCP [issue #48](https://github.com/xyTom/coding-tools-mcp/issues/48) | Documents cancellation limitations and collisions in client-chosen JSON-RPC request IDs. | Use authorized operation identity for execution control; releasing an observation stream has its own semantics. |

A single live root MCP probe in this investigation received `isError: true` with `INVALID_ARGUMENT`, then successfully read an existing file in the same turn. Its original error text was not retained, so the failed layer is unspecified. This observation supports continuing that one call chain, with no general conclusion about every ChatGPT client path. The [evidence receipt](../test/reliability-system/evidence/windows-20261019-20.json) records that limited scope.

## Consumer recovery policy

The existing [command surface](../src/tool-surfaces/codex.ts) defaults to a 2-second initial wait, capped at 12 seconds.
[`read_output`](../src/tool-surfaces/operations.ts) defaults to no wait and caps an observation at 10 seconds; one call can read up to eight commands within a shared byte budget of at most 32 KiB.
These are foreground/observation settings. A caller should inspect the returned operation and its execution contract when deciding whether work has ended.
The existing [federation budget](../src/tool-request-budget.ts) propagates the remaining request deadline; each new hop cannot silently reset that budget.

Recovery should select an action from persisted evidence and the current authorization scope:

| Available evidence | Next action |
| --- | --- |
| Known `operation_id`, execution state uncertain | Read its saved status, then `read_output` from the saved byte cursor. Keep the original ID. |
| Original operation still owns active work | Perform independent work or one bounded observation; respect `poll_after_ms`. |
| Completed result exists | Retrieve the retained result and continue from its effects. |
| `effect=not_started`, `retry_hint=retry_later`, supported admission error | Retry the identical request/key within the original owner/session/member/active-task scope. The existing admission contract creates a new attempt for the same operation. |
| `effect=unknown`, partial effect, or interrupted transport | Reconcile the original operation before another mutation. Automatic write replay remains closed. |
| `WORKSPACE_RESTORE_REQUIRED` | Explicitly call `attach_workspace` with the original `workspace_id` in its session. Historical output can be read before restoration. |
| `TASK_NOT_ACTIVE` when restoring | Start the next authorized task in the existing session, then explicitly restore the original workspace. A closed task stays closed. |
| No safely attributable transport evidence | Inspect coverage and existing task recovery facts. Obtain upstream evidence when available; keep dispatch/review status unknown. |

Batch related file selections and output reads within the tools' existing bounds. Save a checkpoint after a meaningful decision or completed stage, including operation references, cursor positions when useful, and the next action. Commit completed code changes at reviewable boundaries. A later model turn can reconstruct the work from these records without retaining the original reasoning transcript.

The reliability goals are separate: reduce avoidable requests, preserve an accepted operation across observer loss, prevent repeated effects, and reduce the amount of work lost per interruption. Measure these goals separately. A lower server error count alone does not measure how often the host completed a user turn.

## 2026-10-20: SQLite contention and execution cleanup

This follow-up addresses a measured source of local stalls and the recovery boundaries exposed while removing it.
The database schema remains version 6. No production node was deployed by this acceptance work.

### Why a database lock affected unrelated observations

The existing synchronous SQLite connection used `busy_timeout=5000`. SQLite's [busy handler](https://www.sqlite.org/c3ref/busy_timeout.html) sleeps inside the database call until its waiting budget is exhausted. On the Node request thread, that wait also prevents timers, HTTP handling, and transport activity from progressing. [WAL permits readers alongside a writer](https://www.sqlite.org/isolation.html), but our observation paths were also acquiring persistent write leases, and opening an already-current database still entered a migration write transaction.

The new real HTTP regression was first run against `eb0adca`, with only the test and its independent lock-worker helper overlaid. A Worker held the actual database writer lock for three seconds. Historical output, diagnostics, and Console observations failed to complete while the lock was held. The failure is a baseline observation, not an estimate of ChatGPT's timeout threshold. The test's total duration includes fixture setup and cleanup and must not be reported as query latency.

The repair has three layers:

1. Opening an up-to-date database checks the schema and legacy repair requirements without taking the writer lock. Actual migrations and required repairs still acquire the lock, re-read the version, and commit atomically. Initialization failures close their connection.
2. `runSqliteWrite` attempts `BEGIN IMMEDIATE` with the connection's busy handler temporarily disabled. If admission encounters `SQLITE_BUSY`, it restores the setting and yields to a timer before another attempt. The default admission budget is five seconds; delays grow from 10 ms to at most 100 ms. The callback begins only after writer admission succeeds.
3. Historical `read_output`, `read_diagnostics`, agent list/wait, workspace status/recovery, empty stdin polls, and Console GET/HEAD no longer acquire a persistent execution lease merely to observe. Their existing handlers still enforce identity and scope. Write actions retain their execution claims.

This is cooperative lock waiting. The SQL body still runs synchronously. Large SQL scans, serialization, filesystem work, and checkpoint work need their own measurements and may still block the request thread.

### Transaction and effect boundaries

`runSqliteWrite` accepts a synchronous SQL-only callback. It rejects an existing outer transaction and async callbacks, observes an accidentally returned Promise's rejection, and restores `busy_timeout` after each synchronous attempt. Cancellation interrupts waiting; a callback that has begun runs to its synchronous conclusion.

Only a busy error from **writer admission before the callback starts** is retried. A callback error, COMMIT error, rollback error, or connection-cleanup error never causes the transaction body to run again. This matters even when an application listener throws an error with a SQLite-looking code. External commands, file writes, network requests, and post-commit listeners stay outside that retry boundary.

The invocation layer now separates invoking an operation from saving its result. A failed result save reports `INVOCATION_PERSISTENCE_FAILED`, retains the original operation ID, and marks the reported effect as unknown. It does not reinterpret a completed file modification as a fresh `not_started` execution failure or rerun the command. The durable accepted/running record remains available for reconciliation. Arbitrary results lost to a permanent storage failure are not reconstructed by an in-memory retry queue.

Review state and review events commit together before change listeners run. Creating a work run and linking it to its task/member now uses one connection and one transaction. The transaction rechecks the owner, member, active task, finalization state, and invocation attempt after any lock wait. A changed current task prevents a waiting review update from affecting the new task. Concurrent requests share a pending run creation and recheck existing linked runs under the writer lock.

Late operation events also validate their invocation attempt inside the event's write transaction. The regression keeps the newer attempt running while an old finish waits for a lock; the old finish must not append after the newer start or move task/session activity timestamps backwards.

### Process and background lifecycle

Runtime leases and command/mutation claims now have async acquisition and release paths. An action is executed once, outside the lock-admission retry. If release fails after the action ends, `releaseAsync()` reports `EXECUTION_RELEASE_PENDING` and directs recovery to the original operation. Release errors do not replace an action's original exception. Process finalization records pending cleanup and continues delivering its confirmed terminal result. A bounded, single-flight cleanup loop retries deletion of explicitly ended leases owned by that coordinator. It never steals a live claim. A claim pending release still blocks conflicting work but cannot authorize new nested writes.

The pending-release set is process-local; durable occupancy rows remain until deletion commits. Recovery after a process restart still follows the existing owner/operation reconciliation rules.

Session observation, retention, and work-run reconciliation have one maintenance job in flight per loop. Errors are observed and reported, and subsequent cycles can recover. Closing the runtime cancels maintenance lock waits and waits for their settlement before closing the connection.

The async conversion exposed a command-start race: two simultaneous calls with one operation ID could both pass the initial session check and inherit the same claim. A real process probe launched twice and appended twice. `ProcessSessionManager` now reserves the ID before its first await, removes the reservation on preparation failure, and retains the completed session's duplicate-start guard.

Shutdown waits for all owned sessions' exit and close promises, including sessions that have set `running=false` but are still releasing a claim or executing finish callbacks. Ended claims leave the manager's active set; the coordinator retains pending cleanup in memory while the occupancy row remains in SQLite. A real deferred foreign key exercises DELETE success followed by COMMIT failure, then confirms cleanup after the constraint is removed.

### Cross-node task boundaries

New forwarded work is checked before forwarding or creating its first remote task mirror. Existing accepted-work observations and saved receipt replay remain available after task closure.

Artifact copying needs a separate check because its transfer protocol can start work without the ordinary tool recorder. On a closed or finalizing task, an ingress may only perform a read-only lookup of an existing copy receipt. Owner, request key, session, task, member, and original copy parameters must match. Missing receipts reject new copies. An unavailable lookup or an older peer without this method produces an explicit lookup error; it never falls back to starting a copy.

An active copy records its task/member participation before forwarding. This ensures that a task containing only a copy still finalizes the destination's task. Destination invocation reservation carries the original task and operation IDs before `beforeOperation`. A destination that has already closed its task can reject the copy before effects; that rejected invocation must also become terminal instead of remaining `accepted` indefinitely.

The old-peer test uses an old-style RPC dispatch branch against the real current transfer machinery. It is not a complete two-release binary compatibility matrix. Old ingress nodes retain their old behavior until upgraded.

### HTTP request-body boundary

Transferring this round's test bundle through the running MCP endpoint exposed a separate HTTP 413: the base64 field alone contained 108,476 characters, and the target file was absent after rejection. Five smaller, 24,000-character-or-less fragments were accepted and their assembled bundle passed its SHA-256 check.

Source inspection found that the SDK 1.x Express helper installed `express.json()` before QuayMesh request diagnostics and authorization. The installed parser's default limit is 100 KiB, consistent with the observed rejection; [Express documents that default and the memory tradeoff of larger bodies](https://expressjs.com/en/resources/middleware/body-parser/). A specific production stack trace was not captured, so this observation does not attribute every upstream HTTP 413 to this parser.

The MCP path now has an explicit **2 MiB UTF-8 request-body limit**, including the complete JSON envelope. This is a QuayMesh limit. Existing SDK Host-header validation and OAuth/resource checks remain in use. Every MCP body is bounded, including a request with a non-JSON content type that the downstream protocol handler will reject.

Oversized input returns HTTP 413 with JSON-RPC error data `REQUEST_BODY_TOO_LARGE`, `effect: not_started`, `retry_hint: fix_input`, and `limit_bytes`. Malformed JSON returns HTTP 400 / `INVALID_JSON`. Both errors are produced before tool invocation. A separate `mcp_request_rejected` record contains a generated request ID, fixed classification, and byte counts. It contains no body, token, workspace, or claimed task identity; parsing rejection occurs before authentication and cannot be presented as an authenticated task request.

[The real HTTP tests](../test/tool-contract/request-body.test.ts) cover a patch larger than 100 KiB, same-key replay after an independent file change, oversized JSON and non-JSON bodies, invalid JSON, absent bearer credentials, Host rejection, and subsequent ping. Large changes should still use bounded requests or artifact transfer; increasing this limit does not increase an upstream host's independent budget.

### Reproducible checks and remaining scope

The regressions use real SQLite files, independent Worker-held writer locks, SQL triggers and deferred foreign keys, actual Node child processes, and the OAuth MCP SDK over TCP. They assert original IDs, exactly one file effect, event counts, responsive observation during the lock, and normal resource cleanup. Relevant sources include:

- [Lock-admission tests](../src/db/async-write.test.ts), [coordinator tests](../src/execution-coordinator.async.test.ts), and [process lifecycle tests](../src/process-sessions-contention.test.ts).
- [Receipt contention](../src/session/receipt-contention.test.ts), [run/review atomicity](../src/session/run-review-atomicity.test.ts), and [runtime maintenance](../src/session/runtime-contention.test.ts).
- [Cross-node copy state](../src/federation/copy-task-state.test.ts), [HTTP writer contention](../test/tool-contract/sqlite-contention.test.ts), and [HTTP observation during process exit](../test/tool-contract/sqlite-process-exit.test.ts).

The HTTP fixtures check output, diagnostics, Console, and MCP ping while the writer is held, then verify that the original command converges and the original key does not repeat its effect. Timing measurements are individual controlled runs, not production percentiles or a measured ChatGPT failure-rate reduction.

Legacy synchronous APIs remain for other callers, including queued-agent claim transitions and thread binding. This round does not move all database work into a dedicated worker, change upstream approval/dispatch behavior, or establish the cause of every host-side `thinking failed` message. The committed evidence identifies which local paths were exercised.

## 2026-10-21: federated observations and final acceptance

This section covers the three runs in `reliability-acceptance-20261020`. The earlier `run-01` through `run-04` belong to a separate acceptance batch and retain their own dates and commits.

### Three remaining call paths repaired

**Federated long polls.** The peer RPC's ten-second attempt limit collided with a normal `read_output(wait_ms=10000)` or `wait_agent(timeout_ms=10000)` wait. Both real TCP baseline tests failed on `7725782`. Commit `82a1d02` includes a three-second reply margin around the observation window while preserving the original total request deadline. Short deadlines still expire on time, and timed-out write requests are not replayed. See the [observation-budget regression](../test/federation/observation-budget.test.ts).

**Federated read preparation.** Historical observations still acquired a write lease, synchronized titles, or created a new Task mirror at the forwarding boundary. Commit `82a1d02` separates observations from that mutation preparation. A new Cloud Task can inspect an old operation in the same Session without creating its own worker mirror; the response retains the original task and operation. Owner, Session, and Task checks remain active. Console relay, internal forwarding, and legacy entrypoints now use the same read-only admission. The [two-node writer-lock test](../test/tool-contract/federation-observation-contention.test.ts) and [Console regression](../test/console-v5/relay-contention.test.ts) also verify rejected unauthorized reads and paused mutations.

**Agent observation bookkeeping.** Agent list/wait records the provider turn and revision needed by a subsequent control action. Commit `9eb4dcf` gives the whole batch a shared 150 ms async writer-admission budget and skips writes for unchanged observations. A failed save preserves the actual agent state and returns `control_observation.status=observe_again`; no background job silently refreshes control authority. A late revision cannot overwrite a newer one. Repairing a historical interrupt observation requires an authoritative terminal agent record. The [contention regression](../src/session/agent-observation-contention.test.ts) uses real SQLite, batches of 50 agents, and control-refusal assertions with a controlled provider fixture.

### Retained failures and resolutions

On clean `7725782`, `run-01` recorded **277 passed and five skipped**. Subsequently added long-poll and federated-lock baselines failed **2/2** and **1/1**, respectively, and led to the repairs above.

On clean `ada366e`, `run-02` recorded **291 passed, one failed, and five skipped**. The sole failure was an exact agent-response assertion whose expected object omitted the added `control_observation` field. Commit `42cb9d7` adds that field and verifies the persisted provider turn and revision. It retains exact response matching. All seven tests in that file then passed.

The early `4e07cd3` probe's process-terminal-state assertion failure is also retained. The [acceptance evidence](../test/reliability-system/evidence/windows-20261020-db-contention.json) includes failed runs, baseline results, official counts, and source-log digests.

### Final Windows results on a clean commit

The final `run-03` used clean **`42cb9d78870707f0ae6d22eb2703aab68a08484d`** with Node.js **24.21.0**, running from **2026-10-21 07:08:31 to 07:13:01 UTC**. Type checking and the full build both exited with code 0 before acceptance.

| Group | Passed | Failed | Skipped | Duration |
| --- | ---: | ---: | ---: | ---: |
| `mcp-http` | 43 | 0 | 0 | 33.525 s |
| `session-sqlite` | 166 | 0 | 0 | 116.125 s |
| `recovery-federation` | 54 | 0 | 0 | 98.332 s |
| `diagnostics` | 7 | 0 | 0 | 6.029 s |
| `workspace-restore` | 22 | 0 | 5 | 15.888 s |

The total is **292 passed, zero failed, and five Windows symlink tests skipped**. Every group exited normally, with no timeout, cancellation, or incomplete cleanup. The evidence file lists every skipped test.

| Controlled scenario | Measurement from this run |
| --- | --- |
| Three-second independent writer; historical output, diagnostics, and Console | Three authenticated observations took **18.043–20.999 ms**; one command effect |
| Child exits while the writer holds its lock | Observations took **21.791–30.144 ms**; one finish event and one command effect |
| Federated historical observation during the worker's writer lock | **58.905 ms**; no observation invocation, worker commit, or new Task mirror |
| Three Console entrypoints during the writer lock | **10.136 ms**; zero commits and all three paused mutations rejected |
| Ten-second quiet output wait / agent-wait RPC | **10029.028 / 10006.525 ms**; one remote request each |
| Bookkeeping for 50 observed agents during a writer lock | List / wait took **220.034 / 279.653 ms**; zero saves while locked and explicit re-observation status; an unchanged batch performed zero writes |

These are measurements from the controlled run. Evidence records the tested commit, platform, group inputs, official counts, and source-log digests. This delivery contains source changes, regressions, and reports; it did not upgrade or restart production nodes. Production rollout and post-rollout node acceptance remain separate work.

## Next design stages

### Stage 1: preserve acceptance and add mixed-version release gates

Retain the commit-specific Windows summaries, including the passing six-test SSE suite and clean exit for the complete HTTP group.
Retain the restoration failure, its repair, and the corresponding affected-group rerun together so the regression remains reproducible.
Add a separate mixed-version release matrix covering every process that opens shared state and both coordinator/worker directions.
Use the existing fault fixtures as release gates, with the original operation ID and single external effect as core assertions.

### Stage 2: finish isolating synchronous database work

The follow-up above removes synchronous busy waiting from the covered request, receipt, claim, and maintenance paths.
Measure the remaining synchronous callers, large queries, checkpoint work, and serialization before moving them behind a bounded worker-thread or process interface with connections owned by that execution context.
Coordinate all writers, including queued-agent transitions and remaining background bookkeeping; moving only one caller leaves other blocking paths intact.
Keep transactions short, make queue saturation observable, and include admission waiting in the request's deadline budget.
An in-memory queue entry must not be reported as durable acceptance before its operation identity is committed.

Measure held-writer, large-query, event serialization, checkpoint, and snapshot workloads independently.
During a five-second held writer, verify that transport heartbeats and independent read-only receipt requests remain responsive.
After release, verify original IDs, one side effect, bounded queue growth, and graceful shutdown.
Use bounded diagnostic APIs and explicit file scopes for investigation; generic shell commands retain their real resource claims.

### Stage 3: make long hosted turns recoverable

Treat the host wait, HTTP response, operation execution, and output retention as separate budgets.
Return a durable operation reference promptly, keep observation calls bounded, and resume output by cursor.
Extend the existing cross-hop deadline contract with separate admission, preparation, execution, and response measurements.
Losing an observer should release its stream; cancelling execution remains an explicit operation-level action.

Persist checkpoints containing current operation references, output cursors, decisions, and the next safe action.
Recovery should query the original operation/key before proposing another side effect.
Keep error schemas discoverable and responses bounded; retain large immutable output behind references instead of repeating it in every poll.
Report real tool activity and known execution state. Transport comments and card refreshes must not manufacture work progress or host acknowledgment.

### Acceptance targets for the next architecture change

Measure retained-operation recovery success, duplicate external effects, acknowledged-admission latency, and event-loop delay independently.
Use percentiles only after repeated controlled runs, preserving concurrency, payload sizes, runtime, and transport mode with the results.
A held SQLite writer should leave an independent observation responsive; release should complete the original operation once.
A dropped response after a write should recover the saved receipt without repeating the write, and a restarted owner should either restore proven ownership or expose reconciliation explicitly.
Host completion rates need user-visible failure timestamps and host evidence in addition to QuayMesh logs. The current server tests do not establish that rate.

