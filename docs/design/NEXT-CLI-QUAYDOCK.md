# Proposal: local CLI and QuayDock access

[简体中文](NEXT-CLI-QUAYDOCK.zh-CN.md)

Status: next-release proposal, reviewed 2026-10-30. The methods and command examples below are proposed interfaces. This document does not implement them or change the current deployment.

## Decision

Add a local user API to the existing service and a thin CLI over it. Ship task observation first; add task messages through a separate permission grant. QuayDock consumes the same API, without a second background service or a new conversation hierarchy.

Reuse existing Task, workspace, operation, message, revision and cursor identities, plus authenticated owner/client and Task access checks. Reads do not select another Task, resume a conversation, acknowledge messages or create work.

Task observation uses the Task as its authorization and data unit. `tasks.list` returns one summary per authorized Task, including requests between tool calls or without a running command. Keep the saved Task lifecycle and result, latest Task activity, observation freshness and optional execution evidence distinct. Finishing or stopping one execution does not finish or stop its Task. Current and older groups organize the view without changing lifecycle state; unavailable data retains the last snapshot with its observation time and an explicit pending-update indication.

The existing [server](../../src/server.ts) has an administrative runtime-control channel and cluster-authenticated internal routes. Keep the new user surface separate from those controls. Its method dispatcher must enforce capabilities; advertising scopes or checking one general scope at connection time does not enforce method permissions.

## First API surface

| Proposed method | Required capability | Returned data or effect |
| --- | --- | --- |
| `status.get` | `status:read` | Service version, readiness and observed timestamps |
| `tasks.list` | `tasks:read` | Authorized Task summaries and pagination |
| `tasks.get` | `tasks:read` | Task lifecycle and result, activity and observation times, revision and snapshot cursor |
| `events.read` / `events.watch` | `events:read` | Bounded event metadata for an authorized Task |
| `outputs.read` | `outputs:read` | Optional separate grant: persisted output from an authorized Task operation |
| `messages.enqueue` | `messages:write` | Optional later stage: persist the user's message and return its receipt |

The first grant contains the three read capabilities. Task titles and event metadata are still private: filter them through existing Task access rules. Exclude raw command arguments, stdout, file bodies, environment values and credentials from the default response fields. Default read access does not grant access to those extra fields.

If QuayDock needs actual output from a Task, grant `outputs:read` separately; it is absent from the default grant. Expose output as a drill-down from that Task's detail view, with operation references used to locate the requested evidence. `outputs.read` requires a `task_id` and either an operation ID or a service-issued output reference that resolves to that operation. Verify that the operation belongs to the authorized Task, then reuse `read_output`, its byte cursor, retention markers and per-page byte budget. This method accepts no arbitrary filesystem path. Output can contain project content or sensitive values, so QuayDock displays it only in the authorized view and keeps it out of routine diagnostic logs.

For every method, check the authenticated client, its current grant and the requested capability before reading or mutating state; Task-scoped methods also check access to each addressed or returned Task. The credential determines the client identity; a `client_id` or `owner_id` in input cannot assert authority. Every page and event batch repeats the applicable authorization checks. Resource and action restrictions follow RFC 9700 §2.3 and MCP's operation-specific scope guidance.[1][3]

## Local transport and trust boundary

Use Windows named pipes and filesystem Unix-domain sockets, supported by Node's IPC APIs.[4] Discover the endpoint from protected local installation metadata; do not open a public TCP listener for this first release.

On Windows, the existing native host should create the user pipe with an explicit DACL for the intended logon and service identities, reject remote clients, and grant only the required pipe rights. The default pipe descriptor includes broader read access; setting an endpoint name alone does not establish the required access control.[5]

On Unix, use a socket in an owner-controlled `0700` directory with socket mode `0600`. Keep this user endpoint distinct from the administrative stop/admission channel. Do not expose a generic method, path or header forwarding API.

The OS account is the local trust boundary. Ordinary applications under the same account can have access to that account's secrets; an application display name is not process isolation. Per-client grants provide limited authority and independent revocation within that boundary.

## Enrollment, credentials and revocation

Register QuayDock through the existing owner-authenticated settings surface. Show the client name, read capabilities, allowed Tasks and credential expiry. Issue a dedicated random local credential; store only its hash and grant metadata server-side. Use Windows Credential Manager or the desktop Secret Service for client storage.[6][7] If secure storage is unavailable, report that setup requirement explicitly; do not silently write a plaintext credential.

Keep API credentials out of command arguments, URLs, stdout, logs and workspace files. A local credential is accepted only by the user IPC endpoint. Never return or forward the cluster bearer, owner password or administrative credential to QuayDock. Do not accept an inbound token for a different audience or pass it unchanged to downstream services.[1][2]

The owner can revoke one client without affecting other clients or stopping Tasks. Revocation disables subsequent requests and closes that client's active watches. Rotation replaces that client's credential and invalidates the old one. Enabling `messages:write` requires a separate owner grant; the consumer cannot grant itself more access. The first local interface does not add an OAuth refresh flow. Future HTTP access would require a separate OAuth design, including audience binding and refresh-token protection under RFC 9700.[3]

## Results, retries and cursors

Use one versioned method dispatcher for the CLI and native client, with existing bounded response budgets. CLI stdout contains JSON results; event watches use one JSON object per line. Human diagnostics go to stderr. No shell command interpolation is needed.

Preserve existing `task_id`, `operation_id`, message receipt and revision fields when the underlying operation supplies them. A cursor identifies a position within an authorized Task; it grants no access itself. Resume a watch from its last saved cursor and deduplicate by event identity. If retention has removed that position, return `CURSOR_EXPIRED` with `retained_from`; QuayDock obtains a new snapshot and shows the gap.

Optional message writes use a request key scoped to `(client, Task, key)`. An identical retry returns the original receipt; a changed body with the same key fails explicitly. After a timeout, retry with the same key to obtain the saved receipt. Enqueuing a message can influence the task's later actions, so this capability is separate from observation.

## QuayDock example

Proposed CLI syntax, after the owner has registered the `quaydock` client:

```text
quaymesh --client quaydock status --json
quaymesh --client quaydock tasks list --json
quaymesh --client quaydock tasks get --task <returned-task-id> --json
quaymesh --client quaydock events watch --task <returned-task-id> --cursor <returned-cursor> --jsonl
```

QuayDock resolves the installed CLI from trusted installation metadata and launches it with an argument array and shell execution disabled. `--client` selects a stored enrollment; authentication still uses its protected credential. One watch follows the selected Task, and closing the view closes the watch.

From the selected Task's detail view, a separate output grant permits bounded reads of its chosen operation:

```text
quaymesh --client quaydock outputs read --task <returned-task-id> --operation <returned-operation-id> --cursor <byte-cursor> --json
```

Continue with the returned `next_cursor`; use the existing `read_output` retention response when earlier bytes are no longer retained. Output byte cursors and Task event cursors are separate positions.

After the optional message grant, a user click may invoke:

```text
quaymesh --client quaydock messages enqueue --task <returned-task-id> --request-key <new-key> --stdin --json
```

The message goes through stdin. Keep its request key until the saved receipt is known. The initial API contains no command execution, arbitrary file access, task cancellation, installation, shutdown or automatic approval method.

## Delivery boundary

Stage 1 implements observation and client revocation, with output reading available only through its separate grant. Stage 2 adds explicitly granted message enqueue using the existing mailbox. Verify per-method denial, cross-Task denial, operation-to-Task output binding, revocation of an open watch, cursor recovery and duplicate-message handling with real local connections. Keep these implementation changes in the next release, separately reviewed from the current deployment fixes.

## Official references

1. [MCP Authorization, 2026-07-28: scope guidance and audience validation](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
2. [MCP Security Best Practices: token passthrough and scope minimization](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices)
3. [RFC 9700: §2.3 privilege restriction; §4.14 refresh-token protection](https://www.rfc-editor.org/rfc/rfc9700.html)
4. [Node.js 24: IPC support](https://nodejs.org/docs/latest-v24.x/api/net.html#ipc-support)
5. [Microsoft: named-pipe security and access rights](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights); [CreateNamedPipe](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createnamedpipea)
6. [Microsoft: CredWriteW](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credwritew)
7. [freedesktop.org: Secret Service](https://specifications.freedesktop.org/secret-service/latest/)
