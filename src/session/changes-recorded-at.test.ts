import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { openDatabase } from "../db/client.js";
import { git } from "../git.js";
import { SessionChangeCollector } from "./changes.js";
import { SessionStore } from "./store.js";

const epoch = Date.parse("2026-10-28T06:00:00.000Z");
async function fixture(t: TestContext, options: { task?: boolean; git?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "qm-file-time-")), root = join(directory, "project"), stateDir = join(directory, "state");
  await mkdir(root);
  await writeFile(join(root, "a.txt"), "baseline\n");
  if (options.git !== false) {
    await git(root, ["init"]);
    await git(root, ["config", "user.email", "file-time@example.invalid"]);
    await git(root, ["config", "user.name", "File time test"]);
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "baseline"]);
  }
  let database = openDatabase(stateDir), store = new SessionStore(database.sqlite);
  const session = store.createSession("owner", "file-time-test", "File time test");
  const member = store.addMember(session.id, "local", "workspace", root, "checkout", null);
  const taskId = options.task ? store.createTask(session.id, "Task file time", "task-time").id : undefined;
  if (taskId) store.touchTaskMember(taskId, member.id);
  let collector = new SessionChangeCollector(store, stateDir);
  t.after(async () => { await collector.close(); database.close(); await rm(directory, { recursive: true, force: true }); });
  await collector.ensureBaseline(member, ["a.txt", "b.txt", "binary.bin", "large.txt"], root, taskId);
  return {
    root, session, member, taskId,
    get database() { return database; },
    get collector() { return collector; },
    files: () => collector.readSummaries(session.id, member.id, taskId),
    capture: () => collector.capture(member.id, taskId),
    async restart() {
      await collector.close(); database.close();
      database = openDatabase(stateDir); store = new SessionStore(database.sqlite);
      collector = new SessionChangeCollector(store, stateDir);
    },
  };
}

for (const task of [false, true]) {
  test(`${task ? "Task" : "legacy session"} file times survive unchanged captures, other-file edits, rollback and restart`, async t => {
    t.mock.timers.enable({ apis: ["Date"], now: epoch });
    const f = await fixture(t, { task });
    const firstBody = "baseline\nfirst change\n";
    await writeFile(join(f.root, "a.txt"), firstBody);
    await f.capture();
    const first = f.files()[0];
    assert.equal(first.recordedAt, epoch);
    t.mock.timers.setTime(epoch + 1_000);
    await f.capture();
    assert.equal(f.files()[0].recordedAt, epoch);
    assert.equal(f.files()[0].hash, first.hash);

    t.mock.timers.setTime(epoch + 2_000);
    await writeFile(join(f.root, "b.txt"), "other file changed\n");
    await f.capture();
    const a = f.files().find(file => file.path === "a.txt")!;
    assert.equal(a.recordedAt, epoch, "whole-tree version changes cannot make A look newly edited");
    assert.notEqual(a.hash, first.hash, "keep the existing whole-tree public version guard");
    assert.equal(f.files().find(file => file.path === "b.txt")!.recordedAt, epoch + 2_000);
    await assert.rejects(f.collector.fileDiff(f.session.id, first.id, first.hash, f.taskId), /FILE_VERSION_STALE/);

    t.mock.timers.setTime(epoch + 3_000);
    await writeFile(join(f.root, "a.txt"), firstBody + "second change\n");
    await f.capture();
    assert.equal(f.files().find(file => file.path === "a.txt")!.recordedAt, epoch + 3_000);
    t.mock.timers.setTime(epoch + 4_000);
    await writeFile(join(f.root, "a.txt"), firstBody);
    await f.capture();
    const restored = f.files().find(file => file.path === "a.txt")!;
    assert.equal(restored.hash, a.hash, "returning to a content version preserves the original public hash semantics");
    assert.equal(restored.recordedAt, epoch + 4_000, "returning to an earlier version is a new change");
    assert.equal(f.files().find(file => file.path === "b.txt")!.recordedAt, epoch + 2_000);
    t.mock.timers.setTime(epoch + 5_000);
    await f.restart();
    assert.equal(f.files().find(file => file.path === "a.txt")!.recordedAt, epoch + 4_000);
    await f.capture();
    assert.equal(f.files().find(file => file.path === "a.txt")!.recordedAt, epoch + 4_000);
    assert.equal(f.files().find(file => file.path === "b.txt")!.recordedAt, epoch + 2_000);
  });
}

test("ordinary file evidence keeps time and content identity independent, including deletion and reappearance", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: epoch });
  const f = await fixture(t, { task: true, git: false });
  await writeFile(join(f.root, "a.txt"), "first\n");
  await f.capture();
  const first = f.files()[0];
  t.mock.timers.setTime(epoch + 1_000);
  await writeFile(join(f.root, "b.txt"), "b\n");
  await f.capture();
  assert.equal(f.files().find(file => file.path === "a.txt")!.recordedAt, epoch);
  assert.equal(f.files().find(file => file.path === "a.txt")!.hash, first.hash);
  const version = f.database.sqlite.prepare("SELECT latest_ref FROM qm_task_change_baselines WHERE task_id=?").get(f.taskId) as {latest_ref: string};
  t.mock.timers.setTime(epoch + 2_000);
  await f.capture();
  assert.deepEqual(f.database.sqlite.prepare("SELECT latest_ref FROM qm_task_change_baselines WHERE task_id=?").get(f.taskId), version);
  t.mock.timers.setTime(epoch + 3_000);
  await writeFile(join(f.root, "a.txt"), "baseline\n");
  await f.capture();
  assert.equal(f.files().some(file => file.path === "a.txt"), false);
  t.mock.timers.setTime(epoch + 4_000);
  await writeFile(join(f.root, "a.txt"), "first\n");
  await f.capture();
  assert.equal(f.files().find(file => file.path === "a.txt")!.recordedAt, epoch + 4_000);
  assert.equal(f.files().find(file => file.path === "a.txt")!.hash, first.hash);
});

test("binary and large Git evidence uses the complete patch and retains stale-version protection", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: epoch });
  const f = await fixture(t, { task: true });
  await writeFile(join(f.root, "binary.bin"), Buffer.from([0, 1, 2, 3]));
  await writeFile(join(f.root, "large.txt"), "x".repeat(1_100_000) + "\n");
  await f.capture();
  const binary = f.files().find(file => file.path === "binary.bin")!;
  const large = f.files().find(file => file.path === "large.txt")!;
  assert.equal(binary.binary, true); assert.equal(large.large, true);
  t.mock.timers.setTime(epoch + 1_000);
  await writeFile(join(f.root, "b.txt"), "only B changed\n");
  await f.capture();
  assert.equal(f.files().find(file => file.path === "binary.bin")!.recordedAt, epoch);
  assert.equal(f.files().find(file => file.path === "large.txt")!.recordedAt, epoch);
  t.mock.timers.setTime(epoch + 2_000);
  await writeFile(join(f.root, "binary.bin"), Buffer.from([0, 1, 2, 4]));
  await writeFile(join(f.root, "large.txt"), "x".repeat(1_100_000) + "changed\n");
  await f.capture();
  for (const previous of [binary, large]) {
    const current = f.files().find(file => file.id === previous.id)!;
    assert.equal(current.recordedAt, epoch + 2_000);
    assert.notEqual(current.hash, previous.hash);
    await assert.rejects(f.collector.fileDiff(f.session.id, previous.id, previous.hash, f.taskId), /FILE_VERSION_STALE/);
  }
});

test("a path rename records new evidence and repeated capture keeps that time", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: epoch });
  const f = await fixture(t);
  await writeFile(join(f.root, "a.txt"), "baseline\nchanged\n");
  await f.capture();
  t.mock.timers.setTime(epoch + 1_000);
  await rename(join(f.root, "a.txt"), join(f.root, "renamed.txt"));
  await f.capture();
  const renamed = f.files().find(file => file.path === "renamed.txt")!;
  assert.equal(renamed.recordedAt, epoch + 1_000);
  t.mock.timers.setTime(epoch + 2_000);
  await f.capture();
  assert.equal(f.files().find(file => file.path === "renamed.txt")!.recordedAt, epoch + 1_000);
});

test("unproven historical timestamps remain null until that file's evidence actually changes", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: epoch });
  const f = await fixture(t, { task: true });
  await writeFile(join(f.root, "a.txt"), "historic change\n");
  await f.capture();
  f.database.sqlite.prepare("UPDATE qm_task_file_changes SET recorded_at=NULL WHERE task_id=?").run(f.taskId);
  t.mock.timers.setTime(epoch + 1_000);
  await writeFile(join(f.root, "b.txt"), "new B\n");
  await f.capture();
  assert.equal(f.files().find(file => file.path === "a.txt")!.recordedAt, null);
  assert.equal(f.files().find(file => file.path === "b.txt")!.recordedAt, epoch + 1_000);
  t.mock.timers.setTime(epoch + 2_000);
  await writeFile(join(f.root, "a.txt"), "new A\n");
  await f.capture();
  assert.equal(f.files().find(file => file.path === "a.txt")!.recordedAt, epoch + 2_000);
});
