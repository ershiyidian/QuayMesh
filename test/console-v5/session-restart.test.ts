import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import {loadConfig} from '../../src/config.js';
import {defaultQuayMeshConfig} from '../../src/config-schema.js';
import {writeQuayMeshConfig} from '../../src/user-config.js';
import {createProjectConsoleRouter} from '../../src/project-console-router.js';

test('Console服务及数据库连接关闭后重建仍接受原登录，显式注销保持失效',async t=>{
  const root=await mkdtemp(join(tmpdir(),'quaymesh-console-restart-'));
  await mkdir(join(root,'workspace'));
  const defaults=defaultQuayMeshConfig();
  const env={...process.env,QUAYMESH_CONFIG_DIR:join(root,'config'),QUAYMESH_OAUTH_OWNER_TOKEN:randomBytes(32).toString('base64url')};
  writeQuayMeshConfig({...defaults,storage:{...defaults.storage,stateDir:join(root,'state')},
    workspaces:{...defaults.workspaces,allowedRoots:[join(root,'workspace')],worktreeRoot:join(root,'worktrees')},
    subagents:{...defaults.subagents,enabled:false,providers:[]}},env);
  const start=async(port=0)=>{
    const router=createProjectConsoleRouter(loadConfig(env),{assetDirectory:resolve('dist/ui')});
    const app=express();app.use('/console',router.router);
    const http=app.listen(port,'127.0.0.1');await once(http,'listening');
    let closed=false;
    return {port:(http.address() as AddressInfo).port,close:async()=>{
      if(closed)return;closed=true;
      http.closeAllConnections();await new Promise<void>(done=>http.close(()=>done()));router.close();
    }};
  };
  let current=await start();
  t.after(async()=>{await current.close();await rm(root,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${current.port}`;
  const login=await fetch(base+'/console/api/login',{method:'POST',headers:{connection:'close',origin:base,'content-type':'application/json'},body:JSON.stringify({password:env.QUAYMESH_OAUTH_OWNER_TOKEN})});
  assert.equal(login.status,200);const initial=await login.json() as {csrf:string;expiresAt:number};
  const cookie=login.headers.getSetCookie()[0].split(';')[0];
  await current.close();current=await start(current.port);
  const read=await fetch(base+'/console/api/session',{headers:{cookie,connection:'close'}});
  assert.equal(read.status,200);const restored=await read.json() as {csrf:string;expiresAt:number};
  assert.equal(restored.csrf,initial.csrf);assert.equal(restored.expiresAt,initial.expiresAt);
  const denied=await fetch(base+'/console/api/logout',{method:'POST',headers:{cookie,connection:'close',origin:base}});assert.equal(denied.status,403);
  const logout=await fetch(base+'/console/api/logout',{method:'POST',headers:{cookie,connection:'close',origin:base,'x-quaymesh-csrf':restored.csrf}});assert.equal(logout.status,200);
  await current.close();current=await start(current.port);
  assert.equal((await fetch(base+'/console/api/session',{headers:{cookie,connection:'close'}})).status,401);
});
