import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { loadConfig } from "../config.js";
import { git } from "../git.js";
import { resolvePhysicalPath, samePhysicalPath } from "../physical-paths.js";
import { canonicalPathIdentity, canonicalWorkspaceRoot } from "../roots.js";
import { writeTestQuayMeshConfig } from "../test-support/config.test.js";
import { WorkLedger } from "../work-ledger.js";
import { WorkspaceRegistry } from "../workspaces.js";
import { SessionChangeCollector } from "./changes.js";
import { SessionService } from "./service.js";
import { SessionStore } from "./store.js";
import { memberFile } from "./write-evidence.js";

const execFileAsync = promisify(execFile);

async function fixture(t: TestContext, useGit: boolean) {
  // Keep the actual os.tmpdir spelling: hosted Windows runners commonly use
  // RUNNER~1 here. A junction also exercises mixed paths without 8.3 support.
  const directory = await mkdtemp(join(tmpdir(), "qm-path-alias-"));
  let ledger: WorkLedger | undefined, collector: SessionChangeCollector | undefined;
  t.after(async () => {
    try { await collector?.close(); } finally {
      ledger?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  const root = join(directory, "project"), alias = join(directory, "project-alias");
  const stateDir = join(directory, "state");
  await mkdir(root);
  await writeFile(join(root, "tracked.txt"), "tracked base\n");
  await writeFile(join(root, "removed.txt"), "removed base\n");
  await symlink(realpathSync.native(root), alias, process.platform === "win32" ? "junction" : "dir");
  if (useGit) {
    for (const args of [["init"], ["config", "user.email", "path-test@example.invalid"],
      ["config", "user.name", "Path test"], ["add", "."], ["commit", "-m", "baseline"]]) await git(root, args);
  }
  const config = loadConfig(writeTestQuayMeshConfig(join(directory, "config"), {
    storage: { stateDir }, workspaces: { allowedRoots: [root, alias], worktreeRoot: join(directory, "worktrees") },
    subagents: { enabled: false, instructions: "on-demand", providers: [] },
  }));
  const workspaces = new WorkspaceRegistry(config);
  ledger = new WorkLedger(stateDir);
  const store = new SessionStore(ledger.db);
  collector = new SessionChangeCollector(store, stateDir);
  const service = new SessionService(store, workspaces, ledger, undefined, collector);
  const opened = await workspaces.openWorkspace(root);
  // This is the same root field passed by the production workspace start route.
  const session = service.start({ owner_id: "owner", conversation_id: "path-alias" }, "Path aliases");
  const { member } = await service.attach({ owner_id: "owner", conversation_id: "path-alias" }, session.id, {
    id: opened.workspace.id, node: "local", root: opened.workspace.root,
    mode: opened.workspace.mode, sourceRoot: opened.workspace.sourceRoot ?? null,
  });
  const task = store.currentTask(session.id)!;
  const project = ledger.project(member.root);
  const nativeRoot = realpathSync.native(root);
  const gitRoot = useGit ? (await git(root, ["rev-parse", "--show-toplevel"])).stdout.trim() : null;
  t.diagnostic(JSON.stringify({ temporaryDirectory: directory, workspaceRoot: opened.workspace.root,
    memberRoot: member.root, nativeRoot, gitRoot,
    actualShortName: process.platform === "win32" && /~[0-9](?:[\\/]|$)/u.test(root)
      && canonicalPathIdentity(realpathSync(root)) !== canonicalPathIdentity(nativeRoot) }));
  return { directory, root, alias, nativeRoot, gitRoot, ledger, store, collector, session, member, task, project };
}

for (const useGit of [true, false]) {
  test(`${useGit ? "Git" : "ordinary"} capture keeps file evidence through a workspace path alias`, { timeout: 60_000 }, async t => {
    const f = await fixture(t, useGit);
    const persistedMember = f.store.getMember(f.session.id, f.member.id);
    const paths = ["tracked.txt", "removed.txt", "new/nested.txt"];
    const evidence = await f.collector.prepareWrite(f.member, paths, f.alias, f.task.id);
    const baseline = f.store.getChangeBaseline(f.session.id, f.member.id, f.root, f.task.id);
    assert.ok(baseline, "the caller's original root locates the Git/native baseline");
    assert.deepEqual(f.store.getChangeBaseline(f.session.id, f.member.id, f.nativeRoot, f.task.id), baseline);
    assert.deepEqual(evidence.map(file => file.path), paths);
    await writeFile(join(f.alias, "tracked.txt"), "tracked base\nowned change\n");
    await rm(join(f.alias, "removed.txt"));
    await mkdir(join(f.alias, "new"));
    await writeFile(join(f.alias, "new", "nested.txt"), "a newly owned file\n");
    await f.collector.recordWrite(f.member, evidence, f.task.id);
    // Absolute paths retain the short/junction spelling, including a deleted
    // leaf. They must still select the same repository during scoped capture.
    await f.collector.capture(f.member.id, f.task.id, paths.map(path => join(f.alias, path)));
    const files = f.collector.readSummaries(f.session.id, f.member.id, f.task.id);
    assert.deepEqual(files.map(file => [file.path, file.status, file.revertible]), [
      ["new/nested.txt", "A", true], ["removed.txt", "D", true], ["tracked.txt", "M", true],
    ]);
    assert.ok(files.every(file => file.coverage === "session_owned"));
    const patch = await f.collector.patch(f.session.id, f.member.id, undefined, f.task.id);
    assert.match(patch.patch, /\+owned change/);
    assert.match(patch.patch, /\+a newly owned file/);
    assert.match(patch.patch, /-removed base/);
    assert.equal(f.store.changeBaselines(f.session.id, f.member.id, f.task.id).length, 1);
    assert.equal(f.store.getChangeBaseline(f.session.id, f.member.id, f.alias, f.task.id)?.baseline_ref, baseline.baseline_ref);
    assert.equal(f.store.getMember(f.session.id, f.member.id).root, persistedMember.root);
    assert.equal(f.ledger.project(f.member.root).id, f.project.id);
    assert.equal(f.project.root, canonicalWorkspaceRoot(f.root), "persisted project identity keeps its existing algorithm");
  });
}

test("legacy and Task baselines reuse a physical alias without changing stored keys or crossing scopes", { timeout: 60_000 }, async t => {
  const f = await fixture(t, true);
  for (const taskId of [undefined, f.task.id]) {
    await f.collector.ensureBaseline(f.member, ["tracked.txt"], f.root, taskId);
    const original = f.store.getChangeBaseline(f.session.id, f.member.id, f.root, taskId)!;
    assert.ok(original);
    // A real alias stored by an earlier caller must remain a usable key. This
    // also covers databases whose old Windows roots used an 8.3 spelling.
    const storedRoot = canonicalPathIdentity(resolve(f.alias));
    if (taskId) f.ledger.db.prepare("UPDATE qm_task_change_baselines SET repo_root=? WHERE task_id=? AND member_id=?")
      .run(storedRoot, taskId, f.member.id);
    else f.ledger.db.prepare("UPDATE qm_change_baselines SET repo_root=? WHERE session_id=? AND member_id=?")
      .run(storedRoot, f.session.id, f.member.id);
    const found = f.store.getChangeBaseline(f.session.id, f.member.id, f.nativeRoot, taskId);
    assert.deepEqual(found, { ...original, repo_root: storedRoot });
    await f.collector.ensureBaseline(f.member, ["tracked.txt"], f.nativeRoot, taskId);
    f.store.putChangeBaseline({ ...original, repo_root: f.nativeRoot, baseline_ref: "must-not-rebase" }, taskId);
    assert.deepEqual(f.store.changeBaselines(f.session.id, f.member.id, taskId), [{ ...original, repo_root: storedRoot }]);
    const evidence = await f.collector.prepareWrite(f.member, ["tracked.txt"], f.alias, taskId);
    await writeFile(join(f.root, "tracked.txt"), `tracked base\n${taskId ? "Task" : "legacy"} alias change\n`);
    await f.collector.recordWrite(f.member, evidence, taskId);
    await f.collector.capture(f.member.id, taskId, ["tracked.txt"]);
    assert.equal(f.collector.readSummaries(f.session.id, f.member.id, taskId)[0]?.revertible, true);
    const current = f.store.getChangeBaseline(f.session.id, f.member.id, f.nativeRoot, taskId)!;
    assert.equal(current.repo_root, storedRoot);
    assert.equal(current.baseline_ref, original.baseline_ref);
    assert.notEqual(current.latest_ref, original.latest_ref);
  }
  const laterTask = f.store.createTask(f.session.id, "A separate task");
  assert.equal(f.store.getChangeBaseline(f.session.id, f.member.id, f.nativeRoot, laterTask.id), null);
  const otherPhase = f.store.addMember(f.session.id, "other-node", "other-phase", f.root, "checkout", null);
  assert.equal(f.store.getChangeBaseline(f.session.id, otherPhase.id, f.nativeRoot, f.task.id), null);
  const other = f.store.createSession("other-owner", "other-conversation", "Other session");
  const otherMember = f.store.addMember(other.id, "local", "other-workspace", f.root, "checkout", null);
  assert.equal(f.store.getChangeBaseline(other.id, otherMember.id, f.nativeRoot), null);
  assert.throws(() => f.store.getChangeBaseline(other.id, otherMember.id, f.nativeRoot, f.task.id), /TASK_SESSION_MISMATCH/);
  const sibling = join(f.directory, "sibling");
  await mkdir(sibling);
  assert.equal(f.store.getChangeBaseline(f.session.id, f.member.id, sibling, f.task.id), null);
});

test("physical file paths accept missing leaves and reject escaped, dangling, and non-directory boundaries", { timeout: 30_000 }, async t => {
  const f = await fixture(t, false);
  const missing = memberFile(f.member.root, "not-yet/created.txt", f.alias);
  assert.equal(missing.path, "not-yet/created.txt");
  assert.equal(resolvePhysicalPath(missing.absolute), join(f.nativeRoot, "not-yet", "created.txt"));
  const outside = join(f.directory, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "keep.txt"), "outside content\n");
  await symlink(realpathSync.native(outside), join(f.root, "escape"), process.platform === "win32" ? "junction" : "dir");
  await symlink(join(f.nativeRoot, "absent-target"), join(f.root, "dangling"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => memberFile(f.member.root, join(outside, "keep.txt")), /WRITE_OUTSIDE_WORKSPACE/);
  assert.throws(() => memberFile(f.member.root, "escape/keep.txt"), /WRITE_OUTSIDE_WORKSPACE/);
  assert.throws(() => memberFile(f.member.root, "escape/new.txt"), /WRITE_OUTSIDE_WORKSPACE/);
  assert.throws(() => memberFile(f.member.root, "dangling/new.txt"), /Cannot resolve symbolic link/);
  assert.throws(() => memberFile(f.member.root, "tracked.txt/new.txt"), { code: "ENOTDIR" });
  assert.equal(await readFile(join(outside, "keep.txt"), "utf8"), "outside content\n");
});

test("Windows native resolution equates a real 8.3 name without changing durable root normalization", {
  skip: process.platform !== "win32", timeout: 30_000,
}, async t => {
  // This is a read-only check of an existing directory. Git writes above stay
  // entirely in the temporary fixture; no Program Files content is changed.
  const candidate = process.env.ProgramFiles ?? "C:\\Program Files";
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class QmShortPath {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern uint GetShortPathNameW(string path, StringBuilder result, uint size);
}
'@
$buffer = New-Object System.Text.StringBuilder 32768
$length = [QmShortPath]::GetShortPathNameW($env:QM_PATH_ALIAS_INPUT, $buffer, $buffer.Capacity)
if ($length -eq 0) { throw "GetShortPathNameW failed" }
[Console]::Out.Write($buffer.ToString())
`], { env: { ...process.env, QM_PATH_ALIAS_INPUT: candidate }, windowsHide: true, timeout: 20_000 });
  const short = stdout.trim(), native = realpathSync.native(candidate);
  if (canonicalPathIdentity(short) === canonicalPathIdentity(native)) {
    t.skip("This volume does not provide an 8.3 alias for the readable directory");
    return;
  }
  assert.equal(samePhysicalPath(short, native), true);
  assert.equal(resolvePhysicalPath(short), native);
  assert.equal(canonicalWorkspaceRoot(short), canonicalPathIdentity(realpathSync(short)));
  assert.notEqual(canonicalWorkspaceRoot(short), canonicalWorkspaceRoot(native), "the historical ID algorithm is deliberately unchanged");
  t.diagnostic(JSON.stringify({ readOnlyShortPath: short, nativePath: native, realShortNameVerified: true }));
});
