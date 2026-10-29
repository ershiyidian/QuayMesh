# Tasks and agents

[English](TASKS.md) · [简体中文](zh-CN/TASKS.md) · [Home](../README.md)

A QuayMesh Task follows one goal across its workspaces, commands, files, coding agents, and external conversations. Its open or closed state describes the goal; individual command results describe execution.

## Open a task and workspace

Call `start_session` only for a new independent goal. Follow-up instructions use the existing Task and workspace handles. Creating another goal leaves the previous Task open. Reuse the same `request_key` and input when retrying creation.

```json
{
  "title": "Build the application",
  "request_key": "build-application-001"
}
```

When an authenticated host entry already selects a Task, a fresh key alone does not create another one. `TASK_START_SELECTION_REQUIRED` returns the existing Task ID and current binding revision with `effect: "not_started"`. Inspect that Task and continue it if the goal is unchanged. Only for an explicitly independent goal, call `start_session` with `new_goal: true` and `expected_binding_revision` from `task_resume inspect` or the selection conflict. A changed revision is rejected before creation. Closed Tasks require the same explicit choice; they are never reopened by start.

Historical creation keys return their original Tasks without selecting them again. A legacy Session's current Task can be returned as a selection candidate with revision `0`; merely observing it does not establish a binding. First creation in an unbound entry remains compatible with the example above. `source_task_id` records provenance for a newly created Task, not a parent relationship or authorization to continue another Task.

This selection guard applies to entries with verified owner/client identity and a stable host correlation. Generic MCP clients without that correlation retain their existing creation path; its durable creation-key scope remains a separate compatibility gap. The server does not invent an entry from an owner or a transport ID, and an explicit binding revision without a stable entry returns `TASK_ENTRY_REQUIRED`.

Use `workspace_catalog` to find available roots. Open the chosen project with `open_workspace`, then reuse the returned `workspace_id`:

```json
{
  "root_id": "worker/projects",
  "subdirectory": "my-app"
}
```

`mode: "checkout"` operates in the existing project. `mode: "worktree"` creates a separate Git checkout.

Use `attach_workspace` with `path` or `root_id` to add another project to the current session. Opening or restoring a Git worktree can run the repository's configured checkout hooks and filters; these tools therefore advertise write and open-world behavior.

### Restore a cleaned-up worktree

Read-only tools never recreate a managed worktree that retention cleanup has removed. File reads and environment queries return `WORKSPACE_RESTORE_REQUIRED`, with `effect: "not_started"`, `retry_hint: "fix_input"`, and the original workspace handle in `details.restore.arguments`.

To continue work, call `attach_workspace` in the original session with that handle:

```json
{
  "workspace_id": "<original_workspace_id>",
  "session_id": "<original_session_id>"
}
```

Keep the complete `qm:node:...` handle when a worker owns the workspace. Omit `path`, `root_id`, `subdirectory`, `mode`, `base_ref`, and `create_directory` for this form. The original session must have an active task; start the next task in that session first if its previous task is closed. A workspace belonging to another session cannot be restored through this call.

Restoration retains the workspace ID, directory, session member, and saved staged and unstaged changes to tracked files. Concurrent restores share the same restoration, and an already active workspace is reused. `workspace_context` with `status` or `recovery`, and `read_output`, can read authorized retained history while the directory is absent, including after the task has closed.

## Read and modify files

`read` retrieves text ranges or images. `workspace_context` can collect several file ranges, search the workspace, or recover saved task context.

`apply_patch` applies additions, updates, moves, and deletions. Its optional `expected_content` associates each target path with the content you previously read.

The task records affected files and keeps their differences accessible through Console.

## Run commands

```json
{
  "workspace_id": "<workspace_id>",
  "cmd": "pnpm build",
  "yield_time_ms": 1000
}
```

The result includes an `operation_id`. For a command that continues running, call `read_output` using that ID:

```json
{
  "workspace_id": "<workspace_id>",
  "operation_id": "<operation_id>",
  "cursor": 0,
  "wait_ms": 1000
}
```

Continue from the returned `next_cursor`. `write_stdin` sends input or resizes a terminal. `cancel_command` stops the selected command.

Keep the same `operation_key` when retrying an intended write or command submission. A new key represents a new operation.

When `EXECUTION_CONFLICT` or `NODE_ADMISSION_PAUSED` returns `effect: not_started` and `retry_hint: retry_later`, retry with that key after the blocker clears. A new request can attempt admission again within the original active task and workspace, retaining the same `operation_id` and the original refusal. Concurrent retries share one attempt. Completed, cancelled, partial, unknown, and permanent input errors do not restart the operation. Historical receipts without a provable original task remain queryable and cannot be reassigned to a later task.

## Work with coding agents

`spawn_agent` starts an agent task and returns its accepted operation. `list_agents` and `wait_agent` expose progress and retained results.

Use `send_message` to guide an active agent turn, `followup_agent` to continue its thread, and `interrupt_agent` to stop the selected turn.

QuayMesh includes integrations for Codex, Claude Code, OpenCode, Pi, Cursor, Copilot, and Grok. Each node reports which providers are installed, enabled, and configured there.

When assigning parallel work, give agents separate project areas or Git worktrees. The [execution guide](execution-resources.md) describes how operation scopes interact.

## Transfer files

`copy_artifact` transfers a file between workers. Its `start` action returns a `copy_id`; `observe` reads progress, and `cancel` stops that transfer.

`download_artifact` imports a chat attachment into a new workspace path. The client supplies the attachment reference together with the target workspace and path.

## Save progress and continue in another conversation

`checkpoint_task` saves the goal, decisions, supporting references, and next action alongside recorded execution facts. Saving a checkpoint or replying with progress leaves the Task open.

Changing conversation, handing work to another entry, and waiting for a command do not require `finish_task`. In the receiving entry, inspect the existing Task first:

```json
{"action":"inspect","task_id":"<original_task_id>"}
```

Then call `task_resume` with the returned `binding.binding_revision` and a stable key for this selection:

```json
{"action":"resume","task_id":"<original_task_id>","expected_binding_revision":3,"request_key":"resume-original-goal-001"}
```

The example revision `3` must be replaced with the observed binding revision. Retry a lost response with the same key and revision. If the binding changed, inspect again before making a new selection. Resume retains the Task, canonical session, workspace handles, and original operation ownership; it does not start model inference. A card's current entry and the model's entry may differ, so each entry must use its own authenticated selection. Closed Tasks remain historical and cannot be reopened by `task_resume`.

Use `task_messages` to receive, acknowledge exact message IDs, and reply to input for this Task. Receiving messages alone does not select the Task for execution.

Messages retain their complete text. Ordinary text may use up to 16 KiB of UTF-8; JSON escaping also counts toward that limit. The body appears in both the structured result and the JSON text block, so those two encoded copies together must fit 44 KiB. Text containing many quotation marks or backslashes reaches this limit earlier. The card and server apply the same check and reject oversized input before saving it.

History and receive requests paginate whole messages within the complete 48 KiB reply budget, reserving space for IDs, receipt facts, and cursors. If an older saved message or delivery exceeds this budget, the request returns `TASK_MAILBOX_BATCH_LIMIT`; the saved text and original receipt state remain intact. Such a failure does not acknowledge, discard, or replace the message.

### Recover an unconfirmed card message

When you click the card's save button, QuayMesh keeps the submitted text and message key until it receives a matching server receipt. If the host provides the optional widget-state API, the card also stores that pending submission in its own `privateContent` field. Reopening that same card for the same Task can restore the original text and key. Click **Retry save** explicitly to query or retry the original submission; restoring the card never resends it or starts GPT automatically. If host state arrives after you have edited a different draft, the card preserves that draft and shows the pending original separately. **Retry previous message** submits only that original text and key; the current draft remains unsent.

Widget state belongs to that rendered card and depends on the host retaining it. It is not a cross-device backup or evidence that the server saved the message. Unsupported hosts, invalid or oversized state, host write failures, and a cached submission for another Task keep the current in-memory retry behavior. Text that you have not submitted is not stored by this feature. After a matching save receipt, the card removes the cache only if the host's visible record matches the Task, key, and original text. A missing record causes no write. The host API has no compare-and-swap operation, so stale snapshots from different iframes cannot guarantee atomic cleanup. Message status and GPT replies still come from the Task's server-side history.

## Finish a goal deliberately

Closing is optional while work remains. Call `finish_task` only after the goal is achieved, or when the user explicitly ends it. Completing a command, encountering a command error, sending a progress response, or changing conversation does not by itself end the goal.

```json
{
  "task_id": "<task_id>",
  "status": "completed",
  "summary": "Built the application and copied the package to the release workspace.",
  "message_sequence": 0
}
```

Use `completed` for an achieved goal, `failed` for an explicitly ended goal whose outcome was unsuccessful, or `cancelled` for an explicitly cancelled goal. `message_sequence` must equal the latest `task_messages` mailbox sequence; `0` is valid only when there have been no messages. All user messages must have been acknowledged. If new input arrives during confirmation, read and handle it before confirming again.

Finishing checks active and unresolved execution, collects retained evidence, and records the goal's final result. It may first return `state: "finalizing"` while the durable confirmation completes. `finish_task` is not a command-cancellation tool: use `cancel_command` for a specific command, then confirm its actual outcome. A closed Task accepts no new work or inbox messages; its files, operations, and saved results remain available for authorized inspection.

New `finish_task(status="handed_off")` requests are rejected with `TASK_HANDOFF_NOT_TERMINAL` and `effect: "not_started"`. The Task stays open. Save progress with `checkpoint_task`, then resume that same Task in the receiving entry. Historical closed `handed_off` records remain unchanged and readable. On startup, unconfirmed legacy handoff intents on open Tasks are marked as rejected and excluded from automatic completion; their old summary and any previous error are retained. This does not reopen historical closed Tasks or acknowledge user messages.
