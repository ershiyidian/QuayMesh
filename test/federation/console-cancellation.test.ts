import assert from "node:assert/strict";
import {mkdtemp,mkdir,readFile,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createServer} from "node:http";
import {setTimeout as delay} from "node:timers/promises";
import test from "node:test";
import Database from "better-sqlite3";
import type {ServerConfig} from "../../src/config.js";
import {databasePath} from "../../src/db/client.js";
import {WorkLedger} from "../../src/work-ledger.js";
import {closeConsoleReaders,readLocalTaskIndex,withConsoleReadSignal} from "../../src/console-workbench/isolated-queries.js";
import {FederationRuntime,type FederationHooks} from "../../src/federation/runtime.js";
import {PeerTransport} from "../../src/federation/transport.js";
import {dispatchConsoleRequest} from "../../src/federation/console-request.js";
import type {ConsoleReply,FederationConfig} from "../../src/federation/types.js";

function config(nodeId:string):FederationConfig {
  return {enabled:true,nodeId,nickname:nodeId,coordinatorId:"target",host:"127.0.0.1",port:0,priority:0,
    tokenEnv:"UNUSED_TEST_TOKEN",peers:[],roots:[],heartbeatMs:100,rpcTimeoutMs:5000,
    capabilities:{coordinator:nodeId==="target",worker:true,discovery:false,egress:false,meshRelay:false,desktopUi:false,consoleRelay:true},
    egress:{enabled:false,listenPort:0,proxyUrl:"http://127.0.0.1:1",controllerSecretEnv:"UNUSED",probeUrl:"http://example.invalid",
      probeIntervalMs:15000,recoveryDelayMs:60000,inheritProxy:false}};
}
async function until(check:()=>boolean,message:string,timeout=1500){
  const deadline=Date.now()+timeout;
  while(!check()){assert.ok(Date.now()<deadline,message);await delay(10);}
}

test("console RPC cancellation reaches the nested real reader; the next read and accepted write still complete",{timeout:15000},async()=>{
  const directory=await mkdtemp(join(tmpdir(),"qm-console-rpc-cancel-"));
  const queryConfig={stateDir:join(directory,"read-state"),configDir:join(directory,"config"),allowedRoots:[join(directory,"workspace")]} as ServerConfig;
  await mkdir(queryConfig.configDir);await mkdir(queryConfig.allowedRoots[0]);
  const ledger=new WorkLedger(queryConfig.stateDir);
  const run=ledger.begin({root:queryConfig.allowedRoots[0],workspaceId:"reader-test",workItemId:"read-isolation",runKey:"once",
    title:"RPC read fixture",origin:{entryPoint:"qm_cli",evidence:"server_entry"}});
  ledger.close();
  // A real native SQLite lock keeps the official read child waiting. Runtime
  // receipts use a different database, so only this test's observation waits.
  const lock=new Database(databasePath(queryConfig.stateDir));
  lock.pragma("locking_mode = EXCLUSIVE");lock.exec("BEGIN EXCLUSIVE");
  let locked=true,starts=0,writeStarted=false;
  const failures:string[]=[];
  let releaseWrite!:()=>void;
  const writeGate=new Promise<void>(resolve=>{releaseWrite=resolve;});
  const marker=join(directory,"committed.txt");
  const hooks: FederationHooks={stateDir:join(directory,"runtime-state"),httpPort:0,ingressPort:0,publicBaseUrl:"http://127.0.0.1",
    providers:()=>[],prepareOpen:async input=>input,checkWorkspace:async()=>{},settings:()=>({}),updateSettings:async()=>{},
    mihomoImport:async()=>null,mihomoRead:async()=>"",resolveProxy:async()=>"http://127.0.0.1:1",
    artifactStat:async()=>({size:0}),artifactRead:async()=>{throw new Error("unused");},artifactWrite:async()=>{},
    console:async method=>{
      if(method==="POST"){
        writeStarted=true;await writeGate;
        const result=await readLocalTaskIndex(queryConfig);
        await writeFile(marker,String(result.items.length));
        return {status:200,body:{committed:true}};
      }
      // The HTTP route also installs its own request controller. Both scopes
      // must reach the owned reader instead of the inner one hiding RPC abort.
      const reading=withConsoleReadSignal(new AbortController().signal,()=>readLocalTaskIndex(queryConfig));
      starts++;
      try{return {status:200,body:await reading};}
      catch(error){failures.push((error as {code:string}).code);throw error;}
    }};
  const targetConfig=config("target");targetConfig.peers=[{id:"caller",url:""}];
  const target=new FederationRuntime(targetConfig,"console-cancellation-test-secret",hooks);
  let caller:PeerTransport|undefined;
  try{
    await target.transport.start();
    const callerConfig=config("caller");callerConfig.peers=[{id:"target",url:`http://127.0.0.1:${target.transport.address}`}];
    caller=new PeerTransport(callerConfig,"console-cancellation-test-secret",()=>null,()=>{});
    await caller.start();await until(()=>Boolean(caller?.links.get("target")?.connected),"actual peer connects");
    const link=caller.links.get("target")!,cancel=new AbortController();
    const first=link.call("console",{method:"GET",path:"/workbench/isolated-v1/task-index"},5000,undefined,cancel.signal);
    const rejected=assert.rejects(first,{code:"REQUEST_CANCELLED"});
    await until(()=>starts===1,"actual reader request starts");
    await delay(100);assert.deepEqual(failures,[]);
    cancel.abort();await rejected;
    await until(()=>failures.includes("console_read_aborted"),"RPC cancellation must end the owned reader before its deadline");
    lock.exec("ROLLBACK");locked=false;lock.close();
    const next=await link.call<ConsoleReply>("console",{method:"GET",path:"/workbench/isolated-v1/task-index"},3000);
    assert.equal(next.status,200);
    assert.equal((next.body as {items:Array<{localId:string}>}).items[0]?.localId,run.id);
    assert.equal(link.connected,true);

    const stopWaiting=new AbortController();
    const write=link.call("console",{method:"POST",path:"/workbench/fixture-write"},5000,undefined,stopWaiting.signal);
    const writeRejected=assert.rejects(write,{code:"REQUEST_CANCELLED"});
    await until(()=>writeStarted,"mutation is accepted before the caller stops waiting");
    stopWaiting.abort();await writeRejected;releaseWrite();
    await until(()=>target.transport.links.get("caller")?.diagnostics().incomingRpc===0,"accepted mutation completes after cancellation");
    assert.equal(await readFile(marker,"utf8"),"1");
  }finally{
    releaseWrite();if(locked)lock.exec("ROLLBACK");if(lock.open)lock.close();closeConsoleReaders();
    await caller?.close();await target.close();await delay(50);await rm(directory,{recursive:true,force:true});
  }
});

test("console HTTP relay aborts a read body and leaves an accepted POST running",{timeout:10000},async()=>{
  const directory=await mkdtemp(join(tmpdir(),"qm-console-http-cancel-")),marker=join(directory,"write.txt");
  let reading=false,readClosed=false,writeStarted=false,writeFinished=false;
  let releaseWrite!:()=>void;
  const writeGate=new Promise<void>(resolve=>{releaseWrite=resolve;});
  const http=createServer((request,response)=>{
    void(async()=>{
      response.writeHead(200,{"content-type":"application/json"});
      if(request.url==="/console/hold"){
        reading=true;response.on("close",()=>{readClosed=true;});response.write('{"pending":');return;
      }
      if(request.method==="POST"){
        writeStarted=true;await writeGate;await writeFile(marker,"committed");writeFinished=true;
      }
      response.end('{"ready":true}');
    })().catch(error=>response.destroy(error));
  });
  try{
    await new Promise<void>(resolve=>http.listen(0,"127.0.0.1",resolve));
    const port=(http.address() as {port:number}).port,cancel=new AbortController();
    const read=dispatchConsoleRequest(port,"relay",{method:"GET",path:"/console/hold",headers:{}},cancel.signal);
    const observed=read.then(reply=>assert.equal(reply.status,503),error=>assert.equal(error.name,"AbortError"));
    await until(()=>reading,"the real HTTP response body starts");cancel.abort();await observed;
    await until(()=>readClosed,"cancelled fetch closes its local HTTP request");
    const next=await dispatchConsoleRequest(port,"relay",{method:"GET",path:"/console/ready",headers:{}});
    assert.equal(next.status,200);assert.deepEqual(JSON.parse(next.body as string),{ready:true});

    const stopWaiting=new AbortController();
    const write=dispatchConsoleRequest(port,"relay",{method:"POST",path:"/console/write",headers:{}},stopWaiting.signal);
    await until(()=>writeStarted,"the HTTP mutation is accepted");stopWaiting.abort();await delay(30);
    assert.equal(writeFinished,false);releaseWrite();assert.equal((await write).status,200);
    assert.equal(await readFile(marker,"utf8"),"committed");
  }finally{
    releaseWrite();http.closeAllConnections();await new Promise<void>(resolve=>http.close(()=>resolve()));
    await rm(directory,{recursive:true,force:true});
  }
});
