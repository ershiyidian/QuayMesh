import assert from 'node:assert/strict';
import test from 'node:test';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {federationConfigSchema} from '../../src/federation/schema.js';
import {WorkLedger} from '../../src/work-ledger.js';
import {createRealTestServer,freePort} from '../session-card/server-fixture.js';

test('settings forms use desired revisions, root creation never overwrites, and lost settings receipts reconcile without another write',async t=>{
  const [port,ingressPort]=await Promise.all([freePort(),freePort()]);
  const fixture=await createRealTestServer({git:false,configure:async config=>{
    const tokenFile=join(config.configDir,'cluster.token');await writeFile(tokenFile,'console-settings-real-regression-token');
    return {...config,federation:federationConfigSchema.parse({enabled:true,nodeId:'settings-node',nickname:'Settings node',coordinatorId:'settings-node',host:'127.0.0.1',port,ingressPort,tokenFile,
      capabilities:{coordinator:true,worker:true},priority:0,heartbeatMs:1000,rpcTimeoutMs:5000,peers:[],
      roots:[{id:'main',nickname:'Main',path:config.allowedRoots[0]}],egress:{enabled:false}})};
  }});t.after(()=>fixture.dispose());
  const runtime=fixture.running.federation!;assert.ok(runtime);
  const original=runtime.request.bind(runtime),nodeId=fixture.config.federation!.nodeId;
  let updates=0;
  let saved:any={revision:7,savedRevision:7,appliedRevision:6,pending:true,nickname:'desired',priority:10,
    applicationError:'waiting for idle',roots:[{id:'existing',nickname:'saved root',path:fixture.project,tags:[],enabled:true}],
    egress:{enabled:false,mihomoConfig:null,proxyUrl:'http://127.0.0.1:7890',probeUrl:'https://example.invalid',recoveryDelayMs:1000,inheritProxy:false}};
  t.mock.method(runtime,'request',async(node:string,method:string,payload:any,...rest:any[])=>{
    if(node===nodeId&&method==='settings.get')return structuredClone(saved);
    if(node===nodeId&&method==='settings.update'){
      assert.equal(payload.expectedRevision,saved.revision);updates++;
      const {expectedRevision,...fields}=payload;saved={...saved,...fields,revision:expectedRevision+1,savedRevision:expectedRevision+1};
      return structuredClone(saved);
    }
    return original(node,method as any,payload,rest[0]);
  });
  const login=await fetch(fixture.baseUrl+'/console/api/login',{method:'POST',headers:{Origin:fixture.baseUrl,'Content-Type':'application/json'},body:JSON.stringify({password:fixture.config.oauth.ownerToken})});
  assert.equal(login.status,200);const cookie=login.headers.getSetCookie()[0].split(';')[0],{csrf}=await login.json() as {csrf:string};
  const request=async(path:string,body?:unknown)=>{
    const response=await fetch(fixture.baseUrl+'/console/api/v4/'+path,{method:body===undefined?'GET':'POST',headers:{Cookie:cookie,Origin:fixture.baseUrl,'Content-Type':'application/json','X-QuayMesh-CSRF':csrf},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,body:await response.json() as any};
  };
  let snapshot=await request('nodes/'+nodeId+'/settings');assert.equal(snapshot.status,200);
  assert.equal(snapshot.body.settings.revision,7);assert.equal(snapshot.body.settings.nickname,'desired');assert.equal(snapshot.body.settings.error,'waiting for idle');
  saved={...saved,revision:8,savedRevision:8,nickname:'changed elsewhere'};
  snapshot=await request('nodes/'+nodeId+'/settings');assert.equal(snapshot.body.settings.revision,8);assert.equal(snapshot.body.settings.nickname,'changed elsewhere');
  const root={id:'existing',nodeId,name:'attempted overwrite',path:fixture.secondRoot,description:'',tags:[],enabled:true,readOnly:false};
  const duplicate=await request('roots/save',{root,create:true,expectedRevision:8,requestKey:'duplicate-root'});
  assert.equal(duplicate.status,409);assert.equal(duplicate.body.code,'root_exists');assert.equal(duplicate.body.effect,'none');assert.equal(updates,0);
  const obsolete=await request('roots/save',{root:{...root,id:'new'},create:true,expectedRevision:0,requestKey:'zero-revision'});
  assert.equal(obsolete.status,409);assert.equal(obsolete.body.code,'revision_conflict');assert.equal(updates,0);
  const accepted=await request('roots/save',{root:{...root,id:'new'},create:true,expectedRevision:8,requestKey:'new-root'});
  assert.equal(accepted.status,200);assert.equal(accepted.body.revision,9);assert.equal(accepted.body.pending,true);assert.equal(updates,1);
  assert.equal(saved.roots.find((value:any)=>value.id==='existing').path,fixture.project);
  const ledger=new WorkLedger(fixture.config.stateDir);
  try{ledger.db.prepare("UPDATE console_write_receipts SET state='unknown',response_json=NULL WHERE request_key='new-root'").run();}
  finally{ledger.close();}
  const reconciled=await request('receipts/new-root?'+new URLSearchParams({path:'/api/v4/roots/save'}));
  assert.equal(reconciled.status,200);assert.equal(reconciled.body.state,'completed');assert.equal(reconciled.body.response.revision,9);assert.equal(updates,1);
  saved={...saved,revision:10,savedRevision:10,appliedRevision:10,pending:false,roots:[]};
  const superseded=await request('receipts/new-root?'+new URLSearchParams({path:'/api/v4/roots/save'}));
  assert.equal(superseded.body.response.revision,9);assert.equal(superseded.body.response.superseded,true);assert.equal(superseded.body.response.pending,false);assert.equal(updates,1);
  for(const path of ['overview?tz=Invalid%2FZone','activity?kind=events&after=invalid','runs?cursor=%%%']){
    const invalid=await request(path);assert.ok([400,422].includes(invalid.status),JSON.stringify(invalid));assert.equal(invalid.body.effect,'none');
  }
});
