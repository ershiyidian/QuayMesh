import assert from "node:assert/strict";
import test from "node:test";
import * as z from "zod/v4";
import { previewSnapshot } from "../ui/session-card/preview.js";
import { CARD_RESOURCES, projectionForCard, snapshotForCard, WORKSPACE_APP_VERSION } from "./card-contract.js";
import { filesForReader } from "./file-contract.js";
import { fileSchema, snapshotSchema } from "./schema.js";

const oldFile = fileSchema.omit({ recordedAt: true }).strict();
const oldReader = snapshotSchema.extend({ files: z.array(oldFile) }).strip();

test("all cached card readers, including older HTML at v9, require an explicit file-time capability", () => {
  const file = Object.freeze({ ...previewSnapshot.files[0], recordedAt: 1234 });
  const snapshot = Object.freeze({ ...previewSnapshot, files: Object.freeze([file]) as unknown as typeof previewSnapshot.files });
  assert.equal(oldReader.safeParse(snapshot).success, false, "reproduce the cached strict nested reader failure");
  for (const version of [undefined, "unknown-card", ...CARD_RESOURCES.map(resource => resource.version)]) {
    const result = snapshotForCard(snapshot, version);
    const projection = projectionForCard({ snapshot, unchanged: false }, version);
    assert.equal(Object.hasOwn(result.files[0], "recordedAt"), false);
    assert.equal(Object.hasOwn(projection.snapshot.files[0], "recordedAt"), false);
    oldReader.parse(result);
    oldReader.parse(projection.snapshot);
  }
  const current = snapshotForCard(snapshot, WORKSPACE_APP_VERSION, true);
  assert.equal(current.files[0].recordedAt, 1234);
  assert.equal(projectionForCard({snapshot}, WORKSPACE_APP_VERSION, true).snapshot.files[0].recordedAt, 1234);
  assert.equal(Object.hasOwn(snapshotForCard(snapshot, WORKSPACE_APP_VERSION, false).files[0], "recordedAt"), false);
  snapshotSchema.parse(current);
  assert.equal(file.recordedAt, 1234, "wire adaptation must not erase durable evidence");
});

test("file wire adaptation keeps all storage references, removes even explicit null, and leaves known versions intact", () => {
  const file = Object.freeze({ ...previewSnapshot.files[0], patchRef: "/evidence/patch", versionRef: "tree", recordedAt: null });
  const legacy = filesForReader([file], false)[0];
  assert.equal(Object.hasOwn(legacy, "recordedAt"), false);
  assert.equal(legacy.hash, file.hash);
  assert.equal(legacy.patchRef, file.patchRef);
  assert.equal(legacy.versionRef, file.versionRef);
  assert.equal(filesForReader([file], true)[0], file);
  assert.equal(file.recordedAt, null);
});
