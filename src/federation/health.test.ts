import assert from "node:assert/strict";
import test from "node:test";
import koffi from "koffi";
import { sampleHealth } from "./health.js";

test("health sampling reports the real filesystem that contains the workspace", async () => {
  const health = await sampleHealth(0, [process.cwd()]);
  assert.ok(health.cpuCount > 0);
  assert.ok(health.memoryTotal > 0);
  assert.ok(health.disks?.length);
  for (const disk of health.disks ?? []) {
    assert.ok(disk.mount.length > 0);
    assert.ok(disk.total > 0);
    assert.ok(disk.free >= 0 && disk.free <= disk.total);
  }
  assert.equal(typeof health.gpuSampled, "boolean");
});

test("Windows battery health sampling leaves NVIDIA GPU asleep", { skip: process.platform !== "win32" }, async () => {
  const powerStatus = koffi.load("kernel32.dll").func("bool GetSystemPowerStatus(_Out_ void *status)");
  const state = Buffer.alloc(12);
  assert.equal(powerStatus(state), true);
  if (state.readUInt8(0) !== 0) return;
  const health = await sampleHealth(0, [process.cwd()]);
  assert.equal(health.gpuSampled, false);
  assert.deepEqual(health.gpus, []);
});
