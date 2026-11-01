# Upgrading while preserving unresolved execution history

[简体中文](../zh-CN/operations/PRESERVE-HISTORY-UPGRADES.md)

Use this procedure with a release and a reviewed maintenance provider that both implement the **preserve-v2** protocol. It replaces the verified service process domain while retaining unresolved execution records and their resource claims. Protected processes outside that domain must remain alive with the same process identities.

## Select the policy explicitly

| Policy | Behavior |
| --- | --- |
| `prove` — default | Ordinary maintenance must drain. An explicit external provider may supply reviewed physical completion evidence. A rejected drain never automatically selects another policy. |
| `preserve` — explicit | Requires an external provider, a running old service, and the complete reviewed historical set. Unknown outcomes and claims remain recorded; they are not treated as proof that the node is idle. |

The activation API is:

```js
await activateInstallation(preparedManifest, {
  maintenanceLease: reviewedProvider,
  historyPolicy: "preserve",
});
```

`activateInstallation` is exported by `node/install.mjs`. `reviewedProvider` must implement the existing `acquire`, `assertHeld`, and `release` contract. This example is not a standalone command or a new `--force` option. The installer fixes the policy in a version 2 context; the provider must return the same version and policy. A provider cannot select preservation by itself.

## Required boundaries

1. **Acquire the exact maintenance window.** Verify the prepared manifest, old release, node, manager/Core process generations, admission ownership, complete subjects, and complete claims. Close the relevant entry points. Current service work, queues, waiters, and persisted runtime work must be drained; retained historical claims do not satisfy that condition by themselves.
2. **Keep all four checks.** The provider must supply fresh census evidence at `before_backup`, `after_backup`, `before_stop`, and `after_stop`. The installer takes its database backup by default. An explicit `backup: false` uses the [same-version read-only check](../INSTALL.md#upgrade) instead; all four stage names and every identity/counter check remain mandatory. Changed, missing, or additional historical identities reject the attempt. Protected outside processes are not part of the stop domain.
3. **Validate the new generation while paused.** The installation transition keeps admission closed. During preservation, startup reconciliation and session background maintenance are deferred so they cannot rewrite the reviewed history before validation. The new Core must report the expected release/runtime identity and complete the ordinary stability window.
4. **Verify retention without recording completion.** The separate `verify-retained` action opens SQLite read-only and compares the full subjects, claim fingerprints, and historical uncertainty counters against the installer’s pinned identity. It neither calls the physical receipt writer nor deletes claims. `quiescent` and `idle` retain their ordinary meaning; unresolved physical work or claims can keep them false after a successful upgrade.
5. **Release only the owned fence.** Recheck the retained set and protected processes before restoring admission. Confirm the exact transition has been released and admission has reopened. Normal reconciliation then resumes; an unproven claim is not released merely because its old owner exited.

### Schema compatibility is explicit

Preserve-v2 inspection reports `protocolVersion: 2` and `claimFingerprintVersion: 2`. `retainableCommandClaims` supports schema version 16 and newer. Its only normalization is the exact version 18 migration: absent `execution_id`, `execution_generation`, and `owner_process_start` claim columns map to `NULL`, matching the migration’s nullable additions without backfill.

The fingerprint still covers the complete claim row and its execution subject/owner. Existing values, non-`NULL` additions, changed fields, and unreviewed future columns are not ignored. The default `prove` fingerprint is unchanged. Collect and review a new preserve-v2 set; do not reuse a different protocol’s fingerprints.

## Failure and later recovery

Before any stop attempt, compensation may release only this attempt's verified pause and transition. After a stop attempt, a failed `preserve` activation keeps the database, any created backup, lease, and `recovery_required` record. It does **not** automatically start the previous binary, even when the schema version is unchanged: that binary may not understand the preservation gate. A failed admission release after activation has committed keeps the verified new service for explicit reconciliation.

Recovery must use the saved attempt, manifest, database version, any recorded backup, and current process identities. Re-review the state before restarting a service or releasing a fence; the maintenance record does not expire automatically.

After a successful upgrade, inspect retained claims individually by their original Task, operation/execution, generation, and physical evidence. A surviving quiet process must remain protected. A business result, an old owner’s exit, or 30 minutes without Task activity is not physical completion evidence. The 30-minute presentation rule does not close Tasks, stop processes, or expire resource claims. Retained claims can still block conflicting work until their exact physical boundary is established.

Implementation: [installation and rollback](../../node/install.mjs), [lease checks](../../node/maintenance-lease.mjs), [read-only verification](../../node/maintenance-proof.mjs), and [historical identities](../../src/maintenance-status.ts).
