import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { ProcessSessionManager } from "./process-sessions.js";

test("真实命令退出后物理查询unknown时保留claim，SIGINT和terminate不伪造物理终态",{timeout:15000},async t=>{
  const root=await mkdtemp(join(tmpdir(),"qm-physical-unknown-"));await mkdir(join(root,".git"));
  const manager=new ProcessSessionManager({stateDir:join(root,"state"),stdioDrainTimeoutMs:30});
  // Fault only the OS observation boundary; the command, claim and SQLite are real.
  const internals=manager as unknown as {ownedProcessesAlive:(session:unknown)=>boolean|null};
  const observe=internals.ownedProcessesAlive;
  internals.ownedProcessesAlive=()=>null;
  t.after(async()=>{internals.ownedProcessesAlive=observe;await manager.shutdown();await rm(root,{recursive:true,force:true});});
  const started=await manager.start({workspaceId:"workspace",cwd:root,workspaceRoot:root,
    command:`"${process.execPath}" -e "console.log('real-root-exited')"`,yieldTimeMs:250});
  await delay(100);
  const uncertain=await manager.write({workspaceId:"workspace",sessionId:started.sessionId!,chars:"",yieldTimeMs:100});
  assert.equal(uncertain.running,true);assert.equal(uncertain.disposition,"reconciliation_required");
  assert.match(uncertain.recoverableDescription??"",/could not be verified/);
  await manager.write({workspaceId:"workspace",sessionId:started.sessionId!,chars:"\u0003",yieldTimeMs:20});
  manager.terminate("workspace",started.sessionId!);
  assert.equal(manager.executionCoordinator!.admissionStatus().claims,1);
  assert.equal(manager.executionCoordinator!.admissionStatus().quiescent,false);
  internals.ownedProcessesAlive=observe;
  let settled=uncertain;
  for(let index=0;index<30&&settled.running;index++)settled=await manager.write({workspaceId:"workspace",sessionId:started.sessionId!,chars:"",yieldTimeMs:100});
  assert.equal(settled.running,false);
  assert.equal(manager.executionCoordinator!.admissionStatus().claims,0);
});
