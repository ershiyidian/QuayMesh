import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createTailscaleProbe } from "../tailscale.mjs";

const publicUrl="https://managed-example.example.ts.net/mcp",port=29177;
const host=new URL(publicUrl).hostname,target=`http://127.0.0.1:${port}`;
function status() {
  return {Version:"1.102.4",BackendState:"Running",Self:{DNSName:`${host}.`,Online:true}};
}
function config() {
  return {TCP:{"443":{HTTPS:true}},Web:{[`${host}:443`]:{Handlers:{"/":{Proxy:target}}}},
    AllowFunnel:{[`${host}:443`]:true}};
}
function advanceClock(t) {
  t.mock.timers.enable({apis:["Date"],now:Date.now()});
  return ms=>t.mock.timers.tick(ms);
}
async function rejected(promise,code,restart=false) {
  await assert.rejects(promise,error=>{
    assert.equal(error.code,code);
    if(restart)assert.equal(error.restartComponent,true);
    else assert.equal(Object.hasOwn(error,"restartComponent"),false);
    return true;
  });
}
async function fixture(t) {
  const dir=await mkdtemp(join(tmpdir(),"qm-ts-"));
  const socketPath=process.platform==="win32"?`\\\\.\\pipe\\qm-ts-${randomUUID()}`:join(dir,"api.sock");
  const children=[],connections=new Set();
  const data={status:status(),warnings:null,config:config(),state:6,cliMode:"configure"};
  const counts={status:0,health:0,config:0,cli:0};
  let openWatches=0;
  const server=http.createServer(async(req,res)=>{
    if(req.url==="/localapi/v0/status?peers=false") {
      counts.status++;
      const value=structuredClone(data.status);
      if(data.firstStatusGate&&counts.status===1) {
        server.emit("status-request");
        await data.firstStatusGate;
      }
      if(data.statusMode==="hang")return;
      if(data.statusMode==="forbidden"){res.writeHead(403).end();return;}
      res.writeHead(200,{"content-type":"application/json"});
      res.end(data.statusMode==="invalid"?"not-json":JSON.stringify(value));return;
    }
    if(req.url==="/localapi/v0/watch-ipn-bus?mask=130") {
      counts.health++;openWatches++;
      res.once("close",()=>{openWatches--;server.emit("watch-close");});
      res.writeHead(200,{"content-type":"application/json"});
      res.write(JSON.stringify({Version:"1.102.4",State:data.state,Health:null})+"\n");
      if(data.healthMode==="missing"){res.end();return;}
      // Real chunk boundaries split an object. The first null Health is not
      // a healthy snapshot; the reader must wait for this second message.
      const payload=JSON.stringify({State:data.state,Health:{Warnings:data.warnings}})+"\n";
      res.write(payload.slice(0,9));
      setImmediate(()=>{if(!res.destroyed)res.write(payload.slice(9));});
      return;
    }
    if(req.url==="/localapi/v0/serve-config") {
      counts.config++;res.writeHead(200,{"content-type":"application/json"});
      res.end(JSON.stringify(data.config));return;
    }
    if(req.url==="/test/configure"&&req.method==="POST") {
      let body="";for await(const chunk of req)body+=chunk;
      const call=JSON.parse(body);
      counts.cli++;data.cliArgs=call.args;data.cliPid=call.pid;
      if(data.cliMode==="hang")return;
      if(data.cliMode==="fail"){res.writeHead(500).end();return;}
      if(data.cliMode==="configure")data.config=config();
      res.writeHead(204).end();return;
    }
    res.writeHead(404).end();
  });
  server.on("connection",socket=>{
    connections.add(socket);socket.once("close",()=>connections.delete(socket));
  });
  const startChild=async()=>{
    const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});
    children.push(child);await once(child,"spawn");return child;
  };
  t.after(async()=>{
    for(const child of children)if(child.exitCode===null&&child.signalCode===null) {
      const exited=once(child,"exit");child.kill();await exited;
    }
    for(const socket of connections)socket.destroy();
    if(server.listening)await new Promise(resolve=>server.close(resolve));
    await rm(dir,{recursive:true,force:true});
  });
  server.listen(socketPath);await once(server,"listening");
  const command=join(dir,"tailscale-cli.mjs");
  await writeFile(command,`#!${process.execPath}
import http from "node:http";
const args=process.argv.slice(2),socketPath=args.find(value=>value.startsWith("--socket=")).slice(9);
await new Promise((resolve,reject)=>{
  const req=http.request({socketPath,path:"/test/configure",method:"POST",agent:false},res=>{
    res.resume();res.on("end",()=>res.statusCode===204?resolve():reject(new Error("fixture CLI failure")));
  });
  req.on("error",reject);req.end(JSON.stringify({args,pid:process.pid}));
});
`,{mode:0o700});
  const child=await startChild();
  return {dir,socketPath,server,data,counts,child,command,startChild,
    options:{socketPath,publicUrl,port,command},openWatches:()=>openWatches};
}

test("真实 Unix API 健康首包读取后关闭，5 秒缓存合并并发探测",async t=>{
  const f=await fixture(t),advance=advanceClock(t),probe=createTailscaleProbe(f.options);
  const closed=once(f.server,"watch-close",{signal:AbortSignal.timeout(2000)});
  const [first,second,third]=await Promise.all([probe(f.child),probe(f.child),probe(f.child)]);
  assert.equal(first,second);assert.equal(second,third);
  assert.equal(first.ready,true);assert.equal(first.pid,f.child.pid);
  assert.equal(first.dnsName,host);assert.deepEqual(first.funnel,{port:443,target});
  assert.deepEqual(f.counts,{status:1,health:1,config:1,cli:0});
  await closed;
  assert.equal(f.openWatches(),0);
  advance(4999);await probe(f.child);
  assert.equal(f.counts.status,1);
  advance(1);await probe(f.child);
  assert.deepEqual(f.counts,{status:2,health:2,config:2,cli:0});
  assert.equal(f.child.exitCode,null);
});

test("控制连接持续失效跨健康码累计，只有达到恢复窗口才标记重启",async t=>{
  const f=await fixture(t),advance=advanceClock(t);
  f.data.status.Self.Online=false;
  f.data.warnings={"mapresponse-timeout":{WarnableCode:"mapresponse-timeout",ImpactsConnectivity:false}};
  const probe=createTailscaleProbe(f.options);
  await rejected(probe(f.child),"TAILSCALE_CONTROL_STALLED");
  advance(119999);
  f.data.warnings={"not-in-map-poll":{WarnableCode:"not-in-map-poll"}};
  await rejected(probe(f.child),"TAILSCALE_CONTROL_STALLED");
  advance(1);
  await rejected(probe(f.child),"TAILSCALE_CONTROL_STALLED",true);
  assert.equal(f.counts.status,2,"缓存命中时仍应计算恢复窗口");
  assert.equal(f.counts.config,0,"连接未就绪时不读写 Funnel 配置");
  assert.equal(f.child.exitCode,null,"探测器只标记恢复，不自行终止进程");
});

test("网络离线与恢复清除故障窗口，下一轮故障重新计时",async t=>{
  const f=await fixture(t),advance=advanceClock(t),probe=createTailscaleProbe({...f.options,recoveryMs:10000});
  f.data.warnings={"mapresponse-timeout":{}};
  await rejected(probe(f.child),"TAILSCALE_CONTROL_STALLED");
  advance(5000);f.data.warnings={"network-status":{},"mapresponse-timeout":{}};
  await rejected(probe(f.child),"TAILSCALE_NETWORK_DOWN");
  advance(10000);f.data.warnings={"mapresponse-timeout":{}};
  await rejected(probe(f.child),"TAILSCALE_CONTROL_STALLED");
  advance(5000);f.data.warnings=null;await probe(f.child);
  advance(5000);f.data.warnings={"mapresponse-timeout":{}};
  await rejected(probe(f.child),"TAILSCALE_CONTROL_STALLED");
  advance(10000);await rejected(probe(f.child),"TAILSCALE_CONTROL_STALLED",true);
});

test("实际 PID 换代清空缓存和恢复窗口，迟到的旧进程探测不覆盖新结果",async t=>{
  const f=await fixture(t),probe=createTailscaleProbe(f.options);
  let release;
  f.data.status.BackendState="NeedsLogin";
  f.data.firstStatusGate=new Promise(resolve=>{release=resolve;});
  const observed=once(f.server,"status-request");
  const old=probe(f.child).catch(error=>error);
  await observed;
  const replacement=await f.startChild();
  f.data.status=status();
  const healthy=await probe(replacement);
  release();
  assert.equal((await old).code,"TAILSCALE_NOT_RUNNING");
  assert.equal(await probe(replacement),healthy);
  assert.equal(f.counts.status,2);
});

test("PID 换代不会继承上一个进程已到期的恢复标记",async t=>{
  const f=await fixture(t),advance=advanceClock(t),probe=createTailscaleProbe({...f.options,recoveryMs:5000});
  f.data.warnings={"mapresponse-timeout":{}};
  await rejected(probe(f.child),"TAILSCALE_CONTROL_STALLED");
  advance(5000);await rejected(probe(f.child),"TAILSCALE_CONTROL_STALLED",true);
  const replacement=await f.startChild();
  await rejected(probe(replacement),"TAILSCALE_CONTROL_STALLED");
  assert.equal(f.counts.status,3);
});

test("登录、授权、停止及启动状态均不请求重启",async t=>{
  const f=await fixture(t);
  for(const state of ["NoState","InUseOtherUser","NeedsLogin","NeedsMachineAuth","Stopped","Starting"]) {
    f.data.status.BackendState=state;
    await rejected(createTailscaleProbe({...f.options,recoveryMs:0})(f.child),"TAILSCALE_NOT_RUNNING");
  }
  assert.equal(f.counts.health,0);
  f.data.status=status();f.data.state=4;
  await rejected(createTailscaleProbe({...f.options,recoveryMs:0})(f.child),"TAILSCALE_NOT_RUNNING");
  f.data.state=6;f.data.warnings={"login-state":{}};
  await rejected(createTailscaleProbe({...f.options,recoveryMs:0})(f.child),"TAILSCALE_NOT_READY");
  f.data.warnings={"no-derp-home":{ImpactsConnectivity:true}};
  await rejected(createTailscaleProbe({...f.options,recoveryMs:0})(f.child),"TAILSCALE_CONNECTIVITY_UNHEALTHY");
  assert.equal(f.counts.config,0);
});

test("运行但未在线、身份错配、无效或不支持的 API 不触发重启",async t=>{
  const f=await fixture(t);
  f.data.status.Self.Online=false;
  await rejected(createTailscaleProbe({...f.options,recoveryMs:0})(f.child),"TAILSCALE_OFFLINE");
  f.data.status=status();f.data.status.Self.DNSName="different.example.ts.net.";
  await rejected(createTailscaleProbe({...f.options,recoveryMs:0})(f.child),"TAILSCALE_IDENTITY_MISMATCH");
  f.data.status=status();f.data.statusMode="invalid";
  await rejected(createTailscaleProbe({...f.options,recoveryMs:0})(f.child),"TAILSCALE_LOCALAPI_INVALID_JSON");
  f.data.statusMode="forbidden";
  await rejected(createTailscaleProbe({...f.options,recoveryMs:0})(f.child),"TAILSCALE_LOCALAPI_HTTP");
  f.data.statusMode=null;f.data.healthMode="missing";
  await rejected(createTailscaleProbe({...f.options,recoveryMs:0})(f.child),"TAILSCALE_HEALTH_UNAVAILABLE");
  assert.equal(f.counts.cli,0);
});

test("专用 socket 持续不可连接才请求重建进程",async t=>{
  const f=await fixture(t),advance=advanceClock(t);
  const probe=createTailscaleProbe({...f.options,socketPath:process.platform==="win32"?
    `\\\\.\\pipe\\missing-${randomUUID()}`:join(f.dir,"missing.sock"),recoveryMs:10000});
  await rejected(probe(f.child),"TAILSCALE_LOCALAPI_UNREACHABLE");
  advance(9999);await rejected(probe(f.child),"TAILSCALE_LOCALAPI_UNREACHABLE");
  advance(1);await rejected(probe(f.child),"TAILSCALE_LOCALAPI_UNREACHABLE",true);
});

test("真实 socket 挂起受总时限约束，不泄漏连接",async t=>{
  const f=await fixture(t);
  f.data.statusMode="hang";
  const started=performance.now();
  await rejected(createTailscaleProbe({...f.options,timeoutMs:50,recoveryMs:0})(f.child),"TAILSCALE_LOCALAPI_TIMEOUT",true);
  assert.ok(performance.now()-started<1500);
});

test("缺失 Funnel 由配套 CLI 子进程补齐并重读核验", {skip:process.platform==="win32"},async t=>{
  const f=await fixture(t);f.data.config={};
  const result=await createTailscaleProbe(f.options)(f.child);
  assert.equal(result.ready,true);
  assert.equal(f.counts.cli,1);assert.equal(f.counts.config,2);
  assert.deepEqual(f.data.cliArgs,[`--socket=${f.socketPath}`,"funnel","--bg","--https=443",target]);
  assert.notEqual(f.data.cliPid,process.pid);
  assert.throws(()=>process.kill(f.data.cliPid,0),{code:"ESRCH"});
});

test("Funnel 配置冲突不会覆盖现有转发，非预期后端不能报就绪",async t=>{
  const f=await fixture(t);
  f.data.config.Web[`${host}:443`].Handlers["/"].Proxy="http://127.0.0.1:29999";
  await rejected(createTailscaleProbe(f.options)(f.child),"TAILSCALE_FUNNEL_CONFLICT");
  f.data.config=config();f.data.config.TCP["443"]={TCPForward:"127.0.0.1:29999"};
  await rejected(createTailscaleProbe(f.options)(f.child),"TAILSCALE_FUNNEL_CONFLICT");
  f.data.config=config();f.data.config.Foreground={session:{TCP:{"443":{HTTPS:true}}}};
  await rejected(createTailscaleProbe(f.options)(f.child),"TAILSCALE_FUNNEL_CONFLICT");
  assert.equal(f.counts.cli,0);
});

test("CLI 失败、超时或未写入正确配置均不误报成功", {skip:process.platform==="win32"},async t=>{
  const f=await fixture(t);f.data.config={};
  f.data.cliMode="noop";
  await rejected(createTailscaleProbe(f.options)(f.child),"TAILSCALE_FUNNEL_NOT_CONFIGURED");
  f.data.cliMode="fail";
  await rejected(createTailscaleProbe(f.options)(f.child),"TAILSCALE_FUNNEL_SETUP_FAILED");
  f.data.cliMode="hang";
  await rejected(createTailscaleProbe({...f.options,timeoutMs:500})(f.child),"TAILSCALE_FUNNEL_SETUP_FAILED");
  assert.equal(f.counts.cli,3);
  assert.throws(()=>process.kill(f.data.cliPid,0),{code:"ESRCH"});
});

test("无有效子进程或错误入口配置直接拒绝，不作 I/O",async()=>{
  const probe=createTailscaleProbe({socketPath:"/unused.sock",publicUrl,port});
  await rejected(probe({pid:0}),"TAILSCALE_PROCESS_NOT_RUNNING");
  assert.throws(()=>createTailscaleProbe({socketPath:"/unused.sock",publicUrl:"http://example.test",port}),
    {code:"TAILSCALE_PUBLIC_URL_INVALID"});
  assert.throws(()=>createTailscaleProbe({socketPath:"/unused.sock",publicUrl,port:0}),
    {code:"TAILSCALE_TARGET_PORT_INVALID"});
});

