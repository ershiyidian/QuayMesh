import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { ComponentSupervisor } from "../supervisor.mjs";

const fixture = String.raw`
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
const [directory, mode] = process.argv.slice(2);
if (mode === 'grandchild') {
  writeFileSync(join(directory,'grandchild.pid'), String(process.pid));
  const deadline = Date.now() + 12000;
  setInterval(() => {
    if (existsSync(join(directory,'grandchild.stop')) || Date.now() >= deadline) process.exit(0);
    writeFileSync(join(directory,'grandchild.heartbeat'), String(Date.now()));
    writeSync(1,'grandchild alive\n');
    writeSync(2,'grandchild stderr\n');
  }, 20);
} else if (!existsSync(join(directory,'first.pid'))) {
  writeFileSync(join(directory,'first.pid'), String(process.pid));
  const child = spawn(process.execPath, [process.argv[1],directory,'grandchild'], {
    stdio: ['ignore',process.stdout,process.stderr], windowsHide: true,
  });
  child.unref();
  if (mode === 'crash') {
    const timer = setInterval(() => {
      if (!existsSync(join(directory,'grandchild.pid')) || !existsSync(join(directory,'parent.exit'))) return;
      clearInterval(timer); writeSync(1,'first parent exited\n'); process.exit(17);
    }, 5);
  } else {
    setInterval(() => writeSync(1,'first parent alive\n'), 20);
  }
} else {
  writeFileSync(join(directory,'second.pid'), String(process.pid));
  setInterval(() => writeSync(1,'replacement alive\n'), 20);
}
`;

async function until(read, label, budget = 2500) {
  const deadline = Date.now() + budget;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function optionalFile(path) {
  try { return await readFile(path, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}

async function setup(t, mode, ready, release = () => {}) {
  const directory = await mkdtemp(join(tmpdir(), "quaymesh-supervisor-exit-"));
  const file = join(directory, "fixture.mjs");
  await writeFile(file, fixture);
  const supervisor = new ComponentSupervisor({logDir:join(directory,"logs"), intervalMs:10, shutdownMs:150});
  const faults = [];
  supervisor.on("fault", error => faults.push(error));
  supervisor.define([{id:"core", command:process.execPath, args:[file,directory,mode],
    env:{...process.env}, ready:ready ?? (() => {})}]);
  const generations = new Set();
  supervisor.on("change", () => {
    const value = supervisor.components.get("core");
    if (value?.closed) generations.add(value.closed);
  });
  t.after(async () => {
    release();
    // Ask only this fixture's descendant to exit. Never kill a PID or tree.
    await writeFile(join(directory,"grandchild.stop"), "stop");
    await supervisor.close();
    let timeout;
    try {
      await Promise.race([Promise.all([...generations]), new Promise((_,reject) => {
        timeout = setTimeout(() => reject(new Error("fixture stdio did not close")),2500);
      })]);
    } finally { clearTimeout(timeout); }
    await supervisor.components.get("core").logClosed;
    await rm(directory, {recursive:true,force:true});
  });
  await supervisor.start();
  generations.add(supervisor.components.get("core").closed);
  return {directory,supervisor,faults};
}

test("OS exit restarts the component while inherited stdio stays open; late close cannot clear its replacement", {timeout:8000}, async t => {
  let releaseProbe, probeStarted = false, probeDone = false;
  const pendingProbe = new Promise(resolve => { releaseProbe = resolve; });
  const {directory,supervisor,faults} = await setup(t,"crash", async () => {
    if (probeStarted) return;
    probeStarted = true; await pendingProbe; probeDone = true;
    throw new Error("old generation readiness result");
  }, () => releaseProbe());
  const first = supervisor.components.get("core").child;
  let firstClosed = false;
  first.once("close", () => { firstClosed = true; });
  const grandchildPid = Number(await until(() => optionalFile(join(directory,"grandchild.pid")), "grandchild start"));
  await until(() => probeStarted, "old readiness probe start");
  await writeFile(join(directory,"parent.exit"), "exit");
  await until(() => first.exitCode !== null, "parent exit");
  assert.equal(first.exitCode, 17);
  assert.equal(firstClosed, false, "the fixture must retain both inherited pipes");
  assert.equal(alive(grandchildPid), true);
  const observedAt = supervisor.snapshot()[0].observedAt;
  releaseProbe();
  await until(() => probeDone && !supervisor.checks.has("core"), "old readiness probe completion");
  assert.equal(supervisor.snapshot()[0].observedAt, observedAt, "a stale probe must not publish a new health observation");

  const replacement = await until(() => {
    const value = supervisor.components.get("core");
    return value.child && value.child !== first && value.state === "ready" ? value.child : null;
  }, "replacement before descendant exit");
  const before = supervisor.snapshot()[0];
  assert.equal(before.restarts, 1);
  assert.equal(before.lastExitCode, 17);
  assert.equal(firstClosed, false);
  assert.equal(alive(grandchildPid), true, "recovery must not kill inherited-pipe descendants");

  await writeFile(join(directory,"grandchild.stop"), "stop");
  await until(() => firstClosed, "old generation close");
  const after = supervisor.snapshot()[0];
  assert.equal(supervisor.components.get("core").child, replacement);
  assert.equal(after.pid, replacement.pid);
  assert.equal(after.startedAt, before.startedAt);
  assert.equal(after.lastExitAt, before.lastExitAt);
  assert.equal(after.restarts, 1);
  assert.equal(after.state, "ready");
  const log = join(directory,"logs","core.log");
  const previous = (await optionalFile(log))?.length ?? 0;
  await until(async () => ((await optionalFile(log))?.length ?? 0) > previous, "replacement logging after old close");
  assert.deepEqual(faults, []);
});

test("health failure preserves a live component; confirmed stop does not wait for or kill its inherited-pipe descendants", {timeout:8000}, async t => {
  let healthy = true;
  const {directory,supervisor,faults} = await setup(t,"stay", () => { if (!healthy) throw new Error("connection refused"); });
  const first = supervisor.components.get("core").child;
  const grandchildPid = Number(await until(() => optionalFile(join(directory,"grandchild.pid")), "grandchild start"));
  await until(() => supervisor.snapshot()[0].state === "ready", "initial readiness");
  healthy = false;
  await until(() => supervisor.snapshot()[0].state === "degraded", "failed readiness probe");
  assert.equal(supervisor.snapshot()[0].pid, first.pid);
  assert.equal(supervisor.snapshot()[0].restarts, 0);
  assert.equal(alive(first.pid), true);
  let closed = false;
  first.once("close", () => { closed = true; });
  await supervisor.close();
  assert.equal(closed, false, "process stop must finish before descendant stdio closes");
  assert.equal(supervisor.snapshot()[0].processState, "stopped");
  const beat = await optionalFile(join(directory,"grandchild.heartbeat"));
  await delay(220); // Cross the private supervisor's 150 ms force-stop deadline.
  assert.equal(alive(grandchildPid), true, "no force-stop may run after the parent's OS exit");
  assert.notEqual(await optionalFile(join(directory,"grandchild.heartbeat")), beat);
  assert.deepEqual(faults, []);
});

test("a failed spawn still records an exited attempt without waiting for an exit event", {timeout:5000}, async t => {
  const directory = await mkdtemp(join(tmpdir(), "quaymesh-supervisor-spawn-"));
  const supervisor = new ComponentSupervisor({logDir:directory,intervalMs:10,shutdownMs:100});
  supervisor.on("fault", () => {});
  supervisor.define([{id:"core",command:join(directory,"missing-executable"),env:{...process.env}}]);
  t.after(async () => { await supervisor.close(); await rm(directory,{recursive:true,force:true}); });
  await supervisor.start();
  const state = await until(() => {
    const value = supervisor.snapshot()[0];
    return value.restarts === 1 && value.state === "backoff" ? value : null;
  }, "spawn failure backoff");
  assert.equal(state.pid, null);
  assert.equal(state.processState, "stopped");
  assert.match(state.error, /ENOENT/);
});

test("ordinary shutdown drains the final output before returning", {timeout:5000}, async t => {
  const directory = await mkdtemp(join(tmpdir(), "quaymesh-supervisor-tail-"));
  const file = join(directory,"fixture.mjs"), exitFile = join(directory,"exit");
  await writeFile(file, `import {existsSync,writeFileSync,writeSync} from 'node:fs';
    const [exitFile,readyFile] = process.argv.slice(2);
    writeFileSync(readyFile,'ready');
    setInterval(() => { if (existsSync(exitFile)) {
      writeSync(1,'x'.repeat(65536)+'\\nlast-output-marker\\n'); process.exit(0);
    } },5);`);
  const supervisor = new ComponentSupervisor({logDir:join(directory,"logs"),intervalMs:10,shutdownMs:2000});
  supervisor.on("fault", error => assert.fail(error.message));
  supervisor.define([{id:"core",command:process.execPath,args:[file,exitFile,join(directory,"ready")],env:{...process.env},
    stop:() => writeFile(exitFile,"exit"), ready:() => {}}]);
  t.after(async () => {
    await supervisor.close(); await supervisor.components.get("core").closed;
    await supervisor.components.get("core").logClosed;
    await rm(directory,{recursive:true,force:true});
  });
  await supervisor.start();
  await until(() => optionalFile(join(directory,"ready")), "tail fixture start");
  await supervisor.close();
  assert.ok((await readFile(join(directory,"logs","core.log"),"utf8")).endsWith("\nlast-output-marker\n"));
});
