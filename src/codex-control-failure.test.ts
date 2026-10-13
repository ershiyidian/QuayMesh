import assert from "node:assert/strict";
import test from "node:test";
import { summarizeCodexControlFailure } from "./codex-failure-summary.js";

test("control rejection identifies its stage without leaking arguments or private error text", () => {
  const privateText = "bad root /private/project token=private-value";
  const result = summarizeCodexControlFailure("thread/resume", Object.assign(new Error(privateText), { code: -32602 }));
  assert.equal(result.stage, "thread/resume");
  assert.equal(result.category, "invalid_rpc_parameters");
  assert.equal(result.retryable, false);
  assert.equal(result.outcome, "not_confirmed");
  assert(!JSON.stringify(result).includes("private-value"));
  assert(!JSON.stringify(result).includes("/private/project"));
});

test("unsupported and unknown control messages stay bounded and never claim inference", () => {
  assert.equal(summarizeCodexControlFailure("account/rateLimits/read", { code: -32601 }).category, "unsupported_rpc");
  const result = summarizeCodexControlFailure("private /evil\ncontrol", new Error("upstream timeout"));
  assert.equal(result.stage, "unknown_control");
  assert.equal(result.category, "transport_or_service");
  assert.equal(result.outcome, "not_confirmed");
  assert(!JSON.stringify(result).includes("evil"));
});
