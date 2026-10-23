import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { createReviewCheckpointManager, createWorkingTreeSnapshot, readReviewRef } from "./review-checkpoints.js";

const execFileAsync = promisify(execFile);

test("a clean workspace reports no changes from the last-shown checkpoint", async (t) => {
  const root = await committedRepository(t);
  const manager = createReviewCheckpointManager();

  await manager.initializeWorkspace({ workspaceId: "ws_clean", root });
  const clean = await manager.reviewChanges({ workspaceId: "ws_clean", root });

  assert.equal(clean.summary.files, 0);
  assert.equal(clean.patch, "");
});

test("initialization reports whether aggregate review is available", async (t) => {
  const gitRoot = await committedRepository(t);
  const plainRoot = await mkdtemp(join(tmpdir(), "quaymesh-review-plain-test-"));
  t.after(() => rm(plainRoot, { recursive: true, force: true }));
  const manager = createReviewCheckpointManager();

  assert.deepEqual(
    await manager.initializeWorkspace({ workspaceId: "ws_git", root: gitRoot }),
    { available: true },
  );
  const unavailable = await manager.initializeWorkspace({
    workspaceId: "ws_plain",
    root: plainRoot,
  });
  assert.equal(unavailable.available, false);
  if (!unavailable.available) assert.match(unavailable.reason, /git repository/i);
});

test("show_changes reports and advances the last-shown checkpoint", async (t) => {
  const root = await committedRepository(t);
  const manager = createReviewCheckpointManager();
  await manager.initializeWorkspace({ workspaceId: "ws_incremental", root });

  await writeFile(join(root, "README.md"), "hello\nworld\n");
  await writeFile(join(root, "new.txt"), "new\n");

  const unreviewed = await manager.reviewChanges({
    workspaceId: "ws_incremental",
    root,
    markReviewed: false,
  });
  assert.deepEqual(unreviewed.files.map((file) => file.path).sort(), ["README.md", "new.txt"]);
  assert.equal(unreviewed.summary.additions, 2);
  assert.match(unreviewed.patch, /world/);

  const markedReviewed = await manager.reviewChanges({
    workspaceId: "ws_incremental",
    root,
    markReviewed: true,
  });
  assert.equal(markedReviewed.summary.files, 2);
  assert.match(markedReviewed.reviewRef, /^[0-9a-f]{40,64}$/);

  const restored = await manager.reviewByRef({
    workspaceId: "ws_incremental",
    root,
    reviewRef: markedReviewed.reviewRef,
  });
  assert.deepEqual(restored.summary, markedReviewed.summary);
  assert.deepEqual(restored.files, markedReviewed.files);
  assert.equal(restored.patch, markedReviewed.patch);

  const afterReviewed = await manager.reviewChanges({ workspaceId: "ws_incremental", root });
  assert.equal(afterReviewed.summary.files, 0);
  assert.equal(afterReviewed.patch, "");
});

test("historical review refs survive later reviews and manager restarts", async (t) => {
  const root = await committedRepository(t);
  const manager = createReviewCheckpointManager();
  await manager.initializeWorkspace({ workspaceId: "ws_history", root });

  await writeFile(join(root, "README.md"), "hello\nfirst\n");
  const first = await manager.reviewChanges({ workspaceId: "ws_history", root });

  await writeFile(join(root, "README.md"), "hello\nfirst\nsecond\n");
  const second = await manager.reviewChanges({ workspaceId: "ws_history", root });
  assert.notEqual(first.reviewRef, second.reviewRef);

  const restarted = createReviewCheckpointManager();
  const restoredFirst = await restarted.reviewByRef({
    workspaceId: "ws_history",
    root,
    reviewRef: first.reviewRef,
  });
  assert.deepEqual(restoredFirst.summary, first.summary);
  assert.equal(restoredFirst.patch, first.patch);
  assert.match(restoredFirst.patch, /\+first/);
  assert.doesNotMatch(restoredFirst.patch, /\+second/);
});

test("review refs are scoped to the workspace review history", async (t) => {
  const root = await committedRepository(t);
  const manager = createReviewCheckpointManager();
  await manager.initializeWorkspace({ workspaceId: "ws_scoped", root });

  const head = await gitOutput(root, ["rev-parse", "HEAD"]);
  await assert.rejects(
    () => manager.reviewByRef({ workspaceId: "ws_scoped", root, reviewRef: head }),
    /Unknown review reference/,
  );
  await assert.rejects(
    () => readReviewRef(root, head),
    /Unknown QuayMesh review reference/,
  );
});

test("review checkpoints survive a manager restart", async (t) => {
  const root = await committedRepository(t);
  const manager = createReviewCheckpointManager();
  await manager.initializeWorkspace({ workspaceId: "ws_restart", root });

  await writeFile(join(root, "README.md"), "hello\nworld\n");
  await manager.reviewChanges({ workspaceId: "ws_restart", root, markReviewed: true });

  const restartedManager = createReviewCheckpointManager();
  await restartedManager.initializeWorkspace({ workspaceId: "ws_restart", root });
  await writeFile(join(root, "later.txt"), "after restart\n");

  const afterRestart = await restartedManager.reviewChanges({
    workspaceId: "ws_restart",
    root,
    markReviewed: false,
  });
  assert.deepEqual(afterRestart.files.map((file) => file.path), ["later.txt"]);
  assert.match(afterRestart.patch, /after restart/);
  assert.doesNotMatch(afterRestart.patch, /world/);
});

test("concurrent initialization produces one usable checkpoint state", async (t) => {
  const root = await committedRepository(t);
  const manager = createReviewCheckpointManager();

  const [, concurrentReview] = await Promise.all([
    manager.initializeWorkspace({ workspaceId: "ws_concurrent", root }),
    manager.reviewChanges({ workspaceId: "ws_concurrent", root, markReviewed: false }),
  ]);
  assert.equal(concurrentReview.summary.files, 0);

  await writeFile(join(root, "later.txt"), "visible after initialization\n");
  const afterInitialization = await manager.reviewChanges({
    workspaceId: "ws_concurrent",
    root,
    markReviewed: false,
  });
  assert.deepEqual(afterInitialization.files.map((file) => file.path), ["later.txt"]);
});

test("a missing last-shown checkpoint falls back after restart and can be re-established", async (t) => {
  const root = await committedRepository(t);
  const manager = createReviewCheckpointManager();
  await manager.initializeWorkspace({ workspaceId: "ws_missing_baseline", root });

  await writeFile(join(root, "README.md"), "hello\nchanged\n");
  await deleteReviewRef(root, "ws_missing_baseline", "baseline");

  const restartedManager = createReviewCheckpointManager();
  await restartedManager.initializeWorkspace({ workspaceId: "ws_missing_baseline", root });

  const fallback = await restartedManager.reviewChanges({
    workspaceId: "ws_missing_baseline",
    root,
    markReviewed: false,
  });
  assert.equal(fallback.summary.files, 1);
  assert.match(fallback.patch, /changed/);

  const reestablished = await restartedManager.reviewChanges({
    workspaceId: "ws_missing_baseline",
    root,
    markReviewed: true,
  });
  assert.equal(reestablished.summary.files, 1);

  const afterReestablished = await restartedManager.reviewChanges({
    workspaceId: "ws_missing_baseline",
    root,
    markReviewed: false,
  });
  assert.equal(afterReestablished.summary.files, 0);
});

test("a checkpoint workspace rejects a different root without changing its state", async (t) => {
  const root = await committedRepository(t);
  const otherRoot = await committedRepository(t);
  const manager = createReviewCheckpointManager();

  await manager.initializeWorkspace({ workspaceId: "ws_root_mismatch", root });

  await assert.rejects(
    () => manager.reviewChanges({
      workspaceId: "ws_root_mismatch",
      root: otherRoot,
      markReviewed: false,
    }),
    /workspace root mismatch/,
  );

  await writeFile(join(root, "only-first-root.txt"), "first root\n");
  const review = await manager.reviewChanges({
    workspaceId: "ws_root_mismatch",
    root,
    markReviewed: false,
  });
  assert.deepEqual(review.files.map((file) => file.path), ["only-first-root.txt"]);
});

test("a concurrent review rejects a different root after initialization", async (t) => {
  const root = await committedRepository(t);
  const otherRoot = await committedRepository(t);
  const manager = createReviewCheckpointManager();

  const [initialization, review] = await Promise.allSettled([
    manager.initializeWorkspace({ workspaceId: "ws_concurrent_root_mismatch", root }),
    manager.reviewChanges({
      workspaceId: "ws_concurrent_root_mismatch",
      root: otherRoot,
      markReviewed: false,
    }),
  ]);

  assert.equal(initialization.status, "fulfilled");
  assert.equal(review.status, "rejected");
  if (review.status === "rejected") {
    assert.match(String(review.reason), /workspace root mismatch/);
  }
});

test("an unborn repository is reviewable without creating a HEAD commit", async (t) => {
  const root = await unbornRepository(t);
  await writeFile(join(root, "existing.txt"), "present at open\n");
  const manager = createReviewCheckpointManager();

  const availability = await manager.initializeWorkspace({ workspaceId: "ws_unborn", root });
  assert.deepEqual(availability, { available: true });
  await assert.rejects(() => git(root, ["rev-parse", "--verify", "HEAD^{commit}"]));

  await writeFile(join(root, "created-after-open.txt"), "new file\n");

  const review = await manager.reviewChanges({
    workspaceId: "ws_unborn",
    root,
    markReviewed: false,
  });
  assert.deepEqual(review.files.map((file) => file.path), ["created-after-open.txt"]);
  assert.equal(review.files[0]?.type, "new");
  assert.match(review.patch, /new file/);
});

test("a broken HEAD is not treated as an unborn repository", async (t) => {
  const root = await committedRepository(t);
  const head = await gitOutput(root, ["rev-parse", "HEAD"]);
  await rm(join(root, ".git", "objects", head.slice(0, 2), head.slice(2)));
  const manager = createReviewCheckpointManager();

  const availability = await manager.initializeWorkspace({ workspaceId: "ws_broken_head", root });

  assert.equal(availability.available, false);
});

test("an unborn review baseline survives the first user commit", async (t) => {
  const root = await unbornRepository(t);
  await writeFile(join(root, "existing.txt"), "present at open\n");
  const manager = createReviewCheckpointManager();

  await manager.initializeWorkspace({ workspaceId: "ws_first_commit", root });
  await writeFile(join(root, "before-first-commit.txt"), "reviewed before commit\n");
  await manager.reviewChanges({ workspaceId: "ws_first_commit", root });

  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-m", "Initial commit"]);
  await writeFile(join(root, "after-first-commit.txt"), "created after commit\n");

  const review = await manager.reviewChanges({
    workspaceId: "ws_first_commit",
    root,
    markReviewed: false,
  });
  assert.deepEqual(review.files.map((file) => file.path), ["after-first-commit.txt"]);
  assert.match(review.patch, /created after commit/);
  assert.doesNotMatch(review.patch, /reviewed before commit/);
});

test("incremental snapshots exclude older metadata that differs from HEAD and the working tree without changing the user's index", { timeout: 60_000 }, async t => {
  const root = await committedRepository(t);
  await mkdir(join(root, ".quaymesh"));
  await writeFile(join(root, ".quaymesh", "Sessions.md"), "HEAD sessions\n");
  await writeFile(join(root, ".quaymesh", "sessions.json"), '{"state":"HEAD"}\n');
  await writeFile(join(root, "unchosen.txt"), "HEAD unchosen\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "Tracked metadata fixture"]);
  const head = await gitOutput(root, ["rev-parse", "HEAD"]);

  await writeFile(join(root, ".quaymesh", "Sessions.md"), "user staged sessions\n");
  await writeFile(join(root, ".quaymesh", "sessions.json"), '{"state":"user staged"}\n');
  await git(root, ["add", ".quaymesh"]);
  await writeFile(join(root, ".quaymesh", "Sessions.md"), "older captured sessions\n");
  await writeFile(join(root, ".quaymesh", "sessions.json"), '{"state":"older captured"}\n');
  await writeFile(join(root, "unchosen.txt"), "previous snapshot unchosen\n");
  const previousRef = await createWorkingTreeSnapshot(root, head);

  const workingFiles: Record<string, string> = {
    ".quaymesh/Sessions.md": "current recovery sessions\n",
    ".quaymesh/sessions.json": '{"state":"current recovery"}\n',
    "README.md": "hello\nselected change\n",
    "new.txt": "selected new file\n",
    "unchosen.txt": "later unselected working change\n",
  };
  for (const [path, contents] of Object.entries(workingFiles)) await writeFile(join(root, path), contents);
  const userIndex = await readFile(join(root, ".git", "index"));
  const indexMetadata = await gitOutput(root, ["show", ":.quaymesh/Sessions.md"]);
  assert.equal(indexMetadata, "user staged sessions");
  assert.equal(await gitOutput(root, ["show", `${previousRef}:.quaymesh/Sessions.md`]), "older captured sessions");

  const snapshot = await createWorkingTreeSnapshot(root, head, [".quaymesh"], {
    previousRef, paths: ["README.md", "new.txt"],
  });
  assert.deepEqual((await gitOutput(root, ["ls-tree", "-r", "--name-only", snapshot])).split("\n"),
    ["README.md", "new.txt", "unchosen.txt"]);
  assert.equal(await gitOutput(root, ["show", `${snapshot}:README.md`]), "hello\nselected change");
  assert.equal(await gitOutput(root, ["show", `${snapshot}:new.txt`]), "selected new file");
  assert.equal(await gitOutput(root, ["show", `${snapshot}:unchosen.txt`]), "previous snapshot unchosen",
    "incremental capture keeps the previous snapshot for paths outside the requested selection");
  assert.deepEqual(await readFile(join(root, ".git", "index")), userIndex, "the user's index bytes are unchanged");
  assert.equal(await gitOutput(root, ["rev-parse", "HEAD"]), head);
  assert.equal(await gitOutput(root, ["show", ":.quaymesh/Sessions.md"]), indexMetadata);
  for (const [path, contents] of Object.entries(workingFiles)) assert.equal(await readFile(join(root, path), "utf8"), contents);
});

test("full snapshots exclude recovery metadata changed by a real Git clean filter during staging", { timeout: 60_000 }, async t => {
  const root = await committedRepository(t);
  await mkdir(join(root, ".quaymesh"));
  await writeFile(join(root, ".quaymesh", "Sessions.md"), "HEAD sessions\n");
  await writeFile(join(root, ".quaymesh", "sessions.json"), '{"state":"HEAD"}\n');
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "Tracked metadata fixture"]);
  const head = await gitOutput(root, ["rev-parse", "HEAD"]);
  await writeFile(join(root, ".quaymesh", "Sessions.md"), "user staged sessions\n");
  await writeFile(join(root, ".quaymesh", "sessions.json"), '{"state":"user staged"}\n');
  await git(root, ["add", ".quaymesh"]);
  const capturedMetadata = "metadata read by git add\n";
  await writeFile(join(root, ".quaymesh", "Sessions.md"), capturedMetadata);
  await writeFile(join(root, ".quaymesh", "sessions.json"), '{"state":"before concurrent write"}\n');
  const workingFiles: Record<string, string> = {
    "README.md": "hello\nfull capture change\n",
    "new.txt": "new file included in full snapshot\n",
  };
  for (const [path, contents] of Object.entries(workingFiles)) await writeFile(join(root, path), contents);
  const concurrentMetadata: Record<string, string> = {
    ".quaymesh/Sessions.md": "new recovery content written after staging read\n",
    ".quaymesh/sessions.json": '{"state":"concurrent recovery write"}\n',
  };
  const filterPath = join(root, ".git", "snapshot-race-filter.cjs");
  const evidencePath = join(root, ".git", "snapshot-race-evidence.jsonl");
  await writeFile(filterPath, `const fs = require("node:fs");
const path = require("node:path");
const input = fs.readFileSync(0);
const root = ${JSON.stringify(root)};
const writes = ${JSON.stringify(concurrentMetadata)};
for (const [name, content] of Object.entries(writes)) fs.writeFileSync(path.join(root, name), content);
fs.appendFileSync(${JSON.stringify(evidencePath)}, JSON.stringify({ input: input.toString("base64"), index: process.env.GIT_INDEX_FILE }) + "\\n");
process.stdout.write(input);
`);
  // Git executes filters through its shell on both supported platforms. Quote
  // actual executable paths, and keep the filter and configuration in this repo.
  const shellQuote = (value: string) => `'${value.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`;
  await git(root, ["config", "--local", "filter.qm-snapshot-race.clean", `${shellQuote(process.execPath)} ${shellQuote(filterPath)}`]);
  await git(root, ["config", "--local", "filter.qm-snapshot-race.required", "true"]);
  await writeFile(join(root, ".git", "info", "attributes"), ".quaymesh/Sessions.md filter=qm-snapshot-race\n");
  const userIndexPath = join(root, ".git", "index"), userIndex = await readFile(userIndexPath);

  const snapshot = await createWorkingTreeSnapshot(root, head, [".quaymesh"]);
  const evidence = (await readFile(evidencePath, "utf8")).trim().split("\n")
    .map(line => JSON.parse(line) as { input: string; index: string });
  assert.equal(Buffer.from(evidence[0]!.input, "base64").toString("utf8"), capturedMetadata,
    "the real filter returned the old contents to git add while writing newer metadata to disk");
  assert.ok(evidence.every(entry => entry.index && entry.index !== userIndexPath), "staging used a separate GIT_INDEX_FILE");
  assert.deepEqual((await gitOutput(root, ["ls-tree", "-r", "--name-only", snapshot])).split("\n"), ["README.md", "new.txt"]);
  assert.equal(await gitOutput(root, ["show", `${snapshot}:README.md`]), workingFiles["README.md"]!.trim());
  assert.equal(await gitOutput(root, ["show", `${snapshot}:new.txt`]), workingFiles["new.txt"]!.trim());
  assert.deepEqual(await readFile(userIndexPath), userIndex, "the user's index bytes are unchanged");
  assert.equal(await gitOutput(root, ["rev-parse", "HEAD"]), head);
  assert.equal(await gitOutput(root, ["show", ":.quaymesh/Sessions.md"]), "user staged sessions");
  for (const [path, contents] of Object.entries({ ...workingFiles, ...concurrentMetadata }))
    assert.equal(await readFile(join(root, path), "utf8"), contents, "snapshot exclusion does not remove or rewrite working files");
});

async function committedRepository(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "quaymesh-review-checkpoints-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "quaymesh@example.com"]);
  await git(root, ["config", "user.name", "QuayMesh Test"]);
  await writeFile(join(root, "README.md"), "hello\n");
  await git(root, ["add", "README.md"]);
  await git(root, ["commit", "-m", "Initial commit"]);
  return root;
}

async function unbornRepository(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "quaymesh-review-unborn-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "quaymesh@example.com"]);
  await git(root, ["config", "user.name", "QuayMesh Test"]);
  return root;
}

async function deleteReviewRef(
  root: string,
  workspaceId: string,
  checkpoint: "open" | "baseline",
): Promise<void> {
  await git(root, ["update-ref", "-d", `refs/quaymesh/review/${workspaceId}/${checkpoint}`]);
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd })).stdout.trim();
}
