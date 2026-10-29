import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "./client.js";
import { migrateDatabase, LATEST_DATABASE_VERSION } from "./migrations.js";
import { SessionStore } from "../session/store.js";
import type { FileSummary } from "../session/types.js";

test("v11 adds nullable evidence times without backfilling old capture timestamps or rewriting file versions", async t => {
  const directory = await mkdtemp(join(tmpdir(), "qm-file-time-migration-")), root = join(directory, "project");
  await mkdir(root);
  const database = openDatabase(join(directory, "state")), store = new SessionStore(database.sqlite);
  t.after(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });
  const session = store.createSession("owner", "migration", "Migration");
  const member = store.addMember(session.id, "local", "workspace", root, "checkout", null);
  const task = store.createTask(session.id, "Old task", "old-task");
  store.touchTaskMember(task.id, member.id);
  const file: FileSummary & {patchRef: string} = {
    id: "file-a", member_id: member.id, status: "M", path: "a.txt", from: null,
    additions: 1, removals: 0, hash: "old-hash", large: false, binary: false,
    coverage: "partial", revertible: false, patchRef: join(directory, "patch"), recordedAt: 100,
  };
  const baseline = { session_id: session.id, member_id: member.id, repo_root: root,
    baseline_ref: "base", latest_ref: "version", coverage: "partial" as const };
  for (const taskId of [undefined, task.id]) {
    store.putChangeBaseline(baseline, taskId);
    store.replaceFileSummaries(session.id, member.id, "version", [file], taskId);
  }
  const before = ["qm_file_changes", "qm_task_file_changes"].map(table =>
    database.sqlite.prepare(`SELECT created_at,hash,version_ref FROM ${table}`).get());
  // Only this freshly created test database is taken back to the previous schema.
  database.sqlite.exec(`DROP TABLE qm_task_binding_requests;
    DROP TABLE qm_task_creation_receipts;
    DROP TABLE qm_task_bindings;
    ALTER TABLE qm_file_changes DROP COLUMN recorded_at;
    ALTER TABLE qm_task_file_changes DROP COLUMN recorded_at;
    ALTER TABLE qm_task_finalizations DROP COLUMN recovery_state;
    ALTER TABLE qm_task_finalizations DROP COLUMN finalization_revision;
    ALTER TABLE qm_task_members DROP COLUMN context_inherited;
    ALTER TABLE qm_invocations DROP COLUMN response_uses_result;
    DELETE FROM qm_schema_migrations WHERE version>=11;`);
  migrateDatabase(database.sqlite);
  for (const [index, table] of ["qm_file_changes", "qm_task_file_changes"].entries()) {
    const row = database.sqlite.prepare(`SELECT created_at,hash,version_ref,recorded_at FROM ${table}`).get() as Record<string, unknown>;
    assert.equal(row.recorded_at, null);
    const { recorded_at: _recordedAt, ...persisted } = row;
    assert.deepEqual(persisted, before[index]);
  }
  assert.equal(store.fileSummaries(session.id, member.id)[0].recordedAt, null);
  assert.equal(store.fileSummaries(session.id, member.id, task.id)[0].recordedAt, null);
  const version = database.sqlite.prepare("SELECT MAX(version) AS n FROM qm_schema_migrations").get() as {n: number};
  assert.equal(version.n, LATEST_DATABASE_VERSION);
  migrateDatabase(database.sqlite);
  assert.equal(store.fileSummaries(session.id, member.id, task.id)[0].hash, "old-hash");
});
