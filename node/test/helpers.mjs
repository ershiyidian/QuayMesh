import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import net from "node:net";
import { validateCluster, validateNode } from "../config.mjs";

export async function directory(t) {
  const root=await mkdtemp(join(tmpdir(),"quaymesh-test-"));
  t.after(()=>rm(root,{recursive:true,force:true}));
  return root;
}
export function token(){return randomBytes(32).toString("base64url");}
export function cluster(overrides={}) {
  return validateCluster({schemaVersion:1,id:"lab",coordinator:{id:"cloud",address:"127.0.0.1"},
    mesh:{networkName:"lab-network",peers:["udp://127.0.0.1:11010"]},...overrides});
}
export function nodeConfig(root,id="edge",overrides={}) {
  return validateNode({schemaVersion:1,id,stateDir:root,capabilities:{worker:true},
    mesh:{enabled:false,address:"127.0.0.2"},...overrides},cluster(),root);
}
export async function until(read,predicate,timeout=5000) {
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline) {
    const value=await read();
    if(predicate(value))return value;
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  throw new Error("等待实际状态超时");
}

// Match the HTTP fixture contract: Windows may allocate a low ephemeral port
// that Fetch blocks even though the OS can bind it (for example 5060 or 6000).
const FETCH_FORBIDDEN_PORTS = new Set([
  1,7,9,11,13,15,17,19,20,21,22,23,25,37,42,43,53,69,77,79,87,95,
  101,102,103,104,109,110,111,113,115,117,119,123,135,137,138,139,143,161,
  179,389,427,465,512,513,514,515,526,530,531,532,540,548,554,556,563,587,
  601,636,989,990,993,995,1719,1720,1723,2049,3659,4045,4190,5060,5061,
  6000,6566,6665,6666,6667,6668,6669,6679,6697,10080,
]);

export async function freePort() {
  for(let attempt=0;attempt<100;attempt++) {
    const server=net.createServer();
    await new Promise((resolve,reject)=>{
      server.once("error",reject);
      server.listen(0,"127.0.0.1",resolve);
    });
    const port=server.address().port;
    await new Promise(resolve=>server.close(resolve));
    if(port>0&&!FETCH_FORBIDDEN_PORTS.has(port))return port;
  }
  throw new Error("FREE_PORT_EXHAUSTED");
}
