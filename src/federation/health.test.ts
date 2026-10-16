import assert from "node:assert/strict";
import test from "node:test";
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
