import assert from "node:assert/strict";
import test from "node:test";
import {createRealTestServer,callOpen,structured} from "../session-card/server-fixture.js";

test("CT11: new command invocation is visible in an existing Task's live qm_session snapshot",{timeout:60_000},async t=>{
  const fixture=await createRealTestServer({git:false,uiEnabled:true});
  t.after(()=>fixture.dispose());
  const meta={"openai/session":"card-command-same-conversation"};
  const started=structured(await fixture.client.callTool({name:"start_session",arguments:{title:"动态命令测试",request_key:"live-command"},_meta:meta}));
  const opened=structured(await callOpen(fixture.client,fixture.project,"card-command-same-conversation"));
  const before=structured(await fixture.client.callTool({name:"qm_session",arguments:{session_id:opened.session_id,task_id:started.task_id,since_rev:-1},_meta:meta}));
  const beforeRev=before.snapshot.rev as number;
  const token=`card-command-${Date.now()}`;
  const cmd=process.platform==="win32"?`cmd /c echo ${token}`:`sh -c 'echo ${token}'`;
  const executed=await fixture.client.callTool({name:"exec_command",arguments:{workspace_id:opened.workspace_id,cmd,yield_time_ms:1000},_meta:meta});
  assert.notEqual(executed.isError,true,JSON.stringify(executed));
  const after=structured(await fixture.client.callTool({name:"qm_session",arguments:{session_id:opened.session_id,task_id:started.task_id,since_rev:beforeRev},_meta:meta}));
  assert.notEqual(after.unchanged,true,"a model command must advance its Task projection revision");
  assert.ok((after.snapshot.commands as Array<{cmd:string}>).some(item=>item.cmd.includes(token)),
    `new command missing from Task snapshot: ${JSON.stringify(after.snapshot.commands)}`);
});
