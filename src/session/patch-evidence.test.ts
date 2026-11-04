import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomFillSync } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { captureGitPatch, readPatchPreview, readPatchTextPage, readPatchBytePage, requireCompletePatches, textPatchWasOmitted } from "./patch-evidence.js";

const execute = promisify(execFile);
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "qm-patch-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo"), evidence = join(root, "evidence");
  await mkdir(repo); await mkdir(evidence);
  const git = async (args: string[]) => (await execute("git", args, { cwd: repo, maxBuffer: 1024 * 1024 })).stdout.trim();
  await git(["init", "--quiet"]); await git(["config", "user.name", "Patch evidence test"]);
  await git(["config", "user.email", "patch-evidence@example.invalid"]);
  await git(["commit", "--allow-empty", "-qm", "baseline"]);
  const before = await git(["rev-parse", "HEAD"]);
  const snapshot = async () => {
    await git(["add", "."]);
    const tree = await git(["write-tree"]);
    return git(["commit-tree", tree, "-p", before, "-m", "snapshot"]);
  };
  return { root, repo, evidence, git, before, snapshot };
}

async function fileHash(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

test("Git patch streaming preserves public hashes and complete UTF-8 evidence", async t => {
  const f = await fixture(t), path = "中文-🙂.txt";
  await writeFile(join(f.repo, path), ('中文🙂 "引号" \\ 路径\n').repeat(10000));
  const current = await f.snapshot(), previous = "previous-public-tree";
  const args = ["diff", "--binary", "--no-color", f.before, current, "--", path];
  const original = (await execute("git", args, { cwd: f.repo, maxBuffer: 1024 * 1024 })).stdout;
  const saved = await captureGitPatch({ repoRoot: f.repo, args, destination: join(f.evidence, "patch.bin"),
    currentRef: current, previousRef: previous, path });
  assert.equal(await readFile(saved.patchRef, "utf8"), original);
  assert.equal(saved.bytes, Buffer.byteLength(original));
  assert.equal(saved.hash, digest([current, path, original]));
  assert.equal(saved.previousHash, digest([previous, path, original]));
  assert.equal(saved.binary, false);
});

test("code-point pages cross files and UTF-8 boundaries with the original cursor meaning", async t => {
  const f = await fixture(t);
  const text = 'a'.repeat(65535) + '汉🙂\\"\n' + '字🙂'.repeat(30);
  const path = join(f.evidence, "unicode.bin"); await writeFile(path, text);
  const pieces = [{ text: "# 路径🙂\n" }, { path }, { text: "\n尾部🙂" }];
  const combined = pieces[0].text! + text + pieces[2].text!;
  let cursor: number | null = 0, result = "";
  do {
    const page = await readPatchTextPage(pieces, cursor!, 65536);
    assert.ok(Buffer.byteLength(JSON.stringify(page.text)) <= 65536);
    if (page.nextOffset !== null) assert.equal(page.nextOffset, cursor! + Array.from(page.text).length);
    result += page.text; cursor = page.nextOffset;
  } while (cursor !== null);
  assert.equal(result, combined);
  for (const offset of [65536, 65544, Array.from(combined).length]) {
    const page = await readPatchTextPage(pieces, offset, 31);
    assert.ok(combined.endsWith(page.text) || Array.from(combined).slice(offset).join("").startsWith(page.text));
    assert.ok(Buffer.byteLength(JSON.stringify(page.text)) <= 31);
  }
  await assert.rejects(readPatchTextPage(pieces, Array.from(combined).length + 1), /offset/);
  await assert.rejects(readPatchTextPage(pieces, -1), /offset/);
  assert.deepEqual(await readPatchTextPage([], 0), { text: "", nextOffset: null });
});

test("preview budget is explicit and omitted ordinary patches cannot masquerade as complete exports", async t => {
  const f = await fixture(t), path = join(f.evidence, "preview.bin");
  await writeFile(path, "汉字🙂");
  assert.deepEqual(await readPatchPreview(path, 10), { patch: "汉字🙂" });
  assert.deepEqual(await readPatchPreview(path, 9), { patch: "", previewOmitted: "too_large" });
  const text = { path: "large.txt", patchRef: path, large: true, binary: false, additions: null, removals: null };
  assert.equal(textPatchWasOmitted(text), true);
  await assert.rejects(requireCompletePatches([text]), /PATCH_NOT_GENERATED/);
  await writeFile(path, "");
  await assert.rejects(requireCompletePatches([{ ...text, binary: true }]), /PATCH_NOT_GENERATED/);
  await requireCompletePatches([{ ...text, large: false, additions: 0, removals: 0 }]);
});

test("atomic patch replacement invalidates the cached byte position of a code-point cursor", async t => {
  const f = await fixture(t), path = join(f.evidence, "replaced.bin");
  await writeFile(path, "汉".repeat(80));
  const first = await readPatchTextPage([{ path }], 0, 17);
  assert.ok(first.nextOffset);
  const nextText = "0123456789abcdef".repeat(15), replacement = join(f.evidence, "new.bin");
  await writeFile(replacement, nextText); await rename(replacement, path);
  const second = await readPatchTextPage([{ path }], first.nextOffset!, 17);
  assert.equal(second.text, nextText.slice(first.nextOffset!, second.nextOffset!));
});

test("byte pages retain the legacy console cursor and never split a UTF-8 character", async t => {
  const f = await fixture(t), path = join(f.evidence, "byte-page.bin");
  const content = "汉🙂".repeat(50); await writeFile(path, content);
  const pieces = [{ text: "x".repeat(65535) }, { path }, { text: "\n结尾" }];
  const combined = pieces[0].text! + content + pieces[2].text!;
  let cursor: number | null = 0, collected = "";
  do {
    const page = await readPatchBytePage(pieces, cursor!);
    assert.ok(Buffer.byteLength(page.text) <= 65536);
    assert.equal(page.text.includes("\ufffd"), false);
    if (page.nextOffset !== null) assert.equal(page.nextOffset, cursor! + Buffer.byteLength(page.text));
    collected += page.text; cursor = page.nextOffset;
  } while (cursor !== null);
  assert.equal(collected, combined);
  await assert.rejects(readPatchBytePage(pieces, 65536), /offset/);
});

test("failed Git output never replaces retained patch evidence or leaves a pending file", async t => {
  const f = await fixture(t), destination = join(f.evidence, "saved.bin");
  await writeFile(destination, "retained evidence");
  await assert.rejects(captureGitPatch({ repoRoot: f.repo, args: ["diff", "missing-reference", f.before],
    destination, currentRef: f.before, previousRef: f.before, path: "a.txt" }), /Git patch failed/);
  assert.equal(await readFile(destination, "utf8"), "retained evidence");
  assert.deepEqual(await readdir(f.evidence), ["saved.bin"]);
});

test("42 MiB Git binary evidence exceeds the former buffer and remains fully restorable", { timeout: 120000 }, async t => {
  const f = await fixture(t), source = join(f.repo, "library.bin"), sourceBytes = 42 * 1024 * 1024;
  const file = await open(source, "wx"), block = Buffer.alloc(64 * 1024);
  try {
    for (let written = 0; written < sourceBytes; written += block.length) {
      randomFillSync(block); await file.writeFile(block);
    }
  } finally { await file.close(); }
  const sourceHash = await fileHash(source), current = await f.snapshot();
  const saved = await captureGitPatch({ repoRoot: f.repo,
    args: ["diff", "--binary", "--no-color", f.before, current, "--", "library.bin"],
    destination: join(f.evidence, "large.patch"), currentRef: current, previousRef: f.before, path: "library.bin" });
  assert.equal(saved.binary, true);
  assert.ok(saved.bytes > 50 * 1024 * 1024);
  assert.equal((await stat(saved.patchRef)).size, saved.bytes);
  assert.deepEqual(await readPatchPreview(saved.patchRef), { patch: "", previewOmitted: "too_large" });
  const first = await readPatchTextPage([{ path: saved.patchRef }], 0, 65536);
  assert.match(first.text, /GIT binary patch/); assert.ok(first.nextOffset! > 0);
  const second = await readPatchTextPage([{ path: saved.patchRef }], first.nextOffset!, 65536);
  assert.ok(second.nextOffset! > first.nextOffset!);
  const last = await readPatchTextPage([{ path: saved.patchRef }], saved.bytes - 32, 65536);
  assert.equal(last.nextOffset, null); assert.equal(Buffer.byteLength(last.text), 32);
  const restored = join(f.root, "restored"); await mkdir(restored);
  await execute("git", ["apply", "--binary", saved.patchRef], { cwd: restored });
  assert.equal((await stat(join(restored, "library.bin"))).size, sourceBytes);
  assert.equal(await fileHash(join(restored, "library.bin")), sourceHash);
  assert.equal(Number(await f.git(["cat-file", "-s", `${current}:library.bin`])), sourceBytes);
});
