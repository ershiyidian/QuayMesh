import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ExecutionCoordinator, ExecutionConflictError } from "./execution-coordinator.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { canonicalResourcePath, type ExecutionResource } from "./execution-resources.js";
import { requireCommandScope } from "./command-profiles.js";

const execFileAsync=promisify(execFile);
const file=(path:string,access:"read"|"write"="write"):ExecutionResource=>({kind:"file",path,access});
const tree=(path:string,access:"read"|"write"="write"):ExecutionResource=>({kind:"tree",path,access});
async function fixture(t:test.TestContext){
  const root=await mkdtemp(join(tmpdir(),"quaymesh-resources-"));
  const project=join(root,"code"),logs=join(root,"logs"),state=join(root,"state");
  await mkdir(project);await mkdir(logs);
  await execFileAsync("git",["init",project]);
  await writeFile(join(project,"one.txt"),"original\n");await writeFile(join(project,"two.txt"),"second\n");
  const a=new ExecutionCoordinator(state),b=new ExecutionCoordinator(state);
  t.after(async()=>{a.close();b.close();await rm(root,{recursive:true,force:true});});
  return {root,project,logs,state,a,b};
}

test("父目录中的监控只占用输出目录，同一机器的源码写入不受阻挡",async t=>{
  const f=await fixture(t);
  const monitor=f.a.acquire({workspaceRoot:f.root,kind:"command",operationId:"monitor-operation",taskId:"monitor-task",
    title:"系统指标监控",scopes:[tree(f.logs)]});
  const edit=f.b.acquire({workspaceRoot:f.project,kind:"mutation",scopes:[file(join(f.project,"one.txt"))]});
  await writeFile(join(f.project,"one.txt"),"changed while monitor is active\n");
  assert.equal(f.a.admissionStatus().idle,false);
  edit.release();assert.equal(f.a.inspect(f.root).some(value=>value.operationId==="monitor-operation"),true);
  monitor.release();assert.equal(f.a.admissionStatus().idle,true);
});

test("相同文件写入串行，不同文件并行，读取目录与删除父目录正确冲突",async t=>{
  const f=await fixture(t),path=join(f.project,"one.txt");
  const first=f.a.acquire({workspaceRoot:f.project,kind:"mutation",operationId:"op-one",taskId:"task-one",title:"修改第一份文件",scopes:[file(path)]});
  const second=f.b.acquire({workspaceRoot:f.project,kind:"mutation",scopes:[file(join(f.project,"two.txt"))]});
  assert.throws(()=>f.b.acquire({workspaceRoot:f.project,kind:"mutation",scopes:[file(path)]}),error=>{
    assert.ok(error instanceof ExecutionConflictError);
    assert.equal(error.details?.type,"resource");assert.equal(error.details?.operationId,"op-one");
    assert.equal(error.details?.title,"修改第一份文件");assert.deepEqual(error.details?.blockedResources,[file(canonicalResourcePath(path))]);return true;
  });
  assert.throws(()=>f.b.acquire({workspaceRoot:f.root,kind:"mutation",scopes:[tree(f.root)]}),ExecutionConflictError);
  first.release();second.release();
  const reader=f.a.acquire({workspaceRoot:f.project,kind:"read",scopes:[file(path,"read")]});
  const other=f.b.acquire({workspaceRoot:f.project,kind:"read",scopes:[file(path,"read")]});
  assert.throws(()=>f.a.acquire({workspaceRoot:f.root,kind:"mutation",scopes:[tree(f.root)]}),ExecutionConflictError);
  other.release();reader.release();
});

test("观察读取在源码写入和维护期间仍可用，需要稳定输入的读取继续排队",async t=>{
  const f=await fixture(t),manager=new ProcessSessionManager({stateDir:f.state});
  try {
  const writer=f.a.acquire({workspaceRoot:f.project,kind:"command"});
  assert.equal(await manager.readWorkspace(f.project,()=>readFile(join(f.project,"one.txt"),"utf8")),"original\n");
  assert.throws(()=>f.b.acquire({workspaceRoot:f.project,kind:"read",scopes:[tree(f.project,"read")]}),ExecutionConflictError);
  f.a.pause();
  assert.equal(await manager.readWorkspace(f.project,()=>readFile(join(f.project,"one.txt"),"utf8")),"original\n");
  writer.release();f.a.resume();
  } finally { await manager.shutdown(); }
});

test("操作内嵌套请求仅复用已持有的包含范围，不能借用同一会话扩大占用",async t=>{
  const f=await fixture(t),folder=join(f.project,"src");await mkdir(folder);
  const owner=f.a.acquire({workspaceRoot:f.project,kind:"mutation",operationId:"operation",scopes:[tree(folder)]});
  const nested=f.a.acquire({workspaceRoot:f.project,kind:"read",operationId:"operation",scopes:[file(join(folder,"future.ts"),"read")]});
  assert.equal(nested.id,owner.id);nested.release();
  assert.equal(f.a.ownsWriteClaim(owner.id,join(folder,"future.ts"),"operation"),true);
  assert.equal(f.a.ownsWriteClaim(owner.id,join(f.project,"one.txt"),"operation"),false);
  assert.equal(f.a.ownsWriteClaim(owner.id,join(folder,"future.ts"),"different-operation"),false);
  assert.throws(()=>f.a.acquire({workspaceRoot:f.root,kind:"mutation",operationId:"operation",scopes:[tree(f.root)]}),ExecutionConflictError);
  assert.equal(f.a.inspect(f.project).length,1);owner.release();
});

test("多资源申请原子完成，排队只影响冲突范围且维护保留已受理请求直到完成或取消",async t=>{
  const f=await fixture(t),one=join(f.project,"one.txt"),two=join(f.project,"two.txt");
  const writer=f.a.acquire({workspaceRoot:f.project,kind:"mutation",scopes:[file(one)]});
  assert.throws(()=>f.b.acquire({workspaceRoot:f.project,kind:"mutation",scopes:[file(two),file(one)]}),ExecutionConflictError);
  const independent=f.b.acquire({workspaceRoot:f.project,kind:"mutation",scopes:[file(two)]});independent.release();
  const queued=f.b.enqueue({workspaceRoot:f.project,kind:"mutation",scopes:[file(one)]},5000);
  assert.equal(queued.tryAcquire(),undefined);
  f.a.acquire({workspaceRoot:f.project,kind:"mutation",scopes:[file(two)]}).release();
  assert.throws(()=>f.a.acquire({workspaceRoot:f.project,kind:"read",scopes:[file(one,"read")]}),ExecutionConflictError);
  writer.release();f.a.pause();
  const paused=f.a.admissionStatus();
  assert.equal(paused.claims,0);assert.equal(paused.activeWork,0);
  assert.equal(paused.waiting,1);assert.equal(paused.idle,false,"accepted queue entries still protect work from maintenance restart");
  assert.throws(()=>queued.tryAcquire(),/暂不接受/);f.a.resume();
  const granted=queued.tryAcquire();assert.ok(granted);
  assert.equal(f.a.admissionStatus().waiting,0);assert.equal(f.a.admissionStatus().claims,1);
  assert.equal(f.a.admissionStatus().idle,false);granted.release();
  assert.equal(f.a.admissionStatus().idle,true);
  const cancelled=f.b.enqueue({workspaceRoot:f.project,kind:"mutation",scopes:[file(one)]},5000);
  f.a.pause();assert.equal(f.a.admissionStatus().idle,false);
  cancelled.cancel();assert.equal(f.a.admissionStatus().waiting,0);assert.equal(f.a.admissionStatus().idle,true);
});

test("聚合目录自动声明父树范围，Git工作树与显式子范围仍保持独立",async t=>{
  const f=await fixture(t);
  assert.equal(await requireCommandScope(f.root),canonicalResourcePath(f.root));
  assert.equal(await requireCommandScope(f.project),canonicalResourcePath(f.project));
  const nested=join(f.project,"nested");
  await mkdir(nested);
  assert.equal(await requireCommandScope(nested),canonicalResourcePath(f.project));
  assert.equal(await requireCommandScope(f.root,f.project),canonicalResourcePath(f.project));
  const parent=f.a.acquire({workspaceRoot:f.root,kind:"command",
    scopes:[tree(await requireCommandScope(f.root))]});
  assert.throws(()=>f.b.acquire({workspaceRoot:f.project,kind:"mutation",
    scopes:[file(join(f.project,"one.txt"))]}),ExecutionConflictError);
  parent.release();
  const scoped=f.a.acquire({workspaceRoot:f.root,kind:"command",
    scopes:[tree(await requireCommandScope(f.root,f.project))]});
  const sibling=f.b.acquire({workspaceRoot:f.logs,kind:"command",scopes:[tree(f.logs)]});
  sibling.release();scoped.release();
  await execFileAsync("git",["-C",f.project,"-c","user.name=QuayMesh Test","-c","user.email=test@example.invalid","add","."]);
  await execFileAsync("git",["-C",f.project,"-c","user.name=QuayMesh Test","-c","user.email=test@example.invalid","commit","-m","files"]);
  const other=join(f.root,"other-worktree");await execFileAsync("git",["-C",f.project,"worktree","add","--detach",other]);
  const one=f.a.acquire({workspaceRoot:f.project,kind:"command"}),two=f.b.acquire({workspaceRoot:other,kind:"command"});
  assert.equal(await requireCommandScope(other),canonicalResourcePath(other));two.release();one.release();
  const shared:ExecutionResource={kind:"named",key:"build:shared-dependencies",access:"write"};
  const first=f.a.acquire({workspaceRoot:f.project,kind:"command",scopes:[shared]});
  assert.throws(()=>f.b.acquire({workspaceRoot:other,kind:"command",scopes:[shared]}),ExecutionConflictError);first.release();
  await execFileAsync("git",["-C",f.project,"worktree","remove",other]);
});
