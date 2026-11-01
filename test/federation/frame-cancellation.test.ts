import assert from "node:assert/strict";
import test from "node:test";
import {createServer, type Http2Session, type ServerHttp2Stream} from "node:http2";
import {setTimeout as delay} from "node:timers/promises";
import {PeerTransport, RpcRequestTimeoutError, type RpcHandler} from "../../src/federation/transport.js";
import type {FederationConfig} from "../../src/federation/types.js";

async function until(check:()=>boolean, message:string) {
  const end=Date.now()+1500;
  while(!check()){assert.ok(Date.now()<end,message);await delay(10);}
}

// A real HTTP/2 peer that acknowledges the frame stream but stops consuming it.
// This is the receiver-side stall seen during reconnects and oversized snapshots.
async function stalledPeer(handler:RpcHandler) {
  const server=createServer();
  const sessions=new Set<Http2Session>(), frames=new Set<ServerHttp2Stream>();
  const replies:Array<any>=[];
  let control:ServerHttp2Stream|undefined;
  server.on("session",session=>{sessions.add(session);session.on("error",()=>{});session.on("close",()=>sessions.delete(session));});
  server.on("stream",(stream,headers)=>{
    stream.on("error",()=>{});
    if(headers[":path"]==="/control"){
      control=stream;let text="";
      stream.respond({":status":200,"x-quaymesh-node":"target","x-quaymesh-features":"frame-stream-v1"});
      stream.setEncoding("utf8");
      stream.on("data",(part:string)=>{
        text+=part;
        for(;;){const end=text.indexOf("\n");if(end<0)break;const frame=JSON.parse(text.slice(0,end));text=text.slice(end+1);
          replies.push(frame);
          if(frame.id&&frame.method&&!frame.method.startsWith("$"))stream.write(JSON.stringify({id:frame.id,result:"small"})+"\n");
        }
      });
    }else{
      frames.add(stream);stream.on("close",()=>frames.delete(stream));
      stream.respond({":status":200});
      // Deliberately leave the request readable side paused: the real stream's
      // flow-control window fills, so end(callback) cannot finish the payload.
    }
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const config={enabled:true,coordinatorId:"target",nodeId:"caller",nickname:"caller",host:"127.0.0.1",port:0,
    heartbeatMs:100,rpcTimeoutMs:60000,peers:[{id:"target",url:"http://127.0.0.1:"+(server.address() as {port:number}).port}],
    roots:[],tokenEnv:"TEST_TOKEN",priority:0,
    capabilities:{coordinator:false,worker:true,discovery:false,egress:false,meshRelay:false,desktopUi:false,consoleRelay:false},
    egress:{enabled:false,listenPort:0,proxyUrl:"http://127.0.0.1:1",controllerSecretEnv:"TEST_SECRET",probeUrl:"http://example.invalid",probeIntervalMs:15000,recoveryDelayMs:60000,inheritProxy:false},
  } as FederationConfig;
  const transport=new PeerTransport(config,"fixture-secret",handler,()=>{});
  await transport.start();await until(()=>Boolean(transport.links.get("target")?.connected&&control),"control connects");
  const link=transport.links.get("target")!;
  return {link,frames,replies,send:(frame:unknown)=>control!.write(JSON.stringify(frame)+"\n"),
    pauseControl:()=>control!.pause(),resumeControl:()=>control!.resume(),
    close:async()=>{await transport.close();for(const session of sessions)session.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}

test("expired large request releases its stream and leaves control usable",{timeout:8000},async()=>{
  const peer=await stalledPeer(()=>null);
  try{
    await assert.rejects(peer.link.call("bulk",{body:"x".repeat(4*1024*1024)},100),RpcRequestTimeoutError);
    await until(()=>peer.link.diagnostics().outgoingLargeFrames===0,"expired request must release its large-frame slot");
    await until(()=>peer.frames.size===0,"expired request must reset only its abandoned data stream");
    assert.equal(await peer.link.call("small",{},1000),"small");
    assert.equal(peer.link.connected,true);
  }finally{await peer.close();}
});

test("cancelling completed work releases its blocked reply without disconnecting peer",{timeout:8000},async()=>{
  let completed=0;
  const peer=await stalledPeer(method=>{if(method==="bulk"){completed++;return "x".repeat(4*1024*1024);}return "ready";});
  try{
    for(let n=0;n<3;n++){
      const id="reply-"+n;peer.send({id,method:"bulk",params:{}});
      await until(()=>peer.frames.size>0&&peer.link.diagnostics().outgoingLargeFrames===1,"reply enters an independent stream");
      peer.send({method:"$cancel",params:{id}});
      await until(()=>peer.link.diagnostics().outgoingLargeFrames===0&&peer.link.diagnostics().incomingRpc===0,"cancelled reply must release delivery resources");
      await until(()=>peer.frames.size===0,"cancelled reply stream closes");
    }
    assert.equal(completed,3,"delivery cancellation cannot undo already completed work");
    peer.send({id:"after",method:"small",params:{}});
    await until(()=>peer.replies.some(frame=>frame.id==="after"&&frame.result==="ready"),"small replies remain available");
    assert.equal(peer.link.connected,true);
  }finally{await peer.close();}
});

test("cancelling small replies releases request slots while preserving queued-byte accounting",{timeout:8000},async()=>{
  let completed=0;
  const peer=await stalledPeer(method=>{if(method==="small-bulk"){completed++;return "x".repeat(60*1024);}return "ready";});
  try{
    peer.pauseControl();
    const ids=Array.from({length:8},(_,n)=>"small-reply-"+n);
    for(const id of ids)peer.send({id,method:"small-bulk",params:{}});
    await until(()=>completed===ids.length&&Number(peer.link.diagnostics().queuedControlBytes)>0,"small replies fill the real control-stream window");
    await delay(100);
    assert.ok(Number(peer.link.diagnostics().incomingRpc)>0,"completed replies remain blocked by flow control");
    const beforeCancel=peer.link.diagnostics();
    for(const id of ids)peer.send({method:"$cancel",params:{id}});
    await until(()=>peer.link.diagnostics().incomingRpc===0,"cancelled small replies must release request slots");
    assert.ok(Number(peer.link.diagnostics().queuedControlBytes)>0,"cancellation does not discard bytes already queued on the shared stream");
    assert.equal(peer.link.diagnostics().outgoingLargeFrames,0);
    assert.equal(peer.link.connected,true);
    assert.equal(completed,ids.length,"delivery cancellation cannot repeat already completed work");
    assert.ok(Number(beforeCancel.queuedControlBytes)>0);

    peer.resumeControl();
    await until(()=>peer.link.diagnostics().queuedControlBytes===0,"queued bytes are released only after actual delivery");
    peer.send({id:"after-small-cancel",method:"small",params:{}});
    await until(()=>peer.replies.some(frame=>frame.id==="after-small-cancel"&&frame.result==="ready"),"control remains usable after the peer resumes reading");
  }finally{await peer.close();}
});
