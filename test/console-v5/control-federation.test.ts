import assert from 'node:assert/strict';
import test from 'node:test';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {federationConfigSchema} from '../../src/federation/schema.js';
import {WorkLedger} from '../../src/work-ledger.js';
import {createRealTestServer,freePort,structured,type RealTestServer} from '../session-card/server-fixture.js';

async function until(check:()=>boolean|Promise<boolean>,timeout=15000){
  const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await delay(30);}throw new Error('Expected real node state did not settle');
}

test('cross-node stop preserves per-phase effects and reconciles the original target plan after a lost parent receipt',{timeout:90000},async t=>{
  const ids=['cloud','worker-a','worker-b'],ports=await Promise.all(ids.map(()=>freePort())),ingress=await Promise.all(ids.map(()=>freePort()));
  const nodes:RealTestServer[]=[];
  t.after(async()=>{for(const node of nodes.reverse())await node.dispose();});
  for(let index=0;index<ids.length;index++){
    const nodeId=ids[index];
    nodes.push(await createRealTestServer({git:false,prefix:'qm-console-dispatch-',configure:async config=>{
      const tokenFile=join(config.configDir,'cluster.token');await writeFile(tokenFile,'console-cross-node-real-regression-token');
      return {...config,federation:federationConfigSchema.parse({enabled:true,nodeId,nickname:nodeId,coordinatorId:'cloud',host:'127.0.0.1',port:ports[index],ingressPort:ingress[index],tokenFile,
        capabilities:{coordinator:nodeId==='cloud',worker:nodeId!=='cloud'},priority:0,heartbeatMs:1000,rpcTimeoutMs:5000,
        peers:ids.filter(id=>id!==nodeId).map(id=>({id,url:`http://127.0.0.1:${ports[ids.indexOf(id)]}`})),
        roots:nodeId==='cloud'?[]:[{id:'main',nickname:nodeId,path:config.allowedRoots[0]}],egress:{enabled:false}})};
    }}));
  }
  await until(()=>nodes.every(node=>node.running.federation!.nodes().every(peer=>peer.online)));
  const [cloud,a,b]=nodes,meta={'openai/session':'console-dispatch-regression'},client=cloud.client;
  const invoke=async(name:string,args:Record<string,unknown>)=>{const result=await client.callTool({name,arguments:args,_meta:meta});assert.notEqual(result.isError,true,JSON.stringify(result));return structured(result);};
  const task=await invoke('start_session',{title:'跨节点控制回执',request_key:'cross-node-console-task'});
  const first=await invoke('open_workspace',{root_id:'worker-a/main'});
  const second=await invoke('attach_workspace',{root_id:'worker-b/main',session_id:task.session_id});
  await invoke('apply_patch',{workspace_id:second.workspace_id,patch:'*** Begin Patch\n*** Add File: proof.txt\n+waiting phase\n*** End Patch'});
  for(const worker of [a,b])await writeFile(join(worker.project,'long.mjs'),"process.stdout.write('started\\n');setInterval(()=>{},1000);\n");
  const start=async(worker:RealTestServer,workspace:unknown,key:string)=>invoke('exec_command',{workspace_id:workspace,cmd:`"${process.execPath}" "${join(worker.project,'long.mjs')}"`,operation_key:key,yield_time_ms:100});
  const operation=await start(a,first.workspace_id,'first-command');
  const login=await fetch(cloud.baseUrl+'/console/api/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:cloud.baseUrl},body:JSON.stringify({password:'test-owner-token-that-is-long-enough'})});
  assert.equal(login.status,200);const cookie=login.headers.getSetCookie()[0].split(';')[0],{csrf}=await login.json() as {csrf:string};
  const request=async(path:string,body?:unknown)=>{
    const response=await fetch(cloud.baseUrl+'/console/api/v4/'+path,{method:body===undefined?'GET':'POST',headers:{Cookie:cookie,Origin:cloud.baseUrl,'Content-Type':'application/json','X-QuayMesh-CSRF':csrf},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,value:await response.json() as any};
  };
  const api=async(path:string,body?:unknown):Promise<any>=>{
    const result=await request(path,body);assert.equal(result.status,200,JSON.stringify(result.value));return result.value;
  };
  const reference='qmtask:'+task.task_id,path='runs/'+encodeURIComponent(reference);
  const detail=await api(path);assert.equal(detail.run.actions.interrupt,true);assert.equal(detail.phases.length,2);
  const body={action:'interrupt',expectedRevision:detail.run.revision,requestKey:'stop-original-targets'};
  const result=await api(path+'/control',body);assert.equal(result.effect,'applied');assert.equal(result.results.length,1);
  await until(async()=>{const output=await invoke('read_output',{workspace_id:first.workspace_id,operation_id:operation.operation_id,wait_ms:100});return output.process_done===true;});
  const ledger=new WorkLedger(cloud.config.stateDir);
  try{
    ledger.db.prepare("UPDATE console_write_receipts SET state='unknown',response_json=NULL WHERE scope=? AND request_key=?")
      .run(`console:/api/v4/${path}/control:`,body.requestKey);
    const recovered=await api('receipts/'+body.requestKey+'?'+new URLSearchParams({path:'/api/v4/'+path+'/control'}));
    assert.equal(recovered.state,'completed');assert.equal(recovered.effect,'applied');assert.equal(recovered.response.results.length,1);
    assert.deepEqual(await api(path+'/control',body),recovered.response);
  }finally{ledger.close();}

  const activeA=await start(a,first.workspace_id,'second-command-a');await start(b,second.workspace_id,'second-command-b');
  await b.running.federation!.transport.close();
  await until(()=>cloud.running.federation!.nodes().find(node=>node.id==='worker-b')?.online===false);
  let partial:any;
  for(let attempt=0;attempt<4;attempt++){
    const current=await api(path+'?fresh=1');assert.equal(current.complete,false);
    const key='stop-with-missing-node-'+attempt;
    const result=await request(path+'/control',{action:'interrupt',expectedRevision:current.run.revision,requestKey:key});
    if(result.status===200){partial=result.value;break;}
    assert.equal(result.status,409,JSON.stringify(result.value));assert.equal(result.value.code,'revision_conflict');assert.equal(result.value.effect,'none');
    const proof=new WorkLedger(cloud.config.stateDir);
    try{assert.equal((proof.db.prepare("SELECT COUNT(*) count FROM console_write_receipts WHERE scope=? AND request_key=?").get(`console-plan:/api/v4/${path}/control`,key) as {count:number}).count,0);}
    finally{proof.close();}
    const active=await invoke('read_output',{workspace_id:first.workspace_id,operation_id:activeA.operation_id,wait_ms:0});
    assert.equal(active.process_done,false,'a rejected stale request must not stop the known command');
  }
  assert.ok(partial,'fresh reads and bounded explicit retries must permit stopping the reachable member');
  assert.equal(partial.effect,'partial');assert.ok(partial.results.some((value:any)=>value.nodeId==='worker-a'&&value.ok));
  assert.ok(partial.missingNodes.includes('worker-b'));
  await until(async()=>{const output=await invoke('read_output',{workspace_id:first.workspace_id,operation_id:activeA.operation_id,wait_ms:100});return output.process_done===true;});
});
