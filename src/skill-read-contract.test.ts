import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceRegistry } from "./workspaces.js";
import { loadConfig } from "./config.js";
import { writeTestQuayMeshConfig } from "./test-support/config.test.js";
import { readFileTool } from "./pi-tools.js";

test("已公告的 Skill 允许使用家目录和绝对路径，其他文件及目录跳转无法读取", async t => {
  const home = mkdtempSync(join(tmpdir(), "quaymesh-skill-contract-"));
  const priorHome = process.env.HOME, priorProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  t.after(() => {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    if (priorProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = priorProfile;
    rmSync(home, { recursive:true, force:true, maxRetries:8, retryDelay:100 });
  });
  const project=join(home,"project");
  const skill=join(home,".codex","skills","advertised");
  const outside=join(home,"private");
  for(const path of [project,skill,outside])mkdirSync(path,{recursive:true});
  writeFileSync(join(skill,"SKILL.md"),"---\nname: advertised\ndescription: Fixture skill\n---\nfixture skill\n");
  writeFileSync(join(outside,"SKILL.md"),"synthetic secret");
  symlinkSync(outside,join(skill,"escape"),process.platform==="win32"?"junction":"dir");
  const config=loadConfig(writeTestQuayMeshConfig(join(home,"config"),{
    workspaces:{allowedRoots:[project]},storage:{stateDir:join(home,"state")},
    skills:{agentDir:join(home,".codex")},subagents:{enabled:false,instructions:"on-demand",providers:[]},
  }));
  const registry=new WorkspaceRegistry(config),opened=await registry.openWorkspace(project);
  const read=async(path:string)=>{
    const resolved=await registry.resolveReadPath(opened.workspace,path);
    return readFileTool({path:resolved.absolutePath},{cwd:project});
  };
  const tilde="~/.codex/skills/advertised/SKILL.md",absolute=join(skill,"SKILL.md");
  assert.deepEqual(await read(tilde),await read(absolute));
  for(const path of ["~/private/SKILL.md",join(outside,"SKILL.md"),
    "~/.codex/skills/advertised/../../../private/SKILL.md",
    "~/.codex/skills/advertised/escape/SKILL.md"])await assert.rejects(read(path));
});
