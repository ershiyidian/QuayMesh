import test from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:net";
import {once} from "node:events";
import {assertMeshPortFree,assertManagedMeshListener,windowsTcpListenerOwners} from "../easytier-health.mjs";

test("实际端口被独立进程监听时拒绝重复管理，释放后允许启动",{timeout:20000},async t=>{
  const server=createServer(socket=>socket.destroy());
  t.after(async()=>{
    if(server.listening)await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  });
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

test("Windows 监听者识别仅使用精确本地 TCP 监听端口和有效 PID",()=>{
  const output=`Active Connections
  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:15888          0.0.0.0:0              LISTENING       321
  TCP    [::]:15888            [::]:0                 LISTENING       321
  TCP    [::1]:15888           [::]:0                 LISTEN          654
  TCP    [::1]:15888           [::]:0                 ABHÖREN         765
  TCP    127.0.0.1:15888       0.0.0.0:0              ECOUTE          876
  TCP    127.0.0.1:158880      0.0.0.0:0              LISTENING       999
  TCP    127.0.0.1:50000       127.0.0.1:15888        ESTABLISHED     999
  TCP    127.0.0.1:15888       127.0.0.1:50000        ESTABLISHED     999
  UDP    0.0.0.0:15888         *:*                                    999
  TCP    127.0.0.1:15888       0.0.0.0:0              LISTENING       invalid
  TCP    127.0.0.1:15888       0.0.0.0:0              LISTENING       0
`;
  assert.deepEqual(windowsTcpListenerOwners(output,15888),[321,654,765,876]);
  assert.deepEqual(windowsTcpListenerOwners(output,15889),[]);
});
