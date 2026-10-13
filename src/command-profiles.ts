import * as z from "zod/v4";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { expandHomePath } from "./roots.js";
import { canonicalResourcePath, type ExecutionResource } from "./execution-resources.js";
import { resolveExecutableCommand } from "./local-agent-command.js";

export const commandProfileSchema = z.object({
  description:z.string().min(1).max(300),
  executable:z.string().min(1),
  args:z.array(z.string()).max(128).default([]),
  workingDirectory:z.string().optional(),
  reads:z.array(z.string()).max(64).default([]),
  writes:z.array(z.string()).max(64).default([]),
  resources:z.array(z.string().min(1).max(512)).max(16).default([]),
}).strict();
export const commandProfilesSchema = z.record(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/),commandProfileSchema).default({});
export type CommandProfile = z.output<typeof commandProfileSchema>;

export async function requireCommandScope(cwd:string,scopeRoot?:string):Promise<string> {
  if(scopeRoot)return canonicalResourcePath(scopeRoot);
  let current=resolve(cwd);
  for(;;){
    if(existsSync(join(current,".git")))return canonicalResourcePath(current);
    const parent=dirname(current);if(parent===current)break;current=parent;
  }
  // A parent containing independent projects is a valid working directory.
  // Arbitrary shell text cannot reliably be classified as read-only, so
  // conservatively claim this whole directory for writes. The coordinator
  // will reject a real overlapping claim, not the directory's layout.
  return canonicalResourcePath(cwd);
}

export async function resolveCommandProfile(input:{name:string;profiles:Record<string,CommandProfile>;workspaceRoot:string;cwd:string;stateDir:string;operationId:string;env:NodeJS.ProcessEnv}) {
  const profile=input.profiles[input.name];
  if(!profile)throw new Error(`COMMAND_PROFILE_UNKNOWN: ${input.name}`);
  const output=join(input.stateDir,"command-output",input.operationId);
  const substitute=(value:string)=>value.replaceAll("${workspace}",input.workspaceRoot).replaceAll("${output}",output);
  const executable=resolveExecutableCommand(substitute(expandHomePath(profile.executable)),input.env);
  if(!executable)throw new Error(`COMMAND_PROFILE_EXECUTABLE_MISSING: ${input.name}`);
  const cwd=profile.workingDirectory ? resolve(input.cwd,substitute(expandHomePath(profile.workingDirectory))) : input.cwd;
  if(!existsSync(cwd))throw new Error(`执行配置的工作目录不存在：${cwd}`);
  const scopes:ExecutionResource[]=[{kind:"tree",path:output,access:"write"}];
  for(const access of ["read","write"] as const){
    for(const path of access==="read"?profile.reads:profile.writes)scopes.push({kind:"tree",path:resolve(cwd,substitute(expandHomePath(path))),access});
  }
  for(const key of profile.resources)scopes.push({kind:"named",key:substitute(key),access:"write"});
  await mkdir(output,{recursive:true,mode:0o700});
  return {program:{executable,args:profile.args.map(substitute)},cwd,scopes,outputDirectory:output,description:profile.description};
}
