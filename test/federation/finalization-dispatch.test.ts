import assert from "node:assert/strict";
import test from "node:test";
import { PeerTransport, NodeUnavailableError, PeerApplicationError, RpcInterruptedError } from "../../src/federation/transport.js";
import { dispatchPeerRequest, isIdempotentPeerRequest, locallyUnsentPeerRequest } from "../../src/federation/read-retry.js";
import type { FederationConfig } from "../../src/federation/types.js";

function config(nodeId:string):FederationConfig {
  return {enabled:true,coordinatorId:"coordinator",nodeId,nickname:nodeId,
    capabilities:{coordinator:nodeId==="coordinator",worker:nodeId!=="coordinator",discovery:false,egress:false,meshRelay:false,desktopUi:false,consoleRelay:false},
    priority:0,host:"127.0.0.1",port:0,tokenEnv:"QUAYMESH_UNUSED_TEST_TOKEN",peers:[],roots:[],heartbeatMs:300,rpcTimeoutMs:3000,
    egress:{enabled:false,listenPort:0,proxyUrl:"http://127.0.0.1:7890",controllerSecretEnv:"UNUSED",probeUrl:"https://example.invalid",probeIntervalMs:15000,recoveryDelayMs:1000,inheritProxy:false}};
}
async function until(check:()=>boolean) {
  const deadline=Date.now()+6000;
  while(!check()){if(Date.now()>=deadline)throw new Error("actual peer connection did not become ready");await new Promise(resolve=>setTimeout(resolve,20));}
}

test("session.feed only retries explicit snapshot/revision/subscription reads; remote not_started is not local unsent proof",()=>{
  for(const kind of ["snapshot","revision","subscribe","unsubscribe"])assert.equal(isIdempotentPeerRequest("session.feed",{kind}),true);
  for(const kind of ["finalize","archive","future-mutation",undefined])assert.equal(isIdempotentPeerRequest("session.feed",{kind}),false);
  const local=Object.assign(new NodeUnavailableError("worker"),{effect:"not_started",details:{dispatch_state:"not_sent"}});
  assert.equal(locallyUnsentPeerRequest(local),true);
  assert.equal(locallyUnsentPeerRequest(new NodeUnavailableError("worker")),false,"old/read-retry offline errors do not prove no dispatch");
  assert.equal(locallyUnsentPeerRequest(new PeerApplicationError("worker","claimed unsent","NODE_UNAVAILABLE",
    {message:"claimed unsent",effect:"not_started",details:{dispatch_state:"not_sent"}})),false);
  assert.equal(locallyUnsentPeerRequest(new RpcInterruptedError("worker","request","already sent")),false);
});

for(const kind of ["finalize","archive"] as const)test(`actual peer disconnect: ${kind} is sent once and preserves the first interrupted outcome`,{timeout:15000},async t=>{
  const first=config("coordinator"),second=config("worker");first.peers=[{id:"worker",url:""}];
  let received=0,lookups=0;
  const coordinator=new PeerTransport(first,"finalization-disconnect-test-cluster-secret",()=>null,()=>{});
  await coordinator.start();second.peers=[{id:"coordinator",url:`http://127.0.0.1:${coordinator.address}`}];
  let worker:PeerTransport;
  worker=new PeerTransport(second,"finalization-disconnect-test-cluster-secret",(method,params)=>{
    assert.equal(method,"session.feed");assert.equal(params.kind,kind);received++;
    worker.links.get("coordinator")!.close("test response lost after owner received mutation");
    return {received:true};
  },()=>{});
  t.after(async()=>{await worker.close();await coordinator.close();});
  await worker.start();await until(()=>Boolean(coordinator.links.get("worker")?.connected));
  const result=dispatchPeerRequest({node:"worker",method:"session.feed",params:{kind},rpcTimeoutMs:3000,getLink:()=>{
    lookups++;
    const link=coordinator.links.get("worker");
    return link?{connected:link.connected,call:(timeout:number)=>link.call("session.feed",{kind},timeout),close:()=>link.close()}:undefined;
  }});
  await assert.rejects(result,(error:unknown)=>{
    assert.ok(error instanceof RpcInterruptedError);assert.equal(locallyUnsentPeerRequest(error),false);return true;
  });
  assert.equal(received,1);assert.equal(lookups,1,"no read retry may replace a dispatched interruption with a later offline error");
});
