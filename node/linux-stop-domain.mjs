import { access, open, readdir, readlink, lstat, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { posix, resolve, basename, dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { requestJson } from "./network.mjs";
import { loadNodeConfig } from "./config.mjs";
import { componentPlans } from "./compile.mjs";

const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const positive = value => Number.isSafeInteger(value) && value > 0;
const within = (path, root) => path === root || path.startsWith(root === "/" ? "/" : root + "/");
const decodeMount = value => value.replace(/\\(040|011|012|134)/gu, (_all, octal) => String.fromCharCode(parseInt(octal, 8)));
const workers = ["dist/console-workbench/read-worker.js", "dist/session/status-read-worker.js", "dist/session/projection-read-worker.js"];
const commandComponents = new Set(["public-mcp", "funnel", "discovery"]);
const activity = ["claims", "waiting", "operations", "executions", "queuedOperations", "queuedExecutions", "activeWork", "allRuntimeWork", "persistedRuntimeWork"];

export function stopDomainError(reason, details) {
  const summary = details ? Object.fromEntries(["stage", "property", "readError", "count", "unapprovedCount", "outsideCount", "pid", "discoveryHelperReason"]
    .filter(key => details[key] !== undefined).map(key => [key, details[key]])) : {};
  if (details?.unapproved?.length) summary.unapprovedPids = details.unapproved.slice(0, 20).map(row => row.pid);
  if (details?.outside?.length) summary.outsidePids = details.outside.slice(0, 20).map(row => row.pid);
  return Object.assign(new Error(`Linux service stop refused: ${reason}.${Object.keys(summary).length ? " " + JSON.stringify(summary) : ""} No service process was signalled by this check.`),
    { code: "LINUX_STOP_DOMAIN_" + reason, ...(details ? { details } : {}) });
}
function check(ok, reason, details) { if (!ok) throw stopDomainError(reason, details); }
function budget(deadline) { check(performance.now() < deadline, "READ_TIMEOUT"); }

/** Kernel files do not reliably report st_size. Read to EOF with an explicit bound. */
export async function readLinuxBounded(file, maximum = 65536) {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(maximum + 1); let length = 0;
    while (length <= maximum) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      length += bytesRead;
      check(length <= maximum, "READ_BOUND_EXCEEDED");
      if (!bytesRead) return buffer.subarray(0, length).toString("utf8");
    }
    throw stopDomainError("READ_BOUND_EXCEEDED");
  } finally { await handle.close(); }
}

async function executableOnPath(command, path, cwd) {
  const candidates = command.includes("/") ? [command] : (path ?? "").split(":").map(part => posix.join(part || ".", command));
  for (const candidate of candidates) {
    const absolute = resolve(cwd, candidate);
    try {
      await access(absolute, constants.X_OK);
      if (!(await lstat(await realpath(absolute))).isFile()) continue;
      // Go LookPath 拒绝从相对 PATH 命中命令；不在安装检查中猜另一条启动路径。
      if (!posix.isAbsolute(candidate)) return undefined;
      return absolute;
    } catch (error) {
      if (!["ENOENT", "ENOTDIR", "EACCES"].includes(error.code)) throw error;
    }
  }
}

async function discoveryHelperCommands(environment, cwd) {
  const fields = new Set(["PATH", "TUNNEL_CLIENT_CODEX_APP_SERVER_COMMAND", "TUNNEL_CLIENT_CODEX_APP_SERVER_CMD",
    "TUNNEL_CLIENT_CODEX_APP_SERVER_ARGS", "TUNNEL_CLIENT_CODEX_APP_SERVER_CWD"]);
  const env = {};
  for (const item of environment.split("\0")) {
    const at = item.indexOf("="), key = item.slice(0, at);
    if (at > 0 && fields.has(key)) env[key] = item.slice(at + 1);
  }
  if (env.TUNNEL_CLIENT_CODEX_APP_SERVER_COMMAND?.trim()) return { reason: "nonstandard_discovery_shell_command" };
  const args = env.TUNNEL_CLIENT_CODEX_APP_SERVER_ARGS?.trim().split(/\s+/u).filter(Boolean) ?? [];
  if (args.length && !same(args, ["app-server"])) return { reason: "nonstandard_discovery_app_server_arguments" };
  const targets = { x64: ["x86_64-unknown-linux-musl", "@openai/codex-linux-x64"],
    arm64: ["aarch64-unknown-linux-musl", "@openai/codex-linux-arm64"] };
  const target = targets[process.arch];
  if (!target) return { reason: "discovery_codex_platform_unconfirmed" };
  try {
    const command = await executableOnPath(env.TUNNEL_CLIENT_CODEX_APP_SERVER_CMD?.trim() || "codex", env.PATH, cwd);
    const node = await executableOnPath("node", env.PATH, cwd);
    if (!command || !node) return { reason: "discovery_codex_launcher_unresolved" };
    const entry = await realpath(command), packageRoot = dirname(dirname(entry));
    const metadata = JSON.parse(await readLinuxBounded(resolve(packageRoot, "package.json")));
    if (metadata.name !== "@openai/codex" || metadata.bin?.codex !== "bin/codex.js"
      || await realpath(resolve(packageRoot, metadata.bin.codex)) !== entry
      || !(await readLinuxBounded(entry, 262144)).startsWith("#!/usr/bin/env node\n"))
      return { reason: "discovery_codex_launcher_unconfirmed" };
    let vendorRoot;
    try { vendorRoot = resolve(dirname(createRequire(entry).resolve(target[1] + "/package.json")), "vendor"); }
    catch (error) {
      if (error.code !== "MODULE_NOT_FOUND") throw error;
      vendorRoot = resolve(packageRoot, "vendor");
    }
    const binary = resolve(vendorRoot, target[0], "bin/codex");
    await access(binary, constants.X_OK);
    const workingDirectory = await realpath(resolve(cwd, env.TUNNEL_CLIENT_CODEX_APP_SERVER_CWD?.trim() || "."));
    return {
      wrapper: { executable: await realpath(node), args: ["node", command, "app-server"], cwd: workingDirectory },
      native: { executable: await realpath(binary), args: [binary, "app-server"], cwd: workingDirectory },
    };
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(error.code)) return { reason: "discovery_codex_launcher_unresolved" };
    throw error;
  }
}

export function parseLinuxStat(text, pid, boot) {
  check(text.startsWith(String(pid) + " (") && text.lastIndexOf(")") > 0, "PROCESS_STAT_INVALID");
  const fields = text.slice(text.lastIndexOf(")") + 2).trim().split(/\s+/u);
  check(/^\d+$/u.test(fields[19] ?? "") && [1, 2, 3].every(i => /^\d+$/u.test(fields[i] ?? "")), "PROCESS_STAT_INCOMPLETE");
  return { pid, start: "linux:" + boot + ":" + fields[19], parentPid: Number(fields[1]),
    pgid: Number(fields[2]), sid: Number(fields[3]), alive: !["Z", "X", "x"].includes(fields[0]) };
}
function memberships(text) {
  return text.trim().split("\n").map(line => {
    const match = /^(\d+):([^:]*):(\/.*)$/u.exec(line);
    check(match, "CGROUP_MEMBERSHIP_INVALID");
    return { id: match[1], controllers: match[2].split(",").filter(Boolean), group: match[3] };
  });
}
export function linuxHierarchyCandidates(mountInfo, processGroups, unitGroup, cgroupRoot = "/sys/fs/cgroup") {
  check(typeof unitGroup === "string" && unitGroup.startsWith("/") && unitGroup !== "/"
    && unitGroup.length < 4096 && posix.normalize(unitGroup) === unitGroup && !/[\0\r\n]/u.test(unitGroup), "CGROUP_PATH_INVALID");
  const groups = memberships(processGroups), candidates = [];
  for (const line of mountInfo.trim().split("\n")) {
    const parts = line.split(" - "); check(parts.length === 2, "MOUNTINFO_INCOMPLETE");
    const left = parts[0].split(" "), right = parts[1].split(" ");
    const named = right[0] === "cgroup" && right[2]?.split(",").includes("name=systemd");
    if (!named && right[0] !== "cgroup2") continue;
    const member = groups.find(row => named ? row.controllers.includes("name=systemd") : row.id === "0" && !row.controllers.length);
    if (!member || !within(member.group, unitGroup)) continue;
    const mountRoot = decodeMount(left[3]), mount = decodeMount(left[4]);
    check(within(mount, cgroupRoot) && posix.normalize(mount) === mount, "CGROUP_MOUNT_UNCONFIRMED");
    if (mountRoot !== "/" && !within(unitGroup, mountRoot)) continue;
    const relative = mountRoot === "/" ? unitGroup.slice(1) : posix.relative(mountRoot, unitGroup);
    candidates.push({ kind: named ? "v1-systemd" : "v2", mount, group: unitGroup, directory: posix.join(mount, relative) });
  }
  return candidates.sort((a, b) => (a.kind === "v1-systemd" ? 0 : 1) - (b.kind === "v1-systemd" ? 0 : 1));
}

/** Shared read-only kernel reader. Alternate roots are for isolated filesystem tests;
 * the installer always uses the real /proc and /sys/fs/cgroup. No signal or write API. */
export function createLinuxKernelReader({ procRoot = "/proc", cgroupRoot = "/sys/fs/cgroup" } = {}) {
  const processFile = (pid, name) => posix.join(procRoot, String(pid), name);
  const stat = async (pid, boot) => parseLinuxStat(await readLinuxBounded(processFile(pid, "stat")), pid, boot);
  const identity = async (pid, hierarchy, boot) => {
    check(positive(pid), "PROCESS_PID_INVALID");
    const before = await stat(pid, boot);
    const [groupText, status] = await Promise.all([readLinuxBounded(processFile(pid, "cgroup")), readLinuxBounded(processFile(pid, "status"))]);
    const group = memberships(groupText).find(row => hierarchy.kind === "v1-systemd"
      ? row.controllers.includes("name=systemd") : row.id === "0" && !row.controllers.length)?.group;
    const uid = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/mu.exec(status);
    check(group && uid, "PROCESS_METADATA_INCOMPLETE");
    const after = await stat(pid, boot);
    check(same(before, after) && after.alive, "PROCESS_CHANGED_DURING_READ", { pid });
    return { ...after, group, uids: uid.slice(1).map(Number) };
  };
  const collect = async hierarchy => {
    const directories = [], pids = new Set(); let entries = 0;
    const visit = async directory => {
      const info = await lstat(directory);
      check(info.isDirectory() && !info.isSymbolicLink() && await realpath(directory) === directory, "CGROUP_DIRECTORY_UNCONFIRMED");
      check(directories.length < 64, "CGROUP_TREE_BOUND_EXCEEDED");
      directories.push([posix.relative(hierarchy.directory, directory), info.dev, info.ino]);
      const text = (await readLinuxBounded(posix.join(directory, "cgroup.procs"))).trim();
      for (const value of text ? text.split(/\s+/u) : []) {
        const pid = Number(value);
        check(/^[1-9]\d*$/u.test(value) && positive(pid) && !pids.has(pid), "CGROUP_MEMBERSHIP_CHANGED");
        pids.add(pid); check(pids.size <= 512, "CGROUP_PROCESS_BOUND_EXCEEDED");
      }
      for (const child of await readdir(directory, { withFileTypes: true })) {
        check(++entries <= 8192, "CGROUP_ENTRY_BOUND_EXCEEDED");
        check(!child.isSymbolicLink(), "CGROUP_SYMLINK");
        if (child.isDirectory()) await visit(posix.join(directory, child.name));
        else check(child.isFile(), "CGROUP_ENTRY_UNCONFIRMED");
      }
    };
    await visit(hierarchy.directory);
    return { directories: directories.sort((a, b) => a[0].localeCompare(b[0])), pids: [...pids].sort((a, b) => a - b) };
  };
  const selectHierarchy = async (pid, group) => {
    const [mounts, member] = await Promise.all([readLinuxBounded(posix.join(procRoot, "self/mountinfo"), 1024 * 1024), readLinuxBounded(processFile(pid, "cgroup"))]);
    for (const candidate of linuxHierarchyCandidates(mounts, member, group, cgroupRoot)) {
      const observed = await collect(candidate);
      if (observed.pids.includes(pid)) return candidate;
    }
    throw stopDomainError("CGROUP_MOUNT_UNCONFIRMED");
  };
  const outsideGroups = async (hierarchy, boot, approved, deadline) => {
    const groups = new Set(approved.map(row => row.pgid)), outside = []; let count = 0;
    for (const entry of await readdir(procRoot, { withFileTypes: true })) {
      budget(deadline);
      if (!entry.isDirectory() || !/^[1-9]\d*$/u.test(entry.name)) continue;
      check(++count <= 32768, "PROCESS_CENSUS_BOUND_EXCEEDED");
      try {
        // Directory ownership is not the signal-permission boundary: a setuid
        // child can retain a signalable real/saved UID. Determine the PGID
        // first; every live member of a managed PGID is part of this census.
        const pid = Number(entry.name), basic = await stat(pid, boot);
        if (!basic.alive || !groups.has(basic.pgid)) continue;
        const row = await identity(pid, hierarchy, boot);
        if (!within(row.group, hierarchy.group)) outside.push({ ...row, classification: "outside_component_process_group" });
      } catch (error) {
        if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error;
      }
    }
    return outside.sort((a, b) => a.pid - b.pid);
  };
  const observe = async ({ hierarchy, boot, approved, core, directory, uid, deadline = performance.now() + 10000 }) => {
    budget(deadline);
    const before = await collect(hierarchy), rows = [], byPid = new Map(approved.map(row => [row.pid, row]));
    const coreExe = await readlink(processFile(core.pid, "exe"));
    // Resolve canonical entry paths once, including releases installed through
    // an existing directory symlink. No basename or generic Node exception.
    const readerPaths = new Set(await Promise.all(workers.map(name => realpath(resolve(directory, name)))));
    for (const pid of before.pids) {
      budget(deadline);
      const row = await identity(pid, hierarchy, boot), expected = byPid.get(pid);
      check(within(row.group, hierarchy.group) && row.uids.every(value => value === uid), "PROCESS_OUTSIDE_SERVICE_IDENTITY", { pid });
      let classification = "unapproved";
      if (expected) {
        check(["start", "parentPid", "pgid", "sid", "group"].every(key => row[key] === expected[key]) && same(row.uids, expected.uids),
        "MANAGED_PROCESS_GENERATION_CHANGED", { pid });
        if (expected.command) {
          const args = (await readLinuxBounded(processFile(pid, "cmdline"))).split("\0");
          if (args.at(-1) === "") args.pop();
          check(same(args, expected.command.args) && await readlink(processFile(pid, "exe")) === expected.command.executable,
            "MANAGED_PROCESS_COMMAND_CHANGED", { pid });
        }
        classification = expected.classification;
      } else if (row.parentPid === core.pid) {
        const args = (await readLinuxBounded(processFile(pid, "cmdline"))).split("\0");
        if (args.at(-1) === "") args.pop();
        if (args.length === 3 && args[0] === coreExe && args[1] === "--max-old-space-size=192"
          && readerPaths.has(args[2]) && await readlink(processFile(pid, "exe")) === coreExe) classification = "readonly_worker";
      }
      check(same(row, await identity(pid, hierarchy, boot)), "PROCESS_CHANGED_DURING_READ", { pid });
      rows.push({ ...row, classification });
    }
    const discovery = approved.find(row => row.classification === "discovery");
    let discoveryHelperReason;
    if (discovery && rows.some(row => row.parentPid === discovery.pid)) {
      let helper = { reason: "discovery_command_unconfirmed" };
      if (discovery.command) {
        const cwd = await readlink(processFile(discovery.pid, "cwd"));
        check(cwd === await realpath(directory), "DISCOVERY_WORKING_DIRECTORY_CHANGED", { pid: discovery.pid });
        helper = await discoveryHelperCommands(await readLinuxBounded(processFile(discovery.pid, "environ")), cwd);
      }
      discoveryHelperReason = helper.reason;
      if (helper.wrapper) {
        const matches = async (row, expected) => {
          if (!["pgid", "sid", "group"].every(key => row[key] === discovery[key])) return false;
          const args = (await readLinuxBounded(processFile(row.pid, "cmdline"))).split("\0");
          if (args.at(-1) === "") args.pop();
          return same(args, expected.args) && await readlink(processFile(row.pid, "exe")) === expected.executable
            && await readlink(processFile(row.pid, "cwd")) === expected.cwd;
        };
        // 按真实父链分两层识别，PID 顺序不承担进程先后关系；业务后代不继承资格。
        for (const row of rows.filter(row => row.classification === "unapproved" && row.parentPid === discovery.pid)) {
          if (!(await matches(row, helper.wrapper))) continue;
          row.classification = "discovery_codex_launcher";
          for (const child of rows.filter(child => child.classification === "unapproved" && child.parentPid === row.pid))
            if (await matches(child, helper.native)) child.classification = "discovery_codex_app_server";
        }
      }
    }
    const outside = await outsideGroups(hierarchy, boot, approved, deadline);
    check(same(before, await collect(hierarchy)), "CGROUP_MEMBERSHIP_CHANGED");
    for (const row of rows) {
      const again = await identity(row.pid, hierarchy, boot);
      check(["start", "parentPid", "pgid", "sid", "group"].every(key => again[key] === row[key]) && same(again.uids, row.uids), "PROCESS_CHANGED_DURING_READ", { pid: row.pid });
    }
    for (const expected of approved) check(rows.some(row => row.pid === expected.pid && row.start === expected.start), "MANAGED_PROCESS_MISSING", { pid: expected.pid });
    budget(deadline);
    const value = { kind: hierarchy.kind, group: hierarchy.group, directories: before.directories, rows, outside,
      ...(discoveryHelperReason ? { discoveryHelperReason } : {}) };
    return { ...value, observedAt: new Date().toISOString(), digest: digest(value),
      accepted: outside.length === 0 && rows.every(row => row.classification !== "unapproved") };
  };
  return { identity, collect, selectHierarchy, observe,
    boot: async () => (await readLinuxBounded(posix.join(procRoot, "sys/kernel/random/boot_id"))).trim() };
}

async function commandOutput(command, args, deadline) {
  budget(deadline);
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", failure;
    const timer = setTimeout(() => { failure ??= stopDomainError("SYSTEMD_READ_TIMEOUT"); child.kill("SIGKILL"); }, Math.min(5000, deadline - performance.now()));
    child.stdout.on("data", part => { output += part; if (Buffer.byteLength(output) > 262144) { failure ??= stopDomainError("SYSTEMD_READ_BOUND_EXCEEDED"); child.kill("SIGKILL"); } });
    child.stderr.on("data", () => {});
    child.once("error", () => { failure ??= stopDomainError("SYSTEMD_READ_FAILED"); });
    child.once("close", code => {
      clearTimeout(timer);
      if (failure || code !== 0) reject(failure ?? stopDomainError("SYSTEMD_READ_FAILED"));
      else if (performance.now() >= deadline) reject(stopDomainError("READ_TIMEOUT")); else accept(output);
    });
  });
}
const unitFields = ["Id", "LoadState", "ActiveState", "SubState", "MainPID", "InvocationID", "ControlGroup", "KillMode", "Restart", "TimeoutStopUSec",
  "FragmentPath", "DropInPaths", "Job", "BindsTo", "BoundBy", "RequiredBy", "PartOf", "ConsistsOf", "PropagatesStopTo", "StopPropagatedFrom", "ExecStop", "ExecStopPost"];

export async function inspectLinuxUnit(manifest, { deadline = performance.now() + 10000, readCommand = commandOutput, expectedUnitText } = {}) {
  const name = basename(manifest.unitFile ?? "");
  check(/^[A-Za-z0-9][A-Za-z0-9_.@-]*\.service$/u.test(name), "UNIT_NAME_INVALID");
  const scope = manifest.user ? ["--user"] : [];
  const raw = await readCommand("systemctl", [...scope, "--no-pager", "show", name, "--property=" + unitFields.join(",")], deadline);
  const unit = Object.fromEntries(raw.trim().split("\n").map(line => { const at = line.indexOf("="); check(at > 0, "SYSTEMD_PROPERTY_INVALID"); return [line.slice(0, at), line.slice(at + 1)]; }));
  const missingCommands = ["ExecStop", "ExecStopPost"].filter(key => !Object.hasOwn(unit, key));
  if (missingCommands.length) {
    const path = await readCommand("busctl", [...scope, "call", "org.freedesktop.systemd1", "/org/freedesktop/systemd1", "org.freedesktop.systemd1.Manager", "GetUnit", "s", name], deadline);
    const match = /^o\s+("\/org\/freedesktop\/systemd1\/unit\/[A-Za-z0-9_]+")$/u.exec(path.trim());
    check(match, "SYSTEMD_OBJECT_UNCONFIRMED");
    for (const key of missingCommands) {
      const value = await readCommand("busctl", [...scope, "get-property", "org.freedesktop.systemd1", JSON.parse(match[1]), "org.freedesktop.systemd1.Service", key], deadline);
      check(/^a\(sasbttttuii\)\s+0$/u.test(value.trim()), "STOP_HOOK_UNCONFIRMED", { property: key }); unit[key] = "";
    }
  }
  const missingPropagation = ["PropagatesStopTo", "StopPropagatedFrom"].filter(key => !Object.hasOwn(unit, key));
  if (missingPropagation.length) {
    const version = /^systemd (\d+)(?:\s|$)/u.exec(await readCommand("systemctl", ["--version"], deadline));
    check(version && Number(version[1]) === 245, "SYSTEMD_PROPERTIES_UNCONFIRMED");
    for (const key of missingPropagation) unit[key] = ""; // These properties do not exist in systemd 245.
  }
  for (const key of unitFields) check(Object.hasOwn(unit, key), "SYSTEMD_PROPERTY_MISSING", { property: key });
  check(unit.Id === name && unit.LoadState === "loaded" && unit.ActiveState === "active" && unit.SubState === "running"
    && positive(Number(unit.MainPID)) && /^[a-f0-9]{32}$/u.test(unit.InvocationID), "UNIT_GENERATION_UNCONFIRMED");
  check(unit.KillMode === "mixed" && unit.Restart === "on-failure" && unit.TimeoutStopUSec === "1min 30s"
    && unit.DropInPaths === "" && ["", "0"].includes(unit.Job), "SERVICE_POLICY_UNCONFIRMED");
  for (const key of ["BindsTo", "BoundBy", "RequiredBy", "PartOf", "ConsistsOf", "PropagatesStopTo", "StopPropagatedFrom", "ExecStop", "ExecStopPost"])
    check(unit[key].trim() === "", "STOP_DOMAIN_PROPAGATES", { property: key });
  check(await realpath(unit.FragmentPath) === await realpath(manifest.unitFile), "UNIT_FRAGMENT_CHANGED");
  const fragment = await readLinuxBounded(unit.FragmentPath, 262144);
  // The installer supplies its existing official template. A changed main
  // fragment could add OnFailure/SuccessAction or other stop actions without
  // any drop-in; a hash of that unreviewed fragment alone proves nothing.
  check(typeof expectedUnitText === "string" && fragment === expectedUnitText, "UNIT_TEMPLATE_CHANGED");
  budget(deadline);
  return { name, mainPid: Number(unit.MainPID), invocationId: unit.InvocationID, group: unit.ControlGroup,
    policyDigest: digest(unitFields.map(key => [key, unit[key]])), fragmentDigest: digest(fragment) };
}

function compactCensus(value) {
  return { digest: value.digest, observedAt: value.observedAt, count: value.rows.length,
    ...(value.discoveryHelperReason ? { discoveryHelperReason: value.discoveryHelperReason } : {}),
    unapproved: value.rows.filter(row => row.classification === "unapproved").slice(0, 20).map(({ pid, start, parentPid, pgid, sid }) => ({ pid, start, parentPid, pgid, sid })),
    unapprovedCount: value.rows.filter(row => row.classification === "unapproved").length,
    outside: value.outside.slice(0, 20).map(({ pid, start, pgid }) => ({ pid, start, pgid })), outsideCount: value.outside.length };
}
function componentIdentity(status) {
  check(Array.isArray(status.components) && status.components.some(row => row.id === "core"), "COMPONENT_IDENTITIES_UNAVAILABLE");
  const active = status.components.filter(row => row.pid != null);
  check(active.every(row => ["core", "mesh", "discovery", "egress", "public-mcp", "funnel"].includes(row.id) && positive(row.pid)
    && row.state === "ready" && Number.isFinite(row.startedAt) && Number.isSafeInteger(row.restarts)), "COMPONENT_IDENTITIES_UNAVAILABLE");
  check(new Set(active.map(row => row.pid)).size === active.length && active.some(row => row.id === "core"), "COMPONENT_IDENTITIES_UNAVAILABLE");
  return active.map(({ id, pid, startedAt, restarts }) => ({ id, pid, startedAt, restarts })).sort((a, b) => a.id.localeCompare(b.id));
}

async function configuredCommandIdentities(manifest, components) {
  const active = components.filter(row => commandComponents.has(row.id));
  if (!active.length) return new Map();
  check(typeof manifest.config === "string", "COMPONENT_COMMAND_UNCONFIRMED");
  const loaded = await loadNodeConfig(manifest.config);
  check(loaded.node.id === manifest.nodeId, "COMPONENT_COMMAND_UNCONFIRMED");
  const plans = componentPlans(loaded.node, loaded.cluster, loaded.env, {
    root: await realpath(manifest.directory), generatedDir: resolve(loaded.node.stateDir, "generated"),
    configDir: resolve(loaded.node.stateDir, "core"), release: manifest.sourceCommit,
  });
  // These additional managed identities are exact installed plans, not a
  // generic Node/tailscaled exception. Descendants still need their own census.
  return new Map(await Promise.all(active.map(async ({ id }) => {
    const plan = plans.find(value => value.id === id);
    check(plan, "COMPONENT_COMMAND_UNCONFIRMED");
    return [id, { executable: await realpath(plan.command), args: [plan.command, ...plan.args] }];
  })));
}

/** A fresh guard belongs to exactly one running Manager/component generation.
 * External maintenance providers keep their separately reviewed four stages. */
export async function createLinuxInstallationGuard({ manifest, status, token, corePort, expectedUnitText,
  kernel = createLinuxKernelReader(), inspectUnit = inspectLinuxUnit, http = requestJson }) {
  const deadline = performance.now() + 10000;
  check(manifest.platform === "linux" && status.nodeId === manifest.nodeId && status.release === manifest.sourceCommit, "RELEASE_IDENTITY_CHANGED");
  const components = componentIdentity(status), coreComponent = components.find(row => row.id === "core");
  const commands = await configuredCommandIdentities(manifest, components);
  const unit = await inspectUnit(manifest, { deadline, expectedUnitText });
  const health = await http(`http://127.0.0.1:${manifest.adminPort}/healthz`, { timeoutMs: 2500 });
  check(health.pid === unit.mainPid, "MANAGER_IDENTITY_CHANGED");
  const boot = await kernel.boot(); check(/^[a-f0-9-]{36}$/u.test(boot), "BOOT_IDENTITY_UNAVAILABLE");
  const hierarchy = await kernel.selectHierarchy(unit.mainPid, unit.group);
  const manager = await kernel.identity(unit.mainPid, hierarchy, boot);
  const uid = manager.uids[0]; check(manager.uids.every(value => value === uid), "MANAGER_UID_UNCONFIRMED");
  const approved = [{ ...manager, classification: "manager" }];
  for (const component of components) {
    const row = await kernel.identity(component.pid, hierarchy, boot);
    check(row.parentPid === manager.pid && row.pgid === row.pid && row.sid === row.pid && row.uids.every(value => value === uid), "COMPONENT_PARENT_CHANGED", { pid: row.pid });
    approved.push({ ...row, classification: component.id, ...(commands.has(component.id) ? { command: commands.get(component.id) } : {}) });
  }
  const core = approved.find(row => row.pid === coreComponent.pid);
  budget(deadline);
  const fence = async (stage, expectedPause, retainedClaims) => {
    const observedUnit = await inspectUnit(manifest, { deadline: performance.now() + 10000, expectedUnitText });
    check(same(unit, observedUnit), "UNIT_GENERATION_CHANGED", { stage });
    const [current, health, idle] = await Promise.all([
      http(`http://127.0.0.1:${manifest.adminPort}/status`, { timeoutMs: 2500 }),
      http(`http://127.0.0.1:${manifest.adminPort}/healthz`, { timeoutMs: 2500 }),
      http(`http://127.0.0.1:${corePort}/internal/quaymesh/idle`, { token, timeoutMs: 3000 }),
    ]);
    check(current.nodeId === manifest.nodeId && current.release === manifest.sourceCommit && health.pid === manager.pid
      && same(componentIdentity(current), components), "MANAGED_GENERATION_CHANGED", { stage });
    check(current.maintenance === true && current.relayActiveRequests === 0 && idle.accepting === false
      && idle.instance?.pid === core.pid && idle.instance.processStart === core.start, "MAINTENANCE_FENCE_CHANGED", { stage });
    if (expectedPause) check(same({ instance: idle.instance, accepting: idle.accepting, reason: idle.reason, changedAt: idle.changedAt }, expectedPause), "PAUSE_OWNERSHIP_CHANGED", { stage });
    check(activity.every(name => Number.isSafeInteger(idle[name]) && idle[name] >= 0)
      && idle.claims === retainedClaims && activity.every(name => name === "claims" || idle[name] === 0), "ACTIVITY_NOT_DRAINED", { stage });
    for (const expected of approved) {
      const actual = await kernel.identity(expected.pid, hierarchy, boot);
      check(["start", "parentPid", "pgid", "sid", "group"].every(key => actual[key] === expected[key]) && same(actual.uids, expected.uids), "MANAGED_PROCESS_GENERATION_CHANGED", { stage, pid: expected.pid });
    }
  };
  return {
    async assertHeld(stage, { expectedPause, retainedClaims = 0 } = {}) {
      const deadline = performance.now() + 10000;
      try {
        await fence(stage, expectedPause, retainedClaims); budget(deadline);
        const first = await kernel.observe({ hierarchy, boot, approved, core, directory: manifest.directory, uid, deadline });
        check(first.accepted, "UNTRACKED_PROCESSES", { stage, ...compactCensus(first) });
        await delay(50); budget(deadline);
        const second = await kernel.observe({ hierarchy, boot, approved, core, directory: manifest.directory, uid, deadline });
        check(second.accepted, "UNTRACKED_PROCESSES", { stage, ...compactCensus(second) });
        check(first.digest === second.digest, "CGROUP_MEMBERSHIP_CHANGED", { stage });
        await fence(stage, expectedPause, retainedClaims); budget(deadline);
        return compactCensus(second);
      } catch (error) {
        if (error.code?.startsWith("LINUX_STOP_DOMAIN_")) throw error;
        // Do not print proc contents, command arguments, tokens or command stderr.
        throw stopDomainError("EVIDENCE_UNAVAILABLE", { stage, readError: ["ENOENT", "ESRCH", "EACCES", "EPERM"].includes(error.code) ? error.code : "unknown" });
      }
    },
  };
}
