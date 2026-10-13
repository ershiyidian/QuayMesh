import assert from "node:assert/strict";
import test from "node:test";
import { summarizeCodexFailure } from "./codex-failure-summary.js";

test("provider failure classification preserves actionable cause without secret text", () => {
  const secret = "private-key-and-recording-content-do-not-print";
  const failure = summarizeCodexFailure({ turn: { status: "failed", error: {
    message: `Upstream disconnected. ${secret} https://example.test/?token=${secret}`,
    codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } },
  } } });
  assert.equal(failure.category, "transport_or_service");
  assert.equal(failure.httpStatus, 503);
  assert.equal(failure.retryable, true);
  assert.ok(!JSON.stringify(failure).includes(secret));
  assert.ok(!JSON.stringify(failure).includes("example.test"));
});

test("quota, authentication, context and permissions are not blindly retried", () => {
  for (const [message, category] of [
    ["You have hit your usage limit", "usage_or_rate_limit"],
    ["context window exceeded", "context_limit"],
    ["Invalid API key", "authentication"],
    ["Access denied by sandbox", "permission_or_sandbox"],
    ["model not available", "model_configuration"],
  ]) {
    const result = summarizeCodexFailure({ turn: { error: { message } } });
    assert.equal(result.category, category);
    assert.equal(result.retryable, false);
  }
});

test("malformed errors remain bounded and unknown, never invented success", () => {
  const result = summarizeCodexFailure({ turn: { error: { message: "secret".repeat(100000),
    codexErrorInfo: { unsafe_private_field: { httpStatusCode: 99999 } } } } });
  assert.equal(result.category, "unclassified_provider_error");
  assert.equal(result.httpStatus, undefined);
  assert.ok(JSON.stringify(result).length < 600);
  assert.ok(!JSON.stringify(result).includes("unsafe_private_field"));
  assert.equal(summarizeCodexFailure(null).category, "unclassified_provider_error");
});

test("persisted quota evidence is actionable even without an English message", () => {
  const result = summarizeCodexFailure({ type: "task_complete", error: {
    codex_error_info: "usage_limit_exceeded", message: "private provider diagnostic",
  } });
  assert.equal(result.category, "usage_or_rate_limit");
  assert.equal(result.retryable, false);
  assert.equal(result.nextAction, "check_provider_limits_before_resuming_original_thread");
  assert.ok(!JSON.stringify(result).includes("private provider diagnostic"));
});
