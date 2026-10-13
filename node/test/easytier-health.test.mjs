import test from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:net";
import {once} from "node:events";
import {assertMeshPortFree,assertManagedMeshListener} from "../easytier-health.mjs";

test("实际端口被独立进程监听时拒绝重复管理，释放后允许启动",async()=>{
  const server=createServer();
  server.listen(0,"127.0.0.1");
  await once(server,"listening");
  const port=server.address().port;
  await assert.rejects(assertMeshPortFree(port),/EASYTIER_PORT_OCCUPIED/);
  if(process.platform==="win32"){
    await assertManagedMeshListener(process.pid,port);
    await assert.rejects(assertManagedMeshListener(process.pid+1,port),/EASYTIER_RPC_OWNER_MISMATCH/);
  }
  await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  await assertMeshPortFree(port);
});
