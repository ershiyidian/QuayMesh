import assert from "node:assert/strict";
import { test } from "node:test";
import { quotaPreflight } from "./codex-quota-preflight.js";

test("explicit provider limits prevent inference without consuming reset credits", () => {
  const r = quotaPreflight({ rateLimits: { rateLimitReachedType: "weekly", primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 123 } }, secret: "not-output" });
  assert.equal(r.blockedByProvider, true); assert.equal(r.primary?.windowDurationMins, 10080);
  assert.equal(r.resetCreditConsumed, false); assert.ok(!JSON.stringify(r).includes("not-output"));
});
test("missing windows and full percentages alone do not invent a hard account restriction", () => {
  assert.equal(quotaPreflight(null).blockedByProvider, false);
  assert.equal(quotaPreflight({ rateLimits: { primary: { usedPercent: 100 } } }).blockedByProvider, false);
  assert.equal(quotaPreflight({ spendControlReached: true }).blockedByProvider, true);
});
