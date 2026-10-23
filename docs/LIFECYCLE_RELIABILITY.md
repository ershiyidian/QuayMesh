# Lifecycle reliability

## Card and Console state model

The session card, global Console, project Console, and conversation task summaries preserve three separate facts: the saved request result, observed background execution, and source connectivity. A connection failure cannot change a saved result; a saved result cannot hide an unresolved background operation.

| Persisted request / current evidence | Primary presentation | Independent detail |
| --- | --- | --- |
| Closed, completed | Completed | Background execution or unconfirmed receipts remain visible |
| Closed, failed | Not completed | The original result stays fixed |
| Closed, cancelled | Stopped | Any remaining background evidence is shown separately |
| Closed, handed off | Handed off | Confirmed background execution may continue |
| Closed, no confirmed result | Ended / archived; delivery unconfirmed | Never presented as completed |
| Open, fresh active operation | Executing | Last output age and operation duration |
| Open, fresh preparation | Preparing | Preparation is distinct from a command that has started |
| Open, no background operation | No current background execution | Time since the last real activity |
| Open, no progress for ten minutes | No recent execution progress | No inferred completion, failure, or cancellation |
| Open, explicit interrupted result | Execution interrupted | Recent unrelated activity cannot erase the interruption |
| Missing or expired execution evidence | Execution result requires checking | The previous duration stops advancing |
| Durable finalization intent, evidence capture pending | Confirming delivery | The request remains open until finalization succeeds |
| Finalization failed | Delivery confirmation failed | The error remains available; failure does not fabricate a final task result |

`task-view.ts` provides the common delivery and execution rules. The card and Console render the delivery result first for closed requests, followed by background and review information. Execution filters and interrupt controls continue to use actual execution state.

Project membership determines which conversations appear in a project. Each task in those conversations uses the same complete task aggregation as the global task list, including its other workspaces and nodes. A command with an unknown result in a second workspace must remain visible when viewing the first workspace.

An unavailable node does not hide a fresh execution observation from another node. Connectivity notices remain separate from the confirmed operations that can still be observed.

Once a card has accepted a task identity, later snapshots cannot remove or replace that identity. A closed request cannot return to an open state through a delayed snapshot, including archived requests whose result is still unknown. Newer receipts and file evidence may still enrich that request.

Business revisions and live observations advance independently. Equal business revisions may update connectivity and execution observations without rebuilding unchanged files or commands. A delayed business snapshot cannot replace a more recent observation. Poll timestamps are not execution progress.

## Timer and inactivity rules

1. Task time is a wall-clock span from task creation to a proven endpoint. It is not model thinking time, CPU time, or accumulated active execution time.
2. A confirmed delivery endpoint freezes task time permanently. An archived request without a confirmed endpoint displays an unknown duration rather than an invented completion time.
3. An open request advances its task clock only while actual execution, preparation, stopping, or pending finalization is observed. Without background execution, the clock freezes at the most recent real activity.
4. A command clock advances only while that command has a fresh active observation. A terminal command uses its recorded end time. Expired or missing evidence freezes the last confirmed duration, or shows an unknown duration when no valid measurement exists.
5. Execution observations expire after thirty seconds. A heartbeat or a successful card poll does not extend the last business activity timestamp.
6. Inactivity uses the latest real tool, execution, output, or operation event, falling back to task creation when no such event exists. Ten minutes without progress produces a visible warning even for a task that never started a command. A confirmed running command remains running even when it produces no output.
7. Recent activity and confirmed background execution poll every five seconds, including collapsed cards. Quiet open cards use ten seconds when expanded and fifteen seconds when collapsed. Closed requests with unconfirmed receipts continue checking every thirty seconds; settled closed requests stop polling.

The card shows the age of the last activity separately from its frozen duration. A read failure appears as a reconnecting notice without overwriting the saved primary result. Narrow layouts retain the complete state message and all detail tab names.

## Historical card protocol compatibility

The current resource is `ui://quaymesh/task-card/v7.html`. Published v1, v3, v4, v5, and v6 addresses remain registered because historical conversations retain those addresses.

The resource address and the renderer's protocol capability are separate. When a historical address serves the current renderer, that renderer declares `task-card-v7` on every `qm_session` request. The historical address remains available for widget diagnostics. It must not force current JavaScript to request a reduced historical payload.

| Actual reader capability | Snapshot / live reply |
| --- | --- |
| v7 | Full snapshot, execution observation, lightweight live connectivity/execution state, typed finalization |
| v6 | Execution observation and source task identity preserved; v7-only live/finalization fields omitted |
| v1, v3, v4, v5, or unspecified | Historical strict snapshot shape; newer observation/live/finalization fields omitted |

Stored snapshots retain the full data. Compatibility conversion happens at the response boundary, so an old cached reader remains usable without discarding evidence needed by a current reader. Current display parsing tolerates unknown additive fields while continuing to reject malformed known fields.

## Host event and diagnosis boundaries

QuayMesh observes its own tool invocations, processes, durable records, and App bridge. It does not receive a universally reliable event proving that the host has finished thinking, rendered its final answer, or delivered that answer to the user.

If the host answers without calling `finish_task`, the card therefore shows the observable condition: no current background execution, a paused duration, and the age of the latest real activity. It does not infer success from elapsed time or from a working App connection.

`finish_task` may return `state=finalizing`, `accepted=true`, and a retry/query action after its bounded wait, but only after a matching finalization intent has been persisted. The requested status is not yet a confirmed task result. The service retains the work lease and performs real evidence capture; only successful finalization produces `closed` and a final result. Repeating the same intent joins that work; conflicting intent is rejected.

The usual observation budget is two seconds. A database lock may delay durable intent; the service must wait rather than invent acceptance. Recovery scheduling counts entry and owner finalizers together, keeps at most four flights across rounds, and observes each new batch for at most two seconds. A stuck archive retains its maintenance lease while other available slots can finish later tasks. A task never starts a duplicate archive.

For incident attribution, preserve the following boundaries:

- **C09:** live card observations and durable accepted/query contracts expose QuayMesh progress. They do not establish that a particular host supports progress notifications or has consumed them.
- **D09:** HTTP response completion, RPC success, tool outcome, operation effect, and host acknowledgment are different facts. A local `200` or a saved tool response cannot establish host acknowledgment; unavailable acknowledgment remains unknown.
- **D10:** a host message such as `message timeout` or `thinking failed` needs a timestamp and matching request/operation trace before attribution. Missing host/provider evidence cannot be converted into a claim that GPT failed, or into an exact percentage of failures caused by QuayMesh.

Browser acceptance covers real local MCP sessions, SQLite finalization intent, pending-to-closed evidence capture, expired/missing receipts, historical resource addresses, and global/project/conversation consistency. A browser fixture verifies rendering and protocol behavior; it does not substitute for a host delivery acknowledgment.

## Incident remediation register

This register retains all 42 findings from the lifecycle investigation and adds A09 and A10 from deployment cold-start verification, for 44 findings. “Implemented” describes source behavior and regression coverage; a running node receives it only after its actual release has been verified. “Boundary” records a limitation that must remain visible rather than being converted into a successful result.

| ID | Finding | Implemented behavior or remaining boundary |
| --- | --- | --- |
| A01 | Native SQLite cleanup crashes | Pin SQLite 13.0.3; verify 500 real database/statement/GC cycles with the exact packaged Node runtime before activation. |
| A02 | Source version differs from installed contents | Record source commit, Node version/ABI/hash, lockfile hash, and actual loaded SQLite package/native hash in release and runtime identities. |
| A03 | A restart loop briefly appears healthy | Report recent restart rate, crash-loop condition, last exit, and readiness separately; exclude unstable Core instances from gateway selection. |
| A04 | First successful readiness check accepts an upgrade | Require matching actual Core runtime identity and sixty continuous seconds with unchanged ready PID/start/restart identities for every required managed component. |
| A05 | Old binaries cannot read a newly migrated database | Make a real SQLite backup before activation; migration failure keeps new data and its backup in recovery_required instead of blindly starting old binaries. |
| A06 | Core owns command pipes and terminal processes | Preserve live execution ownership and quarantine unconfirmed dead-owner claims. Transparent command/PTY reattachment after Core death still requires a separate command runner. |
| A07 | Stopping a service can stop its child cgroup/Job | Upgrade only after admission freeze and execution/stream drain. Windows activation runs independently through Task Scheduler. Existing command ownership still has the A06 boundary. |
| A08 | Maintenance recovery and activation timestamps are ambiguous | Persist installation transition ownership; keep activation time distinct from Core process start time. |
| A09 | Maintenance blocks discovery's one-time startup probes | Allow only the exact public OAuth metadata GET routes. Unauthenticated MCP startup probes receive a local Relay 401 without parsing or forwarding business requests. Authenticated MCP, registration, token, and other business requests remain closed. |
| A10 | A ready Core hides required discovery startup failure | Derive required components from the actual component plan. Missing, duplicate, stale, failed, or restarted components block verification or reset the shared stability window. |
| B01 | Startup reconciliation rewrites live execution owners | Match owner token, PID, and OS creation identity before recovery; preserve a living owner. |
| B02 | A verified completion cannot close a recovered execution | Accept the current execution owner's proven terminal receipt; retain generation checks and cancellation protection. |
| B03 | Dead Core automatically releases command claims | Retain and audit the isolation claim until terminal or ownership-transfer evidence exists. |
| B04 | Entry receipt and execution-node status disagree | Join entry receipt with authenticated owner lookup and explicitly return found, not_found, or unreachable. |
| B05 | Diagnostics cannot locate invocation-only receipts | Resolve authorized invocation membership even when no local run/operation row exists. |
| B06 | A request never sent is reported as an unknown side effect | Preserve dispatch_state=not_sent and safe retry semantics; uncertain accepted writes continue to use query_original. |
| B07 | Peer errors lose effect and recovery fields | Carry bounded, allowlisted error code/effect/retry/identity fields through the peer transport. |
| B08 | Text and structured error codes differ | Record both classifications at the final HTTP boundary. Real two-node tests preserve NODE_UNAVAILABLE consistently; external rewriting remains unlocated until matched boundary evidence exists. |
| B09 | Accepted-work identity arrives only after slow preparation | Publish the persisted reservation as soon as it exists, including when database contention outlasts the initial response budget. |
| B10 | Execution state and delivery state overwrite one another | Preserve request result, active execution, unknown effects, and delivery acknowledgment as separate facts. |
| C01 | Large responses block small control responses | Negotiate frame-stream-v1; frames above 64 KiB use independent HTTP/2 data streams, including reverse connections behind NAT. |
| C02 | Unbounded peer queues | Bound outstanding requests, queued control bytes, and large-frame concurrency; return a recoverable busy result before unsent work starts. |
| C03 | A stream closes before headers and never settles | Every error/close/timeout path settles once and releases the waiting request. |
| C04 | Base64 images exceed the control-frame budget | Enforce encoded frame size; negotiated data frames allow up to 16 MiB while legacy peers retain explicit 8 MiB limits. |
| C05 | Relay deadline ends at response headers | Keep a final response budget after headers and SSE heartbeats; accepted work remains queryable by its saved operation. |
| C06 | Expired observations continue remote work indefinitely | Propagate read cancellation and deadlines; admitted mutations keep ownership and persist their results. |
| C07 | Output deadline misses queue and disk stages | Carry AbortSignal through observation queues, metadata, segment reads, and wait; ending observation does not terminate a command. |
| C08 | Reply-size fitting rereads disk and overloads readers | Read each snapshot once, trim UTF-8 in memory with exact byte cursors, and bound node-wide concurrent/queued readers. |
| C09 | Business progress is discarded | Forward request-bound, validated progress notifications and preserve the accepted/status fallback for hosts that do not consume progress. |
| C10 | Slow finalization holds one tool response open | Persist a finalization intent, return accepted within the available budget, and retain an independent maintenance-blocking lease until real finalization ends. |
| D01 | Operation status scans unrelated events | Use operation indexes and authenticated session/task membership; cover lookup against a real 20,000-event database. |
| D02 | Synchronous work stalls the Core event loop | Buffer bounded diagnostics, coalesce asynchronous manifest-cache writes, and wait asynchronously for selected SQLite writes. Some projection-materialization writes and aggregation still run synchronously in Core; full isolation remains an architectural follow-up. |
| D03 | Directory search enumerates the whole tree before paging | Bound traversal before the first page, retain a stable continuation, serialize concurrent continuation reads, and enforce file/byte/time limits. |
| D04 | Different health layers collapse into one online flag | Preserve Core readiness/stability, source observation freshness, peer link, discovery, and egress evidence separately. |
| D05 | Windows treats a degraded live process as stopped | Display degraded, stale, and unknown process evidence explicitly. |
| D06 | Link-close causes disappear after restart | Persist link ID, direction, close reason, queue depth, oldest RPC, and heartbeat delay diagnostics. |
| D07 | Metrics invite incorrect interpretation | Name timer drift and HTTP request count explicitly; add true event-loop maximum/p99, diagnostic sequence, and dropped-event counts. |
| D08 | A probe error hides the actual process exit | Preserve last exit code/signal/time independently of probe errors. |
| D09 | Server response completion is treated as host acknowledgment | Preserve separate response/outcome/effect evidence; host acknowledgment remains unknown without a host receipt. |
| D10 | Host timeout/think-failure labels lack per-request correlation | Provide safe request/operation/node/phase boundary diagnostics. A specific host failure still needs matching host evidence for attribution. |
| E01 | Unstable gateways repeatedly regain priority | Exclude crash loops and draining nodes; preserve gateway recovery hysteresis. Legacy nodes without the new health fields and with at least three historical restarts require at least five continuous minutes of stable process and connection identity. |
| E02 | Active egress streams pass the maintenance idle check | Count new and legacy egress leases as blocking, stop new gateway work, and wait for existing streams to drain. |
| E03 | Gateway selection cannot migrate existing TCP/TLS sessions | Keep established streams with their owner; never blindly replay a model request. Transparent recovery requires support from that provider's application protocol. |
| E04 | A generic probe or 503 hides the failure layer | Report proxy connection, tunnel, target TLS, and HTTP probe stages with safe error codes; generic reachability does not establish provider business health. |

## Activation and verification

Maintenance preserves the existing responses from the two OAuth metadata endpoints and the root metadata fallback candidate. Unauthenticated GET/POST `/mcp` startup probes receive only a local authentication challenge; no upstream execution starts. Discovery can therefore initialize while business admission remains paused, without a circular dependency in installation verification. An absent root metadata route still returns 404 rather than fabricated metadata. The external tunnel component can retain other one-time discovery failures; verification of every required component prevents committing that state as a successful upgrade.

Build an immutable platform release from a clean Git commit with Node 24.21.0 and the frozen package lock. `release.json` identifies the actual packaged Node and native dependency bytes. `verify-installed.mjs` performs real SQLite/GC and schema checks before the service changes.

Prepare the release separately from the running installation. Recheck admission, queued work, claims, agents, command processes, and egress streams before activation. The installer saves an online SQLite backup, persists transition state, changes the service, and waits for a stable instance. It resumes admission after the verified activation is committed. If resuming fails after that commit, it keeps the new service for diagnosis.

The installation transition marker gates both manager and Core. A new Core checks it before accepting external execution, rejects new mutations and egress during validation, and keeps read-only diagnostics available. Direct Core resume also fails while the marker exists; removing it still requires an explicit installer resume.

For Windows, launch `node/windows-activate.ps1 -PreparedManifest <prepared.json>` from the intended service user's authorized session. The registered one-shot task executes outside the old Host Job and saves its own result and transcript. It does not stop independent EasyTier or user processes. The Task Scheduler entry is removed when that activation ends.

Old deployments may contain historical unknown receipts with no living owner. Do not erase those receipts or release claims merely to make an idle check pass. A legacy bootstrap requires independent evidence: paused admission, repeated absence of live/queued work, verified process identities and process groups, and no active proxy stream. A dead claim with unverified descendants blocks automatic activation. Keep historical uncertainty in the new database.

The current implementation intentionally does not promise transparent restart survival for Core-owned command pipes/PTYs. Use an independent service or durable job scheduler for work that must survive a Core service replacement. Busy or disconnected nodes keep their current installation until they can be inspected and drained.
