import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { FederationRuntime, type FederationHooks } from "../../src/federation/runtime.js";
import { federationConfigSchema } from "../../src/federation/schema.js";
import { TOOL_DEADLINE_META } from "../../src/tool-request-budget.js";

async function runtimeFixture(t: test.TestContext, proxyPort = 1) {
  const root = await mkdtemp(join(tmpdir(), "qm-runtime-drain-"));
  const config = federationConfigSchema.parse({ enabled: true, nodeId: "worker", coordinatorId: "worker",
    host: "127.0.0.1", capabilities: { worker: true, egress: true }, roots: [], peers: [], priority: 100,
    egress: { enabled: false, proxyUrl: `http://127.0.0.1:${proxyPort}` } });
  config.port=0;
  const hooks: FederationHooks = { stateDir: root, httpPort: 7676, ingressPort: 0, publicBaseUrl: "http://127.0.0.1:7676",
    providers: () => [], prepareOpen: async input => input, checkWorkspace: async () => {}, console: async () => ({ status: 200, body: {} }),
    settings: () => ({}), updateSettings: async () => {}, mihomoImport: async () => null, mihomoRead: async () => "",
    resolveProxy: async () => config.egress.proxyUrl, artifactStat: async () => ({ size: 0 }), artifactRead: async () => { throw new Error("unused"); },
    artifactWrite: async () => {} };
  const runtime = new FederationRuntime(config, "fixture-secret", hooks);
  t.after(async () => {
    // Construction starts release metadata writes even before start(). Await
    // all runtime writers before deleting their directory; hooks run in order.
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });
  return runtime;
}

test("纯出口节点的真实 TCP 连接阻止维护切换，排空后才空闲", async t => {
  const sockets = new Set<Socket>();
  const proxy = createServer(socket => { sockets.add(socket); socket.on("data", bytes => socket.write(bytes)); socket.on("close", () => sockets.delete(socket)); });
  await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => proxy.close(() => resolve())); });
  const runtime = await runtimeFixture(t, (proxy.address() as { port: number }).port);
  await runtime.start();
  const stream = await runtime.openNodeStream("worker", "egress");
  const received = new Promise<Buffer>(resolve => stream.once("data", resolve)); stream.write("model-request");
  assert.equal((await received).toString(), "model-request");
  assert.equal(runtime.execution.admissionStatus().idle, false);
  assert.equal(runtime.status().activeEgressConnections, 1);
  runtime.execution.pause("deployment"); runtime.refreshAdmission();
  assert.equal(runtime.nodes()[0].egress.draining, true);
  await assert.rejects(runtime.openNodeStream("worker", "egress"), { code: "NODE_ADMISSION_PAUSED" });
  assert.equal(stream.destroyed, false);
  stream.destroy();
  for (let attempt = 0; !runtime.execution.admissionStatus().idle && attempt < 100; attempt++) await delay(10);
  assert.equal(runtime.execution.admissionStatus().idle, true);
});

test("只读期限传到实际 handler，修改操作在调用方断开后继续一次落盘", async t => {
  const runtime = await runtimeFixture(t);
  let readCancelled = false;
  runtime.handlers.set("read_output", (_args, extra) => new Promise(resolve => {
    (extra.signal as AbortSignal).addEventListener("abort", () => { readCancelled = true; resolve({ result: "" }); }, { once: true });
  }));
  await assert.rejects(runtime.invokeLocal("read_output", {}, { _meta: { [TOOL_DEADLINE_META]: Date.now() + 100 } }), { code: "REQUEST_TIMEOUT" });
  assert.equal(readCancelled, true);
  const controller = new AbortController(); let writes = 0;
  runtime.handlers.set("apply_patch", async (_args, extra) => {
    await delay(50); assert.equal((extra.signal as AbortSignal).aborted, false); writes++; return { committed: true };
  });
  const write = runtime.invokeLocal("apply_patch", {}, { signal: controller.signal }); controller.abort();
  assert.deepEqual(await write, { committed: true }); assert.equal(writes, 1);
});

test("实际执行阶段与 handler 进度传到调用者，并使用当前请求的 token", async t => {
  const runtime = await runtimeFixture(t);
  const notifications: Array<{ params: { progressToken: string; progress: number; message: string } }> = [];
  runtime.handlers.set("read_output", async (_args, extra) => {
    await (extra.sendNotification as (value: unknown) => Promise<void>)({ method: "notifications/progress", params: {
      progressToken: "different-token", progress: 50, total: 100, message: "输出已读取", authorization: "not-forwarded",
    } });
    return { result: "done" };
  });
  assert.deepEqual(await runtime.tool("read_output", {}, {
    _meta: { progressToken: "current-request" }, sendNotification: async (notification: typeof notifications[number]) => { notifications.push(notification); },
  }), { result: "done" });
  assert.deepEqual(notifications.map(value => value.params.progressToken), Array(4).fill("current-request"));
  assert.deepEqual(notifications.map(value => value.params.progress), [0, 1, 2, 3]);
  assert.match(notifications[0].params.message, /接收调用/);
  assert.equal(notifications[2].params.message, "输出已读取");
  assert.match(notifications[3].params.message, /返回结果/);
  assert.equal("authorization" in notifications[2].params, false);
});
