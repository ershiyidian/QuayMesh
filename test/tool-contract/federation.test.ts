import assert from "node:assert/strict";
import test from "node:test";
import {randomUUID} from "node:crypto";
import {readFile, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {openDatabase} from "../../src/db/client.js";
import {SessionStore} from "../../src/session/store.js";
import {SessionToolRecorder, type RecordModelToolInput} from "../../src/session/tool-recording.js";
import {twoNodes} from "./fixture.js";

test("TC01/02/A02：禁外连协调端保留执行工具与只读诊断，远程有key的首次写入与重放只执行一次", {timeout: 60000}, async t => {
  const {worker, cloud} = await twoNodes(t);
  const tools = (await cloud.client.listTools()).tools.filter(tool => !(tool._meta?.ui as any)?.visibility?.includes("app"));
  assert.equal(tools.length, 22);
  assert.ok(tools.some(tool=>tool.name==='read_diagnostics'));
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

test("远程写请求先交付可恢复回执，完成后按同一 key 重放不会执行第二次", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(join(tmpdir(), "qm-remote-quick-receipt-"));
  const db = openDatabase(root);
  try {
    const store = new SessionStore(db.sqlite);
    const session = store.createSession("owner", "conversation", "远程受理回执");
    const task = store.createTask(session.id, "慢速远程写入", "slow-write");
    const member = store.upsertRemoteMember({ id: randomUUID(), sessionId: session.id, nodeId: "remote-linux",
      workspaceId: "remote-ws", root: "/remote-only/project", sourceRoot: null,
      mode: "checkout", online: true, revision: 0 });
    const recorder = new SessionToolRecorder(store, {} as any, {} as any, {} as any, {} as any);
    let finish!: (result: { content: { type: string; text: string }[] }) => void;
    let invoked = 0;
    const identity = { owner_id: "owner", conversation_id: "conversation", transport_instance_id: "stable-transport",
      request_id: "42", task_id: task.id };
    const args = { workspace_id: "qm:remote-linux:remote-ws", cmd: "do-real-work", operation_key: "same-operation" };
    type Reply = { content?: { type: string; text: string }[]; accepted?: boolean; operation_id?: string;
      next_action?: { tool: string; arguments: { action: string; operation_id?: string } } };
    const options: RecordModelToolInput<Reply> = {
      identity, workspace_id: args.workspace_id, tool_name: "exec_command", kind: "command",
      label: "slow command", input: args, affectsFiles: true, replyWaitMs: 30,
      pendingResult: (context: { operation_id?: string }) => ({
        accepted: true, operation_id: context.operation_id,
        next_action: { tool: "workspace_context", arguments: { action: "status", operation_id: context.operation_id } },
      }),
      operation: async () => { invoked++; return new Promise<{ content: { type: string; text: string }[] }>(resolve => { finish = resolve; }); },
    };
    const accepted = await recorder.recordForwarded(options);
    assert.equal((accepted as { accepted?: boolean }).accepted, true);
    assert.ok((accepted as { operation_id?: string }).operation_id?.startsWith("op_"));
    const pending = store.findKeyedInvocation("owner", session.id, member.id, "same-operation");
    assert.equal(pending?.state, "running");
    assert.equal(pending?.operation_id, (accepted as { operation_id?: string }).operation_id);
    finish({ content: [{ type: "text", text: "modified once" }] });
    await recorder.close();
    const saved = store.findKeyedInvocation("owner", session.id, member.id, "same-operation");
    assert.equal(saved?.state, "succeeded");
    assert.match(saved?.result_json ?? "", /modified once/);
    assert.deepEqual(await recorder.recordForwarded(options), { content: [{ type: "text", text: "modified once" }] });
    assert.equal(invoked, 1);
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});

test("前台受理回执之后远程调用失败会持久记录 unknown，不产生未处理拒绝", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(join(tmpdir(), "qm-remote-lost-receipt-"));
  const db = openDatabase(root);
  try {
    const store = new SessionStore(db.sqlite);
    const session = store.createSession("owner", "conversation", "断连后失败归档");
    const task = store.createTask(session.id, "断连执行", "disconnect");
    const member = store.upsertRemoteMember({ id: randomUUID(), sessionId: session.id, nodeId: "remote-linux",
      workspaceId: "remote-ws", root: "/remote-only/project", sourceRoot: null,
      mode: "checkout", online: true, revision: 0 });
    const recorder = new SessionToolRecorder(store, {} as any, {} as any, {} as any, {} as any);
    let rejectWork!: (error: Error) => void;
    const result = await recorder.recordForwarded({
      identity: { owner_id: "owner", conversation_id: "conversation", transport_instance_id: "transport",
        request_id: "99", task_id: task.id },
      workspace_id: "qm:remote-linux:remote-ws", tool_name: "apply_patch", kind: "patch", label: "patch",
      input: { operation_key: "write-once", patch: "patch-content" }, affectsFiles: true, replyWaitMs: 30,
      pendingResult: context => ({ accepted: true, operation_id: context.operation_id }),
      operation: async () => new Promise<{ accepted: boolean; operation_id?: string }>((_resolve, reject) => { rejectWork = reject; }),
    });
    assert.equal(result.accepted, true);
    rejectWork(Object.assign(new Error("remote response lost"), { code: "REQUEST_TIMEOUT" }));
    await recorder.close();
    const saved = store.findKeyedInvocation("owner", session.id, member.id, "write-once");
    assert.equal(saved?.state, "unknown");
    assert.equal(saved?.effect, "unknown");
    assert.match(saved?.result_json ?? "", /REQUEST_TIMEOUT/);
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});
