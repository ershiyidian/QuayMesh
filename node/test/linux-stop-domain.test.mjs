import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createLinuxKernelReader, createLinuxInstallationGuard, inspectLinuxUnit, linuxHierarchyCandidates,
  readLinuxBounded, parseLinuxStat } from "../linux-stop-domain.mjs";
import { beginInstallationMaintenance } from "../maintenance-lease.mjs";
import { activateInstallation, systemdUnit } from "../install.mjs";
import { QuayMeshNode } from "../app.mjs";
import { requestJson } from "../network.mjs";
import { directory, cluster, token as makeToken } from "./helpers.mjs";

const linux = { skip: process.platform !== "linux" };
const releaseRoot = fileURLToPath(new URL("../../", import.meta.url));
const boot = "819e1a63-4780-4ea0-adf6-10e49110f9f6";
const zero = { claims: 0, waiting: 0, operations: 0, executions: 0, queuedOperations: 0, queuedExecutions: 0,
  activeWork: 0, allRuntimeWork: 0, persistedRuntimeWork: 0 };
const code = reason => error => error.code === "LINUX_STOP_DOMAIN_" + reason;

async function server(t, handler) {
  const server = http.createServer((req, res) => {
    void (async () => {
      let text = ""; for await (const chunk of req) text += chunk;
      const result = await handler(req, text ? JSON.parse(text) : {});
      res.writeHead(result.status ?? 200, { "content-type": "application/json" }).end(JSON.stringify(result.body));
    })().catch(error => res.writeHead(500).end(JSON.stringify({ error: error.message })));
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return server.address().port;
}

function statText(pid, { parentPid = 1, pgid = pid, sid = pgid, ticks = String(pid), state = "S" } = {}) {
  const fields = Array(30).fill("0"); Object.assign(fields, { 0: state, 1: String(parentPid), 2: String(pgid), 3: String(sid), 19: ticks });
  return `${pid} (test process) ${fields.join(" ")}\n`;
}

async function kernelFixture(t, { uid = process.getuid() } = {}) {
  const root = await directory(t), procRoot = join(root, "proc"), cgroupRoot = join(root, "cgroup"), cg = join(cgroupRoot, "unit");
  await mkdir(join(procRoot, "self"), { recursive: true }); await mkdir(join(procRoot, "sys/kernel/random"), { recursive: true });
  await mkdir(cg, { recursive: true });
  await writeFile(join(procRoot, "sys/kernel/random/boot_id"), boot);
  await writeFile(join(procRoot, "self/mountinfo"), `31 20 0:27 / ${cgroupRoot} rw - cgroup2 cgroup rw\n`);
  const add = async (pid, options = {}) => {
    const path = join(procRoot, String(pid)); await mkdir(path, { recursive: true });
    await writeFile(join(path, "stat"), statText(pid, options));
    await writeFile(join(path, "cgroup"), `0::${options.group ?? "/unit"}\n`);
    await writeFile(join(path, "status"), `Name:\tfixture\nUid:\t${(options.uids ?? [uid, uid, uid, uid]).join("\t")}\n`);
    await writeFile(join(path, "cmdline"), (options.args ?? [process.execPath, "unapproved-sensitive-sentinel"]).join("\0") + "\0");
    await symlink(process.execPath, join(path, "exe")).catch(error => { if (error.code !== "EEXIST") throw error; });
  };
  const members = async pids => writeFile(join(cg, "cgroup.procs"), pids.join("\n") + "\n");
  await add(10001); await add(10002, { parentPid: 10001 }); await members([10001, 10002]);
  const kernel = createLinuxKernelReader({ procRoot, cgroupRoot });
  const hierarchy = await kernel.selectHierarchy(10001, "/unit");
  const manager = await kernel.identity(10001, hierarchy, boot), core = await kernel.identity(10002, hierarchy, boot);
  const approved = [{ ...manager, classification: "manager" }, { ...core, classification: "core" }];
  const observe = () => kernel.observe({ hierarchy, boot, approved, core, directory: releaseRoot, uid });
  return { root, procRoot, cgroupRoot, cg, uid, add, members, kernel, hierarchy, manager, core, approved, observe };
}

test("named systemd v1 and unified v2 map exact unit paths; invalid roots and oversized kernel reads reject", linux, async t => {
  const mounts = "31 20 0:27 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n32 20 0:28 / /sys/fs/cgroup/systemd rw - cgroup cgroup rw,name=systemd";
  const candidates = linuxHierarchyCandidates(mounts, "0::/user.slice/node.service\n1:name=systemd:/user.slice/node.service", "/user.slice/node.service");
  assert.deepEqual(candidates.map(row => row.kind), ["v1-systemd", "v2"]);
  assert.equal(candidates[0].directory, "/sys/fs/cgroup/systemd/user.slice/node.service");
  assert.throws(() => linuxHierarchyCandidates(mounts, "0::/", "/"), code("CGROUP_PATH_INVALID"));
  assert.throws(() => linuxHierarchyCandidates(mounts, "0::/unit", "/unit/../other"), code("CGROUP_PATH_INVALID"));
  const root = await directory(t), file = join(root, "bounded"); await writeFile(file, "x".repeat(65));
  await assert.rejects(readLinuxBounded(file, 64), code("READ_BOUND_EXCEEDED"));
  assert.equal((await readLinuxBounded(file, 65)).length, 65);
});

test("real detached descendant survives its parent's exit and is rejected even with no logical work", linux, async t => {
  const kernel = createLinuxKernelReader(), actualBoot = await kernel.boot();
  const parent = spawn(process.execPath, ["-e", `const {spawn}=require('node:child_process');
    const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
    c.unref();process.stdout.write(JSON.stringify({pid:c.pid}));`], { stdio: ["ignore", "pipe", "pipe"], detached: true });
  let output = ""; parent.stdout.on("data", part => { output += part; });
  assert.equal(await new Promise((resolve, reject) => { parent.once("error", reject); parent.once("close", resolve); }), 0);
  const childPid = JSON.parse(output).pid;
  const childStart = parseLinuxStat(await readFile(`/proc/${childPid}/stat`, "utf8"), childPid, actualBoot).start;
  t.after(async () => {
    const current = await readFile(`/proc/${childPid}/stat`, "utf8").catch(() => null);
    if (current && parseLinuxStat(current, childPid, actualBoot).start === childStart) process.kill(childPid, "SIGTERM");
    for (let i = 0; i < 100; i++) {
      const value = await readFile(`/proc/${childPid}/stat`, "utf8").catch(() => null);
      if (!value || !parseLinuxStat(value, childPid, actualBoot).alive) return;
      await delay(10);
    }
    throw new Error("Own test descendant did not exit");
  });
  const groups = await readFile(`/proc/${process.pid}/cgroup`, "utf8"), unified = /^0::(.+)$/mu.exec(groups);
  const named = /^\d+:[^\n]*name=systemd[^:]*:(.+)$/mu.exec(groups);
  assert.ok(unified || named);
  const root = await directory(t), hierarchy = { kind: named ? "v1-systemd" : "v2", group: (named ?? unified)[1], directory: root };
  // Only the cgroup membership file is a fixture. Birth, UID, PPID, PGID,
  // SID, liveness and the exited-parent survivor are actual Linux processes.
  await writeFile(join(root, "cgroup.procs"), `${process.pid}\n${childPid}\n`);
  const self = await kernel.identity(process.pid, hierarchy, actualBoot);
  const child = await kernel.identity(childPid, hierarchy, actualBoot);
  assert.notEqual(child.parentPid, parent.pid); assert.equal(child.pgid, childPid); assert.equal(child.sid, childPid);
  const observed = await kernel.observe({ hierarchy, boot: actualBoot, approved: [{ ...self, classification: "core" }],
    core: self, directory: releaseRoot, uid: process.getuid() });
  assert.equal(observed.accepted, false);
  assert.equal(observed.rows.find(row => row.pid === childPid).classification, "unapproved");
  assert.equal((await kernel.identity(childPid, hierarchy, actualBoot)).start, childStart, "the guard did not signal or claim completion");
});

test("full cgroup traversal includes nested business processes and managed PGID peers with changed effective UID", linux, async t => {
  // The proc fixture directories are owned by the test runner, deliberately
  // not the service's real/saved UID. Directory ownership cannot filter peers.
  const f = await kernelFixture(t, { uid: process.getuid() === 1002 ? 1003 : 1002 });
  await f.add(10003, { parentPid: 1, pgid: 10002, sid: 10002, group: "/other", uids: [f.uid, f.uid + 1, f.uid, f.uid + 1] });
  let observed = await f.observe();
  assert.equal(observed.accepted, false); assert.deepEqual(observed.outside.map(row => row.pid), [10003]);
  await rm(join(f.procRoot, "10003"), { recursive: true });
  await mkdir(join(f.cg, "nested")); await writeFile(join(f.cg, "nested/cgroup.procs"), "10004\n");
  await f.add(10004, { parentPid: 1, group: "/unit/nested" });
  observed = await f.observe(); assert.equal(observed.accepted, false);
  assert.equal(observed.rows.find(row => row.pid === 10004).classification, "unapproved");
  await rm(join(f.cg, "nested/cgroup.procs"));
  await assert.rejects(f.observe(), error => error.code === "ENOENT");
});

async function guardedFixture(t, { ingress = false } = {}) {
  const f = await kernelFixture(t), token = makeToken(), requests = [];
  const idle = { ...zero, instance: { pid: f.core.pid, processStart: f.core.start, token: "core-instance" },
    accepting: false, reason: "node-maintenance", changedAt: "2026-11-02T00:00:00.001Z" };
  const status = { nodeId: "edge", release: "current", maintenance: true, relayActiveRequests: 0,
    components: [{ id: "core", pid: f.core.pid, state: "ready", startedAt: 100, restarts: 0 }] };
  const port = await server(t, req => {
    requests.push(req.url);
    if (req.url === "/status") return { body: status };
    if (req.url === "/healthz") return { body: { pid: f.manager.pid } };
    assert.equal(req.headers.authorization, `Bearer ${token}`); return { body: idle };
  });
  const manifest = { platform: "linux", nodeId: "edge", sourceCommit: "current", directory: releaseRoot, adminPort: port };
  const ingressProcesses = [];
  if (ingress) {
    const configuration = cluster(), stateDir = join(f.root, "tailscale");
    manifest.config = join(f.root, "node.json");
    await writeFile(join(f.root, "cluster.json"), JSON.stringify(configuration));
    await writeFile(join(f.root, "secrets.env"), `QUAYMESH_CLUSTER_TOKEN=${token}\n`);
    await writeFile(manifest.config, JSON.stringify({ schemaVersion: 1, id: "edge", stateDir: f.root,
      capabilities: { worker: true }, mesh: { enabled: false, address: "127.0.0.2" },
      network: { externalAccess: true }, secretsFile: "./secrets.env", nodeRuntime: process.execPath,
      components: { tailscale: { executable: process.execPath } },
      publicMcp: { url: "https://fixture.example.ts.net/mcp", listenPort: 29177, funnel: { stateDir } } }));
    ingressProcesses.push({ id: "public-mcp", pid: 10008, args: [process.execPath, join(releaseRoot, "node/public-mcp.mjs"),
      "--public-url", "https://fixture.example.ts.net/mcp", "--upstream", `http://127.0.0.1:${configuration.discovery.localPort}`,
      "--port", "29177"] },
    { id: "funnel", pid: 10009, args: [process.execPath, "--tun=userspace-networking",
      `--socket=${join(stateDir, "tailscaled.sock")}`, `--state=${join(stateDir, "tailscaled.state")}`,
      `--statedir=${stateDir}`, "--port=0", "--no-logs-no-support"] });
    for (const row of ingressProcesses) {
      await f.add(row.pid, { parentPid: f.manager.pid, args: row.args });
      status.components.push({ id: row.id, pid: row.pid, state: "ready", startedAt: 100, restarts: 0 });
    }
    await f.members([f.manager.pid, f.core.pid, ...ingressProcesses.map(row => row.pid)]);
  }
  const unit = { mainPid: f.manager.pid, group: "/unit", invocationId: "a".repeat(32), fragmentDigest: "f".repeat(64) };
  const options = { manifest, status, token, corePort: port, kernel: f.kernel, inspectUnit: async () => structuredClone(unit) };
  const guard = await createLinuxInstallationGuard(options);
  const expectedPause = { instance: idle.instance, accepting: idle.accepting, reason: idle.reason, changedAt: idle.changedAt };
  return { ...f, options, guard, expectedPause, idle, status, unit, requests, ingressProcesses };
}

test("managed public MCP and Funnel retain exact command identities without approving their descendants", linux, async t => {
  const f = await guardedFixture(t, { ingress: true });
  const first = await f.guard.assertHeld("before_backup", { expectedPause: f.expectedPause });
  assert.equal(first.count, 4); assert.equal(first.unapprovedCount, 0);
  // Installed module paths remain canonical when the recorded release is a symlink.
  const alias = join(f.root, "installed-release"); await symlink(releaseRoot, alias);
  f.options.manifest.directory = alias;
  const throughAlias = await createLinuxInstallationGuard(f.options);
  assert.equal((await throughAlias.assertHeld("before_backup", { expectedPause: f.expectedPause })).count, 4);
  // Even a known read-worker command is unapproved when born under Funnel.
  await f.add(10010, { parentPid: 10009, pgid: 10009, sid: 10009,
    args: [process.execPath, "--max-old-space-size=192", join(releaseRoot, "dist/session/projection-read-worker.js")] });
  await f.members([10001, 10002, 10008, 10009, 10010]);
  await assert.rejects(f.guard.assertHeld("before_stop", { expectedPause: f.expectedPause }), error => {
    assert.equal(error.code, "LINUX_STOP_DOMAIN_UNTRACKED_PROCESSES");
    assert.equal(error.details.unapprovedCount, 1); assert.equal(error.details.unapproved[0].pid, 10010); return true;
  });
});

test("managed ingress rejects another script, changed daemon arguments and a mismatched executable without printing argv", linux, async t => {
  const f = await guardedFixture(t, { ingress: true });
  for (const row of f.ingressProcesses) {
    const changed = [...row.args];
    if (row.id === "public-mcp") changed[1] = "/unreviewed/node/public-mcp.mjs";
    else changed[3] = "--state=/unreviewed/sensitive-state-sentinel";
    await writeFile(join(f.procRoot, String(row.pid), "cmdline"), changed.join("\0") + "\0");
    await assert.rejects(f.guard.assertHeld("before_stop", { expectedPause: f.expectedPause }), error => {
      assert.equal(error.code, "LINUX_STOP_DOMAIN_MANAGED_PROCESS_COMMAND_CHANGED");
      assert.equal(error.details.pid, row.pid);
      assert.equal(JSON.stringify(error).includes("sensitive-state-sentinel"), false); return true;
    });
    await writeFile(join(f.procRoot, String(row.pid), "cmdline"), row.args.join("\0") + "\0");
  }
  const executable = join(f.procRoot, "10009/exe"); await rm(executable); await symlink("/bin/false", executable);
  await assert.rejects(f.guard.assertHeld("before_stop", { expectedPause: f.expectedPause }), code("MANAGED_PROCESS_COMMAND_CHANGED"));
});

test("managed ingress still requires configured plans and direct Manager parentage", linux, async t => {
  const f = await guardedFixture(t, { ingress: true });
  const funnel = f.ingressProcesses.find(row => row.id === "funnel");
  await f.add(funnel.pid, { parentPid: f.core.pid, args: funnel.args });
  await assert.rejects(createLinuxInstallationGuard(f.options), code("COMPONENT_PARENT_CHANGED"));
  const node = JSON.parse(await readFile(f.options.manifest.config, "utf8")); delete node.publicMcp;
  await writeFile(f.options.manifest.config, JSON.stringify(node));
  await assert.rejects(createLinuxInstallationGuard(f.options), code("COMPONENT_COMMAND_UNCONFIRMED"));
});

test("actual HTTP fence plus real filesystem census accepts only exact Core read workers and detects later business before stop", linux, async t => {
  const f = await guardedFixture(t);
  await f.add(10005, { parentPid: f.core.pid, pgid: f.core.pgid, sid: f.core.sid,
    args: [process.execPath, "--max-old-space-size=192", join(releaseRoot, "dist/session/projection-read-worker.js")] });
  await f.members([10001, 10002, 10005]);
  const first = await f.guard.assertHeld("before_backup", { expectedPause: f.expectedPause }); assert.equal(first.count, 3);
  await f.add(10006, { parentPid: f.core.pid, args: [process.execPath, "--max-old-space-size=192", "/unreviewed/work.js", "unapproved-sensitive-sentinel"] });
  await f.members([10001, 10002, 10005, 10006]);
  let stopped = 0;
  await assert.rejects(async () => { await f.guard.assertHeld("before_stop", { expectedPause: f.expectedPause }); stopped++; }, error => {
    assert.equal(error.code, "LINUX_STOP_DOMAIN_UNTRACKED_PROCESSES");
    assert.equal(error.details.unapprovedCount, 1); assert.equal(error.details.unapproved[0].pid, 10006);
    assert.equal(JSON.stringify(error).includes("sensitive-sentinel"), false); return true;
  });
  assert.equal(stopped, 0); assert.equal(f.idle.accepting, false);
});

test("generation, own pause, live work, missing metadata and a fresh rollback generation are separate gates", linux, async t => {
  const f = await guardedFixture(t);
  for (const name of Object.keys(zero)) {
    f.idle[name] = 1;
    await assert.rejects(f.guard.assertHeld("before_stop", { expectedPause: f.expectedPause }), code("ACTIVITY_NOT_DRAINED"));
    f.idle[name] = 0;
  }
  f.idle.changedAt = "2026-11-02T00:00:00.002Z";
  await assert.rejects(f.guard.assertHeld("before_stop", { expectedPause: f.expectedPause }), code("PAUSE_OWNERSHIP_CHANGED"));
  f.idle.changedAt = f.expectedPause.changedAt;
  await f.add(10002, { parentPid: 10001, ticks: "20002" });
  await assert.rejects(f.guard.assertHeld("before_stop", { expectedPause: f.expectedPause }), code("MANAGED_PROCESS_GENERATION_CHANGED"));
  // The old census cannot authorize rollback of a newly running Core. A new
  // guard reads the actual replacement's birth and then the entire domain.
  f.idle.instance = { ...f.idle.instance, processStart: `linux:${boot}:20002` };
  const rollback = await createLinuxInstallationGuard(f.options);
  await rollback.assertHeld("rollback_before_stop");
  await f.add(10007, { parentPid: 1 }); await f.members([10001, 10002, 10007]);
  await assert.rejects(rollback.assertHeld("rollback_before_stop"), code("UNTRACKED_PROCESSES"));
  await rm(join(f.procRoot, "10007/stat"));
  await assert.rejects(rollback.assertHeld("rollback_before_stop"), error => error.code === "LINUX_STOP_DOMAIN_EVIDENCE_UNAVAILABLE" && error.details.readError === "ENOENT");
});

test("systemd command scope and actual typed empty stop hooks are checked; a custom primary unit is rejected", linux, async t => {
  const root = await directory(t), manifest = { unitFile: join(root, "fixture.service"), user: false };
  const expectedUnitText = systemdUnit({ nodeExecutable: "/opt/node", entrypoint: "/opt/node/cli.mjs", configFile: "/etc/node.json", directory: "/opt/node", user: false });
  await writeFile(manifest.unitFile, expectedUnitText);
  const values = { Id: "fixture.service", LoadState: "loaded", ActiveState: "active", SubState: "running", MainPID: "10001", InvocationID: "a".repeat(32), ControlGroup: "/unit",
    KillMode: "mixed", Restart: "on-failure", TimeoutStopUSec: "1min 30s", FragmentPath: manifest.unitFile, DropInPaths: "", Job: "",
    BindsTo: "", BoundBy: "", RequiredBy: "", PartOf: "", ConsistsOf: "", PropagatesStopTo: "", StopPropagatedFrom: "" };
  let typed = "a(sasbttttuii) 0"; const calls = [];
  const readCommand = async (command, args) => {
    calls.push([command, args]);
    if (command === "systemctl") return Object.entries(values).map(([name, value]) => `${name}=${value}`).join("\n");
    return args.includes("GetUnit") ? 'o "/org/freedesktop/systemd1/unit/fixture_2eservice"' : typed;
  };
  await inspectLinuxUnit(manifest, { readCommand, expectedUnitText });
  assert.equal(calls.length, 4); assert.ok(calls.every(([, args]) => !args.includes("--user")));
  typed = "as 0";
  await assert.rejects(inspectLinuxUnit(manifest, { readCommand, expectedUnitText }), code("STOP_HOOK_UNCONFIRMED"));
  typed = "a(sasbttttuii) 0";
  await writeFile(manifest.unitFile, expectedUnitText + "\n[Unit]\nOnFailure=unreviewed.service\n");
  await assert.rejects(inspectLinuxUnit(manifest, { readCommand, expectedUnitText }), code("UNIT_TEMPLATE_CHANGED"));
});

test("real Manager begin returns exactly its acquired pause and conditional compensation cannot resume another owner", async t => {
  const root = await directory(t), token = makeToken(), posts = [];
  let state = { instance: { pid: 10002, processStart: `linux:${boot}:10002`, token: "fixture-instance" },
    accepting: true, reason: null, changedAt: "2026-11-02T00:00:00.000Z" };
  const port = await server(t, (req, body) => {
    if (req.url === "/internal/quaymesh/idle") return { body: { ...state, quiescent: true, ...zero } };
    posts.push(body);
    if (JSON.stringify(body.expected) !== JSON.stringify(state)) return { status: 409, body: { code: "ADMISSION_PRECONDITION_FAILED" } };
    state = { ...state, accepting: body.action === "resume", reason: body.action === "resume" ? null : "node-maintenance", changedAt: new Date(Date.parse(state.changedAt) + 1).toISOString() };
    return { body: state };
  });
  const node = new QuayMeshNode({ revision: 1, node: { id: "edge", stateDir: root, corePort: port, adminPort: 0 } }); node.token = token;
  let relayOpen = true; node.relay = { activeRequests: 0, setAccepting: value => { relayOpen = value; } };
  await node.startAdmin(); t.after(() => new Promise(resolve => { node.admin.closeAllConnections(); node.admin.close(resolve); }));
  let pause;
  assert.equal(await beginInstallationMaintenance({ previous: { adminPort: node.admin.address().port }, token, onNormalPause: value => { pause = value; } }), null);
  assert.deepEqual(pause, state); assert.equal(node.status().maintenancePauseReceipt, 1); assert.equal(relayOpen, false);
  state = { ...state, reason: "another-owned-pause", changedAt: "2026-11-02T00:00:00.003Z" };
  await assert.rejects(requestJson(`http://127.0.0.1:${node.admin.address().port}/maintenance/resume`, { method: "POST", token, body: { expected: pause } }), error => error.status === 409);
  assert.equal(state.reason, "another-owned-pause"); assert.equal(relayOpen, false);
  assert.deepEqual(posts.at(-1).expected, pause);
});

test("actual installer rejects an unsupported old default pause contract before begin or any service/DB operation", linux, async t => {
  const root = await directory(t), token = makeToken(), requests = [];
  const port = await server(t, req => { requests.push(req.url); return { body: { nodeId: "edge", release: "old", components: [] } }; });
  const config = join(root, "node.json"), stagedConfig = join(root, "staged.json"), unitFile = join(root, "fixture.service");
  await writeFile(join(root, "cluster.json"), JSON.stringify(cluster())); await writeFile(join(root, "secrets.env"), `QUAYMESH_CLUSTER_TOKEN=${token}\n`);
  const settings = JSON.stringify({ schemaVersion: 1, id: "edge", stateDir: root, adminPort: port, capabilities: { worker: true }, mesh: { enabled: false, address: "127.0.0.2" }, secretsFile: "./secrets.env" });
  await writeFile(config, settings); await writeFile(stagedConfig, settings); await writeFile(unitFile, "unchanged");
  const previous = { version: 1, platform: "linux", nodeId: "edge", sourceCommit: "old", adminPort: port, unitFile };
  await writeFile(join(root, "installation.json"), JSON.stringify(previous));
  const prepared = { ...previous, sourceCommit: "new", configDir: root, stateDir: root, config, stagedConfig, directory: releaseRoot, nodeExecutable: process.execPath };
  const manifest = join(root, "prepared.json"); await writeFile(manifest, JSON.stringify(prepared));
  await assert.rejects(activateInstallation(manifest, { backup: false }), code("PAUSE_RECEIPT_UNSUPPORTED"));
  assert.deepEqual(requests, ["/status"]); assert.equal(await readFile(unitFile, "utf8"), "unchanged");
  assert.deepEqual(JSON.parse(await readFile(join(root, "installation.json"))), previous);
});
