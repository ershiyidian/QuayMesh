import {readdir,readFile,writeFile,stat} from "node:fs/promises";
import {resolve,join,dirname} from "node:path";
import {fileURLToPath} from "node:url";

const invoked=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
const readJson=async path=>JSON.parse(await readFile(path,"utf8"));

/** Read-only recovery preview. Old generated roots are evidence, never automatic permissions. */
export async function previewWorkspaceRoots(nodeConfig,stateDir){
  const node=await readJson(nodeConfig),current=Array.isArray(node.roots)?node.roots:[];
  const generated=join(stateDir,"generated"),directories=await readdir(generated,{withFileTypes:true}).catch(error=>{
    if(error.code==="ENOENT")return [];throw error;
  });
  const candidateMap=new Map();
  const evidence=[];
  for(const entry of directories.filter(value=>value.isDirectory()&&value.name.startsWith("config-"))){
    const source=join(generated,entry.name,"core","config.jsonc");
    let snapshot;
    try{snapshot=await readJson(source);}catch(error){if(error.code==="ENOENT")continue;throw error;}
    const roots=snapshot?.federation?.roots;
    if(!Array.isArray(roots))continue;
    const {mtimeMs}=await stat(source);
    evidence.push({source,mtimeMs,rootCount:roots.length});
    for(const root of roots){
      if(!root||typeof root.id!=="string"||typeof root.path!=="string"||!root.id||!root.path)continue;
      // Older generated configurations are evidence, not an authoritative
      // settings history. Never pick a security-sensitive root by mtime alone.
      const variants=candidateMap.get(root.id)??new Map();
      const signature=JSON.stringify({path:root.path,nickname:root.nickname??root.id,
        description:root.description??"",tags:root.tags??[],enabled:root.enabled!==false});
      const previous=variants.get(signature);
      if(previous)previous.sources.push(source);
      else variants.set(signature,{id:root.id,path:root.path,nickname:root.nickname??root.id,
        description:root.description??"",tags:root.tags??[],enabled:root.enabled!==false,
        sources:[source]});
      candidateMap.set(root.id,variants);
    }
  }
  const present=new Map(current.map(root=>[root.id,root]));
  const missing=[];const conflicts=[];
  for(const [id,variants] of candidateMap){
    const existing=present.get(id);
    const histories=[...variants.values()];
    if(histories.length!==1){
      conflicts.push({id,currentPath:existing?.path??null,historicalVariants:histories,
        disposition:"AMBIGUOUS_HISTORY_REQUIRES_REVIEW"});
      continue;
    }
    const previous=histories[0];
    if(!existing)missing.push({...previous,source:previous.sources[0],disposition:"REVIEW_BEFORE_EXPORT"});
    else if(existing.path!==previous.path)conflicts.push({id,currentPath:existing.path,
      historicalPath:previous.path,sources:previous.sources,disposition:"EXPLICIT_EDIT_REQUIRES_REVIEW"});
  }
  return {nodeId:node.id,currentRootCount:current.length,missing:missing.sort((a,b)=>a.id.localeCompare(b.id)),conflicts,
    evidence:evidence.sort((a,b)=>b.mtimeMs-a.mtimeMs),readOnly:true,requiresExplicitApproval:true};
}

if(invoked){
  const args=process.argv.slice(2),value=name=>args[args.indexOf(name)+1];
  if(args.includes("--help")){console.log("Usage: node scripts/recover-workspace-roots.mjs --node-config <node.json> --state-dir <state> [--output <report.json>] (read-only preview)");process.exit(0);}
  if(!args.includes("--node-config")||!args.includes("--state-dir")||args.includes("--apply"))throw new Error("只支持显式配置文件和状态目录的只读预览；恢复需通过 Console 保存接口明确确认");
  const report=await previewWorkspaceRoots(resolve(value("--node-config")),resolve(value("--state-dir")));
  if(args.includes("--output"))await writeFile(resolve(value("--output")),JSON.stringify(report,null,2)+"\n");
  console.log(JSON.stringify(report,null,2));
}
