import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdtemp, mkdir, open, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installationStartupBudget, QuayMeshNode } from "../app.mjs";
import { waitRunning } from "../install.mjs";
import { cluster, nodeConfig, token, freePort } from "./helpers.mjs";

const commit="a".repeat(40),previousCommit="b".repeat(40);
async function fixture(t,bytes=8*1024*1024){
  const root=await mkdtemp(join(tmpdir(),"quaymesh-startup-budget-")),close=[];
  t.after(async()=>{try{for(const stop of close.reverse())await stop();}finally{await rm(root,{recursive:true,force:true});}});
  await mkdir(join(root,"dist","db"),{recursive:true});
  await writeFile(join(root,"package.json"),JSON.stringify({type:"module",version:"0.1.0"}));
  await writeFile(join(root,"release.json"),JSON.stringify({sourceCommit:commit}));
  await writeFile(join(root,"dist","db","migrations.js"),"export const LATEST_DATABASE_VERSION=16;\n");
  const backup=join(root,"rollback.sqlite"),file=await open(backup,"wx");
  try{await file.truncate(bytes);}finally{await file.close();}
  const transition={id:"reviewed-upgrade",sourceCommit:commit,previousCommit,ownerPid:process.pid,
    phase:"validating",database:{exists:true,version:9,backup}};
  return {root,close,transition,marker:join(root,"installation-transition.json")};
}

test("升级启动只从匹配结构升级的实际快照大小派生有界预算",async t=>{
  const f=await fixture(t);
  f.transition.coreReadinessMs=Number.MAX_SAFE_INTEGER;
  f.transition.database.bytes=Number.MAX_SAFE_INTEGER;
  const before=structuredClone(f.transition);
  const budget=await installationStartupBudget(f.root,f.transition,commit);
  assert.equal(budget.databaseBytes,8*1024*1024);
  assert.equal(budget.coreReadinessMs,32000);
  assert.equal(budget.validationTimeoutMs,budget.coreReadinessMs+60000+30000,
    "外层必须覆盖完整 Core 等待、60 秒稳定窗口和服务余量");
  assert.equal(budget.fromVersion,9);assert.equal(budget.toVersion,16);
  assert.deepEqual(f.transition,before,"预算观察不能修改切换或备份回执");
  const capped=await installationStartupBudget(f.root,f.transition,commit,1799000);
  assert.equal(capped.coreReadinessMs,1800000);
  assert.equal(new QuayMeshNode({revision:1,node:{stateDir:f.root,corePort:1}}).readinessMs,30000);
});

test("普通启动、错发行、同结构重装、降级及恢复不扩大原 30 秒预算",async t=>{
  const f=await fixture(t);
  const unchanged=[undefined,
    {...f.transition,sourceCommit:"c".repeat(40)},
    {...f.transition,previousCommit:commit},
    {...f.transition,previousCommit:null},
    {...f.transition,phase:"recovery_required"},
    {...f.transition,ownerPid:0},
    {...f.transition,database:{...f.transition.database,exists:false}},
    ...[16,17].map(version=>({...f.transition,database:{exists:true,version,backup:join(f.root,"missing.sqlite")}})),
  ];
  for(const transition of unchanged)assert.deepEqual(await installationStartupBudget(f.root,transition,commit),{coreReadinessMs:30000});
  await assert.rejects(installationStartupBudget(f.root,{...f.transition,database:{...f.transition.database,backup:f.root}},commit),/快照文件/);
  await assert.rejects(installationStartupBudget(f.root,{...f.transition,database:{...f.transition.database,backup:join(f.root,"missing.sqlite")}},commit),{code:"ENOENT"});
});

async function managedProcess(t,upgrading){
  const f=await fixture(t);
  if(upgrading)await writeFile(f.marker,JSON.stringify(f.transition));
  const script=join(f.root,"core-fixture.mjs"),launched=join(f.root,"launched.json"),ready=join(f.root,"ready.json");
  await writeFile(script,`import {writeFileSync} from 'node:fs';
writeFileSync(process.argv[2],JSON.stringify({pid:process.pid}));
setTimeout(()=>writeFileSync(process.argv[3],JSON.stringify({pid:process.pid})),700);
setInterval(()=>{},1000);process.on('SIGTERM',()=>process.exit(0));\n`);
  const configuration={revision:1,node:nodeConfig(f.root),cluster:cluster({coordinator:{id:"cloud",address:"127.0.0.1",apiPort:1}})};
  const node=new QuayMeshNode(configuration,{root:f.root,intervalMs:20,readinessMs:150});
  // The actual manager/supervisor owns a real delayed process. Only its test
  // plan and unused admin listener differ from a packaged Core startup.
  node.prepare=async(configuration,revision)=>({configuration,revision,token:token(),plans:[{
    id:"core",command:process.execPath,args:[script,launched,ready],env:process.env,requires:[],
    ready:async child=>assert.equal(JSON.parse(await readFile(ready,"utf8")).pid,child.pid),
  }]});
  node.startAdmin=async()=>{};
  f.close.push(()=>node.close());
  return {...f,node,launched};
}

test("实际 manager 仅在升级时让同一个 Core 跨过普通启动时限完成",async t=>{
  const f=await managedProcess(t,true),started=performance.now();
  await f.node.start();
  const core=f.node.supervisor.snapshot()[0];
  assert.ok(performance.now()-started>=650);
  assert.equal(core.state,"ready");assert.equal(core.restarts,0);
  assert.equal(core.pid,JSON.parse(await readFile(f.launched,"utf8")).pid);
  assert.equal(f.node.maintenance,true,"延长启动不能恢复准入");
  assert.equal(f.node.status().startupReadiness.coreReadinessMs,2150);
});

test("普通 manager 仍按原预算停止并等待未就绪的真实子进程",async t=>{
  const f=await managedProcess(t,false);
  await assert.rejects(f.node.start(),/150 ms 就绪预算/);
  assert.equal(f.node.stopped,true);
  assert.equal(f.node.supervisor.snapshot()[0].pid,null,"失败返回前必须完成原有子进程清理");
  assert.equal(f.node.status().startupReadiness.coreReadinessMs,150);
});

test("真实管理 HTTP 验证覆盖升级延迟与稳定窗口，恢复标记不能扩展期限",async t=>{
  const f=await fixture(t,4096);await writeFile(f.marker,JSON.stringify(f.transition));
  let polls=0,resumed=0;
  const server=http.createServer((req,res)=>{
    res.setHeader("content-type","application/json");
    if(req.url==="/maintenance/resume"){resumed++;res.end("{}");return;}
    polls++;
    res.end(JSON.stringify({nodeId:"fixture",release:commit,components:[{
      id:"core",state:polls<3?"starting":"ready",processState:"running",pid:101,restarts:0,startedAt:1,observedAt:Date.now(),
    }]}));
  });
  const port=await freePort();await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(port,"127.0.0.1",resolve);});
  f.close.push(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const manifest={nodeId:"fixture",sourceCommit:commit,adminPort:port,directory:f.root,stateDir:f.root};
  const started=performance.now();
  const state=await waitRunning(manifest,"fixture-secret",50,{stableMs:1000,resume:false});
  assert.equal(state.components[0].pid,101);assert.ok(polls>=5);assert.ok(performance.now()-started>=1900);
  assert.equal(resumed,0,"完整就绪验证自身不能提前恢复准入");
  await writeFile(f.marker,JSON.stringify({...f.transition,phase:"recovery_required"}));
  await assert.rejects(waitRunning(manifest,"fixture-secret",50,{stableMs:1000,resume:false}),/50 ms.*稳定 1000 ms/);
  assert.equal(resumed,0);
});
