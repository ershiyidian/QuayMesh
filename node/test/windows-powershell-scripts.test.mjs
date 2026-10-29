import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { directory } from "./helpers.mjs";

const scripts = [
  "apps/native/windows/build.ps1",
  "build.ps1",
  "node/windows-install.ps1",
  "node/windows-stop.ps1",
  "node/windows-activate.ps1",
  "scripts/build-windows.ps1",
  "scripts/test-windows-console.ps1",
  "scripts/verify-windows.ps1",
  "scripts/windows-easytier-cutover.ps1",
];

test("Windows PowerShell 5.1 can identify UTF-8 source containing Chinese text", () => {
  for (const script of scripts) {
    const content = readFileSync(resolve(script));
    if (content.some(byte => byte > 127)) {
      assert.deepEqual([...content.subarray(0, 3)], [0xef, 0xbb, 0xbf], script);
    }
  }
});

test("All deployed PowerShell scripts parse in the native Windows engine",
  { skip: process.platform !== "win32" }, () => {
    for (const script of scripts) {
      const filename = resolve(script).replaceAll("'", "''");
      const expression = [
        "$tokens=$null;$errors=$null;",
        `[System.Management.Automation.Language.Parser]::ParseFile('${filename}',[ref]$tokens,[ref]$errors)|Out-Null;`,
        "if($errors.Count){$errors|Out-String|Write-Error;exit 1}",
      ].join("");
      const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", expression], {
        encoding: "utf8",
        timeout: 10000,
      });
      assert.equal(result.status, 0, `${script}: ${result.stderr || result.stdout}`);
    }
  });

for (const installerExit of [0, 7]) test(
  `Windows activation delegates to the installer and records ${installerExit ? "its refusal" : "its successful commit"}`,
  { skip: process.platform !== "win32", timeout: 30000 }, async t => {
    const root = await directory(t), releaseRoot = join(root, "release"), stateDir = join(root, "state");
    const resultDirectory = join(stateDir, "activations", "fixture"), trace = join(root, "calls.txt");
    await Promise.all(["runtime", "node", "bin"].map(name => mkdir(join(releaseRoot, name), { recursive: true })));
    await mkdir(resultDirectory, { recursive: true });
    const manifestPath = join(root, "prepared.json"), stagedConfig = join(root, "node.json");
    const manifest = { version: 1, platform: "win32", nodeId: `activation-fixture-${randomUUID()}`,
      sourceCommit: "b".repeat(40), directory: releaseRoot, stateDir, stagedConfig,
      nodeExecutable: join(releaseRoot, "runtime", "node.exe"), entrypoint: join(releaseRoot, "bin", "quaymesh.js") };
    const requests = [];
    const server = createServer((request, response) => {
      requests.push(request.url);
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        nodeId: manifest.nodeId, release: manifest.sourceCommit, components: [{ id: "core", pid: process.pid }],
      }));
    });
    await new Promise((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolveListen(); });
    });
    t.after(() => new Promise(resolveClose => { server.closeAllConnections(); server.close(resolveClose); }));
    manifest.adminPort = server.address().port;
    await cp(process.execPath, manifest.nodeExecutable);
    await writeFile(manifestPath, JSON.stringify(manifest));
    await writeFile(stagedConfig, JSON.stringify({ id: manifest.nodeId, stateDir }));
    await writeFile(join(releaseRoot, "release.json"), JSON.stringify({ sourceCommit: manifest.sourceCommit,
      platform: "windows-x64", uncommittedSource: false }));
    await writeFile(join(resultDirectory, "result.json"), JSON.stringify({ status: "queued", nodeId: manifest.nodeId,
      sourceCommit: manifest.sourceCommit, preparedManifest: manifestPath }));
    // Exercise the actual PowerShell runner and real child processes. Only its
    // verifier/installer boundaries are fixtures; no service is registered or stopped.
    await writeFile(join(releaseRoot, "node", "verify-installed.mjs"),
      `import {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(trace)},'verify\\n');`);
    await writeFile(join(releaseRoot, "node", "cutover-preflight.mjs"),
      `import {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(trace)},'obsolete-preflight\\n');process.exitCode=2;`);
    await writeFile(manifest.entrypoint, `const {appendFileSync}=require('node:fs');
      if(JSON.stringify(process.argv.slice(2))!==${JSON.stringify(JSON.stringify(["activate", "--prepared", manifestPath]))})process.exit(92);
      appendFileSync(${JSON.stringify(trace)},'activate\\n');process.exitCode=${installerExit};`);
    const result = await new Promise(resolveRun => {
      execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
        resolve("node/windows-activate.ps1"), "-PreparedManifest", manifestPath, "-RunActivation", "-ResultDirectory", resultDirectory],
      { encoding: "utf8", timeout: 25000 }, (error, stdout, stderr) => resolveRun({ code: error?.code ?? 0, stdout, stderr }));
    });
    assert.equal(result.code, installerExit ? 1 : 0, result.stderr || result.stdout);
    const outcome = JSON.parse((await readFile(join(resultDirectory, "result.json"), "utf8")).replace(/^\uFEFF/u, ""));
    assert.equal(outcome.status, installerExit ? "failed" : "completed");
    assert.equal(outcome.sourceCommit, manifest.sourceCommit);assert.equal(outcome.nodeId, manifest.nodeId);
    assert.deepEqual((await readFile(trace, "utf8")).trim().split(/\r?\n/u), ["verify", "activate"]);
    assert.deepEqual(requests, installerExit ? [] : ["/status"], "only a committed activation receives the final status check");
    assert.ok((await readFile(join(resultDirectory, "activation.log"))).length > 0);
    if (installerExit) assert.match(outcome.error, /发行激活未完成/u);
  });

test("Windows activation accepts the installer win32 manifest and validates the windows-x64 release separately",
  { skip: process.platform !== "win32" }, async t => {
    const root = await directory(t), releaseRoot = join(root, "release"), stateDir = join(root, "state");
    await mkdir(releaseRoot); await mkdir(stateDir);
    const manifestPath = join(root, "prepared.json"), stagedConfig = join(root, "node.json");
    const manifest = { version: 1, platform: "win32", nodeId: "activation-fixture", sourceCommit: "a".repeat(40),
      directory: releaseRoot, stateDir, stagedConfig,
      nodeExecutable: join(releaseRoot, "runtime", "node.exe"), entrypoint: join(releaseRoot, "bin", "quaymesh.js") };
    const release = { sourceCommit: manifest.sourceCommit, platform: "windows-x64", uncommittedSource: false };
    await writeFile(stagedConfig, JSON.stringify({ id: manifest.nodeId, stateDir }));
    const quote = value => `'${value.replaceAll("'", "''")}'`;
    const script = quote(resolve("node/windows-activate.ps1"));
    const expectBoundary = async message => {
      await writeFile(manifestPath, JSON.stringify(manifest));
      await writeFile(join(releaseRoot, "release.json"), JSON.stringify(release));
      // Run the actual production validation. Omitting the registered result
      // directory stops before scheduling, verifying, or activating anything.
      const expression = `try { & ${script} -PreparedManifest ${quote(manifestPath)} -RunActivation; exit 91 } catch { if ($_.Exception.Message -eq ${quote(message)}) { exit 0 }; throw }`;
      const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", expression], {
        encoding: "utf8", timeout: 10000,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
    };
    await expectBoundary("独立激活任务缺少预先登记的结果文件。");
    manifest.platform = "windows-x64";
    await expectBoundary("需要有效的 Windows 已准备发行记录。");
    manifest.platform = "win32"; release.platform = "linux-x64";
    await expectBoundary("安装记录与已提交发行包的身份不一致。");
    release.platform = "windows-x64"; release.sourceCommit = "b".repeat(40);
    await expectBoundary("安装记录与已提交发行包的身份不一致。");
  });
