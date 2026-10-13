import assert from "node:assert/strict";
import test from "node:test";
import { ALL_THREAD_SOURCES, CodexThreadControl } from "./codex-thread-control.js";

test("archive inventory includes noninteractive descendants and all model providers across pages", async () => {
  const calls: string[] = [];
  const provider = new CodexThreadControl({}, async () => ({ identity: async () => ({ instanceId: "fixture", identityVerified: true }), close: async () => {},
    control: async (method, raw) => {
      calls.push(method); const params = raw as Record<string, unknown>;
      if (method === "thread/read") return { thread: { id: "parent", cwd: process.cwd(), status: { type: "notLoaded" }, turns: [{ id: "t1", status: "completed" }] } };
      assert.equal(method, "thread/list"); assert.deepEqual(params.sourceKinds, [...ALL_THREAD_SOURCES]); assert.deepEqual(params.modelProviders, []);
      if (params.archived) return { data: [], nextCursor: null };
      if (!params.cursor) return { data: [{ id: "parent", source: "appServer" }], nextCursor: "next" };
      return { data: [{ id: "unmanaged-child", source: { subAgent: { thread_spawn: { parent_thread_id: "parent" } } } }], nextCursor: null };
    } }));
  const snapshot = await provider.inspect("parent");
  assert(snapshot.inventoryComplete); assert.deepEqual(snapshot.openDescendantIds, ["unmanaged-child"]);
  assert(calls.every((method) => ["thread/read", "thread/list"].includes(method))); await provider.close();
});

test("repeated cursors do not turn an incomplete graph into a safe archive inventory", async () => {
  const provider = new CodexThreadControl({}, async () => ({ identity: async () => ({ instanceId: "fixture", identityVerified: true }), close: async () => {},
    control: async (method, raw) => {
      if (method === "thread/read") return { thread: { id: "parent", cwd: process.cwd(), status: { type: "idle" }, turns: [] } };
      return (raw as { archived: boolean }).archived ? { data: [], nextCursor: null } : { data: [{ id: "parent", source: "appServer" }], nextCursor: "loop" };
    } }));
  assert.equal((await provider.inspect("parent")).inventoryComplete, false); await provider.close();
});
