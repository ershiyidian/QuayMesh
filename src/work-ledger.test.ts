import {ExecutionCoordinator} from "./execution-coordinator.js";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalAgentStore } from "./local-agent-store.js";
import { WorkLedger } from "./work-ledger.js";
import { SessionStore } from "./session/store.js";

test("successful artifact evidence survives failure of the overall acceptance", (t) => {
  const f = fixture(t);
  const run = f.begin("artifact-partial");
  const evidence = [{ label: "APK generated", reference: "artifact:apk-fixture", outcome: "passed" as const },
    { label: "Device installation", reference: "check:device", outcome: "failed" as const }];
  const receipt = f.ledger.finish(run.id, { status: "failed", acceptance: "failed", summary: "APK ready; installation failed", evidence });
  assert.equal(receipt.acceptanceStatus, "failed");
  assert.deepEqual(receipt.evidence, evidence);
  assert.deepEqual(f.ledger.receipt(run.id).evidence, evidence, "Recovery preserves per-artifact facts independently of total goal status");
});

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "quaymesh-work-ledger-"));
  const project = join(root, "project"); mkdirSync(join(project, ".git"), { recursive: true });
  const state = join(root, "state"); const store = new LocalAgentStore(state); const ledger = new WorkLedger(state);
  const agent = store.create({ workspaceRoot: project, workspaceId: "ws", profileName: "codex", provider: "codex" });
  store.update(agent.id, { status: "idle" });
  t.after(() => { ledger.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const begin = (key: string) => ledger.begin({ root: project, workspaceId: "ws", workItemId: "feature", runKey: key,
    title: "Implement feature", origin: { entryPoint: "chatgpt_mcp", evidence: "client_reported", modelLabel: "GPT-6 Pro" } });
  const make = (runId: string, turnId: string, ids: string[] = [], createdHere = true) => {
    const executionId = ledger.beginExecution({ runId, agentId: agent.id, provider: "codex" });
    ledger.attachThread(executionId, { threadId: "thread", instanceId: "instance", identityVerified: true, createdHere,
      priorTurnIds: ids, priorTurnsClosed: true });
    ledger.requestStarted(executionId); ledger.turnStarted(executionId, turnId); return executionId;
  };
  const usage = (executionId: string, turnId: string, total: number) => ledger.usage(executionId, { threadId: "thread", turnId, newThread: false,
    total: { inputTokens: total * .8, cachedInputTokens: total * .6, outputTokens: total * .2, reasoningOutputTokens: total * .1, totalTokens: total } });
  const finishExecution = (executionId: string) => { ledger.providerFinished(executionId); ledger.endExecution(executionId, "completed"); };
  const finish = (runId: string) => ledger.finish(runId, { status: "completed", acceptance: "passed", summary: "Verified",
    evidence: [{ label: "Unit tests", reference: "test://fixture", outcome: "passed" }] });
  return { root, project, state, store, ledger, agent, begin, make, usage, finishExecution, finish };
}

test("explicit project names preserve identity and survive ordinary registration", (t) => {
  const f = fixture(t);
  const original = f.ledger.project(f.project);
  const named = f.ledger.project(f.project, "LanggraphAgent");
  assert.equal(named.id, original.id);
  assert.equal(named.root, original.root);
  assert.equal(f.ledger.project(f.project).name, "LanggraphAgent");
  assert.throws(() => f.ledger.project(f.project, " "));
  assert.equal(f.ledger.project(f.project).name, "LanggraphAgent");
});

test("a host-only run has an explicit zero receipt and idempotent final acceptance", (t) => {
  const f = fixture(t); const run = f.begin("host");
  assert.equal(f.begin("host").id, run.id);
  f.ledger.operation({ runId: run.id, requestKey: "inspect", kind: "read", label: "Host inspected source", status: "completed" });
  const receipt = f.finish(run.id);
  assert.equal(receipt.usageStatus, "not_used"); assert.equal(receipt.codexUsage?.totalTokens, 0);
  assert.equal(f.finish(run.id).receiptRevision, receipt.receiptRevision);
  assert.throws(() => f.ledger.finish(run.id, { status: "failed", acceptance: "failed", summary: "changed", evidence: [] }));
  assert.throws(() => f.ledger.requireScope(run.id, f.project, "another-workspace"));
});

test("per-run usage excludes prior session history and does not sum cache/reasoning details twice", (t) => {
  const f = fixture(t); const first = f.begin("one"); const a = f.make(first.id, "t1");
  f.usage(a, "t1", 1000); f.usage(a, "t1", 1000); f.usage(a, "t1", 500);
  f.finishExecution(a); assert.equal(f.finish(first.id).codexUsage?.totalTokens, 1000);
  const second = f.begin("two"); const b = f.make(second.id, "t2", ["t1"], false);
  f.usage(b, "t2", 1500); f.finishExecution(b); const receipt = f.finish(second.id);
  assert.equal(receipt.usageStatus, "complete");
  assert.deepEqual(receipt.codexUsage, { inputTokens: 400, cachedInputTokens: 300, outputTokens: 100, reasoningOutputTokens: 50, totalTokens: 500 });
  assert.equal(f.ledger.projectUsage(first.project_id).codexUsage?.totalTokens, 1500);
});

test("external turns and missing usage remain unknown rather than attributed or replaced with zero", (t) => {
  const f = fixture(t); const first = f.begin("one"); const a = f.make(first.id, "t1"); f.usage(a, "t1", 1000); f.finishExecution(a); f.finish(first.id);
  const second = f.begin("external"); const b = f.make(second.id, "t2", ["t1", "external-user-turn"], false);
  f.usage(b, "t2", 10000); f.finishExecution(b);
  const result = f.finish(second.id); assert.equal(result.usageStatus, "unavailable"); assert.equal(result.codexUsage, null);
  assert.equal(f.ledger.threads(first.project_id)[0]!.external_activity, 1);
  const third = f.begin("missing"); const c = f.make(third.id, "t3", ["t1", "external-user-turn", "t2"], false); f.finishExecution(c);
  assert.equal(f.finish(third.id).codexUsage, null);
});

test("aggregation includes more than twenty turns and includes failed paid executions", (t) => {
  const f = fixture(t); const run = f.begin("many"); const ids: string[] = [];
  for (let index = 0; index < 26; index++) {
    const turnId = `t${index}`; const execution = f.make(run.id, turnId, [...ids], index === 0);
    f.usage(execution, turnId, (index + 1) * 100); f.ledger.providerFinished(execution);
    f.ledger.endExecution(execution, index === 5 ? "failed" : "completed"); ids.push(turnId);
  }
  const receipt = f.finish(run.id); assert.equal(receipt.executions, 26); assert.equal(receipt.codexUsage?.totalTokens, 2600);
});

test("late predecessor usage increments receipt revision and corrects successor attribution", (t) => {
  const f = fixture(t); const first = f.begin("first"); const a = f.make(first.id, "t1");
  f.usage(a, "t1", 1000); f.finishExecution(a); const before = f.finish(first.id);
  const second = f.begin("second"); const b = f.make(second.id, "t2", ["t1"], false);
  f.usage(b, "t2", 1500); f.finishExecution(b); f.finish(second.id);
  f.usage(a, "t1", 1100);
  assert(f.ledger.receipt(first.id).receiptRevision > before.receiptRevision);
  assert.equal(f.ledger.receipt(second.id).codexUsage?.totalTokens, 400);
  assert.equal(f.ledger.projectUsage(first.project_id).codexUsage?.totalTokens, 1500);
});

test("execution completion never auto-passes acceptance; active operations block finish", (t) => {
  const f = fixture(t); const run = f.begin("active"); const operationId = f.ledger.operation({ runId: run.id,
    requestKey: "build", kind: "build", label: "Build", status: "running" });
  assert.throws(() => f.finish(run.id), /active/);
  f.ledger.endOperation(operationId, "completed");
  const exec = f.make(run.id, "turn"); f.usage(exec, "turn", 1000); f.finishExecution(exec);
  assert.equal(f.ledger.run(run.id).acceptance, "pending");
  assert.throws(() => f.ledger.finish(run.id, { status: "completed", acceptance: "passed", summary: "done", evidence: [] }), /evidence/);
  assert.equal(f.finish(run.id).acceptanceStatus, "passed");
});

test("interrupted execution is marked for reconciliation without deleting usage or replaying work", (t) => {
  const f = fixture(t); const run = f.begin("interrupted"); const execution = f.make(run.id, "t1");
  f.usage(execution, "t1", 1000);
  f.ledger.db.prepare("UPDATE execution_owners SET owner_pid=? WHERE domain='execution' AND id=?").run(2_147_483_647,execution);
  assert.equal(f.ledger.reconcileInterruptedExecutions(), 1);
  assert.equal(f.ledger.run(run.id).status, "reconciliation_required");
  assert.equal(f.ledger.receipt(run.id).usageStatus, "partial");
  assert.equal(f.ledger.receipt(run.id).codexUsage?.totalTokens, 1000);
  assert.equal(f.ledger.reconcileInterruptedExecutions(), 0);
});

test("已归档任务的历史运行停留在 running 时，安全标记可恢复中断", (t) => {
  const f = fixture(t);
  const store = new SessionStore(f.ledger.db);
  const session = store.createSession("owner", "conversation", "测试会话");
  const task = store.createTask(session.id, "第一阶段");
  const run = f.begin(`task-${task.id}-test`);
  assert.equal(f.ledger.archiveTaskRuns(task.id), 1);
  assert.equal(f.ledger.run(run.id).status, "interrupted");
  assert.ok(f.ledger.run(run.id).interrupted_at);
  assert.equal(f.ledger.archiveTaskRuns(task.id), 0);
  assert.equal(f.ledger.resume(run.id).status, "running");
  store.archiveTask(task.id, "superseded");
  f.ledger.db.prepare("update console_work_runs set lease_expires_at=? where id=?")
    .run("2020-01-01T00:00:00Z", run.id);
  assert.equal(f.ledger.reconcileArchivedTaskRuns(), 1);
  assert.equal(f.ledger.run(run.id).status, "interrupted");
});

test("旧轮次有正在执行的子操作时，不伪造结束状态", (t) => {
  const f = fixture(t);
  const store = new SessionStore(f.ledger.db);
  const session = store.createSession("owner", "conversation", "进行中任务");
  const task = store.createTask(session.id, "需要保留运行的任务");
  const run = f.begin(`task-${task.id}-running`);
  const operationId = f.ledger.operation({runId:run.id, requestKey:"running-child",kind:"command",label:"真实工作",status:"running"});
  store.archiveTask(task.id, "superseded");
  assert.equal(f.ledger.archiveTaskRuns(task.id), 0);
  assert.equal(f.ledger.run(run.id).status, "running");
  f.ledger.endOperation(operationId, "completed");
  assert.equal(f.ledger.archiveTaskRuns(task.id), 1);
  assert.equal(f.ledger.run(run.id).status, "interrupted");
});


test("读取一百次不续租，不改写执行进展或修订",t=>{
  const f=fixture(t),run=f.begin("read-does-not-heartbeat");
  const op=f.ledger.operation({runId:run.id,requestKey:"build",kind:"command",label:"silent",status:"running"});
  const previous=f.ledger.run(run.id);
  for(let i=0;i<100;i++)f.ledger.run(run.id);
  assert.deepEqual(f.ledger.run(run.id),previous);
  const observed=new Date(Date.now()+1000).toISOString();f.ledger.observeOperations([op],observed);
  assert.deepEqual(f.ledger.run(run.id),previous);
  assert.equal(f.ledger.hasConfirmedChild(run.id,Date.parse(observed)+29_000),true);
  assert.equal(f.ledger.hasConfirmedChild(run.id,Date.parse(observed)+31_000),false);
  assert.equal(f.ledger.run(run.id).status,"running");
});

test("同目录另一 Task 的普通命令不阻挡交付，自己的占用仍阻挡",t=>{
  const f=fixture(t),store=new SessionStore(f.ledger.db),session=store.createSession("owner","claims","claims");
  const first=store.createTask(session.id,"first"),second=store.createTask(session.id,"second");
  const member=store.addMember(session.id,"local","ws",f.project,"checkout",null);
  const a=f.begin(`task-${first.id}-a`),b=f.begin(`task-${second.id}-b`);
  store.linkRun(session.id,member.id,a.id,first.id);store.linkRun(session.id,member.id,b.id,second.id);
  const coordinator=new ExecutionCoordinator(f.state);
  const claim=coordinator.acquire({workspaceRoot:f.project,kind:"command",taskId:second.id,operationId:"op_foreign"});
  try{
    assert.equal(f.finish(a.id).executionStatus,"completed");
    assert.throws(()=>f.finish(b.id),/claims|ownership/);
    claim.release();
    assert.equal(f.finish(b.id).executionStatus,"completed");
  }finally{claim.release();coordinator.close();}
});

test("执行终态先保存，遗失的操作结束投影可在运行期修复",t=>{
  const f=fixture(t),store=new SessionStore(f.ledger.db),session=store.createSession("owner","terminal","terminal");
  const task=store.createTask(session.id,"task"),member=store.addMember(session.id,"local","ws",f.project,"checkout",null);
  const run=f.begin(`task-${task.id}-terminal`);store.linkRun(session.id,member.id,run.id,task.id);
  const op=f.ledger.operation({runId:run.id,requestKey:"intent",kind:"command",label:"already failed",status:"running"});
  store.reserveInvocation({id:"inv_terminal",ownerId:"owner",transportInstanceId:"http",requestId:"1",sessionId:session.id,
    memberId:member.id,toolName:"exec_command",argumentsJson:"{}"});
  store.updateInvocation({ownerId:"owner",transportInstanceId:"http",requestId:"1",operationId:op,
    state:"failed" as any,effect:"not_started",finished:true,responded:true});
  assert.equal(f.ledger.reconcileTerminalOperations(),1);assert.equal(f.ledger.reconcileTerminalOperations(),0);
  const row=f.ledger.db.prepare("select status,finished_at from console_operations where id=?").get(op) as any;
  assert.equal(row.status,"failed");assert.ok(row.finished_at);
  store.archiveTask(task.id,"superseded");f.ledger.reconcileArchivedTaskRuns();
  assert.equal(f.ledger.run(run.id).status,"interrupted");
});
