import assert from "node:assert/strict";
import test from "node:test";
import { createRuntimeControlServer, runtimeControlPipeName, sendRuntimeControl, type RuntimeControlRequest } from "./runtime-control.js";

test("runtime control sends only the bounded local protocol", async () => {
  const request: RuntimeControlRequest = { protocol: "quaymesh.runtime-control.v1", operation: "status", instanceId: "test-instance", pid: process.pid, startedAt: new Date().toISOString() };
  const pipeName = runtimeControlPipeName(`test-instance-${process.pid}`);
  const control = createRuntimeControlServer({ instanceId: request.instanceId, pid: request.pid, startedAt: request.startedAt, handle: () => ({ accepted: true, state: "received" }) });
  await new Promise<void>((resolve, reject) => { control.server.once("error", reject); control.server.listen(pipeName, resolve); });
  try {
    const response = await sendRuntimeControl(pipeName, request);
    assert.deepEqual(response, { accepted: true, state: "received" });
    assert.match(runtimeControlPipeName("test-instance"), /test-instance/);
    await assert.rejects(() => sendRuntimeControl(pipeName, { ...request, operation: "invalid" as never }));
  } finally { await control.close(); }
});
