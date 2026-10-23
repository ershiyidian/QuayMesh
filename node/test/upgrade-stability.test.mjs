import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { writeFile, rm, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { waitRunning } from "../install.mjs";
import { QuayMeshNode } from "../app.mjs";
import { ComponentSupervisor } from "../supervisor.mjs";
import { directory, until, freePort } from "./helpers.mjs";

test("升级验证要求同一进程连续就绪，首次ready和重启都会重置窗口", async t => {
  let polls = 0, resumed = 0;
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/maintenance/resume") { resumed++; res.end("{}"); return; }
    polls++;
    res.end(JSON.stringify({ nodeId: "fixture", release: "commit", components: [{ id: "core", state: polls === 2 ? "starting" : "ready",
      pid: polls < 3 ? 101 : 102, startedAt: polls < 3 ? 1 : 2, restarts: polls < 3 ? 0 : 1 }] }));
  });
  const port = await freePort(); await new Promise(resolve => server.listen(port, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const started = Date.now();
  const state = await waitRunning({ nodeId: "fixture", sourceCommit: "commit", adminPort: port }, "fixture-secret", 4000, { stableMs: 100 });
  assert.equal(state.components[0].pid, 102); assert.ok(polls >= 4); assert.ok(Date.now() - started >= 1400); assert.equal(resumed, 1);
});

test("manager 已更新而 Core 仍加载旧原生模块时拒绝激活", async t => {
  const root = await directory(t); await mkdir(join(root, "core"));
  const nodeHash = "a".repeat(64), lockHash = "b".repeat(64), nativeHash = "c".repeat(64);
  await writeFile(join(root, "release.json"), JSON.stringify({ node: process.versions.node, nodeAbi: process.versions.modules,
    runtime: { nodeSha256: nodeHash, packageLockSha256: lockHash }, nativeDependencies: { "better-sqlite3": { version: "13.0.3", sha256: nativeHash } } }));
  const active = { commit: "commit", pid: 101, runtime: { nodeVersion: process.versions.node, nodeAbi: process.versions.modules,
    nodeSha256: nodeHash, packageLockSha256: lockHash, sqlitePackageVersion: "13.0.3", sqliteNativeSha256: "d".repeat(64) } };
  await writeFile(join(root, "core", "active-release.json"), JSON.stringify(active));
  const server = http.createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ nodeId: "fixture", release: "commit", components: [{ id: "core", state: "ready", pid: 101 }] }));
  });
  const port = await freePort(); await new Promise(resolve => server.listen(port, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const manifest = { nodeId: "fixture", sourceCommit: "commit", adminPort: port, directory: root, stateDir: root };
  await assert.rejects(waitRunning(manifest, "fixture-secret", 100, { stableMs: 0, resume: false }), /实际指纹/);
  active.runtime.sqliteNativeSha256 = nativeHash;
  await writeFile(join(root, "core", "active-release.json"), JSON.stringify(active));
  const verified = await waitRunning(manifest, "fixture-secret", 1000, { stableMs: 0, resume: false });
  assert.equal(verified.activeCoreRelease.runtime.sqliteNativeSha256, nativeHash);
});

test("真实子进程退出保留信号与探针错误，反复退出后即使探测成功仍标记不稳定", async t => {
  const root = await directory(t); const script = join(root, "alive.mjs");
  await writeFile(script, "setInterval(()=>{},1000);process.on('SIGTERM',()=>process.exit(0));\n");
  const manager = new ComponentSupervisor({ logDir: join(root, "logs"), intervalMs: 25, shutdownMs: 1000 });
  t.after(() => manager.close()); let probeFailure = false;
  manager.define([{ id: "core", command: process.execPath, args: [script], env: process.env,
    ready: async () => { if (probeFailure) throw new Error("probe_fixture"); } }]);
  await manager.start(); await manager.waitReady(["core"]);
  probeFailure = true;
  await until(() => manager.snapshot()[0], value => value.state === "degraded");
  let recovering;
  for(let index=0;index<3;index++){
    const pid=manager.snapshot()[0].pid;process.kill(pid,"SIGTERM");
    const exited=await until(()=>manager.snapshot()[0],value=>value.state==="backoff");
    assert.ok(exited.lastExitAt);assert.match(exited.error,/已退出，code=/);
    assert.ok(exited.lastExitSignal!==null||Number.isInteger(exited.lastExitCode));
    if(index===0)assert.match(exited.probeError,/probe_fixture/);
    probeFailure=false;
    recovering=await until(()=>manager.snapshot()[0],value=>value.pid&&value.pid!==pid&&value.stableSince);
  }
  assert.equal(recovering.state, "degraded"); assert.equal(recovering.crashLoop, true); assert.equal(recovering.probeError, null);
});

test("持久安装标记阻止自动或无归属恢复准入", async t => {
  const root = await directory(t); const marker = join(root, "installation-transition.json");
  await writeFile(marker, JSON.stringify({ sourceCommit: "new", phase: "validating" }));
  const node = new QuayMeshNode({ revision: 1, node: { stateDir: root, corePort: 1 } });
  let observed = 0;
  node.admissionState = async () => { observed++; return { accepting: false, reason: "node-maintenance" }; };
  await node.reconcileMaintenance(); assert.equal(observed, 0);
  await assert.rejects(node.endMaintenance(), /发行切换/);
  await rm(marker);
  node.admission = async () => ({});
  await node.endMaintenance(); assert.equal(node.maintenance, false);
});

test("升级快照使用真实 SQLite 一致备份，后续迁移保留原结构", async t => {
  const root = await directory(t); await mkdir(join(root, "core"));
  const path = join(root, "core", "quaymesh.sqlite"), backup = join(root, "rollback.sqlite");
  const db = new Database(path); t.after(() => db.close());
  db.pragma("journal_mode = WAL"); db.exec("CREATE TABLE qm_schema_migrations(version INTEGER);INSERT INTO qm_schema_migrations VALUES(6);CREATE TABLE work(value TEXT);INSERT INTO work VALUES('retained');");
  const { stdout } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL("../database-snapshot.mjs", import.meta.url)), root, backup]);
  assert.equal(JSON.parse(stdout).version, 6);
  db.exec("INSERT INTO qm_schema_migrations VALUES(8);ALTER TABLE work ADD COLUMN owner TEXT;");
  const saved = new Database(backup, { readonly: true });
  try { assert.equal(saved.prepare("SELECT max(version) AS version FROM qm_schema_migrations").get().version, 6); assert.equal(saved.prepare("SELECT value FROM work").get().value, "retained"); }
  finally { saved.close(); }
});
