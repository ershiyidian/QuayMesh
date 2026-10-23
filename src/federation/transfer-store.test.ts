import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TransferStore } from "./transfer-store.js";

test("transfer pages search the full durable history before applying a limit", t => {
  const directory = mkdtempSync(join(tmpdir(), "qm-transfer-page-"));
  const store = new TransferStore(directory, "node");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  for (let index = 0; index < 65; index++) {
    const saved = store.reserve({ requestKey: `transfer-${index}`, sourceNode: "source", sourceWorkspace: "ws", sourcePath: `source-${index}.txt`,
      destinationWorkspace: "target", destinationPath: `destination-${index}.txt`, overwrite: false });
    store.finish(saved.view.id, "completed", index);
  }
  assert.equal(store.list().length, 40);
  const first = store.page({ limit: 25 });
  assert.equal(first.total, 65);
  const all = [...first.items, ...store.page({ offset: 25, limit: 25 }).items, ...store.page({ offset: 50, limit: 25 }).items];
  assert.equal(new Set(all.map(value => value.id)).size, 65);
  const searched = store.page({ q: "source-0.txt", limit: 25 });
  assert.equal(searched.total, 1); assert.equal(searched.items[0]?.source, "source:source-0.txt");
});
