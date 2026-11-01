import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, Socket } from "node:net";
import { createServer as createHttp2Server, connect, constants, type ClientHttp2Session,
  type ClientHttp2Stream, type Http2Session, type ServerHttp2Stream } from "node:http2";
import type { Duplex } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { FederationRuntime, type FederationHooks } from "../../src/federation/runtime.js";
import { federationConfigSchema } from "../../src/federation/schema.js";
import { TOOL_DEADLINE_META } from "../../src/tool-request-budget.js";
import type { RuntimeWorkInput } from "../../src/execution-coordinator.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function until(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 3000;
  while (!check()) {
    if (performance.now() >= deadline) throw new Error("egress cleanup timed out");
    await delay(5);
  }
}

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

for (const mode of ["cancel-before-proxy", "cancel-after-bridge", "half-close"] as const) {
  test(`出口连接正确回收并保留合法半关闭：${mode}`, { timeout: 15_000 }, async t => {
    const gate = deferred(), opened = deferred(), handled = deferred(), sourceClosed = deferred();
    const proxyInputEnded = deferred(), responseEnded = deferred();
    const sockets = new Set<Socket>(), sessions = new Set<Http2Session>();
    const upload: Buffer[] = [], response: Buffer[] = [], expected = Buffer.alloc(22_161, "response");
    let destination: Socket | undefined, proxySocket: Socket | undefined, source: ServerHttp2Stream | undefined;
    let client: ClientHttp2Session | undefined, request: ClientHttp2Stream | undefined, handlerError: unknown;
    // A real half-open proxy keeps its response side alive after upload EOF.
    // The cancelled source must not leave that TCP connection untracked.
    const proxy = createServer({ allowHalfOpen: true }, socket => {
      proxySocket = socket; sockets.add(socket); socket.on("error", () => {});
      socket.on("close", () => sockets.delete(socket));
      socket.on("data", chunk => upload.push(Buffer.from(chunk))); socket.once("end", proxyInputEnded.resolve);
    });
    const gateway = createHttp2Server();
    gateway.on("session", session => {
      sessions.add(session); session.on("error", () => {}); session.on("close", () => sessions.delete(session));
    });
    t.after(async () => {
      gate.resolve(); destination?.destroy(); request?.destroy(); client?.destroy();
      for (const session of sessions) session.destroy(); for (const socket of sockets) socket.destroy();
      await Promise.all([proxy, gateway].map(server => server.listening
        ? new Promise<void>(resolve => server.close(() => resolve())) : Promise.resolve()));
    });
    await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
    const runtime = await runtimeFixture(t, (proxy.address() as { port: number }).port);
    await runtime.start();
    const beginWork = runtime.execution.beginWork.bind(runtime.execution);
    t.mock.method(runtime.execution, "beginWork", (input: RuntimeWorkInput) => {
      const lease = beginWork(input);
      if (input.kind !== "egress") return lease;
      return { ...lease, run<T>(action: () => T): T {
        // Delay only delivery of the actual TCP dial. Lease ownership and the
        // production receiveStream/bridge/close paths remain unchanged.
        return Promise.resolve(lease.run(action)).then(async socket => {
          assert.ok(socket instanceof Socket); destination = socket; opened.resolve();
          await gate.promise; return socket;
        }) as T;
      } };
    });
    const receiver = runtime as unknown as {
      receiveStream(service: string, metadata: Record<string, unknown>, stream: Duplex): Promise<void>;
    };
    gateway.on("stream", stream => {
      source = stream; stream.on("error", () => {}); stream.once("close", sourceClosed.resolve);
      stream.respond({ ":status": 200 });
      void receiver.receiveStream("egress", {}, stream).catch(error => {
        handlerError = error; stream.destroy();
      }).finally(handled.resolve);
    });
    await new Promise<void>(resolve => gateway.listen(0, "127.0.0.1", resolve));
    client = connect(`http://127.0.0.1:${(gateway.address() as { port: number }).port}`); client.on("error", () => {});
    request = client.request({ ":method": "POST", ":path": "/egress" }, { endStream: false });
    request.on("error", () => {}); request.on("data", chunk => response.push(Buffer.from(chunk)));
    request.once("end", responseEnded.resolve);
    await opened.promise;
    assert.equal(runtime.status().activeEgressConnections, 1);
    assert.equal(runtime.execution.admissionStatus().activeWork, 1);
    if (mode === "cancel-before-proxy") {
      request.close(constants.NGHTTP2_CANCEL); await sourceClosed.promise;
      await until(() => runtime.execution.admissionStatus().activeWork === 0);
      assert.equal(destination!.destroyed, false, "the dial is held before the handler can bridge or clean it");
    } else if (mode === "half-close") request.end("model-request");
    gate.resolve(); await handled.promise;
    assert.equal(handlerError, undefined);
    if (mode === "cancel-after-bridge") {
      assert.equal(destination!.destroyed, false);
      request.close(constants.NGHTTP2_CANCEL); await sourceClosed.promise;
    } else if (mode === "half-close") {
      await proxyInputEnded.promise;
      assert.equal(Buffer.concat(upload).toString(), "model-request");
      assert.equal(source!.destroyed, false); assert.equal(destination!.destroyed, false);
      assert.equal(runtime.execution.admissionStatus().activeWork, 1, "a response still owns its live lease");
      proxySocket!.end(expected); await responseEnded.promise; await sourceClosed.promise;
      assert.deepEqual(Buffer.concat(response), expected, "upload EOF must preserve the complete response");
    }
    await until(() => destination!.destroyed && runtime.status().activeEgressConnections === 0
      && runtime.execution.admissionStatus().activeWork === 0);
  });
}

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
