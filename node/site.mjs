import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { access, mkdir, rm, rename } from "node:fs/promises";
import { writeJson, atomicWrite } from "./files.mjs";
import { validateCluster, validateNode } from "./config.mjs";

export async function createSite({directory,peer,resourceUrl="",tunnelId="",tunnelApiKey="",
  inventory,meshSecret="",clusterToken="",ownerToken="",existingNetwork=false}) {
  const target = resolve(directory);
  try { await access(target); throw new Error("站点目标目录已经存在，请使用新的目录"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (existingNetwork && !meshSecret) throw new Error("加入已有网络需要提供实际组网密钥");
  const config = inventory?.cluster || {
    schemaVersion:1,id:"quaymesh",coordinator:{id:"cloud",address:"10.42.0.1"},
    mesh:{networkName:"quaymesh",peers:peer ? [peer] : []},
    discovery:{resourceUrl:resourceUrl || undefined,channels:["main","harpoon"]},
  };
  const cluster = validateCluster(config);
  const definitions = inventory?.nodes || [
    {id:cluster.coordinator.id,nickname:"Coordinator",capabilities:{coordinator:true,meshRelay:true},network:{externalAccess:false},
      mesh:{address:cluster.coordinator.address,mode:"no-tun",listeners:["udp://0.0.0.0:11010"]},roots:[]},
    {id:"worker",nickname:"Worker",capabilities:{worker:true,discovery:!!cluster.discovery.resourceUrl},
      network:{externalAccess:true},mesh:{address:"10.42.0.2",mode:"no-tun"},roots:[]},
  ];
  if (!Array.isArray(definitions) || !definitions.length) throw new Error("站点至少需要一个节点");
  const ids = new Set(), addresses = new Set();
  const nodes = definitions.map(item => {
    const raw = {schemaVersion:1,...item,clusterFile:"./cluster.json",secretsFile:`./secrets.${item.id}.env`};
    const node = validateNode(raw,cluster,target);
    if (ids.has(node.id) || addresses.has(node.mesh.address)) throw new Error("站点包含重复节点身份或网络地址");
    ids.add(node.id); addresses.add(node.mesh.address);
    return {raw,node};
  });
  if (!ids.has(cluster.coordinator.id)) throw new Error("站点缺少协调端节点");
  const keys = {
    [cluster.tokenEnv]:clusterToken || randomBytes(32).toString("base64url"),
    [cluster.mesh.secretEnv]:meshSecret || randomBytes(32).toString("base64url"),
    QUAYMESH_OWNER_TOKEN:ownerToken || randomBytes(32).toString("base64url"),
  };
  if (keys[cluster.tokenEnv].length < 24 || keys[cluster.mesh.secretEnv].length < 16 || keys.QUAYMESH_OWNER_TOKEN.length < 16) throw new Error("站点凭据长度不足");
  if (nodes.some(value=>value.node.capabilities.discovery) && (!tunnelId || tunnelApiKey.length<16)) throw new Error("启用发现端需要实际 tunnel ID 和运行密钥");
  const temporary = `${target}.pending-${randomBytes(6).toString("hex")}`;
  await mkdir(temporary,{recursive:true,mode:0o700});
  try {
    await writeJson(join(temporary,"cluster.json"),cluster);
    for (const {raw,node} of nodes) {
      const secrets = {[cluster.tokenEnv]:keys[cluster.tokenEnv],QUAYMESH_OWNER_TOKEN:keys.QUAYMESH_OWNER_TOKEN};
      if (node.mesh.enabled) secrets[cluster.mesh.secretEnv] = keys[cluster.mesh.secretEnv];
      if (node.capabilities.discovery) {
        secrets[cluster.discovery.tunnelIdEnv] = tunnelId;
        secrets[cluster.discovery.apiKeyEnv] = tunnelApiKey;
      }
      for (const value of Object.values(secrets)) if (/[\r\n\0]/.test(value)) throw new Error("凭据包含换行");
      await writeJson(join(temporary,`${node.id}.json`),raw);
      await atomicWrite(join(temporary,`secrets.${node.id}.env`),Object.entries(secrets).map(([key,value])=>`${key}=${JSON.stringify(value)}`).join("\n")+"\n",0o600);
    }
    await rename(temporary,target);
  } catch (error) { await rm(temporary,{recursive:true,force:true}); throw error; }
  return {directory:target,nodes:[...ids]};
}
