import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beginInstallationMaintenance } from "../maintenance-lease.mjs";
import { activateInstallation } from "../install.mjs";
import { QuayMeshNode } from "../app.mjs";
import { ComponentSupervisor } from "../supervisor.mjs";
import { requestJson } from "../network.mjs";
import { directory, freePort } from "./helpers.mjs";

const token="maintenance-http-fixture-secret";
const freshCensus=()=>({digest:"c".repeat(64),observedAt:new Date().toISOString()});
const zeroActivity={claims:0,waiting:0,operations:0,executions:0,queuedOperations:0,queuedExecutions:0,
  activeWork:0,allRuntimeWork:0,persistedRuntimeWork:0};

async function serve(t,handle){
  const server=http.createServer((req,res)=>{
    void (async()=>{let body="";for await(const chunk of req)body+=chunk;
      const result=await handle(req,body?JSON.parse(body):{});
      res.writeHead(result.status??200,{"content-type":"application/json"}).end(JSON.stringify(result.body??{}));
    })().catch(error=>res.writeHead(500).end(JSON.stringify({error:String(error)})));
  });
  await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",()=>{server.off("error",reject);resolve();});});
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  return server.address().port;
}

async function leaseFixture(t,claims=[]){
  const root=await directory(t),requests=[];
  const subject={domain:"operation",id:"legacy",generation:"old-attempt",fingerprint:"f".repeat(64)};
  const state={admission:{...zeroActivity,claims:claims.length,accepting:true,reason:null,changedAt:"2026-10-23T00:00:00.000Z"},
    subjects:[subject],claims:structuredClone(claims),processes:[{pid:1001,start:"manager-generation",alive:true},{pid:1002,start:"core-generation",alive:true}]};
  const running={nodeId:"fixture",release:"old-commit",components:[{id:"core",pid:1002,startedAt:1,restarts:0}]};
  const port=await serve(t,(req,body)=>{
    requests.push({path:req.url,body});
    if(req.url==="/healthz")return {body:{pid:1001}};
    if(req.url==="/status")return {body:running};
    assert.equal(req.headers.authorization,`Bearer ${token}`);
    if(req.url==="/internal/quaymesh/idle")return {body:state.admission};
    if(req.url==="/internal/quaymesh/admission"){
      state.admission={...state.admission,accepting:body.action==="resume",reason:body.action==="resume"?null:body.reason,
        changedAt:new Date().toISOString()};return {body:state.admission};
    }
    return {status:409,body:{error:"legacy unresolved effects"}};
  });
  const manifest={version:1,nodeId:"fixture",stateDir:root,config:join(root,"node.json"),sourceCommit:"target-commit"};
  const manifestFile=join(root,"prepared.json");await writeFile(manifestFile,JSON.stringify(manifest));
  let released=0;
  const provider={
    async acquire(context){
      const pause=await requestJson(`http://127.0.0.1:${port}/internal/quaymesh/admission`,{
        method:"POST",token,body:{action:"pause",reason:`release-preflight:${context.attemptId}`}});
      // The same identity with Python sort_keys ordering and harmless extras
      // must remain valid; object serialization order is not an identity.
      return {version:1,attemptId:context.attemptId,pause:{reason:pause.reason,changedAt:pause.changedAt},
        census:freshCensus(),subjects:[{fingerprint:subject.fingerprint,generation:subject.generation,id:subject.id,domain:subject.domain,note:"reviewed"}],
        ...(claims.length?{claims:structuredClone(claims)}:{})};
    },
    async assertHeld(){return {census:freshCensus()};},
    async release(){released++;await requestJson(`http://127.0.0.1:${port}/internal/quaymesh/admission`,{
      method:"POST",token,body:{action:"resume"}});},
  };
  const options={provider,manifest,manifestFile,previous:{adminPort:port,sourceCommit:"old-commit"},running,token,corePort:port,
    proof:async()=>structuredClone(state)};
  return {root,state,running,requests,provider,options,released:()=>released};
}

test("默认维护仍使用真实begin HTTP，409不降级或伪装成功",async t=>{
  let reject=false,calls=0;
  const port=await serve(t,req=>{assert.equal(req.url,"/maintenance/begin");assert.equal(req.method,"POST");
    assert.equal(req.headers.authorization,`Bearer ${token}`);calls++;return reject?{status:409,body:{error:"busy"}}:{body:{paused:true}};});
  assert.equal(await beginInstallationMaintenance({previous:{adminPort:port},token}),null);
  reject=true;await assert.rejects(beginInstallationMaintenance({previous:{adminPort:port},token}),error=>error.status===409);
  assert.equal(calls,2);
});

test("显式lease使用独有暂停并验证各阶段，不启动旧begin的30秒恢复计时器",async t=>{
  const fixture=await leaseFixture(t),lease=await beginInstallationMaintenance(fixture.options);
  for(const stage of ["before_backup","after_backup","before_stop"])await lease.assertHeld(stage);
  fixture.state.processes=fixture.state.processes.map(value=>({...value,alive:false,start:null}));
  fixture.state.admission.reason="服务正在退出";
  await lease.assertHeld("after_stop");
  assert.deepEqual(lease.receipt.stages.map(value=>value.stage),["before_backup","after_backup","before_stop","after_stop"]);
  assert.equal(fixture.requests.some(value=>value.path==="/maintenance/begin"),false);
  await lease.release({outcome:"aborted-before-stop",transition:null,activeStatus:fixture.running});
  assert.equal(fixture.released(),1);assert.equal(lease.receipt.phase,"released");
});

test("备份后暂停归属、进程代次或原始runtime工作变化均在stop前拒绝",async t=>{
  const fixture=await leaseFixture(t),lease=await beginInstallationMaintenance(fixture.options);
  await lease.assertHeld("before_backup");
  fixture.state.admission.changedAt="2026-10-24T00:00:00.000Z";
  await assert.rejects(lease.assertHeld("after_backup"),/ownership changed/);
  fixture.state.admission.changedAt=lease.lease.pause.changedAt;
  fixture.state.processes[1].start="reused-pid-generation";
  await assert.rejects(lease.assertHeld("after_backup"),/generation changed/);
  fixture.state.processes[1].start="core-generation";
  fixture.state.admission.persistedRuntimeWork=1;
  await assert.rejects(lease.assertHeld("before_stop"),/Maintenance state changed/);
  fixture.state.admission.persistedRuntimeWork=0;
  fixture.provider.assertHeld=async()=>({census:{digest:"c".repeat(64),observedAt:"2026-01-01T00:00:00Z"}});
  await assert.rejects(lease.assertHeld("before_stop"),/missing or stale/);
  await lease.release({outcome:"aborted-before-stop",transition:null,activeStatus:fixture.running});
});

const oldClaim={id:"old-claim",operationId:"legacy",ownerId:"old-coordinator",ownerPid:900,
  processStart:"old-process-start",generation:"old-attempt",fingerprint:"a".repeat(64)};

test("显式review的完整command claim集合贯穿四阶段，原始claim计数始终保留",async t=>{
  const fixture=await leaseFixture(t,[oldClaim]),acquire=fixture.provider.acquire;
  fixture.provider.acquire=async context=>({...await acquire(context),claims:[{
    fingerprint:oldClaim.fingerprint,generation:oldClaim.generation,processStart:oldClaim.processStart,
    ownerPid:oldClaim.ownerPid,ownerId:oldClaim.ownerId,operationId:oldClaim.operationId,id:oldClaim.id,note:"reviewed physical domain",
  }]});
  const lease=await beginInstallationMaintenance(fixture.options);
  for(const stage of ["before_backup","after_backup","before_stop"]){
    await lease.assertHeld(stage);assert.equal(fixture.state.admission.claims,1);
  }
  fixture.state.processes=fixture.state.processes.map(value=>({...value,alive:false,start:null}));
  fixture.state.admission.reason="service stopping";
  await lease.assertHeld("after_stop");
  assert.equal(fixture.state.admission.claims,1,"the lease never deletes or discounts the saved claim");
  assert.deepEqual(fixture.state.claims,[oldClaim]);
  const saved=JSON.parse(await readFile(lease.context.receiptFile,"utf8"));
  assert.equal(saved.lease.claims[0].fingerprint,oldClaim.fingerprint);assert.equal(saved.stages.length,4);
  await lease.release({outcome:"aborted-before-stop",transition:null,activeStatus:fixture.running});
});

test("未显式声明、非完整候选集合或operation代次不匹配的claim拒绝acquire",async t=>{
  for(const mode of ["not-opted-in","unsupported","wrong-generation"]){
    const fixture=await leaseFixture(t,[oldClaim]),acquire=fixture.provider.acquire;
    if(mode==="unsupported")fixture.state.claims=[];
    fixture.provider.acquire=async context=>{
      const value=await acquire(context);
      if(mode==="not-opted-in")delete value.claims;
      if(mode==="wrong-generation"){
        value.claims[0].generation="another-attempt";
        fixture.state.claims[0].generation="another-attempt";
      }
      return value;
    };
    await assert.rejects(beginInstallationMaintenance(fixture.options),error=>
      /acquisition is unconfirmed/.test(error.message)&&/complete command claim set/.test(error.cause?.message));
    assert.equal(fixture.released(),1,"only the owned pause is compensated; claim rows are untouched");
    assert.equal(fixture.state.admission.claims,1);
  }
});

test("同数量claim的任一身份或完整指纹变化、额外claim和runtime工作均阻挡stop",async t=>{
  const fixture=await leaseFixture(t,[oldClaim]),lease=await beginInstallationMaintenance(fixture.options);
  await lease.assertHeld("before_backup");
  for(const [key,value] of Object.entries({id:"replacement",operationId:"other-operation",ownerId:"other-owner",ownerPid:901,
    processStart:"reused-pid",generation:"next-attempt",fingerprint:"b".repeat(64)})){
    fixture.state.claims=[{...oldClaim,[key]:value}];
    await assert.rejects(lease.assertHeld("after_backup"),/Maintenance state changed/);
  }
  fixture.state.claims=[oldClaim,{...oldClaim,id:"extra"}];fixture.state.admission.claims=2;
  await assert.rejects(lease.assertHeld("before_stop"),/Maintenance state changed/);
  fixture.state.claims=[oldClaim];fixture.state.admission.claims=1;
  for(const name of ["waiting","operations","executions","queuedOperations","queuedExecutions","activeWork","allRuntimeWork","persistedRuntimeWork"]){
    fixture.state.admission[name]=1;
    await assert.rejects(lease.assertHeld("before_stop"),/Maintenance state changed/);
    fixture.state.admission[name]=0;
  }
  assert.deepEqual(lease.receipt.stages.map(value=>value.stage),["before_backup"]);
  await lease.release({outcome:"aborted-before-stop",transition:null,activeStatus:fixture.running});
});

test("acquire返回的证明无效时补偿只释放自有pause，且必须确认准入确实恢复",async t=>{
  const fixture=await leaseFixture(t),acquire=fixture.provider.acquire;
  fixture.provider.acquire=async context=>({...await acquire(context),census:{digest:"invalid",observedAt:new Date().toISOString()}});
  fixture.provider.release=async()=>{};
  await assert.rejects(beginInstallationMaintenance(fixture.options),/acquisition is unconfirmed/);
  const name=(await readdir(fixture.root)).find(name=>name.startsWith("maintenance-"));
  const receipt=JSON.parse(await readFile(join(fixture.root,name),"utf8"));
  assert.equal(receipt.phase,"acquisition_unconfirmed");assert.match(receipt.releaseError,/not restored admission/);
  assert.equal(fixture.state.admission.accepting,false);
});

test("旧manager不可达时external lease在任何配置写入、backup或服务操作之前拒绝",async t=>{
  const root=await directory(t),port=await freePort();await mkdir(join(root,"state"));
  const config=join(root,"node.json"),stagedConfig=join(root,"staged.json"),unitFile=join(root,"service.fixture");
  await writeFile(config,'{"sentinel":"active"}');await writeFile(stagedConfig,'{"sentinel":"prepared"}');
  await writeFile(unitFile,"original-service");
  const previous={nodeId:"fixture",sourceCommit:"old-commit",adminPort:port};
  await writeFile(join(root,"installation.json"),JSON.stringify(previous));
  const manifest={version:1,nodeId:"fixture",sourceCommit:"new-commit",configDir:root,stateDir:join(root,"state"),
    config,stagedConfig,unitFile,adminPort:port,directory:root,nodeExecutable:process.execPath};
  const manifestFile=join(root,"prepared.json");await writeFile(manifestFile,JSON.stringify(manifest));
  const before=await Promise.all([config,stagedConfig,unitFile].map(file=>readFile(file,"utf8")));
  let acquired=0;
  await assert.rejects(activateInstallation(manifestFile,{maintenanceLease:{acquire:async()=>{acquired++;},assertHeld:async()=>{},release:async()=>{}}}),/正在运行的旧节点/);
  assert.equal(acquired,0);assert.deepEqual(await Promise.all([config,stagedConfig,unitFile].map(file=>readFile(file,"utf8"))),before);
  assert.deepEqual(await readdir(join(root,"state")),[]);
  assert.deepEqual((await readdir(root)).sort(),["installation.json","node.json","prepared.json","service.fixture","staged.json","state"]);
});

test("manager条件resume通过真实HTTP转发，冲突保持relay关闭且timer保留同一CAS",async t=>{
  const root=await directory(t),seen=[];
  const expected={instance:{pid:1002,processStart:"core-generation",token:"core-instance"},accepting:false,reason:"node-maintenance",changedAt:"2026-10-23T00:00:00.000Z"};
  let conflict=true,relayAccepting=false;
  const port=await serve(t,(req,body)=>{
    if(req.url==="/internal/quaymesh/idle")return {body:{...expected,instance:expected.instance}};
    assert.equal(req.url,"/internal/quaymesh/admission");seen.push(body);
    return conflict?{status:409,body:{code:"ADMISSION_PRECONDITION_FAILED"}}:{body:{accepting:true}};});
  const node=new QuayMeshNode({revision:1,node:{stateDir:root,corePort:port,adminPort:0}});node.token=token;
  node.maintenance=true;node.relay={setAccepting:value=>{relayAccepting=value;}};
  await node.startAdmin();t.after(()=>new Promise(resolve=>{node.admin.closeAllConnections();node.admin.close(resolve);}));
  const url=`http://127.0.0.1:${node.admin.address().port}/maintenance/resume`;
  await assert.rejects(requestJson(url,{method:"POST",token,body:{expected}}),error=>error.status===409);
  assert.equal(node.maintenance,true);assert.equal(relayAccepting,false);
  assert.ok(node.errors.snapshot().current.some(error=>error.source==="admission"));
  await assert.rejects(node.reconcileMaintenance(),error=>error.status===409);
  assert.ok(node.errors.snapshot().current.some(error=>error.source==="admission"),"failed conditional mutation remains current");
  assert.equal(seen.length,2);assert.deepEqual(seen.map(value=>value.expected),[expected,expected]);
  conflict=false;await node.reconcileMaintenance();
  assert.equal(node.maintenance,false);assert.equal(relayAccepting,true);
  assert.deepEqual(seen[2].expected,expected);assert.equal(node.maintenanceReleasePending,false);
  assert.equal(node.errors.snapshot().current.some(error=>error.source==="admission"),false);
});

test("一次真实idle超时仅在无维护归属且后续健康观测后恢复，历史回执仍保留",{timeout:10000},async t=>{
  const root=await directory(t),marker=join(root,"installation-transition.json");
  let reads=0,acquireDuringRead=false;
  let state={accepting:false,reason:"release-preflight:other-owner"};
  const port=await serve(t,async req=>{
    assert.equal(req.url,"/internal/quaymesh/idle");
    if(++reads===1)await new Promise(()=>{}); // Exercise requestJson's actual 3s timeout.
    if(acquireDuringRead)node.maintenance=true;
    return {body:state};
  });
  const node=new QuayMeshNode({revision:1,node:{stateDir:root,corePort:port}});node.token=token;
  const reconcile=()=>node.reconcileMaintenance().catch(error=>{node.errors.fail("admission",error);throw error;});
  await assert.rejects(reconcile(),/请求 \/internal\/quaymesh\/idle 超时/);
  const original=node.errors.snapshot().current[0];
  assert.equal(original.source,"admission");assert.equal(original.count,1);assert.equal(original.recoveredAt,null);
  await reconcile();assert.deepEqual(node.errors.snapshot().current,[original],"another owner's pause is not a recovery");
  state={accepting:true,reason:null};
  await writeFile(marker,JSON.stringify({phase:"validating"}));
  await reconcile();assert.equal(reads,2);assert.deepEqual(node.errors.snapshot().current,[original]);
  await rm(marker);
  node.maintenance=true;
  await reconcile();assert.equal(reads,2);assert.deepEqual(node.errors.snapshot().current,[original]);
  node.maintenance=false;acquireDuringRead=true;
  await reconcile();assert.equal(reads,3);assert.deepEqual(node.errors.snapshot().current,[original],"ownership is rechecked after HTTP");
  node.maintenance=false;acquireDuringRead=false;
  node.errors.fail("configuration",new Error("unrelated configuration failure"));
  await reconcile();assert.equal(reads,4);
  const recovered=node.errors.snapshot();
  assert.deepEqual(recovered.current.map(error=>error.source),["configuration"]);
  const history=recovered.history.find(error=>error.source==="admission");
  assert.deepEqual({...history,recoveredAt:null},original);
  assert.ok(Number.isFinite(history.recoveredAt)&&history.recoveredAt>=original.lastOccurredAt);
});

for(const interveningPause of [false,true])test(`CAS恢复响应丢失${interveningPause?"且新owner在核验后暂停时绝不覆盖":"时同实例再次CAS确认恢复manager"}`,async t=>{
  const root=await directory(t),seen=[];
  const instance={pid:1002,processStart:"core-generation",token:"core-instance"};
  const expected={instance,accepting:false,reason:"node-maintenance",changedAt:"2026-10-23T00:00:00.000Z"};
  let state=structuredClone(expected),lost=false,relayAccepting=false;
  const port=await serve(t,(req,body)=>{
    if(req.url==="/internal/quaymesh/idle"){
      const observed=structuredClone(state);
      if(interveningPause)state={instance,accepting:false,reason:"another-maintenance-owner",changedAt:"2026-10-23T00:00:00.002Z"};
      return {body:observed};
    }
    assert.equal(req.url,"/internal/quaymesh/admission");seen.push(body.expected);
    if(JSON.stringify(body.expected)!==JSON.stringify(state))return {status:409,body:{code:"ADMISSION_PRECONDITION_FAILED"}};
    state={instance,accepting:true,reason:null,changedAt:"2026-10-23T00:00:00.001Z"};
    if(!lost){lost=true;req.socket.destroy();}
    return {body:state};
  });
  const node=new QuayMeshNode({revision:1,node:{stateDir:root,corePort:port}});node.token=token;node.maintenance=true;
  node.relay={setAccepting:value=>{relayAccepting=value;}};
  if(interveningPause){
    await assert.rejects(node.endMaintenance(expected),error=>error.status===409);
    assert.equal(node.maintenance,true);assert.equal(relayAccepting,false);assert.equal(state.reason,"another-maintenance-owner");
    assert.deepEqual(node.maintenanceReleaseExpected,expected);
  }else{
    await node.endMaintenance(expected);assert.equal(node.maintenance,false);assert.equal(relayAccepting,true);
  }
  assert.equal(seen.length,2);assert.deepEqual(seen[0],expected);
  assert.deepEqual(seen[1],{instance,accepting:true,reason:null,changedAt:"2026-10-23T00:00:00.001Z"});
});

test("abandoned维护读取后外部fence抢先生效，timer只能CAS旧状态而不能清掉新暂停",async t=>{
  const root=await directory(t),instance={pid:1002,processStart:"core-generation",token:"core-instance"},posts=[];
  const abandoned={instance,accepting:false,reason:"node-maintenance",changedAt:"2026-10-23T00:00:00.000Z"};
  const external={instance,accepting:false,reason:"release-preflight:other-attempt",changedAt:"2026-10-23T00:00:00.001Z"};
  let reads=0,relayAccepting=true;
  const port=await serve(t,(req,body)=>{
    if(req.url==="/internal/quaymesh/idle")return {body:reads++===0?abandoned:external};
    posts.push(body);return {status:409,body:{code:"ADMISSION_PRECONDITION_FAILED"}};
  });
  const node=new QuayMeshNode({revision:1,node:{stateDir:root,corePort:port}});node.token=token;
  node.relay={setAccepting:value=>{relayAccepting=value;}};
  await assert.rejects(node.reconcileMaintenance(),error=>error.status===409);
  assert.equal(posts.length,1);assert.deepEqual(posts[0].expected,abandoned);
  assert.equal(relayAccepting,false);assert.equal(node.maintenance,true);
});

test("standard begin不覆盖已有外部pause，接受后的drain失败只释放自己的CAS",async t=>{
  const root=await directory(t),instance={pid:1002,processStart:"core-generation",token:"core-instance"},posts=[];
  let state={instance,accepting:false,reason:"release-preflight:other-attempt",changedAt:"2026-10-23T00:00:00.000Z"},phase="foreign";
  const port=await serve(t,(req,body)=>{
    if(req.url==="/internal/quaymesh/idle")return {body:{...state,idle:false,quiescent:false}};
    posts.push(body);
    if(JSON.stringify(body.expected)!==JSON.stringify(state))return {status:409,body:{code:"ADMISSION_PRECONDITION_FAILED"}};
    if(body.action==="pause"){
      state={instance,accepting:false,reason:"node-maintenance",changedAt:"2026-10-23T00:00:00.002Z"};phase="owned";
    }else state={instance,accepting:true,reason:null,changedAt:"2026-10-23T00:00:00.003Z"};
    return {body:state};
  });
  const node=new QuayMeshNode({revision:1,node:{stateDir:root,corePort:port}});node.token=token;
  node.relay={activeRequests:0,setAccepting:()=>{}};
  await assert.rejects(node.beginMaintenance(1),error=>error.status===409);
  assert.equal(posts.length,0);assert.equal(phase,"foreign");
  state={instance,accepting:true,reason:null,changedAt:"2026-10-23T00:00:00.001Z"};
  await assert.rejects(node.beginMaintenance(1),/已接受的工作尚未结束/);
  assert.equal(posts.length,2);assert.equal(posts[0].action,"pause");assert.equal(posts[0].expected.accepting,true);
  assert.equal(posts[1].action,"resume");assert.equal(posts[1].expected.reason,"node-maintenance");
  assert.equal(posts[1].expected.changedAt,"2026-10-23T00:00:00.002Z");assert.equal(state.accepting,true);
});

test("本manager受管Core真实替换后显式交接CAS，普通resume不能接受陌生实例",{timeout:15000},async t=>{
  const root=await directory(t),port=await freePort(),script=join(root,"core-fixture.mjs");
  await writeFile(script,`
import http from 'node:http';
import {randomUUID} from 'node:crypto';
const instance={pid:process.pid,processStart:String(Date.now()),token:randomUUID()};
let state={instance,accepting:process.argv[3]==='old',reason:process.argv[3]==='old'?null:'node-maintenance',changedAt:new Date().toISOString()};
const server=http.createServer((req,res)=>{void(async()=>{
  let text='';for await(const chunk of req)text+=chunk;
  if(req.url==='/internal/quaymesh/idle'){res.end(JSON.stringify({...state,idle:true,quiescent:true}));return;}
  const body=JSON.parse(text);
  if(JSON.stringify(body.expected)!==JSON.stringify(state)){res.writeHead(409).end('{}');return;}
  state={instance,accepting:body.action==='resume',reason:body.action==='resume'?null:'node-maintenance',changedAt:new Date(Math.max(Date.now(),Date.parse(state.changedAt)+1)).toISOString()};
  res.end(JSON.stringify(state));
})().catch(error=>res.writeHead(500).end(JSON.stringify({error:String(error)})));});
server.listen(Number(process.argv[2]),'127.0.0.1');
process.on('SIGTERM',()=>{server.closeAllConnections();server.close(()=>process.exit(0));});
`);
  const supervisor=new ComponentSupervisor({logDir:join(root,"logs"),intervalMs:20,shutdownMs:1000});t.after(()=>supervisor.close());
  const plan=generation=>({id:"core",command:process.execPath,args:[script,String(port),generation],env:process.env,
    ready:()=>requestJson(`http://127.0.0.1:${port}/internal/quaymesh/idle`,{timeoutMs:500})});
  supervisor.define([plan("old")]);await supervisor.start();await supervisor.waitReady(["core"]);
  const node=new QuayMeshNode({revision:1,node:{stateDir:root,corePort:port}});node.token=token;node.supervisor=supervisor;
  let relayAccepting=true;node.relay={activeRequests:0,setAccepting:value=>{relayAccepting=value;}};
  const owner=await node.beginMaintenance(1000),oldInstance=node.maintenancePauseExpected.instance;
  const changed=await supervisor.replacePlans([plan("new")]);await supervisor.waitReady(changed);
  const current=await node.admissionState();assert.notEqual(current.instance.token,oldInstance.token);
  assert.equal(current.instance.pid,supervisor.snapshot().find(value=>value.id==="core").pid);
  await assert.rejects(node.endMaintenance(),error=>error.status===409);assert.equal(relayAccepting,false);
  await assert.rejects(node.endMaintenanceAfterReplacement("another-owner",changed),/维护归属已改变/);
  await node.endMaintenanceAfterReplacement(owner,changed);
  assert.equal(node.maintenance,false);assert.equal(relayAccepting,true);
  assert.equal((await node.admissionState()).accepting,true);
});
