import assert from "node:assert/strict";
import {appendFile, mkdir, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {test} from "node:test";
import {ProcessSessionManager} from "../src/process-sessions.js";
import {readOutputTail} from "../src/process-output-evidence.js";
import {WorkLedger} from "../src/work-ledger.js";

const secret="qml1_"+"a".repeat(43), other="qml1_"+"b".repeat(43);
const command=String.raw`
const secret=process.env.QUAYMESH_LOCAL_API_CREDENTIAL;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
  process.stdout.write("ordinary 雪\nQUAYMESH_LOCAL_API_CREDENTIAL="+secret.slice(0,13));
  await delay(40);
  if(process.argv[1]==="pty"){
    process.stdout.write(secret.slice(13)+"\n");
    await delay(40);
    process.stderr.write("stderr="+secret.slice(0,21));
    await delay(40);
    process.stderr.write(secret.slice(21)+"\n");
  }else{
  process.stderr.write("stderr="+secret.slice(0,21));
  await delay(40);
  process.stdout.write(secret.slice(13)+"\n");
  await delay(40);
  process.stderr.write(secret.slice(21)+"\n");
  }
  await delay(40);
  process.stdout.write("dump="+secret+"\nunrelated=qml1_"+"b".repeat(43)+"\nlast=qml1_");
})().catch(()=>{process.exitCode=1;});
`;

for(const tty of process.platform==="win32"?[false]:[false,true])test(`issued local API credential never reaches snapshots, durable sink or output tail (${tty?"pty":"pipes"})`,async()=>{
  const directory=await mkdtemp(join(tmpdir(),"qm-output-secret-")),workspaceRoot=join(directory,"workspace"),stateDir=join(directory,"state"),sinkFile=join(directory,"persisted-output.log");
  await mkdir(workspaceRoot,{recursive:true});
  let ledger:WorkLedger|undefined,manager:ProcessSessionManager|undefined;
  try{
    ledger=new WorkLedger(stateDir);
    const run=ledger.begin({root:workspaceRoot,workspaceId:"ws",workItemId:"secret-output",runKey:"once",title:"Output redaction fixture",
      origin:{entryPoint:"qm_cli",evidence:"server_entry"}});
    manager=new ProcessSessionManager({stateDir,executionEnvironment:async()=>({QUAYMESH_LOCAL_API_CREDENTIAL:secret})});
    const persistedChunks:string[]=[];let finished=false;
    manager.setOutputSink({
      async open(){await writeFile(sinkFile,"",{mode:0o600});},
      async append(_operationId,output){persistedChunks.push(output);await appendFile(sinkFile,output);},
      async finish(){finished=true;},
    });
    let snapshot=await manager.start({workspaceId:"ws",workspaceRoot,cwd:workspaceRoot,scopeRoot:workspaceRoot,tty,
      command:"Node local API output redaction fixture",program:{executable:process.execPath,args:["-e",command,tty?"pty":"pipes"]},
      workRunId:run.id,sessionOperationId:"op_local_api_output_fixture",yieldTimeMs:1000,maxOutputTokens:2000});
    let output=snapshot.output;const expires=Date.now()+10000;
    while(snapshot.running&&Date.now()<expires){
      snapshot=await manager.write({workspaceId:"ws",sessionId:snapshot.sessionId!,chars:"",yieldTimeMs:1000,maxOutputTokens:2000});
      output+=snapshot.output;
    }
    assert.equal(snapshot.running,false,"the actual managed process must reach a terminal result");
    assert.equal(snapshot.exitCode,0);assert.equal(snapshot.outputComplete,true);assert.equal(finished,true);
    assert.ok(snapshot.operationId);
    const sink=await readFile(sinkFile,"utf8"),tail=readOutputTail(stateDir,snapshot.operationId!);
    assert.ok(tail,"the actual managed output tail must exist");
    for(const text of [output,sink,tail!,...persistedChunks])assert.equal(text.includes(secret),false,"no emitted or durable output may contain the minted credential");
    for(const text of [output,sink,tail!]){
      assert.ok(text.includes("ordinary 雪"));assert.ok(text.includes(other),"a different value is outside this exact-secret filter");
      assert.ok(text.includes("[redacted]"));assert.ok(text.endsWith("last=qml1_"),"EOF must release an unmatched normal prefix");
    }
  }finally{await manager?.shutdown();ledger?.close();await rm(directory,{recursive:true,force:true});}
});
