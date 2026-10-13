import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ProcessSessionManager, type ProcessOutputSink } from "../../src/process-sessions.js";
import { SessionOutputStore } from "../../src/session/output.js";

class OrderedSink implements ProcessOutputSink {
  readonly chunks:string[]=[];
  finished=false;
  appendAfterFinish=false;
  async open():Promise<void>{}
  async append(_operationId:string,output:string):Promise<void>{
    await delay(2);
    if(this.finished){this.appendAfterFinish=true;throw new Error("OUTPUT_ALREADY_FINISHED");}
    this.chunks.push(output);
  }
  async finish():Promise<void>{this.finished=true;}
}

test("OP01/OP02：进程关闭后等待两个输出管道和持久写入，再发布终态",{timeout:60000},async()=>{
  for(let attempt=0;attempt<12;attempt++){
    const sink=new OrderedSink(),manager=new ProcessSessionManager();
    manager.setOutputSink(sink);
    try{
      const source=`for(let i=0;i<128;i++){console.log('O'+i);console.error('E'+i);}`;
      const result=await manager.start({workspaceId:"ws",cwd:process.cwd(),command:`"${process.execPath}" -e ${JSON.stringify(source)}`,
        sessionOperationId:`op_${attempt}`,yieldTimeMs:12000});
      assert.equal(result.running,false);
      assert.equal(result.exitCode,0);
      assert.equal(result.disposition,"completed");
      assert.equal(result.outputComplete,true);
      assert.equal(sink.appendAfterFinish,false);
      assert.equal(sink.finished,true);
      const output=sink.chunks.join("");
      for(let index=0;index<128;index++){assert.match(output,new RegExp(`O${index}\\n`));assert.match(output,new RegExp(`E${index}\\n`));}
    } finally {await manager.shutdown();}
  }
});

test("OP03：持久输出明确区分 writing、ready、incomplete 和 expired",async()=>{
  const root=await mkdtemp(join(tmpdir(),"qm-output-state-"));
  try{
    const store=new SessionOutputStore(root,1024);
    await store.open("session","ready","ready");
    await store.append("ready","hello");
    assert.equal((await store.read("session","ready",0,100,"model")).outputState,"writing");
    await store.finish("ready",0,null);
    const ready=await store.read("session","ready",0,100,"model");
    assert.equal(ready.outputState,"ready");assert.equal(ready.processDone,true);assert.equal(ready.errorCode,null);

    await store.open("session","incomplete","incomplete");
    await store.append("incomplete","partial");
    await store.fail("incomplete","OUTPUT_PERSIST_FAILED",0,null);
    const incomplete=await store.read("session","incomplete",0,100,"model");
    assert.equal(incomplete.outputState,"incomplete");assert.equal(incomplete.processDone,true);
    assert.equal(incomplete.errorCode,"OUTPUT_PERSIST_FAILED");

    await store.expire("ready","2026-10-08T00:00:00.000Z");
    await assert.rejects(store.read("session","ready",0,100,"model"),/OUTPUT_EXPIRED/);
    await store.close();
  } finally {await rm(root,{recursive:true,force:true});}
});
