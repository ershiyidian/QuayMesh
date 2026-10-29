import assert from "node:assert/strict";
import test from "node:test";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createRealTestServer, callOpen, structured, waitForFixture, waitForRecordedTool } from "./server-fixture.js";
import { validateSnapshot } from "../../src/session/schema.js";
import { openDatabase } from "../../src/db/client.js";

for (const git of [true, false]) {
  test(`后台命令完成后仍属于原Task，新Task使用独立文件基准（git=${git}）`, {timeout:60000}, async t => {
    const server = await createRealTestServer({git, uiEnabled:true});
    t.after(() => server.dispose());
    const conversation = `task-background-${git}`;
    const meta = {"openai/session":conversation};
    const first = structured(await server.client.callTool({name:"start_session",arguments:{title:"后台任务",request_key:"background-one"},_meta:meta}));
    const opened = structured(await callOpen(server.client,server.project,conversation));
    const scope = {sessionId:String(opened.session_id),workspaceId:String(opened.workspace_id),conversationId:conversation,
      paths:["first-result.txt","second-result.txt"]};
    const script = join(server.project,"background.mjs"), gate = join(server.root,"release-background"), started = join(server.root,"background-started");
    await writeFile(script,`import {existsSync,writeFileSync} from 'node:fs';\nwriteFileSync(${JSON.stringify(started)},'ready');\nconst timer=setInterval(()=>{if(existsSync(${JSON.stringify(gate)})){clearInterval(timer);writeFileSync('first-result.txt','original task result\\n');console.log('background-finished');}},25);\n`);
    const commandResult = await server.client.callTool({name:"exec_command",arguments:{workspace_id:opened.workspace_id,
      cmd:`"${process.execPath}" "${script}"`,yield_time_ms:20},_meta:meta});
    assert.notEqual(commandResult.isError,true,JSON.stringify(commandResult.content));
    const command = structured(commandResult);
    assert.equal(command.running,true);
    await waitForFixture(server,scope,"background process started before handoff",()=>readFile(started,"utf8").catch((error:NodeJS.ErrnoException)=>{
      if(error.code==="ENOENT")return null;throw error;
    }),value=>value==="ready");
    const handoff = await server.client.callTool({name:"finish_task",arguments:{task_id:first.task_id,status:"handed_off",summary:"后台继续"},_meta:meta});
    assert.equal(handoff.isError,true);
    assert.match(JSON.stringify(handoff),/TASK_HANDOFF_NOT_TERMINAL/);
    const selected = structured(await server.client.callTool({name:"task_resume",arguments:{action:"inspect",task_id:first.task_id},_meta:meta}));
    const second = structured(await server.client.callTool({name:"start_session",arguments:{title:"新任务",request_key:"background-two",
      new_goal:true,expected_binding_revision:(selected.binding as {binding_revision:number}).binding_revision},_meta:meta}));
    assert.notEqual(second.task_id,first.task_id);
    await writeFile(gate,"continue");
    await waitForRecordedTool(server,scope,commandResult);
    assert.equal(await readFile(join(server.project,"first-result.txt"),"utf8"),"original task result\n");
    const patch = await server.client.callTool({name:"apply_patch",arguments:{workspace_id:opened.workspace_id,
      patch:"*** Begin Patch\n*** Add File: second-result.txt\n+new task result\n*** End Patch"},_meta:meta});
    assert.notEqual(patch.isError,true,JSON.stringify(patch.content));
    await waitForRecordedTool(server,scope,patch);
    const db = openDatabase(server.config.stateDir);
    try {
      assert.deepEqual(db.sqlite.prepare("SELECT state,result_status FROM qm_tasks WHERE id=?").get(first.task_id),
        {state:"active",result_status:null},"changing goals and finishing a background command do not close the original goal");
      const original = db.sqlite.prepare("SELECT task_id FROM qm_events WHERE event_type='operation_finished' AND task_id=?").all(first.task_id);
      assert.ok(original.length>0);
      const baseline = db.sqlite.prepare("SELECT task_id FROM qm_task_change_baselines WHERE task_id IN (?,?)").all(first.task_id,second.task_id);
      assert.ok(baseline.some(row=>(row as {task_id:string}).task_id===first.task_id));
      assert.ok(baseline.some(row=>(row as {task_id:string}).task_id===second.task_id));
    } finally {db.close();}
    const readCurrent=async()=>validateSnapshot(structured(await server.client.callTool({name:"qm_session",arguments:{
      session_id:opened.session_id,task_id:second.task_id,member_id:opened.member_id,since_rev:-1}})).snapshot);
    // 文件写入先完成，差异投影异步发布；验收等实际文件事件，不借用状态查询触发归档。
    const current=await waitForFixture(server,scope,"new Task file projection",readCurrent,
      value=>value.files.some(file=>file.path==="second-result.txt"));
    assert.ok(current.files.some(file=>file.path==="second-result.txt"));
    assert.equal(current.files.some(file=>file.path==="first-result.txt"),false);
    const historical = validateSnapshot(structured(await server.client.callTool({name:"qm_session",arguments:{
      session_id:opened.session_id,task_id:first.task_id,member_id:opened.member_id,since_rev:-1}})).snapshot);
    assert.equal(historical.files.some(file=>file.path==="second-result.txt"),false);
    assert.ok(historical.commands.some(value=>value.cmd.includes("background.mjs")));
  });
}
