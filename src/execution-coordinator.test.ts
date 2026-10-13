import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { ExecutionCoordinator, ExecutionConflictError, canonicalExecutionRoot } from "./execution-coordinator.js";

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "quaymesh-coordination-"));
  const a = join(root, "a"); const b = join(root, "b");
  for (const path of [a,b]) {
    const result=spawnSync("git",["init",path],{encoding:"utf8"});
    assert.equal(result.status,0,result.stderr);
  }
  const first = new ExecutionCoordinator(join(root, "state"));
  const second = new ExecutionCoordinator(join(root, "state"));
  t.after(() => { first.close(); second.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, a, b, first, second };
}

test("independent connections atomically exclude the same checkout before work", (t) => {
  const { a, first, second } = fixture(t);
  const claim = first.acquire({ workspaceRoot: a, kind: "agent", agentId: "agent-a" });
  let invoked = 0;
  assert.throws(() => { second.acquire({ workspaceRoot: a, kind: "command" }); invoked++; }, ExecutionConflictError);
  assert.equal(invoked, 0);
  assert.equal(second.inspect(a)[0]?.agentId, "agent-a");
  claim.release(); claim.release();
  second.acquire({ workspaceRoot: a, kind: "command" }).release();
});

test("canonical checkout covers nested directories and aliases", (t) => {
  const { root, a, first, second } = fixture(t);
  const nested = join(a, "src"); mkdirSync(nested);
  const alias = join(root, "alias"); symlinkSync(a, alias, process.platform === "win32" ? "junction" : "dir");
  assert.equal(canonicalExecutionRoot(nested), canonicalExecutionRoot(alias));
  const claim = first.acquire({ workspaceRoot: a, kind: "agent" });
  assert.throws(() => second.acquire({ workspaceRoot: nested, kind: "agent", maxConcurrentAgents: 16 }), ExecutionConflictError);
  assert.throws(() => second.acquire({ workspaceRoot: alias, kind: "mutation" }), ExecutionConflictError);
  claim.release();
});

test("global default is two; explicit serial and total limits remain bounded", (t) => {
  const { root, a, b, first, second } = fixture(t);
  const claim = first.acquire({ workspaceRoot: a, kind: "agent" });
  assert.throws(() => second.acquire({ workspaceRoot: b, kind: "agent", maxConcurrentAgents: 1 }), ExecutionConflictError);
  const another = second.acquire({ workspaceRoot: b, kind: "agent" });
  const c = join(root, "c");
  const initialized=spawnSync("git",["init",c],{encoding:"utf8"});assert.equal(initialized.status,0,initialized.stderr);
  assert.throws(() => second.acquire({ workspaceRoot: c, kind: "agent" }), ExecutionConflictError);
  another.release();
  assert.throws(() => second.acquire({ workspaceRoot: b, kind: "agent", maxConcurrentAgents: 0 }));
  claim.release();
});

test("read claims still enforce provider thread ownership and explicit resource exclusion", (t) => {
  const { a, b, first, second } = fixture(t);
  const claim = first.acquire({ workspaceRoot: a, kind: "agent", access: "read", agentId: "a", threadKey: "codex:shared" });
  assert.throws(() => second.acquire({ workspaceRoot: a, kind: "agent", access: "read", agentId: "b", threadKey: "codex:shared" }), ExecutionConflictError);
  const other = second.acquire({ workspaceRoot: b, kind: "agent", access: "read", agentId: "b" });
  assert.throws(() => other.bindThread("codex:shared"), ExecutionConflictError);
  other.release(); claim.release();
});

test("explicit shared build resources exclude independent worktrees", (t) => {
  const { a, b, first, second } = fixture(t);
  const claim = first.acquire({ workspaceRoot: a, kind: "command", resources: ["gradle:shared-output"] });
  assert.throws(() => second.acquire({ workspaceRoot: b, kind: "command", resources: ["gradle:shared-output"] }), ExecutionConflictError);
  second.acquire({ workspaceRoot: b, kind: "command", resources: ["gradle:other-output"] }).release();
  claim.release();
});

test("failed mutation releases its claim, not another owner's claim", async (t) => {
  const { a, b, first, second } = fixture(t);
  const other = second.acquire({ workspaceRoot: b, kind: "command" });
  await assert.rejects(first.run({ workspaceRoot: a, kind: "mutation" }, async () => { throw new Error("fixture"); }));
  assert.equal(first.inspect(a).length, 0);
  assert.equal(first.inspect(b).length, 1);
  other.release();
});

test("closing connection does not steal an uncertain operation or replay it", (t) => {
  const { a, first, second } = fixture(t);
  first.acquire({ workspaceRoot: a, kind: "agent", agentId: "unfinished" });
  first.close();
  assert.throws(() => second.acquire({ workspaceRoot: a, kind: "agent" }), ExecutionConflictError);
  assert.equal(second.inspect(a)[0]?.agentId, "unfinished");
});

test("a separate Node process cannot enter a held checkout", (t) => {
  const { root, a, first } = fixture(t);
  const claim = first.acquire({ workspaceRoot: a, kind: "agent", agentId: "parent" });
  const moduleUrl = new URL("./execution-coordinator.ts", import.meta.url).href;
  const script = `import {ExecutionCoordinator} from ${JSON.stringify(moduleUrl)};
    const c = new ExecutionCoordinator(${JSON.stringify(join(root, "state"))});
    try { c.acquire({workspaceRoot:${JSON.stringify(a)},kind:'command'}); process.exitCode=99; }
    catch(e) { process.exitCode=e.code==='EXECUTION_CONFLICT'?0:98; }
    finally { c.close(); }`;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { timeout: 10_000, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  claim.release();
});
