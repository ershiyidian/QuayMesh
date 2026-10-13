import { parseArgs } from "node:util";
import { readFile,mkdir,cp,chmod,rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve,join } from "node:path";
import { fileURLToPath } from "node:url";
import { platformName } from "../node/compile.mjs";

const root=fileURLToPath(new URL("..",import.meta.url));
const {values}=parseArgs({options:{
  easytier:{type:"string"},tunnel:{type:"string"},"easytier-cli":{type:"string"},
  egress:{type:"string"},source:{type:"boolean",default:false},
}});
const metadata=JSON.parse(await readFile(join(root,"components.lock.json"),"utf8"));
const target=join(root,"components",platformName());
await mkdir(target,{recursive:true});
const exe=name=>name+(process.platform==="win32"?".exe":"");
function run(command,args,cwd=root,env=process.env){
  return new Promise((resolveRun,reject)=>{
    const child=spawn(command,args,{cwd,env,stdio:"inherit",shell:false});
    child.once("error",reject);
    child.once("close",code=>code===0?resolveRun():reject(new Error(`${command} 退出码 ${code}`)));
  });
}
const imports=[["easytier","easytier-core"],["easytier-cli","easytier-cli"],["tunnel","tunnel-client"],["egress","mihomo"]];
for(const [key,name] of imports)if(values[key]){
  await cp(resolve(values[key]),join(target,exe(name)));
  if(process.platform!=="win32")await chmod(join(target,exe(name)),0o755);
}
if(values.source){
  const build=join(root,".build","components");
  await mkdir(build,{recursive:true});
  const python=process.platform==="win32"?"python":"python3";
  for(const component of ["easytier","tunnel"]){
    await run(python,[join(root,"scripts","extract-component.py"),join(root,metadata[component].archive),build]);
  }
  await run("cargo",["build","--locked","--release","-p","easytier","--bin","easytier-core","--bin","easytier-cli"],
    join(build,metadata.easytier.directory));
  for(const name of ["easytier-core","easytier-cli"]){
    await cp(join(build,metadata.easytier.directory,"target","release",exe(name)),join(target,exe(name)));
  }
  await run("go",["build","-trimpath","-o",join(target,exe("tunnel-client")),"./cmd/client"],
    join(build,metadata.tunnel.directory),{...process.env,GOTOOLCHAIN:"auto"});
}
if(!values.source&&!values.easytier&&!values.tunnel&&!values.egress)throw new Error("请指定 --source 或组件的本机可执行文件路径");
await run(join(target,exe("easytier-core")),["--version"]);
await run(join(target,exe("tunnel-client")),["--version"]);
console.log(`组件目录：${target}`);
