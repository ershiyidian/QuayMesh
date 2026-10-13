import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, connect } from "node:net";
import { fileURLToPath } from "node:url";
import { defaultQuayMeshConfig, quaymeshConfigSchema } from "../src/config-schema.js";
import { openDatabase } from "../src/db/client.js";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done,reject) => { server.once("error",reject); server.listen(0,"127.0.0.1",done); });
  const port = (server.address() as {port:number}).port;
  await new Promise<void>((done,reject) => server.close(error => error ? reject(error) : done()));
  return port;
}
async function isListening(port: number): Promise<boolean> {
  return new Promise((done,reject) => {
    const socket = connect({host:"127.0.0.1",port});
    socket.once("connect",() => {socket.destroy();done(true);});
    socket.once("error",(error:NodeJS.ErrnoException) => {socket.destroy();if(error.code==="ECONNREFUSED")done(false);else reject(error);});
    socket.setTimeout(1500,() => socket.destroy(new Error("开发端口检查超时")));
  });
}

export async function seedDevState({reset=false,checkoutRoot=process.cwd()}: {reset?:boolean;checkoutRoot?:string} = {}): Promise<void> {
  const checkout = resolve(checkoutRoot), target = join(checkout,".quaymesh-dev");
  if (existsSync(target)) {
    if (!reset) throw new Error("开发目录已经存在，请停止开发服务后运行 pnpm dev:reset");
    const marker = JSON.parse(await readFile(join(target,"development.json"),"utf8")) as {scope:string;checkout:string;port:number};
    if (marker.scope!=="quaymesh-development" || marker.checkout!==checkout) throw new Error("目标目录没有匹配的开发身份");
    if (await isListening(marker.port)) throw new Error("开发服务仍在监听，请先停止该开发服务");
  }
  const stage = `${target}.pending-${randomUUID()}`, previous = `${target}.previous-${randomUUID()}`;
  const port = await freePort();
  const defaults = defaultQuayMeshConfig();
  const config = quaymeshConfigSchema.parse({
    ...defaults,server:{...defaults.server,host:"127.0.0.1",port,publicBaseUrl:`http://127.0.0.1:${port}`},
    storage:{...defaults.storage,stateDir:join(target,"state")},
    workspaces:{...defaults.workspaces,allowedRoots:[join(target,"workspace")],worktreeRoot:join(target,"worktrees")},
    federation:{enabled:false},subagents:{...defaults.subagents,enabled:false,providers:[]},
    skills:{...defaults.skills,enabled:false,paths:[],agentDir:join(target,"providers")},
  });
  await mkdir(join(stage,"config"),{recursive:true,mode:0o700});
  try {
    await mkdir(join(stage,"workspace"));
    await mkdir(join(stage,"providers","codex"),{recursive:true});
    await writeFile(join(stage,"workspace","README.md"),"# QuayMesh 开发工作区\n\n此目录用于本次检出的本地功能验证。\n");
    await writeFile(join(stage,"config","config.jsonc"),JSON.stringify(config,null,2)+"\n",{mode:0o600});
    await writeFile(join(stage,"config","auth.json"),JSON.stringify({ownerToken:randomBytes(32).toString("base64url")})+"\n",{mode:0o600});
    await writeFile(join(stage,"development.json"),JSON.stringify({scope:"quaymesh-development",checkout,port,instanceId:randomUUID()},null,2)+"\n",{mode:0o600});
    const database = openDatabase(join(stage,"state")); database.close();
    if (existsSync(target)) await rename(target,previous);
    try { await rename(stage,target); }
    catch (error) { if(existsSync(previous))await rename(previous,target);throw error; }
    await rm(previous,{recursive:true,force:true});
  } finally { await rm(stage,{recursive:true,force:true}); }
  console.log(`开发目录：${target}\n开发入口：http://127.0.0.1:${port}/console/`);
}

if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  if (!["seed","reset"].includes(command)) throw new Error("Usage: dev-state <seed|reset>");
  await seedDevState({reset:command==="reset"});
}
