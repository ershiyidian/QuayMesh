import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp,mkdir,writeFile,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { QuayMeshNode } from '../node/app.mjs';
import { loadNodeConfig } from '../node/config.mjs';
import { requestJson } from '../node/network.mjs';

async function port(){
  const server=createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const value=server.address().port;
  await new Promise(resolve=>server.close(resolve));return value;
}
async function until(predicate){
  const end=Date.now()+30000;
  while(Date.now()<end){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,100));}
  throw new Error('节点实际状态未按预期改变');
}
test('真实节点启动Core后，失败的公共配置不会覆盖已应用快照，后续合法版本可以恢复', {timeout:90000},async t=>{
  const directory=await mkdtemp(join(tmpdir(),'quaymesh-node-application-'));
  const workspace=join(directory,'workspace');await mkdir(workspace);
  const ports=[];
  while(ports.length<6){const value=await port();if(!ports.includes(value))ports.push(value);}
  const cluster={schemaVersion:1,id:'application-test',coordinator:{id:'local',address:'127.0.0.1',apiPort:ports[0],mcpPort:ports[1],peerPort:ports[2]},
    mesh:{networkName:'application-test',peers:['udp://127.0.0.1:11010']},
    discovery:{localPort:ports[3],healthPort:ports[4]},egress:{priorities:{}}};
  await writeFile(join(directory,'cluster.json'),JSON.stringify(cluster));
  await writeFile(join(directory,'node.json'),JSON.stringify({schemaVersion:1,id:'local',clusterFile:'./cluster.json',stateDir:join(directory,'state'),
    capabilities:{coordinator:true,worker:true,consoleRelay:true},network:{externalAccess:false},mesh:{enabled:false,mode:'tun',address:'127.0.0.1'},
    adminPort:ports[5],corePort:ports[1],peerPort:ports[2],roots:[{id:'test',path:workspace}],core:{subagents:{enabled:false,providers:[]}}}));
  const token='node-application-token-long-enough';
  const config=await loadNodeConfig(join(directory,'node.json'),{...process.env,QUAYMESH_CLUSTER_TOKEN:token});
  const app=new QuayMeshNode(config,{root:fileURLToPath(new URL('..',import.meta.url)),intervalMs:100,readinessMs:25000});
  t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
  await app.start();
  const first=app.status();assert.equal(first.configuration.state,'applied');
  const corePid=first.components.find(value=>value.id==='core').pid;assert.ok(corePid);
  const url=`http://127.0.0.1:${ports[0]}/v1/cluster`;
  const saved=await requestJson(url,{token});
  const invalid={...saved.cluster,discovery:{...saved.cluster.discovery,localPort:ports[5]}};
  const published=await requestJson(url,{method:'PUT',token,body:{cluster:invalid,expectedRevision:saved.revision}});
  await until(()=>app.status().configuration.state==='rejected');
  const snapshot=JSON.parse(await readFile(join(directory,'state','cluster.snapshot.json'),'utf8'));
  assert.equal(snapshot.revision,saved.revision);
  assert.equal(app.status().configuration.state,'rejected');
  assert.equal(app.status().components.find(value=>value.id==='core').pid,corePid);
  const valid={...saved.cluster,egress:{...saved.cluster.egress,recoveryDelayMs:12345}};
  await requestJson(url,{method:'PUT',token,body:{cluster:valid,expectedRevision:published.revision}});
  // Revision is persisted just before the applying flag clears. Observe the
  // final ready state, rather than racing the asynchronous finally block.
  await until(()=>app.status().configRevision===published.revision+1 && app.status().configuration.state==='applied');
  assert.equal(app.status().configuration.state,'applied');
  assert.equal(app.status().configRevision,published.revision+1);
  assert.equal(app.status().errors.current.some(value=>value.source==='configuration'),false);
  assert.equal((await requestJson(`http://127.0.0.1:${ports[1]}/readyz`)).ok,true);
  // Crash-like orphaned maintenance and a temporary Core outage must recover
  // without rebooting the whole node or discarding the current work ledger.
  await app.admission('pause');
  assert.equal((await app.admissionState()).accepting,false);
  await app.reconcileMaintenance();
  assert.equal((await app.admissionState()).accepting,true);
  const originalAdmission=app.admission.bind(app);
  app.maintenance=true;
  app.relay?.setAccepting(false);
  await originalAdmission('pause');
  // A legitimately active owner must never be auto-unlocked.
  await app.reconcileMaintenance();
  assert.equal((await app.admissionState()).accepting,false);
  let failures=5;
  app.admission=async action => {
    if (action==='resume' && failures-->0) throw new Error('temporary Core I/O failure');
    return originalAdmission(action);
  };
  await assert.rejects(app.endMaintenance(),/temporary Core I\/O failure/);
  assert.equal(app.maintenance,true);
  assert.equal(app.maintenanceReleasePending,true);
  assert.equal((await app.admissionState()).accepting,false);
  app.admission=originalAdmission;
  await app.reconcileMaintenance();
  assert.equal((await app.admissionState()).accepting,true);
  assert.equal(app.maintenance,false);
  assert.equal(app.maintenanceReleasePending,false);
});
