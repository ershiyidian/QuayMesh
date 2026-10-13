# Tool reference

[Home](../README.md) · [Task guide](TASKS.md)

| Area | Tools |
| --- | --- |
| Tasks | `start_session`, `checkpoint_task`, `finish_task` |
| Workspaces | `workspace_catalog`, `open_workspace`, `attach_workspace` |
| Files | `read`, `workspace_context`, `apply_patch` |
| Commands | `exec_command`, `read_output`, `write_stdin`, `cancel_command` |
| Agents | `spawn_agent`, `followup_agent`, `send_message`, `wait_agent`, `list_agents`, `interrupt_agent` |
| Transfers | `download_artifact`, `copy_artifact` |

The connected node advertises its available tools and their parameter schemas. Use returned workspace, operation, task, and transfer IDs for subsequent calls.

See [tasks and agents](TASKS.md) for complete operation examples and [file changes and concurrency](execution-resources.md) for scope behavior.
