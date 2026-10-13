import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { openDatabase } from "../db/client.js";
import { ExecutionCoordinator } from "../execution-coordinator.js";
import { git } from "../git.js";
import { SessionChangeCollector } from "./changes.js";
import { SessionReverter } from "./revert.js";
import { SessionStore } from "./store.js";

const execFileAsync = promisify(execFile);

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "quaymesh-revert-"));
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
  const collector = new SessionChangeCollector(store, join(directory, "state"));
  const execution = new ExecutionCoordinator(join(directory, "state"));
  const reverter = new SessionReverter(store, join(directory, "state"), execution, collector);
  return { directory, root, database, store, collector, execution, reverter };
}

async function sessionFixture(f: Awaited<ReturnType<typeof fixture>>) {
  const session = f.store.createSession("owner-a", `conversation-${Date.now()}`, "revert");
  const member = f.store.addMember(session.id, "desktop", "workspace-a", f.root, "checkout", null);
  await f.collector.ensureBaseline(member, ["tracked.txt", "preexisting.txt"], f.root);
  return { session, member };
}

test("revert restores only changes recorded after the session baseline", async (t) => {
  const f = await fixture();
  t.after(async () => {
    f.execution.close();
    f.database.close();
    await rm(f.directory, { recursive: true, force: true });
  });

  await writeFile(join(f.root, "tracked.txt"), "dirty-before\n");
  await writeFile(join(f.root, "preexisting.txt"), "keep me\n");
  const { session, member } = await sessionFixture(f);

  const evidence = await f.collector.prepareWrite(member, ["tracked.txt"]);
  await writeFile(join(f.root, "tracked.txt"), "dirty-before\nsession-change\n");
  await f.collector.recordWrite(member, evidence);
  await f.collector.capture(member.id);
  const snapshot = f.store.getMember(session.id, member.id);
  const eligibility = await f.reverter.eligibility("owner-a", session.id, member.id);
  assert.equal(eligibility.allowed, true);

  const result = await f.reverter.revert("owner-a", session.id, member.id, snapshot.revision, true);
  assert.deepEqual(result.changed_paths, ["tracked.txt"]);
  assert.equal(await readFile(join(f.root, "tracked.txt"), "utf8"), "dirty-before\n");
  assert.equal(await readFile(join(f.root, "preexisting.txt"), "utf8"), "keep me\n");
});

test("revert refuses to overwrite a later external edit", async (t) => {
  const f = await fixture();
  t.after(async () => {
    f.execution.close();
    f.database.close();
    await rm(f.directory, { recursive: true, force: true });
  });

  const { session, member } = await sessionFixture(f);
  const evidence = await f.collector.prepareWrite(member, ["tracked.txt"]);
  await writeFile(join(f.root, "tracked.txt"), "session-change\n");
  await f.collector.recordWrite(member, evidence);
  await f.collector.capture(member.id);
  await writeFile(join(f.root, "tracked.txt"), "external-change\n");
  const snapshot = f.store.getMember(session.id, member.id);

  await assert.rejects(
    f.reverter.revert("owner-a", session.id, member.id, snapshot.revision, true),
    /REVERT_CONFLICT/,
  );
  assert.equal(await readFile(join(f.root, "tracked.txt"), "utf8"), "external-change\n");
});

test("revert leaves a user's parallel edit in another file intact", async (t) => {
  const f = await fixture();
  t.after(async () => { await f.collector.close(); f.execution.close(); f.database.close(); await rm(f.directory, { recursive: true, force: true }); });
  await writeFile(join(f.root, "user.txt"), "original\n");
  const { session, member } = await sessionFixture(f);
  const evidence = await f.collector.prepareWrite(member, ["tracked.txt"]);
  await writeFile(join(f.root, "tracked.txt"), "agent change\n");
  await writeFile(join(f.root, "user.txt"), "user change\n");
  await f.collector.recordWrite(member, evidence);
  await f.collector.capture(member.id);
  const files = f.collector.readSummaries(session.id, member.id);
  assert.equal(files.find((file) => file.path === "user.txt")?.revertible, false);
  const result = await f.reverter.revert("owner-a", session.id, member.id, f.store.getMember(session.id, member.id).revision, true);
  assert.deepEqual(result.changed_paths, ["tracked.txt"]);
  assert.equal(await readFile(join(f.root, "tracked.txt"), "utf8"), "base\n");
  assert.equal(await readFile(join(f.root, "user.txt"), "utf8"), "user change\n");
});

test("an external edit between two tracked writes removes automatic revert ownership", async (t) => {
  const f = await fixture();
  t.after(async () => { await f.collector.close(); f.execution.close(); f.database.close(); await rm(f.directory, { recursive: true, force: true }); });
  const { session, member } = await sessionFixture(f);
  let evidence = await f.collector.prepareWrite(member, ["tracked.txt"]);
  await writeFile(join(f.root, "tracked.txt"), "first agent change\n");
  await f.collector.recordWrite(member, evidence);
  await writeFile(join(f.root, "tracked.txt"), "first agent change\nuser content\n");
  evidence = await f.collector.prepareWrite(member, ["tracked.txt"]);
  await writeFile(join(f.root, "tracked.txt"), "second agent change\nuser content\n");
  await f.collector.recordWrite(member, evidence);
  await f.collector.capture(member.id);
  assert.equal(f.collector.readSummaries(session.id, member.id)[0]?.revertible, false);
  await assert.rejects(f.reverter.revert("owner-a", session.id, member.id, f.store.getMember(session.id, member.id).revision, true), /REVERT_NOT_ALLOWED/);
  assert.match(await readFile(join(f.root, "tracked.txt"), "utf8"), /user content/);
});

test("revert reads ownership evidence from the current task directory", async (t) => {
  const f = await fixture();
  t.after(async () => { await f.collector.close(); f.execution.close(); f.database.close(); await rm(f.directory, { recursive: true, force: true }); });
  const session = f.store.createSession("owner-a", `conversation-${Date.now()}`, "task-scoped revert");
  const member = f.store.addMember(session.id, "desktop", "workspace-a", f.root, "checkout", null);
  const task = f.store.createTask(session.id, "task-scoped revert");
  await f.collector.ensureBaseline(member, ["tracked.txt"], f.root, task.id);
  const evidence = await f.collector.prepareWrite(member, ["tracked.txt"], f.root, task.id);
  await writeFile(join(f.root, "tracked.txt"), "task change\n");
  await f.collector.recordWrite(member, evidence, task.id);
  await f.collector.capture(member.id,task.id);
  const result = await f.reverter.revert("owner-a", session.id, member.id, f.store.getMember(session.id, member.id).revision, true);
  assert.deepEqual(result.changed_paths, ["tracked.txt"]);
  assert.equal(await readFile(join(f.root, "tracked.txt"), "utf8"), "base\n");
});

test("a recorded rename restores both paths", async (t) => {
  const f = await fixture();
  t.after(async () => { await f.collector.close(); f.execution.close(); f.database.close(); await rm(f.directory, { recursive: true, force: true }); });
  const { session, member } = await sessionFixture(f);
  const evidence = await f.collector.prepareWrite(member, ["tracked.txt", "renamed.txt"]);
  await rename(join(f.root, "tracked.txt"), join(f.root, "renamed.txt"));
  await f.collector.recordWrite(member, evidence);
  await f.collector.capture(member.id);
  await f.reverter.revert("owner-a", session.id, member.id, f.store.getMember(session.id, member.id).revision, true);
  assert.equal(await readFile(join(f.root, "tracked.txt"), "utf8"), "base\n");
  await assert.rejects(readFile(join(f.root, "renamed.txt")), { code: "ENOENT" });
});
