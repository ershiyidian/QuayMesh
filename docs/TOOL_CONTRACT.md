# Tool reference

[Home](../README.md) · [Task guide](TASKS.md)

| Area | Tools |
| --- | --- |
| Tasks | `start_session`, `task_resume`, `checkpoint_task`, `task_messages`, `finish_task` |
| Workspaces | `workspace_catalog`, `open_workspace`, `attach_workspace` |
| Files | `read`, `workspace_context`, `apply_patch` |
| Commands | `exec_command`, `read_output`, `write_stdin`, `cancel_command` |
| Agents | `spawn_agent`, `followup_agent`, `send_message`, `wait_agent`, `list_agents`, `interrupt_agent` |
| Transfers | `download_artifact`, `copy_artifact` |

The connected node advertises its available tools and their parameter schemas. Use returned workspace, operation, task, and transfer IDs for subsequent calls.

## Returned results

Tools expose their structured result in both `structuredContent` and exactly one JSON text block in `content`. Clients that keep the first text block, the last text block, or all text receive the same workspace IDs, operation IDs, status fields, errors, and continuation cursors. Unique explanations are preserved in the text JSON's `_quaymesh_text_notes` array (a numbered suffix avoids collisions with existing result fields). This text-only field does not change the declared structured output schema. Image and resource blocks remain intact; UI metadata stays in `_meta`.

Use the returned `workspace_id` for workspace operations. An exported `root_id`, such as `worker/main`, selects a root when opening or attaching a workspace. The opened handle includes its worker route and must be reused unchanged.

Paged reads and command output include both result representations when calculating their reply budget. Continue with the returned cursor to read the remaining content. Text serialization happens after routing and receipt processing, so old saved receipts also gain the text representation without being rewritten in storage.

When a `workspace_context` status batch would exceed the reply budget, it keeps every operation's identity and state and returns `details_deferred: true` with a single-operation `next_action` for its full receipt. Follow that request and its page cursor for the original content; the batch does not change the saved operation.

In a federated deployment, the public MCP Coordinator creates the final response. Update that Coordinator when deploying changes to the response contract; upgrading a Worker alone does not change the public MCP response.

See [tasks and agents](TASKS.md) for complete operation examples and [file changes and concurrency](execution-resources.md) for scope behavior.
