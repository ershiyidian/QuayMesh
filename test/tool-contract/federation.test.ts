import assert from "node:assert/strict";
import test from "node:test";
import {randomUUID} from "node:crypto";
import {readFile, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {openDatabase} from "../../src/db/client.js";
import {SessionStore} from "../../src/session/store.js";
import {SessionToolRecorder} from "../../src/session/tool-recording.js";
import {twoNodes} from "./fixture.js";

test("TC01/02/A02：禁外连协调端声明21工具，远程有key的首次写入与重放只执行一次", {timeout: 60000}, async t => {
  const {worker, cloud} = await twoNodes(t);
  const tools = (await cloud.client.listTools()).tools.filter(tool => !(tool._meta?.ui as any)?.visibility?.includes("app"));
  assert.equal(tools.length, 21);
  for (const name of ["spawn_agent","followup_agent","send_message","wait_agent","interrupt_agent","list_agents"]) {
    assert.ok(tools.some(tool => tool.name === name), name);
  }
  assert.equal(cloud.config.network?.externalAccess, false);
  assert.equal(cloud.config.subagents.enabled, false);
  const meta = {"openai/session": randomUUID()};
  const raw = (name: string, args: Record<string, unknown>) => cloud.client.callTool({name, arguments: args, _meta: meta});
  const task = await raw("start_session", {title: "全新联邦请求", request_key: randomUUID()});
  assert.notEqual(task.isError, true);
  const opened = await raw("open_workspace", {root_id: "worker/main"});
  assert.notEqual(opened.isError, true, JSON.stringify(opened));
  const workspaceId = (opened.structuredContent as any).workspace_id;
  const script = join(worker.project, "append.mjs");
  await writeFile(script, "import {appendFileSync} from 'node:fs';appendFileSync('once.txt','one\\n');\n");
  const args = {workspace_id: workspaceId, cmd: `"${process.execPath}" "${script}"`, yield_time_ms: 2000, operation_key: randomUUID()};
  const first = await raw("exec_command", args);
  assert.notEqual(first.isError, true, JSON.stringify(first));
  const replay = await raw("exec_command", args);
  assert.notEqual(replay.isError, true, JSON.stringify(replay));
  assert.equal((first.structuredContent as any).operation_id, (replay.structuredContent as any).operation_id);
  assert.equal(await readFile(join(worker.project, "once.txt"), "utf8"), "one\n");
  const unavailable = await raw("spawn_agent", {workspace_id: workspaceId, message: "不要启动模型", target: "disabled"});
  assert.equal(unavailable.isError, true);
  await worker.dispose();
  const after = (await cloud.client.listTools()).tools;
  for (const tool of tools) assert.ok(after.some(item => item.name === tool.name));
});

test("DP06：远程操作key使用成员已有身份，不读取协调端不存在的远程路径", async () => {
  const {mkdtemp, rm} = await import("node:fs/promises");
  const {tmpdir} = await import("node:os");
  const root = await mkdtemp(join(tmpdir(), "qm-remote-key-"));
  const db = openDatabase(root);
  try {
    const store = new SessionStore(db.sqlite);
    const session = store.createSession("owner", "conversation", "远程操作");
    const member = store.upsertRemoteMember({id: randomUUID(), sessionId: session.id, nodeId: "remote-linux",
      workspaceId: "remote-workspace", root: "/remote-machine-only/project", sourceRoot: null,
      mode: "checkout", online: true, revision: 0});
    const record = store.reserveInvocation({id: randomUUID(), ownerId: "owner", sessionId: session.id,
      memberId: member.id, transportInstanceId: "connection-a", requestId: "1", toolName: "exec_command",
      argumentsJson: "{}", operationKey: "read-only-proof"});
    assert.equal(store.findKeyedInvocation("owner", session.id, member.id, "read-only-proof")?.id, record.id);
  } finally {db.close(); await rm(root, {recursive: true, force: true});}
});

test("DP06：转发写操作只记录入口回执，不在协调端执行远程路径基线", async () => {
  const {mkdtemp, rm} = await import("node:fs/promises");
  const {tmpdir} = await import("node:os");
  const root = await mkdtemp(join(tmpdir(), "qm-forwarded-receipt-"));
  const db = openDatabase(root);
  try {
    const store = new SessionStore(db.sqlite);
    const session = store.createSession("owner", "conversation-forwarded", "远程操作");
    const task = store.createTask(session.id, "远程写入", "remote-write");
    const member = store.upsertRemoteMember({id: randomUUID(), sessionId: session.id, nodeId: "remote-win",
      workspaceId: "remote-workspace", root: "E:\\remote-machine-only\\project", sourceRoot: null,
      mode: "checkout", online: true, revision: 0});
    const recorder = new SessionToolRecorder(store, {} as any, {} as any, {} as any, {} as any);
    let beforeWriteCalled = false;
    const result = await recorder.recordForwarded({
      identity: {owner_id:"owner",conversation_id:"conversation-forwarded",transport_instance_id:"http:test",
        request_id:"1",invocation_id:randomUUID(),task_id:task.id},
      workspace_id:"qm:remote-win:remote-workspace",tool_name:"exec_command",kind:"command",label:"remote command",
      input:{workspace_id:"qm:remote-win:remote-workspace",cmd:"echo ok",operation_key:"remote-key"},affectsFiles:true,
      beforeWrite:async()=>{beforeWriteCalled=true;throw new Error("COORDINATOR_MUST_NOT_TOUCH_REMOTE_PATH");},
      operation:async()=>({ok:true}),
    });
    assert.deepEqual(result,{ok:true});
    assert.equal(beforeWriteCalled,false);
    const invocation=store.findKeyedInvocation("owner",session.id,member.id,"remote-key");
    assert.equal(invocation?.state,"succeeded");
  } finally {db.close();await rm(root,{recursive:true,force:true});}
});
