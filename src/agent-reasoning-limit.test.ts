import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result } from "better-result";
import { limitedReasoningEffort } from "./agent-reasoning-limit.js";
import { subagentsConfigSchema, type SubagentProviderConfig } from "./local-agent-config.js";
import { LocalAgentManager } from "./local-agent-manager.js";
import { LocalAgentStore } from "./local-agent-store.js";
import { LocalAgentRuntimePool } from "./local-agent-runtime-pool.js";
import type { LocalAgentDriver, LocalAgentRunInput } from "./local-agent-runtime.js";

const provider: SubagentProviderConfig = { id: "codex", enabled: true, model: "gpt-6-astra", effort: "medium",
  readOnlyDefaults: { effort: "low" }, reasoningLimits: [{ model: "gpt-6", maxEffort: "medium" }] };

test("reasoning ceilings match model families and fail closed on unknown configuration", () => {
  for (const effort of ["high", "xhigh", "max", "ultra"]) assert.equal(limitedReasoningEffort(provider, "gpt-6-astra", effort), "medium");
  for (const effort of ["none", "minimal", "low", "medium"]) assert.equal(limitedReasoningEffort(provider, "gpt-6", effort), effort);
  assert.equal(limitedReasoningEffort(provider, "GPT-6-ASTRA", "high"), "medium");
  assert.equal(limitedReasoningEffort(provider, "gpt-60", "high"), "high");
  assert.equal(limitedReasoningEffort(provider, "gpt-5.4", "high"), "high");
  assert.equal(limitedReasoningEffort(undefined, undefined, "custom"), "custom");
  assert.equal(limitedReasoningEffort(provider, "gpt-6", undefined), "medium");
  assert.throws(() => limitedReasoningEffort(provider, undefined, "high"), /explicit resolved model/);
  assert.throws(() => limitedReasoningEffort(provider, "gpt-6", "unknown"), /Unknown reasoning effort/);
  assert.equal(limitedReasoningEffort({ ...provider, reasoningLimits: [...provider.reasoningLimits!, { model: "gpt-6-astra", maxEffort: "low" }] }, "gpt-6-astra", "high"), "low");
  assert.equal(subagentsConfigSchema.safeParse({ enabled: true, providers: [provider] }).success, true);
  assert.equal(subagentsConfigSchema.safeParse({ enabled: true, providers: [{ ...provider, id: "claude" }] }).success, false);
});

test("fake provider sees capped starts and continuations with defaults and idempotency preserved", async () => {
  const root = mkdtempSync(join(tmpdir(), "quaymesh-reasoning-limit-"));
  const project = join(root, "project"); mkdirSync(project);
  const store = new LocalAgentStore(join(root, "state"));
  const calls: LocalAgentRunInput[] = [];
  const resolutions: Record<string, unknown>[] = [];
  const driver: LocalAgentDriver = { provider: "codex", runtimeKey: () => "fixture", createRuntime: async () => Result.ok({
    provider: "codex", isAlive: () => true, close: async () => {}, releaseSession: async () => {},
    run: async (input) => { calls.push(input); return Result.ok({ provider: "codex", providerSessionId: "fixture-thread", finalResponse: "fixture", items: [] }); },
  }) };
  const manager = new LocalAgentManager({ store, drivers: [driver], pool: new LocalAgentRuntimePool(),
    loadProfiles: async () => [{ name: "reviewer", provider: "codex", model: "gpt-6-astra", effort: "high",
      body: "", description: "fixture", filePath: join(project, "profile.md"), disabled: false }],
    logger: (_level, event, fields) => { if (event === "agent_reasoning_resolved") resolutions.push(fields); },
    allowedRoots: [root], subagents: { enabled: true, instructions: "on-demand", providers: [provider] } });
  const scope = { workspaceRoot: project, workspaceId: "ws" };
  const settled = async () => {
    for (let attempt = 0; attempt < 200 && manager.activeTurnCount; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(manager.activeTurnCount, 0);
  };
  try {
    const input = { ...scope, target: "codex", prompt: "fixture", taskKey: "first", effort: "high" };
    const started = await manager.start(input); assert(started.isOk()); await settled();
    assert.equal(calls[0]?.effort, "medium"); assert.equal(started.value.effort, "medium");
    assert.equal(resolutions[0]?.source, "caller"); assert.equal(resolutions[0]?.requestedEffort, "high");
    assert.equal(resolutions[0]?.effectiveEffort, "medium"); assert.equal(resolutions[0]?.capped, true);
    const replay = await manager.start(input); assert(replay.isOk());
    assert.equal(replay.value.id, started.value.id); assert.equal(calls.length, 1);
    const continued = await manager.continue(started.value.id, "next", { requestKey: "next", effort: "xhigh" }, scope);
    assert(continued.isOk()); await settled(); assert.equal(calls[1]?.effort, "medium");
    const read = await manager.continue(started.value.id, "read", { requestKey: "read", writeMode: "read_only" }, scope);
    assert(read.isOk()); await settled(); assert.equal(calls[2]?.effort, "low");
    assert.equal(resolutions[2]?.source, "read_only_default");
    const write = await manager.continue(started.value.id, "write", { requestKey: "write" }, scope);
    assert(write.isOk()); await settled(); assert.equal(calls[3]?.effort, "medium");
    const rejected = await manager.start({ ...scope, target: "codex", prompt: "invalid", effort: "unknown" });
    assert(rejected.isErr()); assert.equal(calls.length, 4); assert.equal(rejected.error.retryable, false);
    const profile = await manager.start({ ...scope, target: "reviewer", prompt: "profile default" });
    assert(profile.isOk()); await settled(); assert.equal(calls[4]?.effort, "medium");
    assert.equal(resolutions[4]?.source, "target_or_session_default");
    const explicitRead = await manager.continue(started.value.id, "explicit read", { requestKey: "explicit-read", writeMode: "read_only", effort: "high" }, scope);
    assert(explicitRead.isOk()); await settled(); assert.equal(calls[5]?.effort, "medium");
  } finally { await manager.close(); rmSync(root, { recursive: true, force: true }); }
});
