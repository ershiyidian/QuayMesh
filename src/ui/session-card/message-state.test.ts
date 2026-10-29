import assert from "node:assert/strict";
import test from "node:test";
import { messageDraftError } from "./message-state.js";

test("message drafts obey UTF-8 and both returned JSON representations", () => {
  for (const body of ["a".repeat(16_384), "😀".repeat(4096), "\\".repeat(7508), '"'.repeat(7508), "\n".repeat(8191) + "a"]) {
    assert.equal(messageDraftError(body), null);
  }
  for (const body of ["a".repeat(16_385), "😀".repeat(4097), "\\".repeat(7509), '"'.repeat(7509), "\\".repeat(8192), "\n".repeat(8192) + "a", "\n\t "]) {
    assert.ok(messageDraftError(body));
  }
  assert.equal(messageDraftError("纠正方向\n保留原来的任务。"), null);
});
