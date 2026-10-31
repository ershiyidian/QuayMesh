import { parseArgs } from "node:util";
import { readFile, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadNodeConfig, hostUrl, secret, readConfigDocument, validateCluster } from "./config.mjs";
import { componentPlans } from "./compile.mjs";
import { requestJson, createAgent } from "./network.mjs";
import { QuayMeshNode, packageRoot } from "./app.mjs";
import { createSite } from "./site.mjs";

const usage=`QuayMesh
  quaymesh init-site --directory ./site --peer udp://公网地址:11010 --resource-url https://隧道资源地址
  quaymesh run --config ./site/desktop.json
  quaymesh install --config ./site/desktop.json
  quaymesh activate --prepared <准备结果中的manifestFile>
  quaymesh doctor --config ./site/desktop.json
  quaymesh status --config ./site/desktop.json
  quaymesh restart --config ./site/desktop.json --component discovery
  quaymesh publish --config ./site/cloud.json --cluster ./site/cluster.json
  quaymesh local status|tasks|events|peer ... --json   本机受授权 API，不启动节点
  quaymesh client import <alias> --stdin --json      将已授权凭据存入系统凭据库
  quaymesh core <command>         核心命令与工作区工具
`;
export async function main(argv=process.argv.slice(2)) {
  // Both installed entry forms are supported; do not send --json to the
  // lifecycle/config parser or reinterpret local status as manager status.
  if(argv[0]==="--json"&&["local","client"].includes(argv[1]))argv=[argv[1],"--json",...argv.slice(2)];
  const [command="help",...args]=argv;
  if(["help","--help","-h"].includes(command)){console.log(usage);return;}
  if(["version","--version","-v"].includes(command)){
    console.log(JSON.parse(await readFile(join(packageRoot,"package.json"),"utf8")).version);return;
  }
  if(command==="local"||command==="client"){
    try{
      const {runLocalUserApiCli}=await import(pathToFileURL(join(packageRoot,"dist","local-user-api","cli.js")).href);
      process.exitCode=await runLocalUserApiCli([command,...args]);
    }catch{
      console.error(JSON.stringify({ok:false,error:{code:"LOCAL_API_CLIENT_UNAVAILABLE",effect:"not_started",
        message:"The installed release could not load its local API client. Install a release with local API support."}}));
      process.exitCode=1;
    }
    return;
  }
  if(command==="core"){
    await access(join(packageRoot,"dist","cli.js"));
    process.argv=[process.argv[0],join(packageRoot,"dist","cli.js"),...args];
    await import(pathToFileURL(join(packageRoot,"dist","cli.js")).href);return;
  }
  const {values}=parseArgs({args,options:{
    config:{type:"string"},directory:{type:"string"},peer:{type:"string"},"resource-url":{type:"string"},
    prefix:{type:"string"},system:{type:"boolean"},"no-start":{type:"boolean",default:false},
    component:{type:"string"},cluster:{type:"string"},offline:{type:"boolean",default:false},
    inventory:{type:"string"},"existing-network":{type:"boolean",default:false},
    "service-user":{type:"string"},"service-name":{type:"string"},"config-dir":{type:"string"},prepared:{type:"string"},
  }});
  if(command==="init-site"){
    if(!values.directory||(!values.peer&&!values.inventory))throw new Error("需要 --directory，并通过 --inventory 或 --peer 指定站点");
    const result=await createSite({directory:values.directory,peer:values.peer,resourceUrl:values["resource-url"],
      tunnelId:process.env.QUAYMESH_TUNNEL_ID,tunnelApiKey:process.env.QUAYMESH_TUNNEL_API_KEY,
      inventory:values.inventory ? await readConfigDocument(resolve(values.inventory)) : undefined,
      existingNetwork:values["existing-network"],meshSecret:process.env.QUAYMESH_MESH_SECRET,
      clusterToken:process.env.QUAYMESH_CLUSTER_TOKEN,ownerToken:process.env.QUAYMESH_OWNER_TOKEN});
    console.log(JSON.stringify(result,null,2));return;
  }
  if(command==="activate"){
    if(!values.prepared)throw new Error("需要 --prepared 指定准备完成的安装记录");
    const {activateInstallation}=await import("./install.mjs");
    console.log(JSON.stringify(await activateInstallation(values.prepared),null,2));return;
  }
  if(!values.config)throw new Error("需要 --config 指定节点配置");
  const loaded=await loadNodeConfig(values.config);
  const token=secret(loaded.env,loaded.cluster.tokenEnv,24);
  if(command==="run"){
    const node=new QuayMeshNode(loaded);
    let exiting=false;
    const stop=async()=>{
      if(exiting)return;exiting=true;
      try{await node.close();}
      catch(error){console.error(error.message);process.exitCode=1;}
    };
    process.once("SIGTERM",stop);process.once("SIGINT",stop);
    try{await node.start();console.log(`QuayMesh ${loaded.node.id} 已启动，管理端口 ${loaded.node.adminPort}`);}
    catch(error){await node.close();throw error;}
    return;
  }
  if(command==="install"){
    const {installNode}=await import("./install.mjs");
    const result=await installNode(values.config,{prefix:values.prefix,user:values.system === undefined ? undefined : !values.system,
      serviceUser:values["service-user"],serviceName:values["service-name"],configDir:values["config-dir"],start:!values["no-start"]});
    console.log(JSON.stringify(result,null,2));return;
  }
  if(command==="status"){
    console.log(JSON.stringify(await requestJson(`http://127.0.0.1:${loaded.node.adminPort}/status`,{timeoutMs:2000}),null,2));return;
  }
  if(command==="restart"){
    if(!values.component)throw new Error("需要 --component");
    console.log(JSON.stringify(await requestJson(`http://127.0.0.1:${loaded.node.adminPort}/components/${encodeURIComponent(values.component)}/restart`,
      {method:"POST",token,timeoutMs:60000}),null,2));return;
  }
  if(command==="publish"){
    if(!values.cluster)throw new Error("需要 --cluster");
    const cluster=validateCluster(await readConfigDocument(resolve(values.cluster)));
    const url=new URL(hostUrl(loaded.cluster.coordinator.address,loaded.cluster.coordinator.apiPort));
    const agent=createAgent(url,{socksUrl:loaded.node.mesh.enabled&&loaded.node.mesh.mode==="no-tun"
      ?`socks5://127.0.0.1:${loaded.node.mesh.socksPort}`:undefined});
    try{
      const current=await requestJson(new URL("/v1/cluster",url),{token,agent});
      const result=await requestJson(new URL("/v1/cluster",url),{method:"PUT",body:{expectedRevision:current.revision,cluster},token,agent});
      console.log(JSON.stringify(result,null,2));
    }finally{agent.destroy();}
    return;
  }
  if(command==="doctor"){
    const root=packageRoot;
    const plans=componentPlans(loaded.node,loaded.cluster,loaded.env,{root,generatedDir:join(loaded.node.stateDir,"generated"),
      configDir:join(loaded.node.stateDir,"generated","core"),release:"doctor"});
    const checks=[];
    for(const plan of plans){
      try{await access(plan.command);checks.push({component:plan.id,executable:plan.command,ok:true});}
      catch(error){checks.push({component:plan.id,executable:plan.command,ok:false,error:error.code});}
    }
    try{await access(join(root,"dist","cli.js"));checks.push({component:"core-build",ok:true});}
    catch(error){checks.push({component:"core-build",ok:false,error:error.code});}
    if(!values.offline){
      try{checks.push({component:"runtime",ok:true,status:await requestJson(`http://127.0.0.1:${loaded.node.adminPort}/status`,{timeoutMs:1500})});}
      catch(error){checks.push({component:"runtime",ok:false,error:error.message});}
    }
    console.log(JSON.stringify({nodeId:loaded.node.id,capabilities:loaded.node.capabilities,checks},null,2));
    if(checks.some(check=>!check.ok))process.exitCode=1;
    return;
  }
  throw new Error(`未知命令 ${command}`);
}
