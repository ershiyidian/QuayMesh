import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperationEvidenceStore } from "./operation-evidence.js";

test("operation evidence keeps bounded head/tail and reports dropped ranges", async () => {
  const root = await mkdtemp(join(tmpdir(), "quaymesh-evidence-"));
  try {
    const store = new OperationEvidenceStore(root, 10);
    const writer = await store.openWriter("op_test");
    writer.append("stdout", "0123456789ABCDEFGHIJ");
    const beforeClose = await writer.read("stdout", 0, 100);
    assert.equal(beforeClose.totalBytes, 20);
    assert.equal(beforeClose.droppedBytes, 10);
    assert.deepEqual(beforeClose.retainedRanges, [{ start: 0, end: 5 }, { start: 15, end: 20 }]);
    await writer.close();
    const afterClose = await store.read("op_test", "stdout", 15, 5);
    assert.equal(afterClose.bytes.toString(), "FGHIJ");
    assert.equal(afterClose.nextOffset, 20);
    assert.match(await readFile(join(root, "op_test", "metadata.json"), "utf8"), /closedAt/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("operation evidence rejects client-controlled paths and invalid cursors", async () => {
  const root = await mkdtemp(join(tmpdir(), "quaymesh-evidence-"));
  try {
    const store = new OperationEvidenceStore(root, 10);
    await assert.rejects(() => store.openWriter("../outside"));
    await assert.rejects(() => store.read("op_test", "stdout", -1, 1));
    await assert.rejects(() => store.read("op_test", "../../secret", 0, 1));
  } finally { await rm(root, { recursive: true, force: true }); }
});
