import assert from "node:assert/strict";
import {spawn, type ChildProcess} from "node:child_process";
import {randomUUID} from "node:crypto";
import {once} from "node:events";
import {mkdir, mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createInterface} from "node:readline";
import test, {type TestContext} from "node:test";
import {canonicalExecutionRoot} from "./execution-coordinator.js";
import {inspectExecutionClaim, recoverExecutionClaim} from "./execution-claim-recovery.js";
import {processOwner, processOwnerAlive, processStartIdentity} from "./process-identity.js";
import {SessionStore} from "./session/store.js";
import {taskActivityView} from "./task-view.js";
import {WorkLedger} from "./work-ledger.js";

const supportedIdentity = process.platform === "linux" || process.platform === "win32";
const deadline = () => AbortSignal.timeout(5_000);
const quietProgram = "setTimeout(() => {}, 30000)";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "qm-claim-proof-")), root = join(directory, "workspace");
  await mkdir(root);
  const ledger = new WorkLedger(join(directory, "state")), store = new SessionStore(ledger.db);
  const session = store.createSession("owner", null, "Claim proof fixture");
  const member = store.addMember(session.id, "local", "workspace", root, "checkout", null);
  const beginTask = (name: string) => {
    const task = store.createTask(session.id, name);
    store.touchTaskMember(task.id, member.id);
    const run = ledger.begin({root, workspaceId: member.workspace_id, workItemId: task.id, runKey: task.id, title: name,
      origin: {entryPoint: "console", evidence: "server_entry"}});
    store.linkRun(session.id, member.id, run.id, task.id);
    return {task, run};
  };
  const operation = (target: ReturnType<typeof beginTask>, owner = {pid: processOwner.pid, start: processOwner.start}) => {
    const generation = "inv_" + randomUUID();
    const operationId = ledger.operation({runId: target.run.id, requestKey: generation, kind: "command", label: "quiet fixture", status: "running"});
    if (owner.pid !== processOwner.pid || owner.start !== processOwner.start) {
      ledger.db.prepare("UPDATE execution_owners SET owner_pid=?,process_start=?,owner_token=? WHERE domain='operation' AND id=?")
        .run(owner.pid, owner.start, randomUUID(), operationId);
    }
    const claimId = "claim_" + randomUUID();
    ledger.db.prepare(`INSERT INTO execution_claims
      (id,owner_id,owner_pid,kind,checkout_root,agent_id,resources,acquired_at,access_mode,thread_key,
        scopes_json,operation_id,task_id,title,execution_id,execution_generation,owner_process_start)
      VALUES(?,?,?,'command',?,NULL,'[]',?,'write',NULL,NULL,?,?,?,NULL,?,?)`)
      .run(claimId, randomUUID(), owner.pid, canonicalExecutionRoot(root), new Date().toISOString(),
        operationId, target.task.id, target.task.title, generation, owner.start);
    return {operationId, generation, claimId};
  };
  t.after(async () => {ledger.close(); await rm(directory, {recursive: true, force: true});});
  return {ledger, store, beginTask, operation};
}

async function stopOwnedChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit", {signal: deadline()});
  child.kill();
  await exited;
}

async function liveOrphan(t: TestContext) {
  const owner = spawn(process.execPath, ["-e", `
    const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e',${JSON.stringify(quietProgram)}],{stdio:'ignore',detached:true});
    child.unref();
    process.stdout.write(JSON.stringify({pid:child.pid})+'\\n');
    process.stdin.once('data',()=>process.exit(0));
    setTimeout(()=>process.exit(90),10000).unref();
  `], {stdio: ["pipe", "pipe", "pipe"]});
  owner.stderr!.resume();
  let childPid: number | undefined, childStart: string | null = null;
  t.after(async () => {
    await stopOwnedChild(owner);
    if (childPid && childStart && processStartIdentity(childPid) === childStart) {
      try {process.kill(childPid, "SIGTERM");} catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  });
  const lines = createInterface({input: owner.stdout!});
  try {
    const [line] = await once(lines, "line", {signal: deadline()});
    childPid = JSON.parse(line as string).pid as number;
    assert.ok(Number.isSafeInteger(childPid) && childPid > 0);
    childStart = processStartIdentity(childPid);
    const ownerPid = owner.pid!, ownerStart = processStartIdentity(ownerPid);
    assert.ok(childStart); assert.ok(ownerStart);
    assert.equal(processOwnerAlive({owner_pid: childPid, process_start: childStart}), true);
    const exitOwner = async () => {
      const exited = once(owner, "exit", {signal: deadline()});
      owner.stdin!.end("exit\n"); await exited;
      assert.equal(processOwnerAlive({owner_pid: ownerPid, process_start: ownerStart}), false);
    };
    return {ownerPid, ownerStart, childPid, childStart, exitOwner};
  } finally {lines.close();}
}

test("dead owner plus business terminal state cannot release a claim while a real quiet descendant lives", {
  skip: !supportedIdentity,
}, async t => {
  const f = await fixture(t), target = f.beginTask("Historical task"), orphan = await liveOrphan(t);
  const items = (["completed", "failed", "cancelled"] as const).map(status => {
    const item = f.operation(target, {pid: orphan.ownerPid, start: orphan.ownerStart});
    f.ledger.endOperation(item.operationId, status, [], item.generation);
    return item;
  });
  await orphan.exitOwner();
  for (const item of items) {
    const before = f.ledger.db.prepare("SELECT * FROM execution_claims WHERE id=?").get(item.claimId);
    assert.equal(processOwnerAlive({owner_pid: orphan.childPid, process_start: orphan.childStart}), true);
    const result = recoverExecutionClaim(f.ledger.db, item.claimId);
    assert.equal(result.state, "unknown"); assert.equal(result.ownerAlive, false);
    assert.equal(result.reason, "physical_completion_unconfirmed");
    assert.equal(result.physicalState, "unknown");
    assert.deepEqual(f.ledger.db.prepare("SELECT * FROM execution_claims WHERE id=?").get(item.claimId), before);
    assert.equal(f.ledger.db.prepare("SELECT COUNT(*) FROM execution_claim_reconciliations WHERE claim_id=?").pluck().get(item.claimId), 0);
  }
  assert.equal(f.store.getTask(target.task.id).state, "active");
});

test("silence affects task presentation only; exact physical completion releases its own generation and task", {
  skip: !supportedIdentity,
}, async t => {
  const f = await fixture(t), target = f.beginTask("Quiet training"), other = f.beginTask("Other task");
  const item = f.operation(target), unrelated = f.operation(other);
  const child = spawn(process.execPath, ["-e", quietProgram], {stdio: "ignore"});
  t.after(() => stopOwnedChild(child));
  assert.ok(child.pid);
  const at = Date.now(), lastProgressAt = at - 2 * 60 * 60_000;
  const fresh = taskActivityView({requestState: "active", execution: "running", lastProgressAt, executionObservedAt: at, now: at});
  assert.equal(fresh.state, "executing"); assert.equal(fresh.current, true);
  const stale = taskActivityView({requestState: "active", execution: "running", lastProgressAt, executionObservedAt: at - 60_000, now: at});
  assert.equal(stale.state, "idle"); assert.equal(stale.current, false);
  assert.equal(child.exitCode, null);
  assert.equal(inspectExecutionClaim(f.ledger.db, item.claimId).state, "active");
  f.ledger.endOperation(item.operationId, "completed", [], item.generation);
  assert.equal(recoverExecutionClaim(f.ledger.db, item.claimId).state, "unknown");
  assert.equal(child.exitCode, null, "business completion did not stop the quiet process");
  const otherClaim = f.ledger.db.prepare("SELECT * FROM execution_claims WHERE id=?").get(unrelated.claimId);
  await stopOwnedChild(child);
  assert.throws(() => f.ledger.completePhysicalExecution("operation", item.operationId, "another-attempt", {boundary: "fixture_process_exit"}),
    /another execution owner or generation/);
  assert.equal(f.ledger.db.prepare("SELECT COUNT(*) FROM execution_quiescence").pluck().get(), 0);
  f.ledger.completePhysicalExecution("operation", item.operationId, item.generation, {boundary: "fixture_process_exit"});
  assert.equal(inspectExecutionClaim(f.ledger.db, item.claimId).state, "not_found");
  assert.deepEqual(f.ledger.db.prepare("SELECT * FROM execution_claims WHERE id=?").get(unrelated.claimId), otherClaim);
  assert.equal(f.ledger.db.prepare("SELECT COUNT(*) FROM execution_claim_reconciliations WHERE claim_id=?").pluck().get(item.claimId), 1);
  assert.equal(f.store.getTask(target.task.id).state, "active");
  assert.equal(f.store.getTask(other.task.id).state, "active");
});
