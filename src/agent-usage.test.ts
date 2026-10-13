import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalAgentStore } from "./local-agent-store.js";
import { parseCodexUsage, type AgentUsageObservation, type TokenCounts } from "./agent-usage.js";

const totals = (input = 100, output = 20): TokenCounts => ({ inputTokens: input, cachedInputTokens: 40,
  outputTokens: output, reasoningOutputTokens: 8, totalTokens: input + output });

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "quaymesh-usage-"));
  const store = new LocalAgentStore(root);
  const agent = store.create({ workspaceRoot: root, provider: "codex", profileName: "codex" });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const put = (event: Partial<AgentUsageObservation> = {}) => {
    const saved = store.recordUsageResult(agent.id, { threadId: "thread-1", turnId: "turn-1", newThread: true,
      total: totals(), ...event });
    assert(saved.isOk());
  };
  return { store, agent, put };
}

test("usage decoder preserves optional numeric details, rejects invalid values and strips content", () => {
  const value = { threadId: "t", turnId: "u", tokenUsage: { total: { ...totals(), hiddenReasoning: "PRIVATE" },
    last: { ...totals(20, 4), cacheWriteInputTokens: 2 } }, prompt: "PRIVATE" };
  const parsed = parseCodexUsage(value);
  assert(parsed);
  assert.equal(parsed.total.totalTokens, 120);
  assert.equal(parsed.total.cacheWriteInputTokens, undefined);
  assert.equal(parsed.lastRequest?.cacheWriteInputTokens, 2);
  assert(!JSON.stringify(parsed).includes("PRIVATE"));
  assert.equal(parseCodexUsage({ ...value, tokenUsage: { total: totals(-1, 20) } }), undefined);
  assert.equal(parseCodexUsage({ ...value, tokenUsage: { total: { ...totals(), inputTokens: Number.MAX_SAFE_INTEGER + 1 } } }), undefined);
  assert.equal(parseCodexUsage({ ...value, turnId: "" }), undefined);
});

test("cumulative notifications replace snapshots, not sum; stale and duplicate observations are ignored", (t) => {
  const { store, agent, put } = fixture(t);
  put(); put(); put({ total: totals(200, 30) }); put({ total: totals(150, 25) });
  const result = store.usage(agent.id);
  assert.equal(result.observations.length, 1);
  assert.equal(result.threads[0]?.totals.totalTokens, 230);
  assert.equal(result.observations[0]?.growth?.totalTokens, 230);
  assert.equal(result.observations[0]?.basis, "new_thread");
  assert.equal(result.observations[0]?.cumulative.cachedInputTokens, 40);
});

test("unobserved resumed history remains unknown and follow-up growth names its baseline", (t) => {
  const { store, agent, put } = fixture(t);
  put({ newThread: false, total: totals(1000, 100) });
  const first = store.usage(agent.id);
  assert.equal(first.observations[0]?.growth, null);
  assert.equal(first.observations[0]?.basis, "unknown_resumed_history");
  put({ newThread: false, turnId: "turn-2", total: totals(1200, 130), lastRequest: totals(50, 5) });
  const result = store.usage(agent.id);
  assert.equal(result.threads[0]?.totals.totalTokens, 1330);
  assert.equal(result.observations[1]?.growth?.totalTokens, 230);
  assert.equal(result.observations[1]?.basis, "since_previous_observation");
  assert.equal(result.observations[1]?.lastRequest?.totalTokens, 55);
});

test("failed tasks retain observed usage; no notifications is unknown, not zero", (t) => {
  const { store, agent, put } = fixture(t);
  assert.equal(store.usage(agent.id).status, "unknown");
  assert.deepEqual(store.usage(agent.id).threads, []);
  put();
  store.update(agent.id, { status: "error", errorCode: "PROVIDER_EXECUTION_ERROR" });
  assert.equal(store.usage(agent.id).status, "observed");
  assert.equal(store.usage(agent.id).threads[0]?.totals.totalTokens, 120);
  put({ turnId: "reset", newThread: false, total: totals(10, 1) });
  assert.equal(store.usage(agent.id).observations.length, 1);
});
