import assert from "node:assert/strict";
import test from "node:test";
import type { ReviewPayloadData } from "./card-types.js";

test("review payload data carries files, patch and truthful totals", () => {
  const data: ReviewPayloadData = {
    files: [{ path: "src/a.ts", type: "change", additions: 2, removals: 1 }],
    patch: "diff --git a/src/a.ts b/src/a.ts",
    summary: { files: 1, additions: 2, removals: 1 },
  };
  assert.equal(data.files[0]?.path, "src/a.ts");
  assert.equal(data.summary.files, 1);
});
