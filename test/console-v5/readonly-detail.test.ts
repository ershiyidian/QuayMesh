import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { readConsoleDetail } from "../../src/console-workbench/detail-read-model.js";
import { applyDetailReadObservation, applyArtifactReadObservation } from "../../src/console-workbench/detail-read-observation.js";
import { WorkbenchError } from "../../src/console-workbench/types.js";
import { saveRunCheckpoint } from "../../src/session/run-checkpoints.js";
import { SessionProjector } from "../../src/session/projection.js";
import { SessionOutputStore } from "../../src/session/output.js";
import { CaptureReadClock } from "../../src/session/capture-read-observation.js";
import { readonlyDetailFixture } from "./readonly-detail-fixture.js";

test("readonly detail composes Task evidence without projection writes and requires the parent's exact capture fence", async () => {
  const f = await readonlyDetailFixture();
  try {
    const before = f.changes.captureReadFence();
    const dataVersion = f.ledger.db.pragma("data_version", { simple: true });
    const result = await readConsoleDetail(f.config, { kind: "detail", runId: f.run.id }, before);
    assert.equal(f.ledger.db.pragma("data_version", { simple: true }), dataVersion);
    assert.equal(f.store.taskData.projection(f.task.id, f.member.id), null);
    assert.equal(result.value.instructions[0]?.path, "TASK-INSTRUCTIONS.md");
    assert.equal(result.value.complete, false);
    assert.equal(applyDetailReadObservation(result).complete, false);
    assert.equal(applyDetailReadObservation(result).missingPhases[0]?.pending, true);
    const observation = f.changes.captureReadObservation(result.read.scope!, before);
    const accepted = applyDetailReadObservation(result, observation);
    assert.equal(accepted.complete, true);
    assert.equal(accepted.run.actions.revert, false);
    assert.equal(applyDetailReadObservation(result, { ...observation, scope: { ...observation.scope, taskId: "other_task" } }).complete, false);
    assert.equal(applyDetailReadObservation(result, { ...observation, generation: "another-core" }).complete, false);
    const busy = applyDetailReadObservation(result, { ...observation, state: "pending" });
    assert.equal(busy.complete, false); assert.equal(busy.missingPhases[0]?.pending, true);
    assert.deepEqual(busy.warnings, result.value.warnings);
    // The legacy materialization path retains its intended persistence behavior.
    await new SessionProjector(f.store, f.config.stateDir).materialize(f.session.id, f.member.id, f.task.id);
    assert.ok(f.store.taskData.projection(f.task.id, f.member.id));
  } finally { await f.close(); }
});

test("a later Task cannot replace an older Task's evidence or fill an unbound legacy phase", async () => {
  const f = await readonlyDetailFixture();
  try {
    const next = f.store.createTask(f.session.id, "Later Task", "request_2");
    f.store.touchTaskMember(next.id, f.member.id);
    f.store.upsertContextRead({ sessionId: f.session.id, memberId: f.member.id, taskId: next.id,
      actorId: "host", path: "LATER-TASK.md", kind: "instruction", state: "read", incrementRead: true });
    const old = await readConsoleDetail(f.config, { kind: "detail", runId: f.run.id });
    assert.equal(old.read.scope?.taskId, f.task.id);
    assert.deepEqual(old.value.instructions.map(row => row.path), ["TASK-INSTRUCTIONS.md"]);
    f.ledger.db.prepare("UPDATE qm_run_links SET task_id=NULL WHERE run_id=?").run(f.run.id);
    f.store.upsertContextRead({ sessionId: f.session.id, memberId: f.member.id,
      actorId: "host", path: "LATER-SESSION-CONTEXT.md", kind: "instruction", state: "read", incrementRead: true });
    f.ledger.db.prepare("UPDATE qm_session_members SET snapshot_json=? WHERE id=?")
      .run(JSON.stringify({ workspace: { branch: "later-task-branch", baseSha: "later-task-base" } }), f.member.id);
    const legacy = await readConsoleDetail(f.config, { kind: "detail", runId: f.run.id });
    assert.equal(legacy.read.kind, "legacy"); assert.equal(legacy.value.complete, false);
    assert.deepEqual(legacy.value.instructions, []);
    assert.equal(legacy.value.run.branch, null); assert.equal(legacy.value.run.baseSha, null); assert.equal(legacy.value.run.diff, null);
    assert.ok(legacy.value.warnings.some(message => message.includes("后续任务")));
    await assert.rejects(readConsoleDetail({ ...f.config, allowedRoots: [] }, { kind: "detail", runId: f.run.id }),
      error => error instanceof WorkbenchError && error.status === 403);
  } finally { await f.close(); }
});

test("patch pages are bounded, revision bound, and confined to their Task evidence directory", async () => {
  const f = await readonlyDetailFixture();
  try {
    const path = join(f.config.stateDir, "session-evidence", f.session.id, f.member.id, f.task.id);
    await mkdir(path, { recursive: true });
    const patchRef = join(path, "patch.bin"), patch = "diff --git a/a b/a\n" + "+中文\n".repeat(14000);
    await writeFile(patchRef, patch);
    f.store.taskData.putBaseline(f.task.id, { session_id: f.session.id, member_id: f.member.id,
      repo_root: f.root, baseline_ref: "base", latest_ref: "version_1", coverage: "session_owned" });
    f.store.taskData.replaceFiles(f.task.id, f.session.id, f.member.id, "version_1", [{ id: "file_1", member_id: f.member.id,
      status: "M", path: "a", from: null, additions: 14000, removals: 0, hash: "hash_1", large: false,
      binary: false, coverage: "session_owned", revertible: true, patchRef }]);
    const before = f.changes.captureReadFence();
    const first = await readConsoleDetail(f.config, { kind: "patch", runId: f.run.id }, before);
    assert.equal(first.kind, "patch");
    if (first.kind !== "patch") throw new Error("wrong kind");
    const page1 = applyArtifactReadObservation(first, f.changes.captureReadObservation(first.read.scope!, before));
    assert.ok(Buffer.byteLength(page1.patch) <= 64 * 1024);
    assert.equal(page1.complete, false); assert.ok(page1.nextCursor);
    const second = await readConsoleDetail(f.config, { kind: "patch", runId: f.run.id, cursor: page1.nextCursor! }, before);
    if (second.kind !== "patch") throw new Error("wrong kind");
    const page2 = applyArtifactReadObservation(second, f.changes.captureReadObservation(second.read.scope!, before));
    assert.equal(page2.complete, true); assert.equal(page1.patch + page2.patch, `# a\n${patch}`);
    const frozen = await new SessionProjector(f.store, f.config.stateDir).readSnapshot(f.session.id, f.member.id, f.task.id);
    saveRunCheckpoint(f.ledger.db, f.run.id, { revision: frozen.rev, snapshot: frozen,
      files: f.store.fileSummaries(f.session.id, f.member.id, f.task.id) });
    await assert.rejects(readConsoleDetail(f.config, { kind: "patch", runId: f.run.id, cursor: page1.nextCursor! }, before),
      error => error instanceof WorkbenchError && error.code === "revision_conflict");
    f.ledger.db.prepare("UPDATE qm_run_checkpoints SET snapshot_json=? WHERE run_id=?")
      .run(JSON.stringify({ ...frozen, changeSummary: { state: "incomplete", error: "fixture capture failed" } }), f.run.id);
    f.ledger.db.prepare("UPDATE qm_tasks SET change_summary_state='complete' WHERE id=?").run(f.task.id);
    await assert.rejects(readConsoleDetail(f.config, { kind: "patch", runId: f.run.id }, before),
      error => error instanceof WorkbenchError && error.code === "task_incomplete");
    f.ledger.db.prepare("DELETE FROM qm_run_checkpoints WHERE run_id=?").run(f.run.id);
    const clock = new CaptureReadClock(), changedBefore = clock.fence();
    clock.touch(f.member.id, f.task.id);
    assert.throws(() => applyArtifactReadObservation({ ...first, read: { ...first.read, fence: changedBefore } },
      clock.observe(first.read.scope!, changedBefore, { state: "idle", error: null })), error => error instanceof WorkbenchError && error.code === "revision_conflict");
    f.ledger.db.prepare("UPDATE qm_task_file_changes SET hash='hash_2' WHERE task_id=?").run(f.task.id);
    await assert.rejects(readConsoleDetail(f.config, { kind: "patch", runId: f.run.id, cursor: page1.nextCursor! }, before),
      error => error instanceof WorkbenchError && error.code === "revision_conflict");
    const outside = join(f.directory, "outside.patch"); await writeFile(outside, "private");
    f.ledger.db.prepare("UPDATE qm_task_file_changes SET patch_ref=? WHERE task_id=?").run(outside, f.task.id);
    await assert.rejects(readConsoleDetail(f.config, { kind: "patch", runId: f.run.id }, before),
      error => error instanceof WorkbenchError && error.code === "artifact_scope");
  } finally { await f.close(); }
});

test("saved command output requires an exact operation/run association", async () => {
  const f = await readonlyDetailFixture();
  const output = new SessionOutputStore(f.config.stateDir);
  try {
    const id = f.ledger.operation({ runId: f.run.id, requestKey: "command", kind: "command", label: "fixture", status: "completed" });
    await output.open(f.session.id, id, id); await output.append(id, "保存的输出"); await output.finish(id, 0, null);
    const result = await readConsoleDetail(f.config, { kind: "command-output", runId: f.run.id, commandId: id });
    if (result.kind !== "command-output") throw new Error("wrong kind");
    const page = applyArtifactReadObservation(result);
    assert.equal(page.chunk, "保存的输出"); assert.equal(page.outputState, "ready");
    const partialId = f.ledger.operation({ runId: f.run.id, requestKey: "partial", kind: "command", label: "partial UTF-8", status: "completed" });
    await output.open(f.session.id, partialId, partialId); await output.append(partialId, Buffer.from([0xe4, 0xb8]));
    const partial = await readConsoleDetail(f.config, { kind: "command-output", runId: f.run.id, commandId: partialId });
    if (partial.kind !== "command-output") throw new Error("wrong kind");
    assert.equal(partial.value.cursor, 0); assert.equal(partial.value.hasMore, false);
    assert.equal(partial.value.done, false); assert.equal(partial.value.outputState, "writing");
    await assert.rejects(readConsoleDetail(f.config, { kind: "command-output", runId: f.run.id, commandId: id, expectedTaskId: "another_task" }),
      error => error instanceof WorkbenchError && error.code === "task_scope");
    await assert.rejects(readConsoleDetail(f.config, { kind: "command-output", runId: f.run.id, commandId: id, expectedSessionId: f.session.id }),
      error => error instanceof WorkbenchError && error.code === "task_scope");
    await assert.rejects(readConsoleDetail(f.config, { kind: "command-output", runId: f.run.id, commandId: id,
      expectedTaskId: f.task.id, expectedSessionId: f.session.id }), error => error instanceof WorkbenchError && error.code === "invalid_read");
    const scoped = await readConsoleDetail(f.config, { kind: "command-output", runId: f.run.id, commandId: id, expectedTaskId: f.task.id });
    assert.equal(scoped.kind, "command-output");
    const other = f.ledger.begin({ root: f.root, workItemId: "other", runKey: "other", title: "Other phase",
      origin: { entryPoint: "console", evidence: "server_entry" } });
    f.store.linkRun(f.session.id, f.member.id, other.id, f.task.id);
    await assert.rejects(readConsoleDetail(f.config, { kind: "command-output", runId: other.id, commandId: id }),
      error => error instanceof WorkbenchError && error.code === "command_not_found");
    f.ledger.db.prepare("UPDATE qm_run_links SET task_id=NULL WHERE run_id=?").run(f.run.id);
    const legacy = await readConsoleDetail(f.config, { kind: "command-output", runId: f.run.id, commandId: id, expectedTaskId: f.session.id });
    assert.equal(legacy.kind, "command-output");
    const sessionScoped = await readConsoleDetail(f.config, { kind: "command-output", runId: f.run.id, commandId: id, expectedSessionId: f.session.id });
    assert.equal(sessionScoped.kind, "command-output");
    f.ledger.db.prepare(`INSERT INTO qm_tasks(id,session_id,title,revision,state,start_sequence,created_at,last_activity_at,source_kind)
      SELECT ?,session_id,'real Task with a legacy-looking ID',0,'active',start_sequence,created_at,last_activity_at,source_kind FROM qm_tasks WHERE id=?`)
      .run(f.session.id, f.task.id);
    await assert.rejects(readConsoleDetail(f.config, { kind: "command-output", runId: f.run.id, commandId: id, expectedTaskId: f.session.id }),
      error => error instanceof WorkbenchError && error.code === "task_scope");
  } finally { await output.close(); await f.close(); }
});
