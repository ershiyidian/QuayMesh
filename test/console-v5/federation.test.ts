import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { WorkLedger } from "../../src/work-ledger.js";
import { createRealTestServer, freePort } from "../session-card/server-fixture.js";

test("Console reads tasks from their node and keeps last-confirmed rows when a node disconnects", { timeout: 60_000 }, async (t) => {
  const previous = process.env.QUAYMESH_CLUSTER_TOKEN;
  process.env.QUAYMESH_CLUSTER_TOKEN = "console-v5-real-local-cluster-token";
  t.after(() => { if (previous === undefined) delete process.env.QUAYMESH_CLUSTER_TOKEN; else process.env.QUAYMESH_CLUSTER_TOKEN = previous; });
  const workerPort = await freePort();
  const worker = await createRealTestServer({ federation: { nodeId: "worker", nickname: "执行节点", capabilities: {coordinator:false,worker:true,discovery:false,egress:false,meshRelay:false,desktopUi:false,consoleRelay:false}, priority: 0,
    port: workerPort, ingressPort: await freePort(), peers: [{ id: "entry", url: "" }] } });
  t.after(() => worker.dispose());
  const entry = await createRealTestServer({ federation: { nodeId: "entry", nickname: "控制台节点", capabilities: {coordinator:true,worker:false,discovery:false,egress:false,meshRelay:true,desktopUi:false,consoleRelay:false}, priority: 0,
    port: await freePort(), ingressPort: await freePort(), peers: [{ id: "worker", url: `http://127.0.0.1:${workerPort}` }] } });
  t.after(() => entry.dispose());
  const workerLedger = new WorkLedger(worker.config.stateDir);
  const run = workerLedger.begin({ root: worker.project, title: "远端工作记录", workItemId: "remote", runKey: "remote",
    origin: { entryPoint: "console", evidence: "server_entry" } });
  workerLedger.finish(run.id, { status: "completed", acceptance: "not_applicable", summary: "真实远端记录", evidence: [] });
  workerLedger.close();
  const deadline = Date.now() + 10000;
  while (!entry.running.federation!.nodes().some((node) => node.id === "worker" && node.online)) {
    assert.ok(Date.now() < deadline, "worker must connect"); await delay(100);
  }
  const login = await fetch(entry.baseUrl + "/console/api/login", { method: "POST", headers: { "Content-Type": "application/json", Origin: entry.baseUrl }, body: JSON.stringify({ password: "test-owner-token-that-is-long-enough" }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.getSetCookie()[0].split(";")[0];
  async function get(path: string) {
    const response = await fetch(entry.baseUrl + "/console/api/v4/" + path, { headers: { Cookie: cookie } });
    const value = await response.json() as any;
    assert.equal(response.status, 200, JSON.stringify(value)); return value;
  }
  const tasks = await get("runs?days=0");
  const remote = tasks.items.find((item: any) => item.localId === run.id);
  assert.ok(remote);
  assert.equal(remote.nodeId, "worker");
  assert.equal(tasks.complete, true);
  const detail = await get("runs/" + encodeURIComponent(remote.id));
  assert.equal(detail.summary, "真实远端记录");
  await worker.dispose();
  let after = tasks;
  const limit = Date.now() + 10000;
  while (!after.sources.some((source: any) => source.nodeId === "worker" && source.stale)) {
    assert.ok(Date.now() < limit, "offline source must be visible"); await delay(300); after = await get("runs?days=0");
  }
  assert.equal(after.complete, false);
  assert.ok(after.items.some((item: any) => item.localId === run.id));
  assert.equal(after.sources.find((source: any) => source.nodeId === "worker").online, false);
});
