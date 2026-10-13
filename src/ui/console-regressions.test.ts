import assert from "node:assert/strict";
import test from "node:test";
import { mergeUsage } from "./console/usage.js";
import { pathContains, rangeDays, safeConsoleUrl } from "./console/validation.js";
import { parseTime } from "./console/format.js";
import type { Usage } from "./console/types.js";
const usage = (status: Usage["usageStatus"], total: number | null): Usage => ({ usageStatus: status, codexUsage: total === null ? null : { inputTokens: total - 2, outputTokens: 2, totalTokens: total }, missingExecutions: status === "unavailable" ? 1 : 0, executions: 1, pendingExecutions: 0 });

test("unknown usage remains unknown instead of zero", () => {
  assert.equal(mergeUsage([usage("unavailable", null)]).codexUsage, null);
  assert.equal(mergeUsage([]).usageStatus, "unavailable");
});
test("known and unknown usage is partial, retaining known tokens", () => {
  const merged = mergeUsage([usage("complete", 200), usage("unavailable", null)]);
  assert.equal(merged.codexUsage?.totalTokens, 200);
  assert.equal(merged.usageStatus, "partial");
  assert.equal(merged.missingExecutions, 1);
});
test("absent optional token details are not invented", () => {
  assert.equal(mergeUsage([usage("complete", 200)]).codexUsage?.cachedInputTokens, undefined);
});
test("confirmed no model invocation is zero", () => {
  const result = mergeUsage([{ ...usage("not_used", null), executions: 0 }]);
  assert.equal(result.codexUsage?.totalTokens, 0);
  assert.equal(result.usageStatus, "not_used");
});
test("Unix path containment is case-sensitive and segment-aware", () => {
  assert.equal(pathContains("/data/VLA/src", "/data/VLA"), true);
  assert.equal(pathContains("/data/vla/src", "/data/VLA"), false);
  assert.equal(pathContains("/data/vla-old", "/data/vla"), false);
  assert.equal(pathContains("/data/vla", "/"), true);
});
test("Windows path containment supports separators and case", () => {
  assert.equal(pathContains("D:\\Projects\\game\\src", "d:/projects/Game/"), true);
  assert.equal(pathContains("\\\\host\\share\\src", "\\\\HOST\\SHARE"), true);
});
test("only supported date ranges can form API queries", () => {
  assert.equal(rangeDays("7"), 7);
  for (const input of ["all", "", "NaN", "Infinity", "-1", "99999999"]) assert.equal(rangeDays(input), null);
});
test("card URLs cannot execute scripts", () => {
  assert.equal(safeConsoleUrl("javascript:alert(1)"), undefined);
  assert.equal(safeConsoleUrl("data:text/html,hello"), undefined);
  assert.equal(safeConsoleUrl("https://example.com/console/?view=changes"), "https://example.com/console/?view=changes");
});
test("SQLite, ISO and seconds timestamps sort consistently", () => {
  assert.equal(parseTime("2026-09-24 10:00:00"), parseTime("2026-09-24T10:00:00Z"));
  assert.equal(parseTime("1790244000"), 1790244000000);
  assert.equal(parseTime("not-a-time"), null);
});
