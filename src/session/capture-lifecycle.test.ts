import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { loadConfig } from "../config.js";
import { git } from "../git.js";
import { LocalAgentStore } from "../local-agent-store.js";
import { ProcessSessionManager, type ProcessSnapshot } from "../process-sessions.js";
import { writeTestQuayMeshConfig } from "../test-support/config.test.js";
import { WorkLedger } from "../work-ledger.js";
import { SqliteWorkspaceStore } from "../workspace-store.js";
import { WorkspaceRegistry } from "../workspaces.js";
import { createInvocationContext } from "./invocations.js";
import { createSessionRuntime } from "./runtime.js";
import { SessionStore } from "./store.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function until(check: () => boolean, description: string): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (!check()) {
    assert.ok(performance.now() < deadline, description);
    await delay(10);
  }
}

async function fixture(t: TestContext, holdFinish = false) {
  const directory = await mkdtemp(join(tmpdir(), "qm-capture-lifecycle-"));
  const root = join(directory, "project"), stateDir = join(directory, "state");
  await mkdir(root);
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "capture@example.invalid"]);
  await git(root, ["config", "user.name", "Capture Test"]);
  await writeFile(join(root, "tracked.txt"), "base\n");
  await git(root, ["add", "tracked.txt"]);
  await git(root, ["commit", "-m", "baseline"]);
  const config = loadConfig(writeTestQuayMeshConfig(join(directory, "config"), {
    storage: { stateDir }, workspaces: { allowedRoots: [root], worktreeRoot: join(directory, "worktrees") },
    subagents: { enabled: false, instructions: "on-demand", providers: [] },
  }));
  const workspaceStore = new SqliteWorkspaceStore(stateDir), workspaces = new WorkspaceRegistry(config, workspaceStore);
  const ledger = new WorkLedger(stateDir), agents = new LocalAgentStore(stateDir);
  const manager = new ProcessSessionManager({ stateDir });
  const finishEntered = deferred(), finishRelease = deferred();
  if (!holdFinish) finishRelease.resolve();
  // Hold the real finish sequence after its process claim is released, before
  // SessionRuntime's listener. This is the command-to-capture ownership edge.
  manager.addFinishListener(async () => { finishEntered.resolve(); await finishRelease.promise; });
  const execution = manager.executionCoordinator!;
  const runtime = createSessionRuntime({ config, workspaces, ledger, agents, execution, processSessions: manager });
  const session = runtime.store.createSession("owner", "capture-lifecycle", "Capture lifecycle");
  const member = runtime.store.addMember(session.id, config.federation?.nodeId ?? "local", "workspace", root, "checkout", null);
  const task = runtime.store.createTask(session.id, "Capture real command changes");
  runtime.store.touchTaskMember(task.id, member.id);
  const commandReady = join(directory, "command-ready"), commandRelease = join(directory, "command-release");
  const filterEntered = join(directory, "filter-entered"), filterRelease = join(directory, "filter-release");
  t.after(async () => {
    finishRelease.resolve();
    await Promise.all([writeFile(commandRelease, "release"), writeFile(filterRelease, "release")]);
    await manager.shutdown({ drainSharedWork: () => runtime.close() });
    agents.close(); ledger.close(); workspaceStore.close();
    await rm(directory, { recursive: true, force: true });
  });
  await runtime.changes.ensureBaseline(member, ["tracked.txt"], root, task.id);
  const filterFile = join(directory, "wait-clean-filter.mjs");
  await writeFile(filterFile, `import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
const data=readFileSync(0);writeFileSync(process.argv[2],String(process.pid));
const deadline=Date.now()+15000;
while(!existsSync(process.argv[3])){if(Date.now()>deadline)throw new Error('filter release timeout');await delay(10);}
process.stdout.write(data);\n`);
  const quote = (value: string) => '"' + value.replaceAll('"', '\\"') + '"';
  await git(root, ["config", "filter.capturewait.clean", [process.execPath, filterFile, filterEntered, filterRelease].map(quote).join(" ")]);
  await git(root, ["config", "filter.capturewait.required", "true"]);
  await writeFile(join(root, ".gitattributes"), "tracked.txt filter=capturewait\n");
  // A trigger runs at the first real terminal invocation write, not at a
  // convenient later observation. The periodic reconciler can immediately
  // copy this state to console_operations, so the tail must already be owned.
  ledger.db.exec(`CREATE TABLE capture_terminal_observations(operation_id TEXT NOT NULL);
    CREATE TRIGGER capture_terminal_requires_lease BEFORE UPDATE OF state ON qm_invocations
    WHEN NEW.state IN ('succeeded','failed','cancelled') AND OLD.state NOT IN ('succeeded','failed','cancelled')
    BEGIN
      SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM qm_runtime_work
        WHERE operation_id=NEW.operation_id AND kind='capture' AND blocking=1)
        THEN RAISE(ABORT,'terminal invocation lost capture ownership') END;
      INSERT INTO capture_terminal_observations VALUES(NEW.operation_id);
    END`);
  const context = createInvocationContext({ auth: { owner_id: session.owner_id },
    transport: { instance_id: "capture-transport" }, request: { id: "command", tool_name: "exec_command" },
    session: { session_id: session.id, task_id: task.id, member_id: member.id, workspace_id: member.workspace_id } });
  const start = () => runtime.recorder.recordWithContext<ProcessSnapshot>(context, {
    tool_name: "exec_command", kind: "command", label: "real command with background capture", input: {},
    affectsFiles: true, runningResult: result => result.running,
    operation: captured => manager.start({
      workspaceId: member.workspace_id, cwd: root, workspaceRoot: root, command: "capture fixture",
      sessionOperationId: captured.operation_id, workRunId: captured.run_id, yieldTimeMs: 0,
      scopes: [{ kind: "tree", path: root, access: "write" }],
      program: { executable: process.execPath, args: ["--input-type=module", "-e", `
import {writeFileSync,existsSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
writeFileSync(process.argv[1],'base\\ncaptured command change\\n');writeFileSync(process.argv[2],'ready');
const deadline=Date.now()+15000;
while(!existsSync(process.argv[3])){if(Date.now()>deadline)throw new Error('command release timeout');await delay(10);}
console.log('command completed');`, join(root, "tracked.txt"), commandReady, commandRelease] },
    }),
  });
  return { directory, root, ledger, runtime, manager, execution, session, member, task, context, start,
    finishEntered, finishRelease, commandReady, commandRelease, filterEntered, filterRelease };
}

test("real command completion transfers to visible capture before its terminal receipt, across maintenance pause", { timeout: 20_000 }, async t => {
  const f = await fixture(t, true);
  const accepted = await f.start();
  assert.equal(accepted.running, true, "initial tool receipt returns while the real child still runs");
  await until(() => existsSync(f.commandReady), "real command starts");
  await writeFile(f.commandRelease, "release");
  await f.finishEntered.promise;
  const before = f.execution.admissionStatus();
  assert.equal(before.claims, 0, "physical command claim is released before its finish listener");
  assert.ok(before.operations > 0, "source business operation still owns the accepted tail");
  assert.equal(before.quiescent, false);
  f.execution.pause("node-maintenance");
  f.finishRelease.resolve();
  await until(() => existsSync(f.filterEntered), "real Git clean filter enters while admission is paused");
  await until(() => f.runtime.store.findInvocationByOperationId(f.context.operation_id!)?.state === "succeeded", "real finish listener persists terminal receipt");
  const terminal = f.ledger.db.prepare("SELECT operation_id FROM capture_terminal_observations").all();
  assert.deepEqual(terminal, [{ operation_id: f.context.operation_id }]);
  f.ledger.reconcileTerminalOperations();
  const holding = f.execution.admissionStatus();
  assert.equal(holding.accepting, false);
  assert.equal(holding.claims, 0);
  assert.ok(holding.activeWork > 0, "background Git remains a blocking runtime lease after terminal receipt");
  assert.equal(holding.quiescent, false);
  assert.ok(f.ledger.db.prepare("SELECT 1 FROM qm_runtime_work WHERE kind='capture' AND task_id=? AND blocking=1").get(f.task.id));
  await assert.rejects(f.runtime.changes.markDirty(f.member.id, ["tracked.txt"], f.task.id), { code: "NODE_ADMISSION_PAUSED" });
  await assert.rejects(f.runtime.changes.capture(f.member.id, f.task.id), { code: "NODE_ADMISSION_PAUSED" });
  // Independent pause-rejected callers do not cancel the accepted capture.
  assert.equal(existsSync(f.filterRelease), false);
  await writeFile(f.filterRelease, "release");
  await f.runtime.changes.flush();
  await until(() => f.execution.admissionStatus().activeWork === 0, "capture and recovery release their real leases");
  const file = f.runtime.changes.readSummaries(f.session.id, f.member.id, f.task.id).find(row => row.path === "tracked.txt");
  assert.ok(file);
  const storedFile = f.runtime.store.fileSummaries(f.session.id, f.member.id, f.task.id).find(row => row.id === file.id)!;
  assert.match(await readFile(storedFile.patchRef, "utf8"), /\+captured command change/);
  assert.equal(f.execution.admissionStatus().quiescent, true);
  f.execution.resume();
  await writeFile(join(f.root, "tracked.txt"), "base\ncaptured command change\nafter resume\n");
  await f.runtime.changes.capture(f.member.id, f.task.id);
  assert.equal(f.runtime.changes.readSummaries(f.session.id, f.member.id, f.task.id).find(row => row.path === "tracked.txt")?.additions, 2);
  const finished = await f.runtime.service.finishTask("owner", f.task.id, "completed", "real capture was published");
  assert.equal(finished.state, "closed", "the finalizer's own capture lease does not count as competing Task work");
});

test("manager shutdown drains real Git capture before closing its shared coordinator", { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  assert.equal((await f.start()).running, true);
  await until(() => existsSync(f.commandReady), "real command starts");
  await writeFile(f.commandRelease, "release");
  await until(() => existsSync(f.filterEntered), "actual Git capture is blocked");
  await until(() => f.runtime.store.findInvocationByOperationId(f.context.operation_id!)?.state === "succeeded", "command finish listener completes");
  f.execution.pause("服务正在退出");
  let closed = false;
  const shutdown = f.manager.shutdown({ drainSharedWork: () => f.runtime.close() }).then(() => { closed = true; });
  await delay(50);
  assert.equal(closed, false, "shutdown waits for the existing Git child rather than closing its database");
  assert.ok(f.execution.admissionStatus().activeWork > 0, "shared coordinator remains usable while runtime drains");
  await writeFile(f.filterRelease, "release");
  await shutdown;
  const persisted = new SessionStore(f.ledger.db);
  const file = persisted.fileSummaries(f.session.id, f.member.id, f.task.id).find(row => row.path === "tracked.txt");
  assert.ok(file, "accepted capture publishes before runtime closes its store");
  assert.match(await readFile(file.patchRef, "utf8"), /\+captured command change/);
  assert.equal(f.ledger.db.prepare("SELECT COUNT(*) FROM qm_runtime_work").pluck().get(), 0);
  assert.equal(persisted.findInvocationByOperationId(f.context.operation_id!)?.state, "succeeded");
  assert.notEqual(persisted.getTask(f.task.id).change_summary_state, "incomplete");
});
