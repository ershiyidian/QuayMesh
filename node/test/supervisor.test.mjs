import test from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { ComponentSupervisor } from "../supervisor.mjs";
import { directory, until } from "./helpers.mjs";

const worker=fileURLToPath(new URL("./worker-process.mjs",import.meta.url));
function plan(id,root,requires=[],revision="one") {
  const output=join(root,`${id}.json`);
  return {id,command:process.execPath,args:[worker,output],cwd:root,env:{...process.env,REVISION:revision},requires,
    ready:async()=>{const data=JSON.parse(await readFile(output,"utf8"));assert.ok(Date.now()-data.time<2000);}};
}

test("实际组件独立重启，重启一个组件保留另一个进程",async t=>{
  const root=await directory(t);
  const manager=new ComponentSupervisor({logDir:join(root,"logs"),intervalMs:40,shutdownMs:1000});
  // 先结束受管子进程，再让 directory 的删除钩子运行，避免 Windows 目录被占用。
  t.after(async()=>{await manager.close();});manager.define([plan("mesh",root),plan("core",root,["mesh"])]);
  await manager.start();
  const before=await until(()=>manager.snapshot(),state=>state.every(component=>component.state==="ready"));
  const mesh=before.find(c=>c.id==="mesh").pid;const core=before.find(c=>c.id==="core").pid;
  process.kill(core,"SIGTERM");
  const after=await until(()=>manager.snapshot(),state=>state.find(c=>c.id==="core").state==="ready"&&state.find(c=>c.id==="core").pid!==core);
  assert.equal(after.find(c=>c.id==="mesh").pid,mesh);
  assert.ok(after.find(c=>c.id==="core").restarts>=1);
  const pids=after.map(c=>c.pid);await manager.close();
  for(const pid of pids)assert.throws(()=>process.kill(pid,0),{code:"ESRCH"});
});

test("组件配置更新只重启变化的依赖分支",async t=>{
  const root=await directory(t);
  const manager=new ComponentSupervisor({logDir:join(root,"logs"),intervalMs:40,shutdownMs:1000});
  // 先结束受管子进程，再让 directory 的删除钩子运行，避免 Windows 目录被占用。
  t.after(async()=>{await manager.close();});
  manager.define([plan("mesh",root),plan("core",root,["mesh"]),plan("discovery",root,["core"])]);
  await manager.start();
  const before=await until(()=>manager.snapshot(),state=>state.every(c=>c.state==="ready"));
  await manager.replacePlans([plan("mesh",root),plan("core",root,["mesh"],"two"),plan("discovery",root,["core"])]);
  const after=await until(()=>manager.snapshot(),state=>state.every(c=>c.state==="ready"));
  assert.equal(after.find(c=>c.id==="mesh").pid,before.find(c=>c.id==="mesh").pid);
  assert.notEqual(after.find(c=>c.id==="core").pid,before.find(c=>c.id==="core").pid);
  assert.notEqual(after.find(c=>c.id==="discovery").pid,before.find(c=>c.id==="discovery").pid);
  await manager.close();
});

test("找不到真实程序时记录失败并退避，依赖组件保持等待",async t=>{
  const root=await directory(t);const manager=new ComponentSupervisor({logDir:join(root,"logs"),intervalMs:40,shutdownMs:500});
  // 先结束受管子进程，再让 directory 的删除钩子运行，避免 Windows 目录被占用。
  t.after(async()=>{await manager.close();});
  manager.define([{id:"mesh",command:join(root,"missing-program"),args:[],env:process.env,requires:[]},plan("core",root,["mesh"])]);
  await manager.start();
  const result=await until(()=>manager.snapshot(),state=>state.find(c=>c.id==="mesh").state==="backoff");
  assert.equal(result.find(c=>c.id==="core").pid,null);
  assert.match(result.find(c=>c.id==="mesh").error,/ENOENT/);
  await manager.close();
});

