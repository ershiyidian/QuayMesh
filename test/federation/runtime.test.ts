import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile,readFile,mkdir,readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { federationConfigSchema } from '../../src/federation/schema.js';
import { probeProxy } from '../../src/federation/egress.js';
import { createRealTestServer,freePort,structured,type RealTestServer } from '../session-card/server-fixture.js';

const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check:()=>boolean|Promise<boolean>,ms=15000){const end=Date.now()+ms;while(Date.now()<end){if(await check())return;await pause(30);}throw new Error('实际节点状态未改变');}
async function cluster(t:test.TestContext){
  const ids=['cloud','s1','s2','desktop'];
  const rpc=await Promise.all(ids.map(()=>freePort())),ingress=await Promise.all(ids.map(()=>freePort()));
  const servers:RealTestServer[]=[];
  t.after(async()=>{for(const server of servers.reverse())await server.dispose();});
  for(let index=0;index<ids.length;index++){
    const node=ids[index];
    const server=await createRealTestServer({git:false,uiEnabled:true,configure:async config=>{
      const tokenFile=join(config.configDir,'cluster.token');await writeFile(tokenFile,'quaymesh-four-real-core-token-long-enough');
      return {...config,federation:federationConfigSchema.parse({enabled:true,nodeId:node,nickname:node,coordinatorId:'cloud',host:'127.0.0.1',port:rpc[index],ingressPort:ingress[index],tokenFile,
        capabilities:{coordinator:node==='cloud',worker:node!=='cloud'},priority:0,heartbeatMs:1000,rpcTimeoutMs:30000,
        peers:ids.filter(id=>id!==node).map(id=>({id,url:id==='desktop'?'':`http://127.0.0.1:${rpc[ids.indexOf(id)]}`})),
        roots:node==='cloud'?[]:[{id:'main',nickname:node,path:config.allowedRoots[0]}],egress:{enabled:false}})};
    }});
    servers.push(server);await server.running.ready;
    await writeFile(join(server.project,'source.bin'),Buffer.alloc(3*1024*1024,index+1));
  }
  await until(()=>servers.every(server=>server.running.federation!.nodes().every(node=>node.online)));
  return Object.fromEntries(ids.map((id,index)=>[id,servers[index]])) as Record<string,RealTestServer>;
}
function copied(result:any){
  assert.notEqual(result.isError,true,JSON.stringify(result.content));
  const value=structured(result);
  assert.equal(typeof value.id,"string","复制回执必须有稳定 ID");
  assert.equal(typeof value.status,"string","复制回执必须保留状态");
  return value;
}

test('四个真实Core完成远端读写、受管命令、双向复制、幂等查询与节点离线恢复',{timeout:120000},async t=>{
  const envKeys = ['QUAYMESH_NODE_ADMIN_URL', 'QUAYMESH_CLUSTER_TOKEN'] as const;
  const previousEnv = new Map(envKeys.map(key => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];
  t.after(() => {
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const c=await cluster(t),client=c.cloud.client,meta={'openai/session':'real-federation-workflow'};
  const task=structured(await client.callTool({name:'start_session',arguments:{title:'四节点验证',request_key:'four-node-request'},_meta:meta}));
  const opened=structured(await client.callTool({name:'open_workspace',arguments:{root_id:'s2/main'},_meta:meta}));
  const desktop=structured(await client.callTool({name:'attach_workspace',arguments:{root_id:'desktop/main',session_id:task.session_id},_meta:meta}));
  const catalog=structured(await client.callTool({name:'workspace_catalog',arguments:{}}));
  assert.equal((catalog.workspaces as any[]).length,3);
  assert.match(opened.workspace_id,/^qm:s2:/);assert.match(desktop.workspace_id,/^qm:desktop:/);
  const read=await client.callTool({name:'read',arguments:{workspace_id:opened.workspace_id,path:'README.md'},_meta:meta});
  assert.notEqual(read.isError,true);assert.match(structured(read).result,/session card test fixture/);
  const patch=await client.callTool({name:'apply_patch',arguments:{workspace_id:opened.workspace_id,
    patch:'*** Begin Patch\n*** Add File: proof.txt\n+real remote write\n*** End Patch'},_meta:meta});
  assert.notEqual(patch.isError,true,JSON.stringify(patch.content));assert.equal(await readFile(join(c.s2.project,'proof.txt'),'utf8'),'real remote write\n');
  const program=join(c.s2.project,'read-proof.mjs');await writeFile(program,"import {readFileSync} from 'node:fs';console.log(readFileSync(new URL('./proof.txt',import.meta.url),'utf8'));\n");
  let command=structured(await client.callTool({name:'exec_command',arguments:{workspace_id:opened.workspace_id,cmd:`"${process.execPath}" "${program}"`,yield_time_ms:1000},_meta:meta}));
  let output=command.result;
  for(let i=0;i<30&&command.running;i++){command=structured(await client.callTool({name:'write_stdin',arguments:{workspace_id:opened.workspace_id,session_id:command.session_id,chars:'',yield_time_ms:500},_meta:meta}));output+='\n'+command.result;}
  assert.equal(command.exit_code,0);assert.match(output,/real remote write/);
  for(const [source,destination,sourceWorkspace,destinationWorkspace] of [
    ['s2','desktop',opened.workspace_id,desktop.workspace_id],['desktop','s2',desktop.workspace_id,opened.workspace_id],
  ]){
    const args={action:'start',request_key:`copy-${source}-${destination}`,source_workspace_id:sourceWorkspace,destination_workspace_id:destinationWorkspace,source_path:'source.bin',destination_path:`from-${source}.bin`};
    const started=copied(await client.callTool({name:'copy_artifact',arguments:args,_meta:meta}));
    const replay=copied(await client.callTool({name:'copy_artifact',arguments:args,_meta:meta}));assert.equal(replay.id,started.id);
    let final=started;
    await until(async()=>{final=copied(await client.callTool({name:'copy_artifact',arguments:{action:'observe',copy_id:started.id},_meta:meta}));return final.status!=='running';});
    assert.equal(final.status,'completed',final.error);assert.equal(final.bytes,3*1024*1024);
    assert.deepEqual(await readFile(join(c[destination].project,`from-${source}.bin`)),await readFile(join(c[source].project,'source.bin')));
    assert.equal((await readdir(c[destination].project)).some(name=>name.endsWith('.part')),false);
  }
  const sleeper=structured(await client.callTool({name:'exec_command',arguments:{
    workspace_id:opened.workspace_id,cmd:`"${process.execPath}" -e "setTimeout(() => {}, 30000)"`,yield_time_ms:100,
  },_meta:meta}));
  assert.equal(sleeper.running,true);
  const cancelled=structured(await client.callTool({name:'cancel_command',arguments:{
    workspace_id:opened.workspace_id,operation_id:sleeper.operation_id,
  },_meta:meta}));
  assert.equal(cancelled.cancel_requested,true);
  let latestCancelledOutput:any=null;
  await until(async()=>{
    const state=structured(await client.callTool({name:'read_output',arguments:{
      workspace_id:opened.workspace_id,operation_id:sleeper.operation_id,
    },_meta:meta}));
    latestCancelledOutput=state;
    return state.process_done && state.operation_state==='cancelled';
  },10000).catch(error=>{throw new Error(`${error.message}: ${JSON.stringify(latestCancelledOutput)}`);});
  const finished=structured(await client.callTool({name:'finish_task',arguments:{task_id:task.task_id,status:'completed',summary:'真实跨节点操作完成'},_meta:meta}));
  assert.equal(finished.state,'closed');
  const additional=join(c.s2.project,'additional');await mkdir(additional);
  await assert.rejects(c.cloud.running.federation!.request('s2','settings.get',{}),/节点管理服务地址未配置/);
  await assert.rejects(c.cloud.running.federation!.request('s2','settings.update',{expectedRevision:0,nickname:'计算节点二',roots:[
    {id:'main',nickname:'主项目',path:c.s2.project,enabled:true,tags:[],description:''},
    {id:'additional',nickname:'额外目录',path:additional,enabled:true,tags:['extra'],description:''},
  ]}),/节点管理服务地址未配置/);
  assert.equal(c.cloud.running.federation!.nodes().find(node=>node.id==='s2')?.nickname,'s2');
  const updated=structured(await client.callTool({name:'workspace_catalog',arguments:{query:'extra'}}));
  assert.equal(updated.workspaces.length,0,'Core-only fixture must not pretend an unsaved root was published');
  await c.s1.running.federation!.close();
  await until(()=>!c.desktop.running.federation!.nodes().find(node=>node.id==='s1')?.online);
  const remaining=await client.callTool({name:'read',arguments:{workspace_id:opened.workspace_id,path:'proof.txt'},_meta:meta});
  assert.notEqual(remaining.isError,true,JSON.stringify(remaining.content));assert.match(structured(remaining).result,/real remote write/);
  const cloud=c.desktop.running.federation!.nodes().find(node=>node.id==='cloud');assert.equal(cloud?.online,true);
});

test('联邦节点缓存损坏时仍能启动并忽略缓存',{timeout:30000},async t=>{
  const previousToken=process.env.QUAYMESH_CLUSTER_TOKEN;
  t.after(()=>{if(previousToken===undefined)delete process.env.QUAYMESH_CLUSTER_TOKEN;else process.env.QUAYMESH_CLUSTER_TOKEN=previousToken;});
  process.env.QUAYMESH_CLUSTER_TOKEN='quaymesh-corrupt-cache-token-long-enough';
  const rpc=await freePort(),ingress=await freePort();
  const server=await createRealTestServer({git:false,uiEnabled:false,federation:{nodeId:'desktop',nickname:'桌面电脑',capabilities:{coordinator:false,worker:true,discovery:false,egress:false,meshRelay:false,desktopUi:true,consoleRelay:false},priority:0,port:rpc,ingressPort:ingress,peers:[]},configure:async config=>{
    await writeFile(join(config.stateDir,'federation-nodes.json'),Buffer.alloc(4096));
    await writeFile(join(config.configDir,'cluster.token'),'quaymesh-corrupt-cache-token-long-enough');
    return config;
  }});
  t.after(()=>server.dispose());
  assert.equal(server.running.federation?.startupError,undefined);
  assert.equal(server.running.federation?.nodes().some(node=>node.id==='desktop'),true);
});
test('代理探测依据真实HTTP目标响应，目标停止后不会仅凭监听端口判定健康',async t=>{
  const target=createServer((_req,res)=>res.writeHead(204).end());
  await new Promise<void>(resolve=>target.listen(0,'127.0.0.1',resolve));const targetPort=(target.address() as {port:number}).port;
  const sockets=new Set<import('node:net').Socket>();
  const proxy=createServer();
  proxy.on('connect',(_req,client,head)=>{
    const upstream=connect(targetPort,'127.0.0.1');sockets.add(client);sockets.add(upstream);
    client.on('error',()=>upstream.destroy());upstream.on('error',()=>{client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');});
    client.once('close',()=>{sockets.delete(client);upstream.destroy();});upstream.once('close',()=>sockets.delete(upstream));
    upstream.once('connect',()=>{client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);client.pipe(upstream);upstream.pipe(client);});
  });
  await new Promise<void>(resolve=>proxy.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>proxy.close(()=>resolve()));if(target.listening)await new Promise<void>(resolve=>target.close(()=>resolve()));});
  const proxyUrl=`http://127.0.0.1:${(proxy.address() as {port:number}).port}`;
  await probeProxy(proxyUrl,`http://127.0.0.1:${targetPort}/`,2000);
  await new Promise<void>(resolve=>target.close(()=>resolve()));
  await assert.rejects(probeProxy(proxyUrl,`http://127.0.0.1:${targetPort}/`,2000));
});
