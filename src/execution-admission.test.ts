import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecutionCoordinator } from "./execution-coordinator.js";
import { WorkLedger } from "./work-ledger.js";

test("仅排队的工作记录不阻挡维护，实际开始的工作继续阻挡", async t => {
  const root = await mkdtemp(join(tmpdir(),"quaymesh-admission-queued-"));
  const coordinator = new ExecutionCoordinator(join(root,"state"));
  const ledger = new WorkLedger(join(root,"state"));
  t.after(async () => { ledger.close(); coordinator.close(); await rm(root,{recursive:true,force:true}); });
  const run = ledger.begin({root,workItemId:"maintenance-test",runKey:"one",title:"维护排队检查",
    origin:{entryPoint:"qm_cli",evidence:"server_entry"}});
  const queued = ledger.operation({runId:run.id,requestKey:"queued",kind:"command",label:"等待资源",status:"queued"});
  coordinator.pause("维护检查");
  assert.equal(coordinator.admissionStatus().queuedOperations,1);
  assert.equal(coordinator.admissionStatus().idle,true);
  coordinator.resume();
  const active = ledger.operation({runId:run.id,requestKey:"running",kind:"command",label:"执行准备",status:"starting"});
  assert.equal(coordinator.admissionStatus().idle,false);
  ledger.endOperation(active,"completed");
  assert.equal(coordinator.admissionStatus().idle,true);
  ledger.endOperation(queued,"completed");
});

test("共享数据库的接收控制同时限制工具、传输和出口，已接受工作可以完成",async t=>{
  const root=await mkdtemp(join(tmpdir(),"quaymesh-admission-"));
  const a=new ExecutionCoordinator(join(root,"state"));
  const b=new ExecutionCoordinator(join(root,"state"));
  t.after(()=>{a.close();b.close();return rm(root,{recursive:true,force:true});});
  const accepted=a.beginWork({kind:"tool"});
  b.pause("test maintenance");
  for(const kind of ["tool","transfer","egress"] as const)assert.throws(()=>b.beginWork({kind}),/维护|test maintenance|暂停|admission/i);
  await accepted.run(async()=>{
    const nested=b.beginWork({kind:"transfer"});
    assert.equal(b.admissionStatus().activeWork,2);
    nested.release();
  });
  const observation=b.beginWork({kind:"tool",allowWhilePaused:true});
  assert.equal(b.admissionStatus().idle,false);
  accepted.release();
  assert.equal(b.admissionStatus().idle,true);
  observation.release();b.resume();
  const transfer=b.beginWork({kind:"transfer"});
  assert.equal(a.admissionStatus().work.find(value=>value.kind==="transfer")?.count,1);
  transfer.release();assert.equal(a.admissionStatus().idle,true);
});
test("重启只清除服务退出暂停，维护暂停保持", async t => {
  const root = await mkdtemp(join(tmpdir(), "quaymesh-admission-restart-"));
  const first = new ExecutionCoordinator(join(root, "state"));
  first.pause("服务正在退出");
  first.close();
  const restarted = new ExecutionCoordinator(join(root, "state"));
  assert.equal(restarted.resumeAfterRestart(), true);
  assert.equal(restarted.admissionStatus().accepting, true);
  assert.equal(restarted.admissionStatus().reason, null);

  restarted.pause("服务准备停止");
  restarted.close();
  const stoppedBeforeShutdown = new ExecutionCoordinator(join(root, "state"));
  assert.equal(stoppedBeforeShutdown.resumeAfterRestart(), true);
  assert.equal(stoppedBeforeShutdown.admissionStatus().accepting, true);
  stoppedBeforeShutdown.close();

  const maintenance = new ExecutionCoordinator(join(root, "state"));
  maintenance.pause("维护操作");
  maintenance.close();
  const maintained = new ExecutionCoordinator(join(root, "state"));
  assert.equal(maintained.resumeAfterRestart(), false);
  assert.equal(maintained.admissionStatus().accepting, false);
  assert.equal(maintained.admissionStatus().reason, "维护操作");
  maintained.close();
  await rm(root, { recursive: true, force: true });
});



test("长期出口连接不冒充任务，维护仍等待真实工作并拒绝新出口",async t=>{
  const root=await mkdtemp(join(tmpdir(),"quaymesh-egress-admission-"));
  const coordinator=new ExecutionCoordinator(join(root,"state"));
  t.after(()=>{coordinator.close();return rm(root,{recursive:true,force:true});});
  const channel=coordinator.beginWork({kind:"egress",blocking:false});
  assert.equal(coordinator.admissionStatus().idle,true);
  const job=coordinator.beginWork({kind:"tool"});
  coordinator.pause("release cutover");
  assert.equal(coordinator.admissionStatus().idle,false);
  assert.throws(()=>coordinator.beginWork({kind:"egress",blocking:false}),/release cutover/);
  job.release();assert.equal(coordinator.admissionStatus().idle,true);
  channel.release();coordinator.resume();
});
