import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {existsSync} from "node:fs";
import {basename,join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {resolveExecutableCommand} from "./local-agent-command.js";
import {executionContract} from "./process-platform.js";
import type {ToolRegistrationContext} from "./tool-surfaces/types.js";

const execute=promisify(execFile);
const probe="import json,sys; print(json.dumps({'executable':sys.executable,'version':sys.version.split()[0],'virtualenv':sys.prefix!=sys.base_prefix}))";

function discoverPython(cwd:string,requested?:string,environment=process.env) {
  const project=[join(cwd,".venv",process.platform==="win32"?"Scripts/python.exe":"bin/python"),
    join(cwd,"venv",process.platform==="win32"?"Scripts/python.exe":"bin/python")].filter(existsSync);
  const candidates=requested?[requested.includes("/")||requested.includes("\\")?resolve(cwd,requested):requested]
    :project.length?project:process.platform==="win32"?["python","py"]:["python3","python"];
  // 只检查候选文件和 PATH；解释器及其启动代码只能通过显式执行入口运行。
  const executables=[...new Set(candidates.map(candidate=>resolveExecutableCommand(candidate,environment))
    .filter((candidate):candidate is string=>candidate!==undefined))];
  return {executable:executables[0]??null,candidates:executables,verification:"not_run" as const};
}

export async function inspectPython(cwd:string,requested?:string,environment=process.env) {
  const project=[join(cwd,".venv",process.platform==="win32"?"Scripts/python.exe":"bin/python"),
    join(cwd,"venv",process.platform==="win32"?"Scripts/python.exe":"bin/python")].filter(existsSync);
  const candidates=requested?[requested.includes("/")||requested.includes("\\")?resolve(cwd,requested):requested]
    :project.length?[project[0]!]:process.platform==="win32"?["python","py"]:["python3","python"];
  const failures:Array<{candidate:string;error:string}>=[];
  for(const candidate of candidates) {
    const executable=resolveExecutableCommand(candidate,environment);
    if(!executable){failures.push({candidate,error:"executable not found"});continue;}
    const args=[...(/^py(?:\.exe)?$/i.test(basename(executable))?["-3"]:[]),"-c",probe];
    try {
      const result=await execute(executable,args,{cwd,env:{...environment,PYTHONIOENCODING:"utf-8"},
        windowsHide:true,timeout:3000,maxBuffer:16384,encoding:"utf8"});
      const value=JSON.parse(result.stdout) as {executable:string;version:string;virtualenv:boolean};
      if(typeof value.executable!=="string"||typeof value.version!=="string")throw new Error("invalid Python probe response");
      return {available:true,...value};
    } catch(error) {
      const message=error instanceof Error?error.message:String(error);
      if(requested||project.length)throw new Error(`PYTHON_UNAVAILABLE: ${candidate}: ${message}`);
      failures.push({candidate,error:message});
    }
  }
  if(requested)throw new Error(`PYTHON_UNAVAILABLE: ${requested}`);
  return {available:false,error:"No usable Python interpreter",attempts:failures};
}

export async function workspaceEnvironment(context:ToolRegistrationContext,workspaceId:string,python?:string) {
  const workspace=await context.workspaces.getWorkspace(workspaceId);
  const runtime=executionContract();
  const analysis=resolve(fileURLToPath(new URL("../scripts/analysis/",import.meta.url)));
  return {workspace_id:workspaceId,node_id:context.config.federation?.nodeId??"local",cwd:workspace.root,
    platform:runtime.platform,shell:runtime.shell,python:discoverPython(workspace.root,python),
    worktree:workspace.worktree??null,
    skills:workspace.skills.filter(skill=>!skill.disableModelInvocation)
      .map(skill=>({name:skill.name,path:skill.filePath,description:skill.description})),
    agents:workspace.agentProfiles.map(profile=>({name:profile.name,description:profile.description,provider:profile.provider})),
    providers:context.config.subagents.providers.filter(provider=>provider.enabled).map(provider=>({id:provider.id,model:provider.model})),
    profiles:Object.entries(context.config.commandProfiles??{}).map(([name,profile])=>({name,...profile})),
    analysis_scripts:{directory:analysis,logs:join(analysis,"summarize-quaymesh-log.py"),reports:join(analysis,"aggregate-json-reports.py")}};
}
