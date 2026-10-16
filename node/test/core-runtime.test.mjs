import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";
import { directory, token, until } from "./helpers.mjs";

const root=fileURLToPath(new URL("../..",import.meta.url));
const build=join(root,".build","federation");
await mkdir(build,{recursive:true});
async function productionModule(name) {
  const input=await readFile(join(root,"src","federation",`${name}.ts`),"utf8");
  const output=ts.transpileModule(input,{fileName:`${name}.ts`,compilerOptions:{
    target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,verbatimModuleSyntax:true,
  }}).outputText;
  const file=join(build,`${name}.mjs`);
  await writeFile(file,output);
  return import(pathToFileURL(file).href);
}
const {PeerTransport,RpcRequestTimeoutError}=await productionModule("transport");
const {chooseGateway,routedResult}=await productionModule("routing");

test("实际 HTTP/2 节点在动态注册后双向读取文件，单次请求超时不关闭连接",async t=>{
  const directoryPath=await directory(t);
  await writeFile(join(directoryPath,"result.txt"),"QuayMesh 实际文件内容\n");
  const key=token();
  const config=id=>({nodeId:id,host:"127.0.0.1",port:0,peers:[],heartbeatMs:100,rpcTimeoutMs:2000});
  const fileHandler=async(method,params)=>{
    if(method==="read_file")return readFile(join(directoryPath,params.name),"utf8");
    if(method==="delayed_read"){
      await new Promise(done=>setTimeout(done,100));
      return readFile(join(directoryPath,params.name),"utf8");
    }
    throw new Error(`未知方法 ${method}`);
  };
  const streams=async(service,metadata,stream)=>{
    if(service!=="file")throw new Error(`未知数据流 ${service}`);
    stream.end(await readFile(join(directoryPath,metadata.name)));
  };
  const cloud=new PeerTransport(config("cloud"),key,fileHandler,streams);
  const worker=new PeerTransport(config("worker"),key,fileHandler,streams);
  t.after(async()=>{await worker.close();await cloud.close();});
  await cloud.start();await worker.start();
  cloud.updatePeers([{id:"worker",url:""}]);
  worker.updatePeers([{id:"cloud",url:`http://127.0.0.1:${cloud.address}`}]);
  const cloudLink=await until(()=>cloud.links.get("worker"),value=>value?.connected);
  const workerLink=await until(()=>worker.links.get("cloud"),value=>value?.connected);
  assert.equal(await cloudLink.call("read_file",{name:"result.txt"}),"QuayMesh 实际文件内容\n");
  assert.equal(await workerLink.call("read_file",{name:"result.txt"}),"QuayMesh 实际文件内容\n");
  await assert.rejects(cloudLink.call("delayed_read",{name:"result.txt"},20),RpcRequestTimeoutError);
  assert.equal(cloudLink.connected,true);
  assert.equal(await cloudLink.call("read_file",{name:"result.txt"}),"QuayMesh 实际文件内容\n");
  // 真实 HTTP/2 会话偶发一次 ping 失败，不能误杀共享连接及后续调用。
  const originalPing = cloudLink.session.ping.bind(cloudLink.session);
  let pingAttempts = 0;
  cloudLink.session.ping = (callback) => {
    pingAttempts++;
    if (pingAttempts === 1) callback(new Error("transient ping loss"));
    else originalPing(callback);
  };
  await until(() => pingAttempts, value => value >= 2);
  assert.equal(cloudLink.connected, true);
  assert.equal(await cloudLink.call("read_file",{name:"result.txt"}),"QuayMesh 实际文件内容\n");
  cloudLink.session.ping = originalPing;
  const file=await cloudLink.openStream("file",{name:"result.txt"});
  file.end();
  const chunks=[];for await(const chunk of file)chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(),"QuayMesh 实际文件内容\n");
});

test("出口选择排除 Coordinator，在健康节点间切换并等待优先出口恢复",()=>{
  const node=(id,priority,egress=true)=>({id,priority,online:true,onlineSince:1,
    capabilities:{egress},egress:{enabled:egress,healthy:true,healthySince:1}});
  const cloud=node("cloud",1000,false);
  const s1=node("s1",300),s2=node("s2",250),desktop=node("desktop",200);
  assert.equal(chooseGateway([cloud,s1,s2,desktop],20000,10000).id,"s1");
  s1.online=false;
  assert.equal(chooseGateway([cloud,s1,s2,desktop],20000,10000,"s1").id,"s2");
  s1.online=true;s1.onlineSince=19500;
  assert.equal(chooseGateway([cloud,s1,s2,desktop],20000,10000,"s2").id,"s2");
  assert.equal(chooseGateway([cloud,s1,s2,desktop],30000,10000,"s2").id,"s1");
  s1.online=false;s2.online=false;desktop.online=false;
  assert.equal(chooseGateway([cloud,s1,s2,desktop],30000,10000),undefined);
});

test("工作区返回标识保持实际所属节点",()=>{
  const reply=routedResult({workspaces:[
    {node_id:"s2",workspace_id:"ws_a"},
    {node_id:"desktop",workspace_id:"ws_b"},
  ]},"cloud");
  assert.equal(reply.workspaces[0].workspace_id,"qm:s2:ws_a");
  assert.equal(reply.workspaces[1].workspace_id,"qm:desktop:ws_b");
});

test("初始数据库在真实 SQLite 中创建完整表、外键与请求唯一约束",async()=>{
  const db=new DatabaseSync(":memory:");
  try{
    db.exec("PRAGMA foreign_keys=ON");
    db.exec(await readFile(join(root,"schema","initial.sql"),"utf8"));
    for(const name of ["qm_sessions","qm_tasks","qm_events","qm_task_snapshots","console_work_runs","oauth_clients"]){
      assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name));
    }
    db.prepare("INSERT INTO qm_sessions(id,owner_id,title,created_at,last_activity_at) VALUES(?,?,?,?,?)")
      .run("session","owner","对话","2026-10-01T00:00:00Z","2026-10-01T00:00:00Z");
    const insert=db.prepare("INSERT INTO qm_tasks(id,session_id,title,created_at,last_activity_at,request_key) VALUES(?,?,?,?,?,?)");
    insert.run("task-a","session","第一轮","2026-10-01","2026-10-01","request-a");
    assert.throws(()=>insert.run("task-b","session","重复请求","2026-10-01","2026-10-01","request-a"),/UNIQUE/);
    assert.throws(()=>insert.run("task-c","missing","未知对话","2026-10-01","2026-10-01","request-c"),/FOREIGN KEY/);
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check,"ok");
  }finally{db.close();}
});
