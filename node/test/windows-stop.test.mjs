import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stopService, enforceInstallationRollbackBoundary } from "../install.mjs";
import { directory } from "./helpers.mjs";

test("Windows upgrades run the candidate stop helper once with the previous Host identity", async () => {
  const calls = [];
  const previous = { platform: "win32", desktopUi: true, directory: resolve("previous-584-release") };
  await stopService(previous, { runCommand: async (...args) => { calls.push(args); } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "powershell.exe");
  const args = calls[0][1];
  assert.equal(args[args.indexOf("-File") + 1], fileURLToPath(new URL("../windows-stop.ps1", import.meta.url)));
  assert.equal(args[args.indexOf("-HostExecutable") + 1], join(previous.directory, "components", "windows-x64", "QuayMesh.Host.exe"));
  assert.equal(args.includes("--exit"), false);
});

test("preserve records recovery after an unconfirmed stop without inventing a current database observation", async t => {
  const stateDir = await directory(t);
  const transition = { id: "attempt", maintenanceLease: { version: 2, historyPolicy: "preserve", receiptFile: "retained-receipt" } };
  const snapshot = { exists: true, version: 19, backup: null };
  await assert.rejects(enforceInstallationRollbackBoundary({
    manifest: { stateDir, sourceCommit: "candidate" }, previous: { sourceCommit: "previous" },
    transition, snapshot, error: new Error("Host ACK arrived; original Task is still running"), historyPolicy: "preserve",
  }), /保留历史执行/);
  const saved = JSON.parse(await readFile(join(stateDir, "installation-transition.json"), "utf8"));
  assert.equal(saved.phase, "recovery_required");
  assert.deepEqual(saved.maintenanceLease, transition.maintenanceLease);
  assert.deepEqual(saved.database, snapshot);
  assert.equal(Object.hasOwn(saved, "currentDatabaseVersion"), false);
});

const cases = [
  ["success", null],
  ["task-stuck", /Timed out/],
  ["host-stuck", /Timed out/],
  ["replacement", /instance changed/],
  ["definition-change", /definition changed/],
  ["engine-mismatch", /not the expected Host generation/],
];
for (const [mode, expectedError] of cases) test(
  "Windows graceful stop: " + mode,
  { skip: process.platform !== "win32", timeout: 15000 },
  async t => {
    const root = await directory(t), marker = join(root, "exit-requested");
    const engineCode = [
      "const {existsSync}=require('node:fs');",
      "process.send('ready');",
      "if (" + JSON.stringify(mode) + " !== 'host-stuck') {",
      " const timer=setInterval(()=>{",
      "  if(existsSync(" + JSON.stringify(marker) + ")){",
      "   clearInterval(timer);setTimeout(()=>process.exit(0),250);",
      "  }",
      " },20);",
      "}",
      "setTimeout(()=>process.exit(91),10000);",
    ].join("\n");
    const engine = spawn(process.execPath, ["-e", engineCode], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    t.after(async () => {
      if (engine.exitCode === null && engine.signalCode === null) {
        const exited = once(engine, "exit");
        engine.kill();
        await exited;
      }
    });
    await once(engine, "message", { signal: AbortSignal.timeout(5000) });
    const result = await new Promise(resolveRun => {
      execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
        resolve("node/test/fixtures/windows-stop-fixture.ps1"), "-StopScript", resolve("node/windows-stop.ps1"),
        "-EngineExecutable", process.execPath, "-EnginePid", String(engine.pid), "-Marker", marker, "-Mode", mode],
      { encoding: "utf8", timeout: 10000 }, (error, stdout, stderr) => resolveRun({ code: error?.code ?? 0, stdout, stderr }));
    });
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const observed = JSON.parse(result.stdout.trim());
    assert.equal(observed.forceStops, 0);
    assert.equal(observed.unregisters, 0);
    assert.equal(observed.exitRequests, mode === "engine-mismatch" ? 0 : 1);
    if (expectedError) {
      assert.match(observed.error, expectedError);
      if (mode === "host-stuck" || mode === "engine-mismatch") assert.equal(observed.engineAlive, true);
    } else {
      assert.equal(observed.error, null);
      assert.equal(observed.engineAlive, false);
      assert.ok(Date.now() - (await stat(marker)).mtimeMs >= 800);
      const receipt = JSON.parse(observed.output[0]);
      assert.equal(receipt.stopped, true);
      assert.equal(receipt.hostPid, engine.pid);
      assert.equal(receipt.taskInstance, "{original}");
      assert.match(receipt.hostStart, /^win32:\d+$/);
      assert.equal(receipt.forced, false);
    }
  }
);

test("explicit Windows stop and unregister retain their existing Task semantics",
  { skip: process.platform !== "win32", timeout: 10000 }, async t => {
    const root = await directory(t);
    const result = await new Promise(resolveRun => {
      execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
        resolve("node/test/fixtures/windows-stop-fixture.ps1"), "-StopScript", resolve("node/windows-stop.ps1"),
        "-EngineExecutable", process.execPath, "-EnginePid", "0", "-Marker", join(root, "unused"), "-Mode", "explicit"],
      { encoding: "utf8", timeout: 8000 }, (error, stdout, stderr) => resolveRun({ code: error?.code ?? 0, stdout, stderr }));
    });
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const observed = JSON.parse(result.stdout.trim());
    assert.equal(observed.error, null);
    assert.equal(observed.exitRequests, 0);
    assert.equal(observed.forceStops, 1);
    assert.equal(observed.unregisters, 1);
  });
