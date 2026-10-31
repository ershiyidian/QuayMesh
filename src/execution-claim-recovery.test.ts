import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { WorkLedger } from "./work-ledger.js";
import { ExecutionCoordinator } from "./execution-coordinator.js";
import { processOwner, processStartIdentity } from "./process-identity.js";
import { quiescenceSubject, recordExecutionQuiescence } from "./maintenance-status.js";
import { requireClaimAccess } from "./execution-claim-control.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "qm-one-claim-"));
  const project = join(root,"project"); await mkdir(project);
  const ledger = new WorkLedger(join(root,"state")), coordinator = new ExecutionCoordinator(join(root,"state"));
  t.after(async () => { coordinator.close(); ledger.close(); await rm(root,{recursive:true,force:true}); });
  const run = ledger.begin({ root:project,workItemId:"item",runKey:"run",title:"Claim recovery",
    origin:{entryPoint:"qm_cli",evidence:"server_entry"} });
  ledger.db.prepare(`INSERT INTO local_agent_sessions(id,workspace_root,profile_name,provider,status,created_at,updated_at)
    VALUES('agent',?,'fixture','codex','running',?,?)`).run(project,new Date().toISOString(),new Date().toISOString());
  const executionId = ledger.beginExecution({runId:run.id,agentId:"agent",provider:"codex"});
  const claim = coordinator.acquire({workspaceRoot:project,kind:"agent",agentId:"agent",executionId,
    scopes:[{kind:"file",path:join(project,"agent.txt"),access:"write"}]});
  return {root,project,ledger,coordinator,run,executionId,claim};
}

test("physical completion releases this attempt while preserving its unknown result and open work",{timeout:10_000},async t=>{
  const f=await fixture(t);
  f.ledger.endExecution(f.executionId,"reconciliation_required");
  const before=f.ledger.execution(f.executionId),run=f.ledger.run(f.run.id);
  f.ledger.completePhysicalExecution("execution",f.executionId,f.executionId,{version:1,boundary:"managed_agent_turn_settled"});
  assert.equal(f.ledger.db.prepare("SELECT 1 FROM execution_claims WHERE id=?").get(f.claim.id),undefined);
  assert.deepEqual(f.ledger.execution(f.executionId),before);
  assert.deepEqual(f.ledger.run(f.run.id),run);
  assert.equal(f.coordinator.admissionStatus().physicalUnknown,0);
  assert.equal(f.coordinator.admissionStatus().reconciliationPending,true);
  const next=f.coordinator.acquire({workspaceRoot:f.project,kind:"mutation",
    scopes:[{kind:"file",path:join(f.project,"agent.txt"),access:"write"}]});
  next.release();
});

test("single-claim recovery is atomic and leaves a different live command and admission untouched",{timeout:10_000},async t=>{
  const f=await fixture(t);
  const child=spawn(process.execPath,["-e","process.send('ready'); setInterval(()=>{},1000)"],
    {stdio:["ignore","ignore","ignore","ipc"]});
  const exited=once(child,"exit");
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill();await exited;}});
  await once(child,"message",{signal:AbortSignal.timeout(5000)});
  const childStart=processStartIdentity(child.pid!);assert.ok(childStart);
  const operationId=f.ledger.operation({runId:f.run.id,requestKey:"live-command",kind:"command",label:"live",status:"running"});
  const other=f.coordinator.acquire({workspaceRoot:f.project,kind:"command",operationId,
    scopes:[{kind:"file",path:join(f.project,"other.txt"),access:"write"}]});
  t.after(()=>other.release());
  f.ledger.endExecution(f.executionId,"reconciliation_required");
  const execution=f.ledger.execution(f.executionId),operation=f.ledger.db.prepare("SELECT * FROM console_operations WHERE id=?").get(operationId);
  recordExecutionQuiescence(f.ledger.db,[quiescenceSubject(f.ledger.db,"execution",f.executionId)],{
    id:"settled-turn",verifiedAt:new Date().toISOString(),evidence:{boundary:"managed_agent_turn_settled"},
  });
  f.ledger.db.exec("CREATE TRIGGER refuse_recovery BEFORE DELETE ON execution_claims BEGIN SELECT RAISE(ABORT,'fixture delete failed'); END");
  assert.throws(()=>f.ledger.recoverClaim(f.claim.id),/fixture delete failed/);
  assert.equal(f.ledger.db.prepare("SELECT count(*) FROM execution_claim_reconciliations").pluck().get(),0);
  f.ledger.db.exec("DROP TRIGGER refuse_recovery");
  assert.equal(f.ledger.recoverClaim(f.claim.id).state,"released");
  assert.equal(f.ledger.recoverClaim(f.claim.id).state,"not_found");
  assert.deepEqual(f.ledger.execution(f.executionId),execution);
  assert.deepEqual(f.ledger.db.prepare("SELECT * FROM console_operations WHERE id=?").get(operationId),operation);
  assert.ok(f.ledger.db.prepare("SELECT 1 FROM execution_claims WHERE id=?").get(other.id));
  assert.equal(processStartIdentity(child.pid!),childStart);
  assert.equal(f.coordinator.admissionStatus().accepting,true);
});

test("a later failed agent turn and a reused PID cannot release an older unresolved turn",{timeout:10_000},async t=>{
  const f=await fixture(t);
  const next=f.ledger.beginExecution({runId:f.run.id,agentId:"agent",provider:"codex"});
  f.ledger.endExecution(next,"failed");
  f.ledger.endExecution(f.executionId,"reconciliation_required");
  const previousStart=`previous:${processOwner.start}`;
  f.ledger.db.prepare("UPDATE execution_claims SET owner_process_start=? WHERE id=?").run(previousStart,f.claim.id);
  f.ledger.db.prepare("UPDATE execution_owners SET process_start=? WHERE domain='execution' AND id=?").run(previousStart,f.executionId);
  const result=f.ledger.recoverClaim(f.claim.id);
  assert.equal(result.executionId,f.executionId);
  assert.equal(result.ownerAlive,false,"the current process must not impersonate the saved PID generation");
  assert.equal(result.state,"unknown");
  assert.ok(f.ledger.db.prepare("SELECT 1 FROM execution_claims WHERE id=?").get(f.claim.id));
  assert.equal(f.ledger.execution(next).status,"failed");
  const subject=quiescenceSubject(f.ledger.db,"execution",f.executionId);
  recordExecutionQuiescence(f.ledger.db,[subject],{id:"old-turn-ended",verifiedAt:new Date().toISOString(),evidence:{boundary:"managed_agent_turn_settled"}});
  f.ledger.db.prepare("UPDATE console_executions SET boundary_reason='new evidence' WHERE id=?").run(f.executionId);
  assert.equal(f.ledger.recoverClaim(f.claim.id).state,"unknown","a changed execution invalidates its old physical receipt");
});

test("a live Core needs an explicit physical receipt even for a terminal result",{timeout:10_000},async t=>{
  for (const status of ["completed","failed","cancelled"]) {
    await t.test(status, async t=>{
      const f=await fixture(t);
      f.ledger.endExecution(f.executionId,status);
      const before=f.ledger.execution(f.executionId);
      const unconfirmed=f.ledger.recoverClaim(f.claim.id);
      assert.equal(unconfirmed.ownerAlive,true);
      assert.notEqual(unconfirmed.state,"released");
      f.ledger.completePhysicalExecution("execution",f.executionId,f.executionId,{version:1,boundary:"managed_agent_turn_settled"});
      assert.equal(f.ledger.db.prepare("SELECT 1 FROM execution_claims WHERE id=?").get(f.claim.id),undefined);
      assert.deepEqual(f.ledger.execution(f.executionId),before);
    });
  }
});

test("an old operation completion cannot release a same-id newer attempt",{timeout:10_000},async t=>{
  const f=await fixture(t);
  const operationId=f.ledger.operation({runId:f.run.id,requestKey:"first",kind:"command",label:"attempt",status:"running"});
  const claim=f.coordinator.acquire({workspaceRoot:f.project,kind:"command",operationId,
    scopes:[{kind:"file",path:join(f.project,"command.txt"),access:"write"}]});
  f.ledger.db.prepare("UPDATE console_operations SET request_key='second' WHERE id=?").run(operationId);
  f.ledger.db.prepare("UPDATE execution_owners SET generation='second' WHERE domain='operation' AND id=?").run(operationId);
  const before=f.ledger.db.prepare("SELECT * FROM console_operations WHERE id=?").get(operationId);
  assert.throws(()=>f.ledger.completePhysicalExecution("operation",operationId,"first",{boundary:"managed_process_group_empty"}),/generation/);
  assert.deepEqual(f.ledger.db.prepare("SELECT * FROM console_operations WHERE id=?").get(operationId),before);
  assert.ok(f.ledger.db.prepare("SELECT 1 FROM execution_claims WHERE id=?").get(claim.id));
  assert.equal(f.ledger.recoverClaim(claim.id).state,"unknown");
  claim.release();
});

test("claim recovery authorizes the saved Task owner, node and workspace, including legacy missing task_id",{timeout:10_000},async t=>{
  const f=await fixture(t);
  f.ledger.db.exec(`INSERT INTO qm_sessions(id,owner_id,title,created_at,last_activity_at)
    VALUES('session','owner','Task owner','2026-10-31','2026-10-31');
    INSERT INTO qm_tasks(id,session_id,title,created_at,last_activity_at)
    VALUES('task','session','Target task','2026-10-31','2026-10-31');`);
  f.ledger.db.prepare(`INSERT INTO qm_session_members(id,session_id,node_id,workspace_id,root,mode,recovery_root,first_seen_at,last_observed_at)
    VALUES('member','session','node','workspace',?,'checkout',?,'2026-10-31','2026-10-31')`).run(f.project,f.project);
  f.ledger.db.prepare("INSERT INTO qm_run_links(session_id,member_id,run_id,task_id) VALUES('session','member',?,'task')").run(f.run.id);
  const input={claimId:f.claim.id,ownerId:"owner",nodeId:"node",workspaceRoot:f.project};
  assert.equal(requireClaimAccess(f.ledger,input).taskId,"task");
  for (const changed of [{ownerId:"other"},{nodeId:"elsewhere"},{workspaceRoot:f.root}])
    assert.throws(()=>requireClaimAccess(f.ledger,{...input,...changed}),/CLAIM_SCOPE_MISMATCH/);
  assert.ok(f.ledger.db.prepare("SELECT 1 FROM execution_claims WHERE id=?").get(f.claim.id));
});
