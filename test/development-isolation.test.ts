import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { seedDevState } from "../scripts/dev-state.js";
import { openDatabase } from "../src/db/client.js";

test("开发初始化只创建当前检出的身份与数据库，重置拒绝仍在运行的开发入口", async t => {
  const root=await mkdtemp(join(tmpdir(),"quaymesh-development-test-"));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await seedDevState({checkoutRoot:root});
  const path=join(root,".quaymesh-dev");
  const config=JSON.parse(await readFile(join(path,"config","config.jsonc"),"utf8"));
  assert.equal(config.server.host,"127.0.0.1");
  assert.notEqual(config.server.port,7676);
  assert.equal(config.federation.enabled,false);
  assert.equal(config.subagents.enabled,false);
  assert.deepEqual(config.workspaces.allowedRoots,[join(path,"workspace")]);
  const first=await readFile(join(path,"config","auth.json"),"utf8");
  const db=openDatabase(join(path,"state"));
  assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS count FROM qm_tasks").get() as {count:number}).count,0);
  db.close();
  const server=createServer();
  await new Promise<void>(resolve=>server.listen(config.server.port,"127.0.0.1",resolve));
  try { await assert.rejects(seedDevState({checkoutRoot:root,reset:true}),/仍在监听/); }
  finally { await new Promise<void>(resolve=>server.close(()=>resolve())); }
  await seedDevState({checkoutRoot:root,reset:true});
  assert.notEqual(await readFile(join(path,"config","auth.json"),"utf8"),first);
});

test("开发重置不会替换没有当前检出标识的目录",async t=>{
  const root=await mkdtemp(join(tmpdir(),"quaymesh-development-owner-"));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const path=join(root,".quaymesh-dev");await mkdir(path);
  await writeFile(join(path,"development.json"),JSON.stringify({scope:"user-data",checkout:root,port:1}));
  await writeFile(join(path,"preserve.txt"),"actual existing content");
  await assert.rejects(seedDevState({checkoutRoot:root,reset:true}),/没有匹配/);
  assert.equal(await readFile(join(path,"preserve.txt"),"utf8"),"actual existing content");
});
