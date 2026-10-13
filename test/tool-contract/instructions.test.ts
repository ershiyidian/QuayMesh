import assert from "node:assert/strict";
import test from "node:test";
import {mkdir,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {fixture} from "./fixture.js";
import {buildWorkerBrief} from "../../src/session/prompts.js";

test("IN01/02/03/04/05/08：主MCP只发现根指令路径，正文按需，嵌套不预载",{timeout:60000},async t=>{
  const f=await fixture(t,{files:{"AGENTS.md":"# root-secret-instruction\n","CLAUDE.md":"# claude-private-guidance\n",
    "src/nested/AGENTS.md":"# nested-instruction-only-on-read\n"}, configure:async config=>{
      const agentDir=join(config.stateDir,"global-agent");await mkdir(agentDir,{recursive:true});
      await writeFile(join(agentDir,"AGENTS.md"),"global-private-instruction\n".repeat(10000));
      for(let index=0;index<120;index++) {
        const path=join(config.allowedRoots[0]!,`nested-${index}`);await mkdir(path,{recursive:true});await writeFile(join(path,"AGENTS.md"),"nested-marker");
      }
      return {...config,agentDir};
    }});
  assert.equal(f.workspace.agents_files,undefined);
  assert.deepEqual(f.workspace.available_agents_files.map((item:any)=>item.path),["AGENTS.md","CLAUDE.md"]);
  assert.ok(!JSON.stringify(f.workspace).includes("private-instruction"));
  const snapshot=await f.call("qm_session",{session_id:f.task.session_id,task_id:f.task.task_id,since_rev:-1});
  assert.ok(!JSON.stringify(snapshot).includes("root-secret-instruction"));
  assert.ok(!JSON.stringify(snapshot).includes("nested-instruction-only-on-read"));
  const root=await f.call("read",{...f.scope,path:"AGENTS.md"});assert.match(root.result,/root-secret-instruction/);
  const nested=await f.call("read",{...f.scope,path:"src/nested/AGENTS.md"});assert.match(nested.result,/nested-instruction-only-on-read/);
  const after=await f.call("qm_session",{session_id:f.task.session_id,task_id:f.task.task_id,since_rev:-1});
  assert.ok(after.snapshot.instructions.some((item:any)=>item.path.replaceAll("\\","/").endsWith("src/nested/AGENTS.md")&&item.status==="loaded"),JSON.stringify(after.snapshot.instructions));
  const reused=await f.raw("open_workspace",{path:f.project});
  assert.notEqual(reused.isError,true);
  const value=reused.structuredContent as any;
  assert.equal(value.workspace_id,f.workspace.workspace_id);assert.equal(value.skills,undefined);
  assert.equal(value.execution,undefined);assert.equal(value.available_agents_files,undefined);
  assert.ok(!JSON.stringify(reused).includes("global-private-instruction"));
  const attached=await f.call("attach_workspace",{path:f.project,session_id:f.task.session_id});
  assert.equal(attached.skills,undefined);assert.equal(attached.agents_files,undefined);
});

test("IN06/07：恢复不注入正文，本地代理保留项目规则说明",{timeout:60000},async t=>{
  const f=await fixture(t,{files:{"AGENTS.md":"private-default-instruction\n"}});
  const recovery=await f.call("workspace_context",{...f.scope,action:"recovery",task_id:f.task.task_id});
  assert.ok(!JSON.stringify(recovery).includes("private-default-instruction"));
  const brief=buildWorkerBrief("检查指定文件");
  assert.match(brief,/Project instructions.*apply/);
  const tools=await f.client.listTools();
  assert.ok(!tools.tools.find(tool=>tool.name==="read")!.description!.includes("AGENTS.md"));
  assert.ok(!f.client.getInstructions()?.includes("Read applicable project instructions"));
});
