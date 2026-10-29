import assert from "node:assert/strict";
import test from "node:test";
import { fileSchema } from "../../src/session/schema.js";
import { fixture, until } from "./fixture.js";

test("real qm_session v9 replies and all file pages negotiate timestamps explicitly, while file diff stays compatible", async t => {
  const f = await fixture(t, { git: false });
  const patch = ["*** Begin Patch", ...Array.from({ length: 51 }, (_, index) => [
    `*** Add File: evidence-${String(index).padStart(2, "0")}.txt`, "+file time evidence",
  ]).flat(), "*** End Patch"].join("\n");
  await f.call("apply_patch", { ...f.scope, patch });
  const args = { session_id: f.workspace.session_id, task_id: f.task.task_id, member_id: f.workspace.member_id,
    since_rev: -1, resource_version: "task-card-v9" };
  await until(async () => (await f.call("qm_session", args)).snapshot?.totals.files === 51, 30_000);
  const oldFile = fileSchema.omit({ recordedAt: true }).strict();
  for (const capability of [undefined, false, true]) {
    let cursor: string | null = null;
    const ids = new Set<string>();
    do {
      const reply = await f.call("qm_session", { ...args, ...(capability === undefined ? {} : {file_recorded_at: capability}),
        ...(cursor ? {cursor} : {}) });
      for (const file of reply.snapshot.files) {
        assert.equal(ids.has(file.id), false, "file paging does not duplicate evidence"); ids.add(file.id);
        if (capability === true) assert.equal(typeof file.recordedAt, "number");
        else { assert.equal(Object.hasOwn(file, "recordedAt"), false); oldFile.parse(file); }
      }
      cursor = reply.snapshot.cursors.files;
    } while (cursor);
    assert.equal(ids.size, 51);
  }
  const current = await f.call("qm_session", { ...args, file_recorded_at: true });
  const file = current.snapshot.files[0];
  const diff = await f.call("qm_file_diff", { session_id: args.session_id, task_id: args.task_id, member_id: file.member_id,
    file_id: file.id, hash: file.hash });
  assert.match(diff.patch, /file time evidence/);
  assert.equal(Object.hasOwn(diff, "file"), false);
  assert.equal(Object.hasOwn(diff, "recordedAt"), false);
});
