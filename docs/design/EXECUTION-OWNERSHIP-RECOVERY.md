# Execution ownership and recovery

English · [简体中文](EXECUTION-OWNERSHIP-RECOVERY.zh-CN.md)

Status: design for a subsequent release. The 2026-10-30 patch supplies agent Task ownership, preserves agent identity across nodes, and clarifies command scope. Per-claim recovery described below is still planned.

## Problem and objective

The incident's game workspace was readable. The user's authorized C-drive logs were successfully collected through the existing shell interface into the project's diagnostics directory. Two retained command claims belonged to other projects. Code review also found that agent claims omitted Task ownership and cross-node errors omitted agent identity, leaving callers without an actionable owner.

Longer-lived failures come from handling historical outcomes, physical execution, and resource recovery in several places. Recovering one old operation can require node-wide maintenance. The objective is continuous observation, recovery of individual executions, and truthful task and node state.

## Retain the existing ownership model

| Object | Responsibility | Completion |
| --- | --- | --- |
| Task | User goal, context, messages, and result ownership | Goal completed or explicitly ended |
| Execution | One command or one agent turn | Its supervised processes finish or the provider confirms turn completion |
| Claim | Coordinate files and directories affected by that execution | The associated execution releases its resources |

Reuse WorkLedger, console_operations, console_executions, execution_owners, and the execution coordinator. Associate agent claims with the exact console_executions.id for the current turn. Command claims retain their console_operations.id. Resolve Task ownership through qm_run_links. An agent's start-request receipt and its actual turn finish at different times; recovery follows the execution record.

## Centralize physical completion

ProcessSessionManager already releases claims when the process group ends while retaining an unresolved outcome. Maintenance status already records physical completion. Consolidate these capabilities into shared completion handling:

- When a command and its supervised descendants exit, record their exit and release their claims.
- When a request times out while execution continues, retain the same execution and query output by its existing ID.
- When execution has ended but its returned result is missing, retain the unresolved result and release its resources.
- Closing or archiving a Task updates the goal record. Explicit cancellation ends an active execution.

Reuse the stored PID, start identity, and execution generation for liveness. Replace PID-only claim checks with the same identity check so PID reuse cannot preserve a claim for a different process.

## Recover individual claims

Extend the existing workspace_context recovery and console recovery paths to locate claim_id and invoke shared logic:

1. Resolve the exact execution, Task, node, and resources.
2. Determine whether that execution is still running.
3. Release an ended execution's claim, or invoke the existing command cancellation or agent interruption when the user requests stopping an active execution.
4. Complete release from the observed termination result and return that recovery result.

Other projects remain available. An offline node retains its local recovery state while online nodes continue serving work. Resolve missing historical identity from existing agent, run, and execution relationships.

## Keep observation available and scopes specific

Retain readWorkspace's current observation behavior without file claims. Structured mutations retain file scopes. Long-running commands declare the affected project through execution_scope. Existing worktrees provide independent copies for concurrent changes to the same repository.

Stable artifact copies retain existing single-file transfer and consistency behavior. For growing logs, create a diagnostic copy at the source and transfer that copy, shortening occupation of the original source.

Exported roots govern structured workspace and file interfaces. execution_scope coordinates command concurrency. Shell file access follows the local account's operating-system permissions. User-authorized external logs can be read through the shell and copied into a diagnostics directory for structured inspection.

## Return actionable conflicts

Return the node, claim_id, exact execution identity, available Task identity, affected resources, and the corresponding inspection or cancellation action. Preserve agent_id for agent conflicts. The console resolves display names and state from the same records.

Directory-scope errors identify available roots and the next supported action. Connection health, goal state, execution activity, and resource ownership use their corresponding facts so one historical error does not produce several misleading running or blocking indicators.

## Implementation order and acceptance

Centralize physical completion first, then add individual claim recovery, then unify process identity and presentation. Keep the immediate ownership patch separate so it can enter a release promptly.

Use real files, databases, and processes to verify:

- Files and logs remain observable while another execution runs in the same project.
- An execution that finishes after a request timeout releases resources while preserving the original outcome.
- After Core restart, an ended execution can be recovered independently while live executions keep their processes.
- Returning an agent start receipt preserves its running turn's claim; completing that turn releases it.
