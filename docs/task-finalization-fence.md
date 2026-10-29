# Task finalization fencing

A failed finish is not proof that it is safe to continue the goal. An owner may have received the finish, closed local runs, or committed a final Task snapshot before a response was lost. Conversely, a finish that provably never reached any owner must not return later and close work that the user explicitly resumed.

This change retains the existing Task, mailbox, binding and finalization tables. Database v13 adds two columns to `qm_task_finalizations`:

| Field | Meaning |
| --- | --- |
| `finalization_revision` | Monotonic generation of the admitted attempt. Every new admission and safe retirement advances it. Background retry and asynchronous writebacks use their captured value. |
| `recovery_state` | `safe`, `reconcile`, or `superseded`; legacy `NULL` is unknown. It records evidence, independently of the human-readable `error`. |

## Admission and recovery

An in-flight intent (`error IS NULL`, not completed) blocks new goal execution. A failed `safe` intent may be retired by a **new explicit resume** or actual new-work admission. Retirement and the binding/admission change share the same SQLite write transaction. A historical resume-key replay never retires a later intent.

A failed `reconcile` or legacy-unknown intent blocks new workspace execution and resume. It remains available for retry of the original finish; it does not silently reopen any already closed Worker. Messages, receipt acknowledgement, replies, saved history, original operation output/status and controls for accepted operations remain available. Read-only evidence collection retains its existing permissions. New inbox input continues to invalidate the old mailbox cutoff, so old maintenance cannot close a Task over newly saved input.

`superseded` records remain durable history but are excluded from automatic retry and current pending/failed card notices. Normal Task execution bookkeeping resumes. The original operation key can retry a prior eligible `not_started` admission in the same owner/Task/member scope; its first error receipt remains immutable.

## Evidence for `safe`

Coordinator-created attempts start `safe`. Before any remote finalization is dispatched, the current attempt is durably marked `reconcile`. The entire owner fan-out is awaited with `Promise.allSettled`.

Only an attempt which was already safe and whose **every** owner call failed with local, single-dispatch proof of `not_sent` may return to `safe`. A successful owner receipt, interruption, timeout, unknown exception or remote `PeerApplicationError` prevents this. A peer claiming `not_started` or `dispatch_state=not_sent` is still a received peer request, not local proof that the owner never received it. Once an earlier attempt was unknown/reconcile, a later offline attempt cannot erase that uncertainty.

A Worker receiving delegated finalization starts `reconcile`. It cannot independently cancel the Coordinator's intent. Local run completion is also preceded by durable reconciliation state.

`session.feed` read retries now use a whitelist: snapshot, revision, subscribe and unsubscribe. Finalize and archive dispatch once. Their durable intent controls further attempts, so a later offline error cannot hide an earlier dispatched timeout.

## Version checks and ownership

Background maintenance retains the generation read with its batch. Request admission compares that generation inside the writer transaction. An old batch therefore cannot clear the error on a retired or newer intent.

Remote frozen snapshots, local frozen snapshots/context/checkpoints, final change summaries, local run completion and final Task closure verify the captured generation in their own write transaction. Failed stale callbacks cannot overwrite a newer intent's error or recovery state. Closing the goal and confirming its finalization still commit together with the exact mailbox-cutoff check.

Open/attach admission and copy admission use the same guard as normal execution. A Coordinator Task lease covers remote admission through the owner receipt. Copy first looks up an existing immutable receipt: replaying an old copy key cannot retire a newer failed finish. This adds one bounded metadata RPC to new copies; ordinary tool execution does not gain that extra round trip.

Task ownership, canonical storage and entry CAS remain unchanged. No Task is created, merged, selected or reopened by finalization recovery. No new service, timer or table is introduced.

## Public continuation contract

`task_resume` inspect returns the model-readable `task_revision` plus a direct `finalization` view containing its original status/summary, mailbox cutoff, attempt revision, recovery state and completion flag. This lets a replacement conversation inspect the exact original intent before reconciliation. These fields are on the tool response, not the persisted strict card Snapshot or entry-binding sideband.

After a terminal intent has been superseded, a **new explicit** `finish_task` must provide `expected_task_revision` from a current inspect. It must also provide the latest acknowledged mailbox cutoff as before. A stale transport request without that explicit observation cannot revive the retired intent. The existing Console's explicit Task-revision CAS is retained.

An accepted finish's next action retries its saved status/summary/cutoff; it does not repeat the first-admission Task revision. If new work superseded it meanwhile, that retry is rejected and the caller must inspect again. This preserves same-intent recovery without treating a delayed old request as a new decision to end the goal.

Unconfirmed historical `handed_off` intents remain retired by the prior handoff migration/startup policy. The new fence marks them `superseded` without changing their summary, acknowledgement history or already closed Task facts. A new terminal status can replace that prohibited legacy action without pretending the old handoff is still authorized to end the goal.

## Upgrade and verification

The v13 migration defaults legacy records to generation 0 and recovery `NULL`. It never infers unsent safety from existing error messages. Current-schema downgrade fixtures explicitly remove the two new columns before replaying earlier migrations. The independently maintained installed-05bd upgrade harness additionally exercises a real old completed/offline failure and a retired old handoff against the new code.

Required native coverage:

- Two real SQLite connections: old maintenance batch waits, resume/new work wins, then old batch and stale callbacks cannot close or overwrite it.
- Same-entry continuation, winning retry vs resume, immutable saved resume-key replay, explicit new-finish revision, legacy unknown and delegated Worker recovery.
- Original operation key: eligible unsent failure retries after retirement, performs one actual filesystem effect, preserves original receipt.
- Real projector: retired intent disappears from current notices; reconcile remains visible and blocks continuation.
- Real Peer disconnect: finalize/archive sent once, first interrupted outcome retained.
- Real MCP/Peer owner fan-out: one Worker truly closed plus another offline leaves Coordinator active/reconcile; no new directory/write; original output and message receipt/reply remain available.
- Actual peer error falsely claiming unsent remains reconcile.
- Copy replay does not retire an intent; a new copy's authority lease spans the owner-receipt boundary.
- Existing mailbox, handoff, resume/restart, binding and migration gates.

Local syntax and SQLite-adapter checks do not replace the Home native `better-sqlite3`, SDK, peer and browser gates. This package is a candidate until those gates pass.

## 中文说明

本轮修复区分“失败”与“能够证明没有派发”。只有后一种结束请求，才允许在明确恢复或开始新工作时退役；发送过、可能发送过和旧版本未知记录均保留原意图等待核对。旧回调、后台队列和旧请求重放不能撤销较新的继续决定，也不能关闭继续后的工作。消息与原操作查询仍然可用，不把任务恢复限制变成无法收信、确认或核对的死锁。已经关闭的远端历史不会被默默重开。
