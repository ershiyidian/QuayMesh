import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { terminateProcessTree } from "./process-platform.js";

test("取消真实子进程时事件循环可以继续运行", { timeout: 10000 }, async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: process.platform !== "win32", stdio: "ignore", windowsHide: true,
  });
  await once(child, "spawn");
  const exited = once(child, "exit");
  const progress: string[] = [];
  const tick = setImmediate(() => progress.push("event-loop"));
  try {
    await terminateProcessTree(child, "SIGTERM", process.platform !== "win32");
    await exited;
    await delay(0);
    assert.ok(progress.includes("event-loop"));
    assert.ok(child.exitCode !== null || child.signalCode !== null);
  } finally {
    clearImmediate(tick);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});
