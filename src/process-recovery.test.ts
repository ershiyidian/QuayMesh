import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessSessionManager } from "./process-sessions.js";
const node = `"${process.execPath}"`;
const base = { workspaceId: "a", cwd: process.cwd(), yieldTimeMs: 2000 };

test("bounded terminal receipts replay lost start/write failures and cancellations, reject writes and foreign workspaces", { timeout: 15_000 }, async (t) => {
  const events: string[] = [];
  const manager = new ProcessSessionManager({ maxBufferCharacters: 512, diagnostics: (event) => events.push(event) });
  t.after(() => manager.shutdown());
  const result = await manager.start({ ...base, command: `${node} -e "console.log('once');process.exit(7)"` });
  assert.equal(result.running, false); assert.equal(result.exitCode, 7);
  for (let i = 0; i < 2; i++) assert.deepEqual(await manager.write({ workspaceId: "a", sessionId: result.sessionId! }), { ...result, terminalReplay: true });
  assert.equal(events.filter((e) => e === "process_started").length, 1);
  assert.equal(events.filter((e) => e === "process_finished").length, 1);
  assert.equal(events.filter((e) => e === "process_output_consumed").length, 1);
  await assert.rejects(manager.write({ workspaceId: "b", sessionId: result.sessionId! }), /does not belong/);
  await assert.rejects(manager.write({ workspaceId: "a", sessionId: result.sessionId!, chars: "mutation" }), /only empty/);
  const running = await manager.start({ ...base, command: `${node} -e "setInterval(()=>{},1000)"`, yieldTimeMs: 20 });
  let cancelled = await manager.write({ workspaceId: "a", sessionId: running.sessionId!, chars: "\u0003", yieldTimeMs: 2000 });
  if (cancelled.running) {
    cancelled = await manager.write({ workspaceId: "a", sessionId: running.sessionId!, yieldTimeMs: 3000 });
  }
  assert.equal(cancelled.running, false);
  assert.deepEqual(await manager.write({ workspaceId: "a", sessionId: running.sessionId! }), { ...cancelled, terminalReplay: true });
});

test("terminal receipts expire by count and TTL", { timeout: 10_000 }, async (t) => {
  const manager = new ProcessSessionManager({ maxCompletedSessions: 1, completedSessionTtlMs: 300 });
  t.after(() => manager.shutdown());
  const first = await manager.start({ ...base, command: "echo first" });
  const second = await manager.start({ ...base, command: "echo second" });
  await assert.rejects(manager.write({ workspaceId: "a", sessionId: first.sessionId! }), /Unknown/);
  assert.equal((await manager.write({ workspaceId: "a", sessionId: second.sessionId! })).terminalReplay, true);
  await new Promise((resolve) => setTimeout(resolve, 350));
  await assert.rejects(manager.write({ workspaceId: "a", sessionId: second.sessionId! }), /Unknown/);
});

test("root exit retains lifecycle until inherited stdio closes", { timeout: 10_000, skip: process.platform === "win32" ? "cmd shell root waits for child; POSIX exec fixture required" : false }, async (t) => {
  const manager = new ProcessSessionManager(); t.after(() => manager.shutdown());
  // Leave a wide gap between root startup and descendant shutdown so this
  // lifecycle assertion remains deterministic under a loaded CI host.
  const result = await manager.start({ ...base, command: `exec ${node} -e "const child=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},3000)'],{stdio:['ignore',1,2]});child.unref();process.exit(0)"`, yieldTimeMs: 1500 });
  assert.equal(result.running, true); assert.equal(result.phase, "root_exited_stdio_open");
  const closed = await manager.write({ workspaceId: "a", sessionId: result.sessionId!, yieldTimeMs: 5000 });
  assert.equal(closed.phase, "closed"); assert.equal(closed.exitCode, 0);
});

test("root exit with a live descendant stays running past the drain timeout", { timeout: 20_000, skip: process.platform === "win32" ? "cmd shell root waits for child; POSIX exec fixture required" : false }, async (t) => {
  const manager = new ProcessSessionManager({ stdioDrainTimeoutMs: 500 }); t.after(() => manager.shutdown());
  const result = await manager.start({ ...base, command: `exec ${node} -e "const child=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},8000)'],{stdio:['ignore',1,2]});child.unref();process.exit(0)"`, yieldTimeMs: 1500 });
  assert.equal(result.phase, "root_exited_stdio_open");
  await new Promise((resolve) => setTimeout(resolve, 800));
  const drained = await manager.write({ workspaceId: "a", sessionId: result.sessionId!, yieldTimeMs: 500 });
  assert.equal(drained.running, true);
  assert.equal(drained.phase, "root_exited_stdio_open");
  assert.equal(drained.disposition, "waiting_for_descendants");
  const closed = await manager.write({ workspaceId: "a", sessionId: result.sessionId!, yieldTimeMs: 9000 });
  assert.equal(closed.running, false);
  assert.equal(closed.phase, "closed");
  assert.equal(closed.exitCode, 0);
  assert.equal(closed.outputComplete, true);
});

test("windows inherited stdio keeps the session open until the drain timeout", { timeout: 20_000 }, async (t) => {
  const pidDir = mkdtempSync(join(tmpdir(), "quaymesh-stdio-"));
  const pidFiles = [join(pidDir, "hang.txt"), join(pidDir, "release.txt")];
  const killRecorded = () => {
    for (const file of pidFiles) {
      if (!existsSync(file)) continue;
      const pid = Number(readFileSync(file, "utf8"));
      if (!Number.isInteger(pid) || pid <= 0) continue;
      try { process.kill(pid); } catch {}
    }
  };
  t.after(() => {
    killRecorded();
    rmSync(pidDir, { recursive: true, force: true });
  });
  const commandFor = (pidFile: string) => {
    const quoted = pidFile.replaceAll("\\", "\\\\");
    return `${node} -e "const fs=require('fs'); const child=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},20000)'],{stdio:['ignore',1,2],detached:true,windowsHide:true}); fs.writeFileSync('${quoted}', String(child.pid)); child.unref(); setTimeout(()=>process.exit(0), 300)"`;
  };
  const hanging = new ProcessSessionManager({ stdioDrainTimeoutMs: 15_000 });
  t.after(() => hanging.shutdown());
  const open = await hanging.start({ ...base, command: commandFor(pidFiles[0]), yieldTimeMs: 1500 });
  assert.equal(open.running, true);
  assert.equal(open.phase, "root_exited_stdio_open");

  const releasing = new ProcessSessionManager({ stdioDrainTimeoutMs: 400 });
  t.after(() => releasing.shutdown());
  const started = await releasing.start({ ...base, command: commandFor(pidFiles[1]), yieldTimeMs: 900 });
  assert.equal(started.running, true);
  assert.equal(started.phase, "root_exited_stdio_open");
  const drainDeadline = Date.now() + 3_000;
  let drained = started;
  while (drained.disposition !== "waiting_for_descendants" && Date.now() < drainDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    drained = await releasing.write({ workspaceId: "a", sessionId: started.sessionId!, yieldTimeMs: 50 });
  }
  assert.equal(drained.running, true);
  assert.equal(drained.phase, "root_exited_stdio_open");
  assert.equal(drained.disposition, "waiting_for_descendants");
  assert.notEqual(drained.outputComplete, false);
  killRecorded();
  const closed = await releasing.write({ workspaceId: "a", sessionId: started.sessionId!, yieldTimeMs: 3000 });
  assert.equal(closed.running, false);
  assert.equal(closed.phase, "closed");
  assert.equal(closed.exitCode, 0);
  assert.equal(closed.outputComplete, true);
});
