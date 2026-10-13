import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { openDatabase } from "../db/client.js";
import { git } from "../git.js";
import { createWorkingTreeSnapshot } from "../review-checkpoints.js";
import { SessionStore } from "./store.js";
import { SessionChangeCollector } from "./changes.js";

const execFileAsync = promisify(execFile);

async function repoFixture() {
  const directory = await mkdtemp(join(tmpdir(), "quaymesh-changes-"));
  const root = join(directory, "repo");
  await mkdir(root, { recursive: true });
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "session-test@example.invalid"]);
  await git(root, ["config", "user.name", "Session Test"]);
  await writeFile(join(root, "tracked.txt"), "base\n");
  await git(root, ["add", "tracked.txt"]);
  await git(root, ["commit", "-m", "baseline"]);
  const database = openDatabase(join(directory, "state"));
  const store = new SessionStore(database.sqlite);
  return { directory, root, database, store };
}

test("cumulative Git changes use the session baseline and preserve pre-session edits", async (t) => {
  const f = await repoFixture();
  t.after(async () => {
    f.database.close();
    await rm(f.directory, { recursive: true, force: true });
  });

  const tracked = join(f.root, "tracked.txt");
  await writeFile(tracked, "user-before-session\n");
  await writeFile(join(f.root, "preexisting.txt"), "existing-untracked\n");

  const session = f.store.createSession("owner-a", "conversation-changes", "changes");
  const member = f.store.addMember(session.id, "desktop", "workspace-a", f.root, "checkout", null);
  const collector = new SessionChangeCollector(f.store, join(f.directory, "state"));
  await collector.ensureBaseline(member, ["tracked.txt", "preexisting.txt"], f.root);
  const baseline = f.store.getChangeBaseline(session.id, member.id, f.root);
  assert.ok(baseline);
  assert.equal(baseline.baseline_ref, baseline.latest_ref);

  await writeFile(tracked, "user-before-session\npatch-a\n");
  await collector.capture(member.id);
  await writeFile(tracked, "user-before-session\npatch-a\npatch-b\n");
  await collector.capture(member.id);
  await writeFile(tracked, "user-before-session\npatch-a\n");
  await collector.capture(member.id);

  const summaries = collector.readSummaries(session.id, member.id);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]?.path, "tracked.txt");
  assert.equal(summaries[0]?.status, "M");
  assert.equal(summaries[0]?.additions, 1);
  assert.equal(summaries[0]?.removals, 0);
  assert.equal(summaries.some((file) => file.path === "preexisting.txt"), false);
  assert.equal(f.store.eventsByType(session.id, "file_changed").length, 3);

  const current = await createWorkingTreeSnapshot(f.root, baseline.baseline_ref);
  const expected = (await git(f.root, ["diff", "--numstat", "-z", baseline.baseline_ref, current])).stdout
    .split("\0").filter(Boolean)[0];
  assert.equal(expected, "1\t0\ttracked.txt");

  const beforeReads = f.store.getChangeBaseline(session.id, member.id, f.root);
  assert.ok(beforeReads);
  await collector.readSummaries(session.id, member.id);
  await collector.readSummaries(session.id, member.id);
  const afterReads = f.store.getChangeBaseline(session.id, member.id, f.root);
  assert.deepEqual(afterReads, beforeReads);
});

test("Git file diff and patch read the stored cumulative evidence", async (t) => {
  const f = await repoFixture();
  t.after(async () => {
    f.database.close();
    await rm(f.directory, { recursive: true, force: true });
  });
  const tracked = join(f.root, "tracked.txt");
  const session = f.store.createSession("owner-a", "conversation-diff", "diff");
  const member = f.store.addMember(session.id, "desktop", "workspace-a", f.root, "checkout", null);
  const collector = new SessionChangeCollector(f.store, join(f.directory, "state"));
  await collector.ensureBaseline(member, ["tracked.txt"], f.root);
  await writeFile(tracked, "base\nchanged\n");
  await collector.capture(member.id);
  const file = collector.readSummaries(session.id, member.id)[0];
  assert.ok(file);
  const diff = await collector.fileDiff(session.id, file.id, file.hash);
  assert.match(diff.patch, /\+changed/);
  const patch = await collector.patch(session.id, member.id);
  assert.match(patch.patch, /tracked\.txt/);
  await assert.rejects(collector.fileDiff(session.id, file.id, "stale"), /FILE_VERSION_STALE/);
});

test("known file writes capture incrementally while an unscoped command still observes all files", async (t) => {
  const f = await repoFixture();
  const collector = new SessionChangeCollector(f.store, join(f.directory, "state"));
  t.after(async () => { await collector.close(); f.database.close(); await rm(f.directory, { recursive: true, force: true }); });
  await writeFile(join(f.root, "other.txt"), "before\n");
  await git(f.root, ["add", "other.txt"]);
  await git(f.root, ["commit", "-m", "second file"]);
  const session = f.store.createSession("owner-a", "incremental", "incremental");
  const member = f.store.addMember(session.id, "local", "incremental", f.root, "checkout", null);
  await collector.ensureBaseline(member, ["tracked.txt"]);

  await writeFile(join(f.root, "tracked.txt"), "base\nfirst\n");
  await writeFile(join(f.root, "other.txt"), "before\nexternal\n");
  collector.markDirty(member.id, ["tracked.txt"]);
  await collector.flush();
  assert.deepEqual(collector.readSummaries(session.id, member.id).map(file => file.path), ["tracked.txt"]);

  await writeFile(join(f.root, "tracked.txt"), "base\nfirst\nsecond\n");
  collector.markDirty(member.id, ["tracked.txt"]);
  await collector.flush();
  assert.equal(collector.readSummaries(session.id, member.id)[0]?.additions, 2);

  // 命令可以修改任意文件，必须恢复完整扫描。
  collector.markDirty(member.id);
  await collector.flush();
  assert.deepEqual(collector.readSummaries(session.id, member.id).map(file => file.path), ["other.txt", "tracked.txt"]);
  const before = f.store.eventsByType(session.id, "file_changed").length;
  collector.markDirty(member.id, ["tracked.txt"]);
  await collector.flush();
  assert.equal(f.store.eventsByType(session.id, "file_changed").length, before);
});

test("incremental capture tolerates a newly created file removed before collection", async (t) => {
  const f = await repoFixture();
  const collector = new SessionChangeCollector(f.store, join(f.directory, "state"));
  t.after(async () => { await collector.close(); f.database.close(); await rm(f.directory, { recursive: true, force: true }); });
  const session = f.store.createSession("owner-a", "transient", "transient");
  const member = f.store.addMember(session.id, "local", "transient", f.root, "checkout", null);
  await collector.ensureBaseline(member, ["transient.txt"]);
  await writeFile(join(f.root, "transient.txt"), "temporary\n");
  await rm(join(f.root, "transient.txt"));
  collector.markDirty(member.id, ["transient.txt"]);
  await collector.flush();
  assert.deepEqual(collector.readSummaries(session.id, member.id), []);
});

test("ordinary directories add newly discovered paths and distinguish empty files from absence", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "quaymesh-ordinary-"));
  const root = join(directory, "files");
  await mkdir(root);
  const database = openDatabase(join(directory, "state"));
  const store = new SessionStore(database.sqlite);
  const collector = new SessionChangeCollector(store, join(directory, "state"));
  t.after(async () => { await collector.close(); database.close(); await rm(directory, { recursive: true, force: true }); });
  const session = store.createSession("owner-a", "ordinary", "ordinary");
  const member = store.addMember(session.id, "local", "ordinary", root, "checkout", null);
  await collector.ensureBaseline(member, []);
  await writeFile(join(root, "empty.txt"), "");
  await writeFile(join(root, "delete.txt"), "old\n");
  const evidence = await collector.prepareWrite(member, ["new.txt", "new-empty.txt", "empty.txt", "delete.txt"]);
  await writeFile(join(root, "new.txt"), "new\n");
  await writeFile(join(root, "new-empty.txt"), "");
  await rm(join(root, "empty.txt"));
  await rm(join(root, "delete.txt"));
  await collector.recordWrite(member, evidence);
  collector.markDirty(member.id);
  await collector.flush();
  assert.deepEqual(collector.readSummaries(session.id, member.id).map((file) => [file.path, file.status]), [
    ["delete.txt", "D"], ["empty.txt", "D"], ["new-empty.txt", "A"], ["new.txt", "A"],
  ]);
});

test("a parent workspace captures multiple child repositories without dropping the first", async (t) => {
  const f = await repoFixture();
  const collector = new SessionChangeCollector(f.store, join(f.directory, "state"));
  t.after(async () => { await collector.close(); f.database.close(); await rm(f.directory, { recursive: true, force: true }); });
  await git(f.directory, ["clone", "repo", "repo2"]);
  const session = f.store.createSession("owner-a", "nested", "nested");
  const member = f.store.addMember(session.id, "local", "parent", f.directory, "checkout", null);
  const evidence = await collector.prepareWrite(member, ["repo/tracked.txt", "repo2/tracked.txt"]);
  await writeFile(join(f.directory, "repo", "tracked.txt"), "change one\n");
  await writeFile(join(f.directory, "repo2", "tracked.txt"), "change two\n");
  await collector.recordWrite(member, evidence);
  await collector.capture(member.id);
  assert.deepEqual(collector.readSummaries(session.id, member.id).map((file) => file.path), ["repo/tracked.txt", "repo2/tracked.txt"]);
});
