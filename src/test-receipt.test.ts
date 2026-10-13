import assert from "node:assert/strict";
import test from "node:test";
import { TestReceiptSummary } from "./test-receipt.js";

test("test receipts retain only complete numeric footer evidence", () => {
  const parser = new TestReceiptSummary();
  parser.accept("private fixture body must stay in the local log\n  # pass 999\n# tests 3\n# pa");
  parser.accept("ss 2\n# fail 0\n# cancelled 0\n# skipped 1\n# todo 0\n# duration_ms 12.5\n");
  const receipt = parser.result(0, true);
  assert.equal(receipt.status, "passed");
  assert.equal(receipt.counts.pass, 2);
  assert.equal(receipt.counts.skipped, 1);
  assert(!JSON.stringify(receipt).includes("private fixture body"));
  assert.equal(parser.result(1, true).status, "failed");
  assert.equal(parser.result(0, false).status, "source_changed");
});

test("missing, inconsistent and oversized output never produces false passing evidence", () => {
  const parser = new TestReceiptSummary();
  parser.accept("x".repeat(100_000) + "\n");
  parser.accept("# tests 3\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n");
  assert.equal(parser.result(0, true).status, "incomplete");
  assert.equal(new TestReceiptSummary().result(0, true).status, "incomplete");
});
