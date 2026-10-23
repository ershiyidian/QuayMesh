import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import filesystem, { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { openDatabase } from "../db/client.js";
import { ExecutionCoordinator } from "../execution-coordinator.js";
import { git } from "../git.js";
import { canonicalWorkspaceRoot } from "../roots.js";
import { WriteReceipts } from "../console-workbench/receipts.js";
import { SessionChangeCollector } from "./changes.js";
import { SessionReverter, RevertPreconditionError } from "./revert.js";
import { SessionStore } from "./store.js";

const execFileAsync = promisify(execFile);

async function waitForPublication(entered: Promise<void>, capture: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      entered,
      capture.then(() => { throw new Error("Capture completed without reaching its publication callback"); }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Capture did not reach its publication callback within 15 seconds")), 15_000);
      }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

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

test("direct revert rejects pending and failed capture before selecting files or acquiring mutation scopes", { timeout: 60_000 }, async t => {
  const f = await fixture();
  t.after(async () => { await f.collector.close(); f.execution.close(); f.database.close(); await rm(f.directory, { recursive: true, force: true }); }, { timeout: 20_000 });
  const { session, member } = await sessionFixture(f);
  const writeOwned = async (text: string) => {
    const evidence = await f.collector.prepareWrite(member, ["tracked.txt"]);
    await writeFile(join(f.root, "tracked.txt"), text);
    await f.collector.recordWrite(member, evidence);
  };
  await writeOwned("first change\n"); await f.collector.capture(member.id);
  await writeOwned("second change\n");
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.collector.setCaptureListener(async () => { entered(); await gate; });
  const pending = f.collector.capture(member.id);
  void pending.catch(() => undefined);
  try {
    await waitForPublication(reached, pending);
    let selections = 0, claims = 0;
    const files = f.store.fileSummaries.bind(f.store), acquire = f.execution.acquire.bind(f.execution);
    t.mock.method(f.store, "fileSummaries", (...args: Parameters<typeof files>) => { selections++; return files(...args); });
    t.mock.method(f.execution, "acquire", (...args: Parameters<typeof acquire>) => { claims++; return acquire(...args); });
    for (const state of ["pending", "failed"] as const) {
      if (state === "failed") {
        release(); await pending;
        await writeOwned("third change\n");
        f.collector.setCaptureListener(() => { throw new Error("capture delivery failed"); });
        await assert.rejects(f.collector.capture(member.id), /capture delivery failed/);
        selections = 0; claims = 0;
      }
      assert.equal(f.collector.captureObservation(member.id).state, state);
      const eligibility = await f.reverter.eligibility("owner-a", session.id, member.id);
      assert.equal(eligibility.allowed, false); assert.match(eligibility.reason!, /采集.*刷新/);
      await assert.rejects(f.reverter.revert("owner-a", session.id, member.id, f.store.getMember(session.id, member.id).revision, true),
        error => error instanceof RevertPreconditionError && error.code === `file_capture_${state}` && error.effect === "none");
      assert.equal(selections, 0); assert.equal(claims, 0);
      assert.equal(await readFile(join(f.root, "tracked.txt"), "utf8"), state === "pending" ? "second change\n" : "third change\n");
      assert.equal(f.store.eventsForSession(session.id).filter(event => event.type === "operation_started").length, 0);
    }
  } finally {
    release(); f.collector.setCaptureListener(() => undefined);
    if (f.collector.captureObservation(member.id).state === "failed") await f.collector.capture(member.id);
  }
});

test("revert rechecks capture immediately before writing even when collection starts after its claim", async t => {
  const f = await fixture();
  t.after(async () => { await f.collector.close(); f.execution.close(); f.database.close(); await rm(f.directory, { recursive: true, force: true }); });
  const { session, member } = await sessionFixture(f);
  const evidence = await f.collector.prepareWrite(member, ["tracked.txt"]);
  await writeFile(join(f.root, "tracked.txt"), "keep this until evidence is ready\n");
  await f.collector.recordWrite(member, evidence); await f.collector.capture(member.id);
  let scheduled = false;
  const detach = f.store.onChange(({ sequence }) => {
    const event = f.database.sqlite.prepare("SELECT event_type,data_json FROM qm_events WHERE sequence=?").get(sequence) as { event_type: string; data_json: string };
    if (!scheduled && event.event_type === "operation_started" && JSON.parse(event.data_json).label === "Revert session changes") {
      scheduled = true;
      f.collector.markDirty(member.id, ["tracked.txt"]);
    }
  });
  try {
    await assert.rejects(f.reverter.revert("owner-a", session.id, member.id, f.store.getMember(session.id, member.id).revision, true),
      error => error instanceof RevertPreconditionError && error.code === "file_capture_pending" && error.effect === "none");
    assert.equal(scheduled, true);
    assert.equal(await readFile(join(f.root, "tracked.txt"), "utf8"), "keep this until evidence is ready\n");
    assert.equal(f.execution.inspect(f.root).length, 0);
    const finished = f.store.eventsForSession(session.id).filter(event => event.type === "operation_finished");
    assert.equal(finished.length, 1); assert.equal(finished[0]?.payload.effect, "not_started");
  } finally { detach(); await f.collector.flush(); }
});

test("an explicit legacy revert scope does not inherit or mutate a later Task with failed capture", async t => {
  const f = await fixture();
  t.after(async () => { await f.collector.close(); f.execution.close(); f.database.close(); await rm(f.directory, { recursive: true, force: true }); });
  const { session, member } = await sessionFixture(f);
  const evidence = await f.collector.prepareWrite(member, ["tracked.txt"]);
  await writeFile(join(f.root, "tracked.txt"), "legacy change\n");
  await f.collector.recordWrite(member, evidence); await f.collector.capture(member.id);
  const current = f.store.createTask(session.id, "later task");
  await f.collector.ensureBaseline(member, ["next.txt"], f.root, current.id);
  const currentEvidence = await f.collector.prepareWrite(member, ["next.txt"], f.root, current.id);
  await writeFile(join(f.root, "next.txt"), "later task change\n");
  await f.collector.recordWrite(member, currentEvidence, current.id);
  f.collector.setCaptureListener((_session, _member, taskId) => { if (taskId === current.id) throw new Error("later task capture failed"); });
  try {
    await assert.rejects(f.collector.capture(member.id, current.id), /later task capture failed/);
    assert.equal((await f.reverter.eligibility("owner-a", session.id, member.id)).allowed, false);
    const legacy = await f.reverter.eligibility("owner-a", session.id, member.id, undefined, null);
    assert.equal(legacy.allowed, true); assert.deepEqual(legacy.paths, ["tracked.txt"]);
    const taskRevision = f.store.getTask(current.id).revision;
    await f.reverter.revert("owner-a", session.id, member.id, legacy.revision, true, undefined, null);
    assert.equal(await readFile(join(f.root, "tracked.txt"), "utf8"), "base\n");
    assert.equal(await readFile(join(f.root, "next.txt"), "utf8"), "later task change\n");
    assert.equal(f.store.getTask(current.id).revision, taskRevision);
    const operations = f.store.eventsForSession(session.id).filter(event => event.type === "operation_started" || event.type === "operation_finished");
    assert.equal(operations.length, 2); assert.ok(operations.every(event => event.task_id === null));
  } finally { f.collector.setCaptureListener(() => undefined); await f.collector.capture(member.id, current.id); }
});

test("a restore that changes a file before rejecting records unknown effects and cannot replay its receipt", async t => {
  const f = await fixture();
  t.after(async () => { await f.collector.close(); f.execution.close(); f.database.close(); await rm(f.directory, { recursive: true, force: true }); });
  const { session, member } = await sessionFixture(f), path = join(f.root, "tracked.txt");
  const evidence = await f.collector.prepareWrite(member, ["tracked.txt"]);
  await writeFile(path, "owned change\n");
  await f.collector.recordWrite(member, evidence); await f.collector.capture(member.id);
  const revision = f.store.getMember(session.id, member.id).revision;
  const receipts = new WriteReceipts(join(f.directory, "state"));
  let attempts = 0;
  const execute = () => receipts.execute("revert", "restore-error", "/revert", { member: member.id, revision }, () => {
    attempts++;
    return f.reverter.revert("owner-a", session.id, member.id, revision, true);
  });
  const actualRename = filesystem.rename;
  const targetPath = canonicalWorkspaceRoot(path);
  // Inject a failure after the real replacement, just as a later chmod may fail.
  // This exercises the effect boundary on Windows as well as POSIX.
  const injected = t.mock.method(filesystem, "rename", async (source: Parameters<typeof actualRename>[0], destination: Parameters<typeof actualRename>[1]) => {
    await actualRename(source, destination);
    if (String(source).includes(".quaymesh-revert-") && canonicalWorkspaceRoot(String(destination)) === targetPath)
      throw new Error("restore failed after file replacement");
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(execute(), /restore failed after file replacement/);
    assert.equal(await readFile(path, "utf8"), "base\n");
    const finished = f.store.eventsForSession(session.id).filter(event => event.type === "operation_finished");
    assert.equal(finished.length, 1);
    assert.equal(finished[0]?.payload.effect, "unknown");
    assert.deepEqual(finished[0]?.payload.changed_paths, []);
    assert.deepEqual(finished[0]?.payload.attempted_paths, ["tracked.txt"]);
    assert.equal(finished[0]?.payload.error_message, "restore failed after file replacement");
    const receipt = receipts.get("revert", "restore-error");
    assert.equal(receipt?.state, "unknown"); assert.equal(receipt?.effect, "unknown");
    await assert.rejects(execute(), /restore failed after file replacement/);
    assert.equal(attempts, 1);
    assert.equal(f.execution.inspect(f.root).length, 0);
  } finally { injected.mock.restore(); syncBuiltinESMExports(); }
});
