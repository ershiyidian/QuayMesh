import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, open, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "../db/client.js";
import { ExecutionCoordinator } from "../execution-coordinator.js";
import { SessionStore } from "./store.js";
import { SessionChangeCollector } from "./changes.js";
import { SessionReverter } from "./revert.js";
import { fileIdentity, INLINE_FILE_BYTES, ordinaryVersion, readFileContent } from "./file-content.js";
import { ownershipPath, readOwnedFiles, restoreFileState, writeOwnedFiles } from "./write-evidence.js";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), "quaymesh-file-streams-")), root = join(directory, "files");
  await mkdir(root);
  const stateDir = join(directory, "state"), database = openDatabase(stateDir), store = new SessionStore(database.sqlite);
  const collector = new SessionChangeCollector(store, stateDir), execution = new ExecutionCoordinator(stateDir);
  const reverter = new SessionReverter(store, stateDir, execution, collector);
  const session = store.createSession("owner", "stream-" + Date.now(), "stream files");
  const member = store.addMember(session.id, "local", "files", root, "checkout", null);
  t.after(async () => { await collector.close(); execution.close(); database.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, root, stateDir, store, collector, execution, reverter, session, member };
}

test("streamed ordinary versions retain legacy base64 JSON identity across chunk boundaries", async t => {
  const f = await fixture(t);
  const values = [null, Buffer.alloc(0), Buffer.alloc(65537, 0xa7), Buffer.alloc(131075, 0x59)];
  for (const [index, before] of values.entries()) {
    const after = values[(index + 2) % values.length]!;
    const oldPath = join(f.root, "old"), newPath = join(f.root, "new");
    if (before) await writeFile(oldPath, before);
    if (after) await writeFile(newPath, after);
    const expected = createHash("sha256").update(JSON.stringify([before?.toString("base64") ?? null, after?.toString("base64") ?? null])).digest("hex");
    assert.equal(await ordinaryVersion(before ? oldPath : null, after ? newPath : null), expected);
  }
});

test("a queued capture rejected before lease admission stays observable and recovers on a new batch", async t => {
  const f = await fixture(t), gated = new SessionChangeCollector(f.store, f.stateDir, f.execution);
  try {
    await gated.ensureBaseline(f.member, ["admission.txt"]);
    await writeFile(join(f.root, "admission.txt"), "actual change\n");
    const admitted = gated.markDirty(f.member.id, ["admission.txt"]);
    f.execution.pause("capture-admission-window");
    await assert.rejects(admitted, /capture-admission-window/);
    await assert.rejects(gated.flushTask(f.member.id), /capture-admission-window/);
    assert.equal(gated.captureObservation(f.member.id).state, "failed");
    assert.match(gated.captureObservation(f.member.id).error!, /capture-admission-window/);
    f.execution.resume();
    await gated.markDirty(f.member.id, ["admission.txt"]); await gated.flushTask(f.member.id);
    assert.deepEqual(gated.captureObservation(f.member.id), { state: "idle", error: null });
    assert.equal(gated.readSummaries(f.session.id, f.member.id)[0]?.path, "admission.txt");
  } finally { f.execution.resume(); await gated.close(); }
});

test("a queued capture rejected during an accepted capture leaves that accepted publication valid", async t => {
  const f = await fixture(t), gated = new SessionChangeCollector(f.store, f.stateDir, f.execution);
  await gated.ensureBaseline(f.member, ["accepted.txt"]);
  await writeFile(join(f.root, "accepted.txt"), "accepted content\n");
  const original = f.store.publishChangeCaptureAsync.bind(f.store);
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  f.store.publishChangeCaptureAsync = async (...args) => { entered(); await held; return original(...args); };
  const direct = gated.capture(f.member.id);
  try {
    await reached;
    const queued = gated.markDirty(f.member.id, ["accepted.txt"]);
    f.execution.pause("queued-admission-window");
    await assert.rejects(queued, /queued-admission-window/);
    release(); await direct; await gated.flushTask(f.member.id);
    assert.equal(gated.readSummaries(f.session.id, f.member.id)[0]?.path, "accepted.txt");
    assert.deepEqual(gated.captureObservation(f.member.id), { state: "idle", error: null });
  } finally {
    release(); f.execution.resume(); await direct.catch(() => {});
    f.store.publishChangeCaptureAsync = original; await gated.close();
  }
});

test("large binary capture stays bounded and unchanged full capture reads no file bodies", async t => {
  const f = await fixture(t), path = join(f.root, "large.zip");
  const before = await f.collector.prepareWrite(f.member, ["large.zip"]);
  const file = await open(path, "wx"); await file.truncate(32 * 1024 * 1024 + 5); await file.close();
  const originalString = Buffer.prototype.toString;
  let largestBase64 = 0;
  t.mock.method(Buffer.prototype, "toString", function(this: Buffer, encoding?: BufferEncoding, start?: number, end?: number) {
    if (encoding === "base64") largestBase64 = Math.max(largestBase64, this.length);
    return originalString.call(this, encoding, start, end);
  });
  await f.collector.recordWrite(f.member, before);
  await f.collector.capture(f.member.id);
  const first = f.collector.readSummaries(f.session.id, f.member.id)[0]!;
  assert.equal(first.binary, true); assert.equal(first.large, true); assert.equal(first.revertible, true);
  assert.ok(largestBase64 <= INLINE_FILE_BYTES, "large content never becomes one main-thread base64 string");
  assert.ok((await stat(ownershipPath(f.stateDir, f.session.id, f.member.id))).size < 4096);
  const probe = await open(path), prototype = Object.getPrototypeOf(probe), originalStream = prototype.createReadStream;
  await probe.close();
  let bodyReads = 0;
  t.mock.method(prototype, "createReadStream", function(this: unknown, ...args: unknown[]) {
    bodyReads++; return originalStream.apply(this, args);
  });
  await f.collector.capture(f.member.id);
  assert.equal(bodyReads, 0, "an unknown-scope capture still stats every path but reuses unchanged content");
  const second = f.collector.readSummaries(f.session.id, f.member.id)[0]!;
  assert.equal(second.hash, first.hash); assert.equal(second.recordedAt, first.recordedAt);
});

test("ordinary capture notices unlisted same-size external writes and atomic replacement", async t => {
  const f = await fixture(t), a = join(f.root, "a.txt"), b = join(f.root, "b.txt");
  await writeFile(a, "first\n"); await writeFile(b, "start\n");
  const before = await f.collector.prepareWrite(f.member, ["a.txt", "b.txt"]);
  await writeFile(a, "after\n"); await writeFile(b, "after\n");
  await f.collector.recordWrite(f.member, before); await f.collector.capture(f.member.id);
  const old = f.collector.readSummaries(f.session.id, f.member.id).find(file => file.path === "b.txt")!;
  const info = await stat(b);
  await writeFile(b, "other\n"); await utimes(b, info.atime, info.mtime);
  await f.collector.markDirty(f.member.id, ["a.txt"]); await f.collector.flush();
  const changed = f.collector.readSummaries(f.session.id, f.member.id).find(file => file.path === "b.txt")!;
  assert.notEqual(changed.hash, old.hash); assert.equal(changed.revertible, false);
  const replacement = join(f.root, "replacement");
  await writeFile(replacement, "third\n"); await utimes(replacement, info.atime, info.mtime); await rename(replacement, b);
  await f.collector.capture(f.member.id);
  assert.notEqual(f.collector.readSummaries(f.session.id, f.member.id).find(file => file.path === "b.txt")!.hash, changed.hash);
});

test("legacy owned JSON is compacted off-thread without overwriting it or sharing mutable results", async t => {
  const f = await fixture(t), path = ownershipPath(f.stateDir, f.session.id, f.member.id);
  await mkdir(join(path, ".."), { recursive: true });
  const raw = Buffer.alloc(9 * 1024 * 1024 + 7, 0xa5);
  await writeFile(path, JSON.stringify({ "large.bin": { safe: true,
    before: { exists: true, content: raw.toString("base64"), mode: 0o644 },
    after: { exists: false, content: "", mode: null } } }));
  const identity = await fileIdentity(path);
  const [one, two] = await Promise.all([readOwnedFiles(path), readOwnedFiles(path)]);
  assert.equal(await fileIdentity(path), identity, "a read never rewrites the old ownership receipt");
  assert.ok(JSON.stringify(one).length < 4096); assert.ok(one["large.bin"]!.before.contentRef);
  delete one["large.bin"];
  assert.ok(two["large.bin"]); assert.ok((await readOwnedFiles(path))["large.bin"]);
  await restoreFileState(join(f.root, "restored.bin"), two["large.bin"]!.before);
  assert.deepEqual(await readFile(join(f.root, "restored.bin")), raw);
  await writeOwnedFiles(path, two);
  assert.ok((await stat(path)).size < 4096);
  assert.equal((await readOwnedFiles(path))["large.bin"]!.before.sha256, createHash("sha256").update(raw).digest("hex"));
});

test("same-content evidence publication keeps an existing blob identity during concurrent captures", async t => {
  const f = await fixture(t), source = join(f.root, "source.bin"), directory = join(f.directory, "evidence");
  await writeFile(source, Buffer.alloc(2 * 1024 * 1024 + 3, 0x36));
  const [first, alsoFirst] = await Promise.all([readFileContent(source, directory), readFileContent(source, directory)]);
  assert.equal(alsoFirst.state.contentRef, first.state.contentRef);
  const ref = first.state.contentRef!, identity = await fileIdentity(ref);
  const values = await Promise.all([readFileContent(source, directory), readFileContent(source, directory), readFileContent(ref)]);
  assert.equal(await fileIdentity(ref), identity);
  assert.ok(values.every(value => value.state.sha256 === first.state.sha256));
});

test("legacy ownership compaction retains the old public version and recorded time after restart", async t => {
  const f = await fixture(t), path = join(f.root, "legacy.bin"), raw = Buffer.alloc(7 * 1024 * 1024 + 5, 0x37);
  const before = await f.collector.prepareWrite(f.member, ["legacy.bin"]);
  await writeFile(path, raw); await f.collector.recordWrite(f.member, before); await f.collector.capture(f.member.id);
  const original = f.collector.readSummaries(f.session.id, f.member.id)[0]!;
  const oldVersion = createHash("sha256").update(JSON.stringify([null, raw.toString("base64")])).digest("hex");
  assert.equal(original.hash, oldVersion);
  const receipt = ownershipPath(f.stateDir, f.session.id, f.member.id);
  await writeFile(receipt, JSON.stringify({ "legacy.bin": { safe: true,
    before: { exists: false, content: "", mode: null },
    after: { exists: true, content: raw.toString("base64"), mode: (await stat(path)).mode & 0o777 } } }));
  const identity = await fileIdentity(receipt), restarted = new SessionChangeCollector(f.store, f.stateDir);
  try {
    await restarted.capture(f.member.id);
    const current = restarted.readSummaries(f.session.id, f.member.id)[0]!;
    assert.equal(current.hash, oldVersion); assert.equal(current.recordedAt, original.recordedAt);
    assert.equal(current.revertible, true); assert.equal(await fileIdentity(receipt), identity);
  } finally { await restarted.close(); }
});

for (const corrupt of [false, true]) test("revert validates every saved original before changing any target: " + (corrupt ? "corrupt blob" : "missing blob"), async t => {
  const f = await fixture(t), a = join(f.root, "a.txt"), b = join(f.root, "b.bin");
  await writeFile(a, "before\n"); await writeFile(b, Buffer.alloc(INLINE_FILE_BYTES + 7, 0x32));
  const before = await f.collector.prepareWrite(f.member, ["a.txt", "b.bin"]);
  await writeFile(a, "after\n"); await writeFile(b, Buffer.alloc(INLINE_FILE_BYTES + 7, 0x46));
  await f.collector.recordWrite(f.member, before); await f.collector.capture(f.member.id);
  const owned = await readOwnedFiles(ownershipPath(f.stateDir, f.session.id, f.member.id)), saved = owned["b.bin"]!.before.contentRef!;
  if (corrupt) {
    const blob = await open(saved, "r+"); await blob.write(Buffer.from("X"), 0, 1, 0); await blob.close();
  } else await rm(saved);
  const revision = f.store.getMember(f.session.id, f.member.id).revision;
  await assert.rejects(f.reverter.revert("owner", f.session.id, f.member.id, revision, true, undefined, null), /FILE_EVIDENCE_CONTENT_CHANGED/);
  assert.equal(await readFile(a, "utf8"), "after\n");
  assert.deepEqual(await readFile(b), Buffer.alloc(INLINE_FILE_BYTES + 7, 0x46));
});

test("large ordinary text keeps complete undo evidence while omitting an unbounded text diff", async t => {
  const f = await fixture(t), path = join(f.root, "large.txt"), original = Buffer.alloc(INLINE_FILE_BYTES + 1, 0x61);
  await writeFile(path, original);
  const before = await f.collector.prepareWrite(f.member, ["large.txt"]);
  await writeFile(path, Buffer.alloc(INLINE_FILE_BYTES + 1, 0x62));
  await f.collector.recordWrite(f.member, before); await f.collector.capture(f.member.id);
  const file = f.collector.readSummaries(f.session.id, f.member.id)[0]!;
  assert.equal(file.binary, false); assert.equal(file.large, true);
  assert.equal(file.additions, null); assert.equal(file.removals, null); assert.equal(file.revertible, true);
  assert.equal((await f.collector.fileDiff(f.session.id, file.id, file.hash)).patch, "");
  const revision = f.store.getMember(f.session.id, f.member.id).revision;
  await f.reverter.revert("owner", f.session.id, f.member.id, revision, true, undefined, null);
  assert.deepEqual(await readFile(path), original);
});
