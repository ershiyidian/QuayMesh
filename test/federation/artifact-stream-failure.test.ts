import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {readFile,readdir,unlink,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import test from "node:test";
import {ExecutionConflictError} from "../../src/execution-coordinator.js";
import {federationConfigSchema} from "../../src/federation/schema.js";
import type {TransferView} from "../../src/federation/transfer-store.js";
import {createRealTestServer,freePort,type RealTestServer} from "../session-card/server-fixture.js";

async function until(check:()=>boolean|Promise<boolean>){
  const deadline=Date.now()+10000;
  while(Date.now()<deadline){if(await check())return;await delay(20);}
  throw new Error("实际复制状态未按时到达");
}

test("真实双向复制保留源读取拒绝身份，空文件不能把失败流当成成功",{timeout:60000},async t=>{
  const token=randomUUID(),ports=[await freePort(),await freePort()],servers:RealTestServer[]=[];
  t.after(async()=>{for(const server of servers.reverse())await server.dispose();});
  for(const [index,id] of ["cloud","worker"].entries()){
    const server=await createRealTestServer({git:false,configure:async config=>{
      const tokenFile=join(config.configDir,"cluster.token");await writeFile(tokenFile,token);
      return {...config,artifactsEnabled:true,subagents:{...config.subagents,enabled:false,providers:[]},
        federation:federationConfigSchema.parse({enabled:true,nodeId:id,coordinatorId:"cloud",host:"127.0.0.1",port:ports[index],
          ingressPort:await freePort(),tokenFile,capabilities:{coordinator:id==="cloud",worker:true},
          // One outbound connection exercises both normal and reverse byte streams.
          peers:[{id:id==="cloud"?"worker":"cloud",url:id==="cloud"?"":`http://127.0.0.1:${ports[0]}`}],
          roots:[{id:"main",nickname:id,path:config.allowedRoots[0]}],egress:{enabled:false},heartbeatMs:1000})};
    }});
    servers.push(server);
  }
  const [cloud,worker]=servers,meta={"openai/session":randomUUID()};
  await until(()=>cloud.running.federation!.nodes().some(node=>node.id==="worker"&&node.online));
  const cloudLink=cloud.running.federation!.transport.links.get("worker")!,workerLink=worker.running.federation!.transport.links.get("cloud")!;
  assert.equal(cloudLink.client,undefined);assert.ok(workerLink.client);
  const assertSameLinks=()=>{
    assert.equal(cloud.running.federation!.transport.links.get("worker"),cloudLink);
    assert.equal(worker.running.federation!.transport.links.get("cloud"),workerLink);
    assert.equal(cloudLink.connected,true);assert.equal(workerLink.connected,true);
  };
  const call=async<T>(name:string,args:Record<string,unknown>):Promise<T>=>{
    const result=await cloud.client.callTool({name,arguments:args,_meta:meta});
    assert.notEqual(result.isError,true,JSON.stringify(result));assert.ok(result.structuredContent);
    return result.structuredContent as T;
  };
  const settled=async(id:string)=>{
    let view:TransferView|undefined;
    await until(async()=>{view=await call<TransferView>("copy_artifact",{action:"observe",copy_id:id});return view.status!=="running";});
    return view!;
  };
  await call("start_session",{title:"Copy source admission",request_key:randomUUID()});
  const workspaces={cloud:await call<{workspace_id:string}>("open_workspace",{root_id:"cloud/main"}),
    worker:await call<{workspace_id:string}>("attach_workspace",{root_id:"worker/main"})};
  for(const bytes of [76685,593990,0])for(const [sourceId,destinationId,source,destination] of [
    ["worker","cloud",worker,cloud],["cloud","worker",cloud,worker],
  ] as const)await t.test(`${sourceId} → ${destinationId}, ${bytes} bytes`,async()=>{
    const name=`source-${bytes}.bin`,sourcePath=join(source.project,name),payload=Buffer.alloc(bytes,0x61);
    await writeFile(sourcePath,payload);
    const hooks=source.running.federation!.hooks,originalRead=hooks.artifactRead,conflicts:ExecutionConflictError[]=[];
    // Source preparation finishes after the byte-stream handshake starts.
    // Both normal and reverse paths must retain this real admission failure.
    hooks.artifactRead=async input=>{await delay(10);try{return await originalRead(input);}catch(error){
      if(error instanceof ExecutionConflictError)conflicts.push(error);throw error;
    }};
    const blockerOperation="source-writer-"+randomUUID(),privateTitle="private source writer title must not cross the peer boundary";
    const owner=source.running.execution.acquire({workspaceRoot:source.project,kind:"mutation",operationId:blockerOperation,title:privateTitle,
      scopes:[{kind:"tree",path:source.project,access:"write"}]});
    const args={action:"start",request_key:randomUUID(),source_workspace_id:workspaces[sourceId].workspace_id,
      destination_workspace_id:workspaces[destinationId].workspace_id,source_path:name,destination_path:`blocked-${sourceId}-${bytes}.bin`};
    let failed:TransferView;
    try{
      const started=await call<TransferView>("copy_artifact",args);
      failed=await settled(started.id);
      assertSameLinks();
      assert.equal(conflicts.length,1);assert.equal(conflicts[0].code,"EXECUTION_CONFLICT");
      assert.equal(conflicts[0].effect,"not_started");assert.equal(conflicts[0].claimId,owner.id);
      assert.equal(failed.status,"failed");assert.equal(failed.bytes,0);assert.equal(failed.totalBytes,bytes);
      assert.match(failed.error??"",/EXECUTION_CONFLICT/);
      assert.ok(failed.error?.includes(`(${sourceId})`),"失败回执保留源节点身份");
      assert.ok(failed.error?.includes(owner.id),"失败回执保留占用claim身份");
      assert.ok(failed.error?.includes(blockerOperation),"失败回执保留占用operation身份");
      assert.equal(failed.error?.includes(privateTitle),false,"源任务私有标题不能通过错误回执泄漏");
      assert.doesNotMatch(failed.error??"",/Premature close|NGHTTP2_INTERNAL_ERROR/);
      assert.deepEqual(await readFile(sourcePath),payload,"源拒绝读取时，原文件没有变化");
      assert.equal((await readdir(destination.project)).some(file=>file===args.destination_path||file.endsWith(".part")),false);
    }finally{await owner.releaseAsync();hooks.artifactRead=originalRead;}
    assert.deepEqual(await call<TransferView>("copy_artifact",args),failed,"释放锁不把原失败回执隐式重跑");
    const retry={...args,request_key:randomUUID(),destination_path:`copied-${sourceId}-${bytes}.bin`};
    const started=await call<TransferView>("copy_artifact",retry),completed=await settled(started.id);
    assertSameLinks();
    assert.equal(completed.status,"completed",completed.error);assert.equal(completed.bytes,bytes);assert.equal(completed.totalBytes,bytes);
    assert.deepEqual(await readFile(join(destination.project,retry.destination_path)),payload,"解锁后的正常复制保留完整内容，也允许真实空文件");
    assert.equal((await readdir(destination.project)).some(file=>file.endsWith(".part")),false);
  });
  for(const [sourceId,destinationId,source,destination] of [
    ["worker","cloud",worker,cloud],["cloud","worker",cloud,worker],
  ] as const)await t.test(`${sourceId} → ${destinationId}, source removed after stat`,async()=>{
    const name=`removed-${sourceId}.bin`,path=join(source.project,name);
    await writeFile(path,"source existed during stat");
    const hooks=source.running.federation!.hooks,originalRead=hooks.artifactRead;
    hooks.artifactRead=async input=>{await unlink(path);return originalRead(input);};
    const args={action:"start",request_key:randomUUID(),source_workspace_id:workspaces[sourceId].workspace_id,
      destination_workspace_id:workspaces[destinationId].workspace_id,source_path:name,destination_path:`missing-${sourceId}.bin`};
    try {
      const started=await call<TransferView>("copy_artifact",args),failed=await settled(started.id);
      assertSameLinks();
      assert.equal(failed.status,"failed");assert.equal(failed.bytes,0);
      assert.equal(failed.totalBytes,Buffer.byteLength("source existed during stat"));
      assert.match(failed.error??"",/ENOENT/);
      assert.ok(failed.error?.includes(`(${sourceId})`));
      assert.doesNotMatch(failed.error??"",/Premature close|NGHTTP2_INTERNAL_ERROR|\[object Object\]/);
      assert.equal((await readdir(destination.project)).some(file=>file===args.destination_path||file.endsWith(".part")),false);
      assert.deepEqual(await call<TransferView>("copy_artifact",args),failed,"源文件错误也只重放原失败回执");
    } finally {hooks.artifactRead=originalRead;}
  });
});
