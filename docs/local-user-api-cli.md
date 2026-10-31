# Local terminal API

This CLI is a client of the existing local IPC service. It does not start a
service, enroll itself, read an owner password, or fall back to MCP/HTTP when IPC
is unavailable. The server still authorizes every method and every Task.

## Supported methods

| CLI | IPC method | Default user-client access |
| --- | --- | --- |
| `quaymesh local status` | `status.get` | Read only |
| `quaymesh local tasks list` | `tasks.list` | Read only |
| `quaymesh local tasks get <task-id>` | `tasks.get` | Read only |
| `quaymesh local events read <task-id>` | `events.read` | Read only |
| `quaymesh local events watch <task-id>` | `events.watch` | Read only |
| `quaymesh local peer send <target-task-id> --message-key <key> --stdin` | `peer.send` | Requires a separate Task-bound grant |
| `quaymesh local peer receive --request-key <key>` | `peer.receive` | Requires a separate Task-bound grant |
| `quaymesh local peer ack <delivery-id> --message-id <id>` | `peer.ack` | Requires a separate Task-bound grant |

Commands produce JSON by default and accept an explicit `--json` flag without
changing the response shape. `events watch` emits one JSON result per line, including
empty heartbeats; use `nextCursor` to resume explicitly. The client does not
silently retry or resubscribe. Ctrl-C cancels its connection and exits with 130.
Other failures produce a JSON error on stderr and exit with 1.

`tasks list` accepts `--cursor` and `--limit 1..50`; event reads/watches accept
`--cursor` and `--limit 1..100`. `peer receive` accepts `--after-sequence` and
`--limit 1..8`. `peer send` optionally accepts `--reply-to <message-id>`. A peer
acknowledgement accepts up to eight distinct `--message-id` values.

Task results include the same resolved `title` as the console, plus `current`
and `activityState` (`executing`, `recent`, `idle`, `unknown`, or `ended`). The
persistent `state: active` only means the Task is not closed; it does not prove
that an execution is currently running. QuayDock should use the activity fields.

An open Task is `current` while its last actual progress is less than 30 minutes
old, or while a trusted running/starting/stopping/queued execution observation
is less than 30 seconds old. Polling, receiving a cached response, and peer
messages do not refresh those timestamps. A training job can remain current
through fresh execution evidence even when its last reported progress is older.
The activity projection does not close or archive a Task, stop a process, or
release a resource lease. Missing or expired execution evidence does not prove
that a process has stopped or that its resources are safe to reclaim.

These read capabilities return Task metadata and event sequence/type/time, not
event payloads, command text, stdout, user-message bodies or arbitrary files.
Output reading is not an implemented method or capability in this version.

There is no local `messages.write`, user enqueue, owner command, arbitrary URL
request, or user-reply method. A model's reply to a user message continues to use
the existing Task-message reply path and its user-turn authorization rules.

### Replies to user input

The existing `task_messages` path requires an explicit user message, receipt
acknowledgement, and valid Task/receiver access. Each acknowledged user message
authorizes one new saved reply. Another authorized entry may continue an
unanswered message. Once a reply is saved, an identical `message_key`, body and
set of `reply_to` IDs can replay that receipt; a new key cannot reuse that user
input to start another reply. Changed content under the same key is a conflict.
If a reply references several user messages and any has already been answered,
the whole new reply is rejected. A new user message supplies a new reply turn.

The 30-minute activity rule does not expire an unanswered user's request: a
long-running Task can deliver its first reply later, subject to the existing
Task closure/finalization and access checks. Neither acknowledgement nor a
saved reply proves that the Task is complete. Peer messages are stored with
Task identity separately from the user dialogue; they cannot impersonate a
user, acknowledge user input, or authorize a new user-facing reply. Task-to-Task
exchange uses the terminal API below and adds no standalone MCP tool.

## QuayDock and other user clients

The owner must first register the client through the owner-authenticated service
entry. Its default capabilities are `status:read`, `tasks:read`, and
`events:read`. Registration is not performed by this CLI.

### Owner registration, rotation and revocation

Use the authority's existing authenticated Owner console entry. These routes
are not available through the local IPC method set or peer console-operation
forwarding. POST requests require the Owner session cookie, an exact same-origin
`Origin`, and its `x-quaymesh-csrf` value (available from the authenticated
`GET /console/api/session`). Do not give this session, CSRF value, owner password
or cluster bearer to QuayDock or a managed terminal.

| Owner route | Purpose | Request body |
| --- | --- | --- |
| `GET /console/api/local-clients` | List user-client grants; no credentials are returned | None |
| `POST /console/api/local-clients` | Register a user client on an explicit node | Registration object below |
| `POST /console/api/local-clients/<grant-id>/rotate` | Replace a valid user-client credential | `{}` |
| `POST /console/api/local-clients/<grant-id>/revoke` | Revoke the grant | `{}` |

The registration object contains `nodeId`, `clientName` and `expiresAt` (Unix
milliseconds, in the future and at most 90 days away). Optional `capabilities`
defaults to the three read capabilities. Optional `taskIds` restricts metadata
access; an omitted or null value means all Tasks owned by this Owner. For a
limited QuayDock enrollment, the Owner can use these non-secret settings:

```js
{
  nodeId: "<installed-node-id>",
  clientName: "QuayDock",
  capabilities: ["status:read", "tasks:read", "events:read"],
  taskIds: ["<authorized-task-id>"],
  expiresAt: Date.now() + 24 * 60 * 60 * 1000
}
```

Only an explicitly requested peer grant adds `peer:send`, `peer:read` or
`peer:ack`; it also requires a fixed `sourceTaskId`. `peerTaskIds` controls the
separate peer scope, and any explicit Task scope must include the source.
The server checks both Task owners and that method's scope on every call.
QuayDock receives no peer capabilities by default.

Registration and rotation return a sensitive enrollment response once. Pipe it
directly into the import command below, without displaying or saving its
credential. Rotation keeps the grant ID, advances its revision, and invalidates
the old credential; import the new response under the same alias. It does not
extend expiry or change scope. An expired/revoked grant or different scope
requires a new Owner registration. Revocation is checked centrally, including
on subsequent watch polls; a stale worker verifier cannot restore access. It
does not undo messages that were already accepted. The authority stores a
credential hash and grant metadata; workers forward the verified grant ID and
revision, not the client's credential. The CLI cannot register, rotate, revoke
or escalate its own permissions.

Pipe the complete enrollment response directly to:

```text
quaymesh client import quaydock --stdin
```

The registration response includes the local endpoint, credential, client/grant
identifiers, audience, capabilities, Task scope and expiry. Import checks that
the audience and endpoint match public discovery, validates the scope metadata,
and writes a minimal credential record into Windows Credential Manager or a
Linux Secret Service. Its output is a non-secret receipt. Do not put the
credential in command arguments or create an intermediate plaintext enrollment
file. An unavailable or locked vault fails closed; there is no file fallback.

Then use the enrolled alias explicitly:

```text
quaymesh local status --client quaydock --json
quaymesh local tasks list --client quaydock --limit 20 --json
quaymesh local tasks get <task-id> --client quaydock --json
quaymesh local events watch <task-id> --client quaydock --json
```

The CLI reads only `local-user-api.json` for discovery. Directory selection is:

1. `--config-dir <directory>`;
2. `QUAYMESH_LOCAL_API_CONFIG_DIR`, the stable directory supplied by the installed
   node runtime;
3. `QUAYMESH_CONFIG_DIR` for an explicitly configured CLI environment;
4. the installed default: `%LOCALAPPDATA%\QuayMesh\config` on Windows, or
   `$XDG_CONFIG_HOME/quaymesh` / `~/.config/quaymesh` on Linux.

It does not scan `auth.json`, accept an owner token, or silently choose another
installation. An installation using a different directory must select it
explicitly.

### Installed command path

The existing package binary stays `quaymesh` (`bin/quaymesh.js`). It imports
`node/cli.mjs`, which dispatches `local` and `client` directly to the compiled
local client before the node lifecycle/configuration parser. It does not route
these commands through manager status or require `--config`/an owner secret.
The optional form `quaymesh --json local ...` is also accepted.

Release bundles already include `bin`, `node`, `dist`, and their private Node
runtime. An application that does not rely on PATH can use the current public
installation record's `nodeExecutable` as its executable and pass
`<installation.directory>/bin/quaymesh.js` followed by the same arguments. These
are fixed paths relative to the active installation; there is no need to locate
or invoke a `dist` module manually. Pass arguments as an array without a shell.
Re-read the active installation record after an upgrade instead of pinning a
release-hash directory forever. No new package binary or dependency is needed.

The source build runs TypeScript over `src`, and the bundle copies the resulting
`dist/local-user-api` directory. The official bundle verifier/build and an
installed-bin smoke test are still required before declaring a release usable.

Run the entry smoke against the compiled repository or a verified release:

```text
node scripts/analysis/verify-local-cli-entry.mjs --root <package-or-release-directory> --node <node-executable>
```

It invokes that package's real `bin/quaymesh.js`, checks both `--json` forms,
rejects a forged source Task option, and validates malformed import input. It
uses an empty temporary configuration directory, removes inherited QuayMesh
environment variables, and does not use a real credential or start a service.

The discovery file is private. On Linux it must be owned by the current user
and have no group/other access; its directory must be owned by that user and not
writable by group/others. The IPC socket and its immediate parent are private
to that user. On Windows the discovery file needs a protected ACL owned by the
current user, with access only for that user, SYSTEM or Administrators; its
directory must not grant other users write/delete/permission-change rights.
Links/reparse points are rejected. Read-only directory permissions such as a
Linux `0755` installation directory do not require changing that directory.

On Windows the transport also verifies the server of the actual connected pipe.
A fixed PowerShell/C# helper holds that connection, obtains its server process
ID, holds the corresponding process handle, and checks the process token SID
against the current Windows user. It sends no application bytes until this
check succeeds; it never reconnects between checking and sending. A pipe owned
by another user, or an identity that cannot be queried, is rejected. Public
discovery permissions alone do not authorize a pipe listener. The helper uses
fixed code/arguments and private stdin/stdout, streams watch results, and exits
with the client's connection. There is no TCP or unverified-pipe fallback.

## Managed model terminals

The actual managed exec path supplies both `QUAYMESH_LOCAL_API_ENDPOINT` and
`QUAYMESH_LOCAL_API_CREDENTIAL`. The CLI uses them directly, without discovery or
the persistent vault. Do not combine these inherited values with `--client` or
use the inherited environment to import a persistent client. Missing/invalid
pairs fail explicitly.

The short-lived grant fixes the current Task. There is no `--source-task-id`,
owner, node, credential or arbitrary endpoint command-line option. A peer target
is explicit, but the server derives the sender from the verified grant and
checks the peer capability and both Tasks' access/activity state.

Managed terminal grants last at most 15 minutes from the recorded dispatch and
are restricted to that execution's actual owner, node and source Task. Retrying
the same dispatch rotates its credential under the same grant ID with an
incremented revision; an explicitly revoked dispatch grant cannot issue another credential.
A new terminal execution obtains its own binding. The terminal's ordinary Task
and event reads are scoped to its source Task; peer access has a separate scope.

### Two-Task exchange

Run these commands inside the two actual managed Task terminals. Set
`TASK_A_ID`/`TASK_B_ID` to the verified Task IDs, and set `DELIVERY_ID` and
`PEER_MESSAGE_ID` from receive's JSON result. The sender is always derived from
the terminal grant, not from command arguments.

```sh
# Terminal A: stdin contains the peer message; use one stable key for this send.
printf '%s' 'The requested build is ready for validation.' |
  quaymesh local peer send "$TASK_B_ID" --message-key build-ready-1 --stdin --json

# Terminal B: read its own inbox, then acknowledge the exact returned delivery.
quaymesh local peer receive --request-key inbox-b-1 --after-sequence 0 --limit 4 --json
quaymesh local peer ack "$DELIVERY_ID" --message-id "$PEER_MESSAGE_ID" --json

# Terminal B: an optional reply targets A and references A's peer message.
printf '%s' 'I will validate the requested build.' |
  quaymesh local peer send "$TASK_A_ID" --message-key validation-reply-1 --reply-to "$PEER_MESSAGE_ID" --stdin --json
```

Both Tasks must remain open and outside a blocking finalization, and must have
recent actual progress or fresh execution evidence under the activity rule
above. An idle or unobserved Task rejects a new send; receiving, acknowledging,
or exchanging peer messages cannot make either Task current again. Existing
receipts/history can still be read with valid authorization, including after
closure; this does not permit a new send. A peer `reply_to` must refer to a peer
message in the reverse Task pair, never a user-message ID.

Peer send limits are 12 new messages per source Task and 24 per destination Task
in a rolling minute, across clients. Exact-key replays do not consume that
quota. A restricted inbox filters out-of-scope senders before pagination;
`nextSequence` may therefore contain gaps. Continue with a new request key and
the returned sequence. Replaying an older delivery still requires current
permission for every message in that delivery.

Supply peer message text as UTF-8 stdin, at most 16 KiB, also within the server's
encoded reply budget. Keep the same
`--message-key` for a retry of the same send and the same `--request-key` for a
retry of the same nonempty receive, including its original cursor/limit. Empty
receive polls save no delivery and a retry may observe new data. Acknowledgements
must use the exact delivery and message IDs returned by receive. The CLI does
not invent a new mutation key.

A timeout after a peer request was sent is reported as `effect: "unknown"`;
it is not evidence that the mutation failed or never reached the server.

## Integration and validation status

The client code has no new package dependency. Its protocol constants and strict
parameter validator are shared with the server.

Local tests exercise real Unix sockets, frame fragmentation, bounded reads,
timeouts, cancellation, output backpressure/closure, discovery permissions,
stdin-only import and secret redaction. Cross-layer tests use the actual IPC,
grant/verifier, observation, peer-mailbox and dispatcher modules with SQLite
fixtures. Those fixtures prove the tested client/service contract, not the
availability of a particular installed service.

Before release, the complete repository still needs its normal typecheck/build
gate, and Windows needs a real Credential Manager/ACL/named-pipe smoke test.
The local Windows and Linux vault process tests inspect the fixed executable,
arguments, stdin and sanitized environment using an injected process runner;
they do not claim to have written a real OS vault entry.

The implementation includes Owner routes, service lifecycle, authority
forwarding, managed-exec environment injection and NativeHost pipe bootstrap.
They must ship with the matching client and schema in an installed release;
source code and fixture success do not prove deployment on every node.
`LOCAL_API_DISCOVERY_UNAVAILABLE` or `LOCAL_API_UNAVAILABLE` is expected when the
matching service is absent or unavailable. The CLI does not start another
service or forward owner/cluster credentials to work around that boundary.
