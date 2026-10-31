# Recover one execution claim

[简体中文](zh-CN/execution-recovery.md)

A resource claim belongs to one command or one agent turn. The Task can stay open after that execution ends. Missing output or an unknown business result stays in the execution history; confirmed physical completion releases only that execution's resources.

Use the `claim_id` from an execution conflict to inspect its saved owner:

```json
{"workspace_id":"qm:worker:ws_example","action":"recovery","claim_id":"claim_example","recovery_action":"inspect"}
```

Call `workspace_context` with the same arguments and `recovery_action: "release"` to consume an existing completion receipt. This operation does not stop a process, change the Task result, or pause the node. The response identifies the Task, command or exact agent execution, and its physical state under `resource_recovery`.

If you intend to stop that execution, use `recovery_action: "stop"`. Commands use the existing command cancellation path; agents use the saved provider turn identity. A request cannot stop a newer turn of the same agent. Stopping a command can take time: inspect the same claim again until its resources are released. Other claims and processes remain active.

`unknown` means there is insufficient evidence to release the claim. A dead owner PID, an elapsed timeout, a successful newer agent turn, or a missing response is not a physical completion receipt. The original result remains available for reconciliation. Recovery checks the saved Task owner, node and workspace before disclosing or changing a claim.

Ordinary `read` calls keep their durable result and file-context evidence without creating a business execution or a durable runtime lease. Cancellation and other control requests retain their own execution records, even when older records used the generic `read` kind.

For a cancellation request that returned `COMMAND_NOT_ATTACHED`, inspect the cancellation's own `operation_id` with `action: "recovery"`. `recovery_action: "release"` can record physical completion only when the saved local invocation, owner generation and finish event prove that this exact guard returned before sending a signal. It preserves both unknown business results and every claim of the target command. Other cancellation errors remain unresolved. This API accepts `stop` only with a `claim_id`.

If an agent interrupt has been dispatched but its result is unconfirmed, recovery preserves `effect: "unknown"` and `retry_hint: "query_original"`. Replaying the same request returns that saved outcome instead of sending another interrupt.
