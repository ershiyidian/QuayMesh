import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readSavedOutputPage } from "./output-reader.js";
import { readSavedTextArtifact, SavedArtifactError } from "./saved-artifacts.js";

test("saved output pages preserve UTF-8 byte cursors and never write metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "qm-output-read-"));
  try {
    const path = join(root, "session-output");
    await mkdir(join(path, "command_1"), { recursive: true });
    const bytes = Buffer.from("中文éabcd末尾");
    await writeFile(join(path, "command_1", "segment-0.bin"), bytes);
    const metadata = JSON.stringify({ version: 3, session_id: "s", command_id: "command_1", operation_id: "operation_1",
      total_bytes: bytes.length, retained_from: 0, done: true, exit_code: 0, signal: null, updated_at: "2026-11-01T00:00:00Z",
      state: "ready", segments: [{ start: 0, bytes: bytes.length, file: "segment-0.bin" }] });
    await writeFile(join(path, "command_1.json"), metadata);
    let cursor = 0, result = "";
    for (let count = 0; count < 20; count++) {
      const page = await readSavedOutputPage(root, { sessionId: "s", commandId: "command_1", operationId: "operation_1" }, cursor, 4);
      assert.ok(page.nextCursor > cursor);
      result += page.chunk; cursor = page.nextCursor;
      if (page.done) break;
    }
    assert.equal(result, bytes.toString("utf8"));
    assert.equal(cursor, bytes.length);
    assert.equal(await readFile(join(path, "command_1.json"), "utf8"), metadata);
    await assert.rejects(readSavedOutputPage(root, { sessionId: "other", commandId: "command_1", operationId: "operation_1" }, 0), SavedArtifactError);
    await assert.rejects(readSavedOutputPage(root, { sessionId: "s", commandId: "command_1", operationId: "other" }, 0), SavedArtifactError);
    const insideCharacter = await readSavedOutputPage(root, { sessionId: "s", commandId: "command_1", operationId: "operation_1" }, 1);
    assert.equal(insideCharacter.cursor, 1); assert.equal(insideCharacter.nextCursor, bytes.length);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("retention is explicit, incomplete output remains incomplete, and short segments fail", async () => {
  const root = await mkdtemp(join(tmpdir(), "qm-output-retained-"));
  try {
    const path = join(root, "session-output");
    await mkdir(join(path, "command_2"), { recursive: true });
    await writeFile(join(path, "command_2", "segment-5.bin"), "later");
    const metadata = { version: 3, session_id: "s", command_id: "command_2", operation_id: "command_2",
      total_bytes: 10, retained_from: 5, done: true, exit_code: 1, signal: null, state: "incomplete", error_code: "WRITE_FAILED",
      segments: [{ start: 5, bytes: 5, file: "segment-5.bin" }] };
    await writeFile(join(path, "command_2.json"), JSON.stringify(metadata));
    const page = await readSavedOutputPage(root, { sessionId: "s", commandId: "command_2", operationId: "command_2" }, 0);
    assert.equal(page.chunk, "later"); assert.equal(page.truncated, true); assert.equal(page.retainedFrom, 5);
    assert.equal(page.outputState, "incomplete"); assert.equal(page.errorCode, "WRITE_FAILED");
    await writeFile(join(path, "command_2", "segment-5.bin"), "la");
    await assert.rejects(readSavedOutputPage(root, { sessionId: "s", commandId: "command_2", operationId: "command_2" }, 5), SavedArtifactError);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("saved references reject traversal, symlink escape and oversize content", async () => {
  const root = await mkdtemp(join(tmpdir(), "qm-saved-artifact-"));
  try {
    const evidence = join(root, "evidence"); await mkdir(evidence);
    const secret = join(root, "outside.txt"); await writeFile(secret, "outside");
    await mkdir(join(evidence, "task_b"));
    await writeFile(join(evidence, "task_b", "other-task.patch"), "other Task");
    await assert.rejects(readSavedTextArtifact(evidence, join(evidence, "task_b", "other-task.patch"), 100),
      error => error instanceof SavedArtifactError && error.code === "artifact_scope");
    await assert.rejects(readSavedTextArtifact(evidence, secret, 100), error => error instanceof SavedArtifactError && error.code === "artifact_scope");
    if (process.platform !== "win32") {
      await symlink(secret, join(evidence, "link"));
      await symlink(join(evidence, "task_b", "other-task.patch"), join(evidence, "other-task-link"));
      await assert.rejects(readSavedTextArtifact(evidence, join(evidence, "other-task-link"), 100),
        error => error instanceof SavedArtifactError && error.code === "artifact_scope");
      await assert.rejects(readSavedTextArtifact(evidence, join(evidence, "link"), 100), error => error instanceof SavedArtifactError && error.code === "artifact_scope");
    }
    await writeFile(join(evidence, "large"), "abcd");
    await assert.rejects(readSavedTextArtifact(evidence, join(evidence, "large"), 3), error => error instanceof SavedArtifactError && error.code === "artifact_too_large");
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("replacement characters consume original bytes and a live partial UTF-8 suffix waits for append", async () => {
  const root = await mkdtemp(join(tmpdir(), "qm-output-byte-cursor-"));
  try {
    const path = join(root, "session-output"); await mkdir(join(path, "command_3"), { recursive: true });
    const bytes = Buffer.from([0xff, 0xc3, 0x28, 0xe1, 0x80, 0x41, 0xf0, 0x9f, 0x92, 0xa9]);
    const metadata = { version: 3, session_id: "s", command_id: "command_3", operation_id: "command_3",
      total_bytes: bytes.length, retained_from: 0, done: true, exit_code: 0, signal: null, state: "ready",
      segments: [{ start: 0, bytes: bytes.length, file: "segment-0.bin" }] };
    await writeFile(join(path, "command_3", "segment-0.bin"), bytes);
    await writeFile(join(path, "command_3.json"), JSON.stringify(metadata));
    let cursor = 0, output = "";
    for (let count = 0; count < 20; count++) {
      const page = await readSavedOutputPage(root, { sessionId: "s", commandId: "command_3", operationId: "command_3" }, cursor, 4);
      assert.ok(page.nextCursor > cursor && page.nextCursor <= bytes.length);
      output += page.chunk; cursor = page.nextCursor; if (page.done) break;
    }
    assert.equal(cursor, bytes.length); assert.equal(output, bytes.toString("utf8"));
    const partial = Buffer.from([0xe4, 0xb8]);
    await writeFile(join(path, "command_3", "segment-0.bin"), partial);
    await writeFile(join(path, "command_3.json"), JSON.stringify({ ...metadata, done: false, state: "writing", total_bytes: 2,
      segments: [{ start: 0, bytes: 2, file: "segment-0.bin" }] }));
    const waiting = await readSavedOutputPage(root, { sessionId: "s", commandId: "command_3", operationId: "command_3" }, 0);
    assert.equal(waiting.chunk, ""); assert.equal(waiting.nextCursor, 0); assert.equal(waiting.done, false); assert.equal(waiting.outputState, "writing");
  } finally { await rm(root, { recursive: true, force: true }); }
});
