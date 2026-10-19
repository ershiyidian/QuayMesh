# Tasks and agents

[English](TASKS.md) · [简体中文](zh-CN/TASKS.md) · [Home](../README.md)

A QuayMesh task follows one user request across its workspaces, commands, files, and coding agents.

## Open a task and workspace

Call `start_session` once for a new user request. Reuse the same `request_key` when retrying that request.

```json
{
  "title": "Build the application",
  "request_key": "build-application-001"
}
```

Use `workspace_catalog` to find available roots. Open the chosen project with `open_workspace`, then reuse the returned `workspace_id`:

```json
{
  "root_id": "worker/projects",
  "subdirectory": "my-app"
}
```

`mode: "checkout"` operates in the existing project. `mode: "worktree"` creates a separate Git checkout.

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

## Save progress and finish

`checkpoint_task` saves the goal, decisions, supporting references, and next action. These notes are stored alongside the recorded execution facts.

Use `finish_task` to record the task's outcome:

```json
{
  "task_id": "<task_id>",
  "status": "completed",
  "summary": "Built the application and copied the package to the release workspace."
}
```

The other outcomes are `failed`, `cancelled`, and `handed_off`. Use `handed_off` when accepted work continues beyond the current response.

The conversation retains the task and its results for later inspection.
