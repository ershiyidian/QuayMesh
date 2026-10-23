import assert from "node:assert/strict";
import test from "node:test";
import { writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createRealTestServer, freePort } from "./session-card/server-fixture.js";

test("首次启动的真实 Core 在发行验证期间拒绝新工作与出口，并保留诊断查询", async t => {
  const keys = ["QUAYMESH_INSTALL_TRANSITION_FILE", "QUAYMESH_CLUSTER_TOKEN"] as const;
  const previous = new Map(keys.map(key => [key, process.env[key]]));
  t.after(() => { for (const [key, value] of previous) value === undefined ? delete process.env[key] : process.env[key] = value; });
  const token = "isolated-upgrade-transition-token-long-enough";
  process.env.QUAYMESH_CLUSTER_TOKEN = token;
  let marker = "";
  const server = await createRealTestServer({ git: false, uiEnabled: false,
    federation: { nodeId: "validation", nickname: "validation", priority: 100, port: await freePort(), ingressPort: await freePort(), peers: [],
      capabilities: { coordinator: false, worker: true, discovery: false, egress: true, meshRelay: false, desktopUi: false, consoleRelay: false } },
    configure: async config => {
      marker = join(dirname(config.stateDir), "installation-transition.json");
      await writeFile(marker, JSON.stringify({ sourceCommit: "new", phase: "validating" }));
      process.env.QUAYMESH_INSTALL_TRANSITION_FILE = marker;
      return config;
    },
  });
  t.after(() => server.dispose());
  const runtime = server.running.federation!;
  assert.equal(server.running.execution.admissionStatus().accepting, false);
  assert.equal(runtime.nodes()[0].egress.draining, true);
  let mutations = 0;
  runtime.handlers.set("apply_patch", () => { mutations++; return { done: true }; });
  runtime.handlers.set("read_output", () => ({ saved: true }));
  await assert.rejects(runtime.invokeLocal("apply_patch", {}), { code: "NODE_ADMISSION_PAUSED" });
  await assert.rejects(runtime.openNodeStream("validation", "egress"), { code: "NODE_ADMISSION_PAUSED" });
  assert.deepEqual(await runtime.invokeLocal("read_output", {}), { saved: true });
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const idle = await fetch(`${server.baseUrl}/internal/quaymesh/idle`, { headers });
  assert.equal(idle.status, 200); assert.equal((await idle.json()).accepting, false);
  const resume = () => fetch(`${server.baseUrl}/internal/quaymesh/admission`, { method: "POST", headers, body: JSON.stringify({ action: "resume" }) });
  assert.equal((await resume()).status, 409);
  assert.equal(mutations, 0);
  await rm(marker);
  assert.equal(server.running.execution.admissionStatus().accepting, false, "删除标记后仍等待 manager 明确恢复");
  assert.equal((await resume()).status, 200);
  assert.deepEqual(await runtime.invokeLocal("apply_patch", {}), { done: true });
  assert.equal(mutations, 1); assert.equal(runtime.nodes()[0].egress.draining, false);
});
