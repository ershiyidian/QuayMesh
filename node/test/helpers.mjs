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

export async function freePort() {
  const server=net.createServer();
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  const port=server.address().port;
  await new Promise(resolve=>server.close(resolve));
  return port;
}
