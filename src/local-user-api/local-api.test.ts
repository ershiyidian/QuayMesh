import assert from "node:assert/strict";
import test, {type TestContext} from "node:test";
import {createConnection, createServer} from "node:net";
import {once} from "node:events";
import {createInterface} from "node:readline";
import {mkdtemp, rm, lstat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import Database from "better-sqlite3";
import {localUserApiSchema} from "../db/local-user-api-schema.js";
import {taskPeerSchema} from "../db/task-peer-schema.js";
import {TaskPeerMailboxStore, type TaskPeerActivity} from "../messaging/task-peer-mailbox.js";
import {taskPrincipalFromAuthInfo} from "../tasks/task-access.js";
import {requestContextStorage} from "../session/invocations.js";
import type {InvocationContext} from "../session/types.js";
import type {TrustedInvocationEnvelope} from "../federation/session-types.js";
import {LocalUserGrantStore, LocalCredentialVerifier} from "./grants.js";
import {LocalObservationStore} from "./observations.js";
import {LocalUserDispatcher} from "./dispatcher.js";
import {LocalApiSessions, startLocalUnixApi} from "./ipc.js";
import {LOCAL_USER_API_PROTOCOL, LOCAL_USER_API_MAX_FRAME_BYTES} from "./protocol.js";
import {connectNativeUserChannel} from "./native-channel.js";

function fixture(t: TestContext) {
  const db = new Database(":memory:"); db.pragma("foreign_keys=ON");
  db.exec(`CREATE TABLE qm_sessions(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL);
    CREATE TABLE qm_tasks(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES qm_sessions(id),state TEXT NOT NULL,
      title TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,finished_at TEXT,result_status TEXT,
      last_activity_at TEXT NOT NULL DEFAULT 'unchanged');
    CREATE TABLE qm_session_members(id TEXT PRIMARY KEY,node_id TEXT NOT NULL);
    CREATE TABLE qm_task_members(task_id TEXT NOT NULL,member_id TEXT NOT NULL);
    CREATE TABLE qm_task_finalizations(task_id TEXT PRIMARY KEY,error TEXT,completed_at TEXT,recovery_state TEXT);
    CREATE TABLE qm_invocations(id TEXT PRIMARY KEY,operation_id TEXT,owner_id TEXT,task_id TEXT,session_id TEXT,member_id TEXT,tool_name TEXT,state TEXT);
    CREATE TABLE qm_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT,event_type TEXT,created_at TEXT,data_json TEXT);
    CREATE INDEX qm_events_task_sequence ON qm_events(task_id,sequence);
    INSERT INTO qm_sessions VALUES('s','owner'),('x','foreign');
    INSERT INTO qm_tasks(id,session_id,state,title,created_at) VALUES('a','s','active','A','2026-10-31'),
      ('b','s','active','B','2026-10-31'),('foreign','x','active','Private','2026-10-31');
    INSERT INTO qm_session_members VALUES('ma','worker'),('mb','worker');
    INSERT INTO qm_task_members VALUES('a','ma'),('b','mb');
    INSERT INTO qm_invocations VALUES('ia','oa','owner','a','s','ma','exec_command','running'),
      ('ib','ob','owner','b','s','mb','exec_command','running');
    INSERT INTO qm_events(task_id,event_type,created_at,data_json) VALUES('a','command_finished','2026-10-31','{"secret":"never expose"}'),
      ('foreign','command_finished','2026-10-31','{"secret":"foreign secret"}');`);
  db.exec(localUserApiSchema); db.exec(taskPeerSchema);
  t.after(() => db.close());
  let now = 1_800_000_000_000;
  const activities: TaskPeerActivity[] = ["a", "b"].map(taskId => ({taskId, executionStatus: "unknown", lastProgressAt: now - 1000, executionObservedAt: null}));
  let resolveActivity = async (_ids: readonly string[]) => activities;
  const grants = new LocalUserGrantStore(db, () => now), local = new LocalCredentialVerifier(db, "worker", () => now);
  const activity = (ids: readonly string[]) => resolveActivity(ids);
  const peer = new TaskPeerMailboxStore(db, {ownerSource: "legacy-session", now: () => now, activityResolver: activity});
  const dispatcher = new LocalUserDispatcher(grants, new LocalObservationStore(db, "center", activity, () => now), peer);
  const principal = taskPrincipalFromAuthInfo({extra: {owner_id: "owner"}});
  const forward = async (credential: string, method: Parameters<typeof dispatcher.dispatch>[2], params = {}) => dispatcher.dispatch("worker", local.authenticate(credential), method, params);
  async function user(extra = {}) {
    const issued = await grants.issueUser(principal, {nodeId: "worker", clientName: "Dock", expiresAt: now + 60_000, ...extra});
    await local.install(grants.verifier(issued.grantId)); return issued;
  }
  async function model(task: "a" | "b") {
    const current: InvocationContext = {owner_id: "owner", task_id: task, session_id: "s", member_id: `m${task}`,
      workspace_id: "workspace", invocation_id: `i${task}`, operation_id: `o${task}`, tool_name: "exec_command",
      actor: "model", conversation_id: null, transport_instance_id: "transport", request_id: `r${task}`};
    const trusted = {...current, request_id: String(current.request_id)} as TrustedInvocationEnvelope;
    await requestContextStorage.run(current, () => grants.recordCurrentDispatch("worker", trusted));
    const issued = await grants.issueModel("worker", current.invocation_id);
    await local.install(grants.verifier(issued.grantId)); return {issued, current, trusted};
  }
  return {db, grants, local, dispatcher, principal, forward, user, model, activities,
    advance: (ms: number) => {now += ms;}, resolveWith: (resolver: typeof resolveActivity) => {resolveActivity = resolver;}};
}

test("default user grant is metadata-only and node/owner scoped", async t => {
  const f = fixture(t), user = await f.user();
  const list = await f.forward(user.credential, "tasks.list") as {items: {taskId: string}[]};
  assert.deepEqual(list.items.map(item => item.taskId), ["a", "b"]);
  const events = await f.forward(user.credential, "events.read", {task_id: "a"});
  assert.equal(JSON.stringify(events).includes("secret"), false);
  await assert.rejects(f.forward(user.credential, "tasks.get", {task_id: "foreign"}), {code: "TASK_ACCESS_DENIED"});
  await assert.rejects(f.dispatcher.dispatch("wrong-node", f.local.authenticate(user.credential), "status.get", {}), {code: "LOCAL_API_UNAUTHORIZED"});
  await assert.rejects(f.forward(user.credential, "peer.send", {target_task_id: "b", message_key: "key", body: "x"}));
  await assert.rejects(f.grants.issueUser({ownerId: "owner"} as typeof f.principal,
    {nodeId: "worker", clientName: "Forged", expiresAt: user.expiresAt}), {code: "MISSING_AUTHENTICATED_OWNER"});
  assert.equal(JSON.stringify(f.db.prepare("SELECT * FROM qm_local_api_grants").all()).includes(user.credential), false);
});

test("rotation and revocation reject stale node mirrors and previously verified grants", async t => {
  const f = fixture(t), user = await f.user(), old = f.local.authenticate(user.credential);
  const checked = f.grants.authenticateForwarded("worker", old);
  const rotated = await f.grants.rotate(f.principal, user.grantId);
  await assert.rejects(f.dispatcher.dispatch("worker", old, "status.get", {}), {code: "LOCAL_API_UNAUTHORIZED"});
  assert.throws(() => checked.assertCurrent("tasks:read", ["a"]), {code: "LOCAL_API_UNAUTHORIZED"});
  await f.local.install(f.grants.verifier(user.grantId));
  assert.throws(() => f.local.authenticate(user.credential), {code: "LOCAL_API_UNAUTHORIZED"});
  await f.forward(rotated.credential, "status.get");
  await f.grants.revoke(f.principal, user.grantId);
  await assert.rejects(f.forward(rotated.credential, "status.get"), {code: "LOCAL_API_UNAUTHORIZED"});
});

test("metadata distinguishes an unclosed Task from current activity and uses the resolved Console title", async t => {
  const f = fixture(t), user = await f.user();
  f.db.prepare("UPDATE qm_tasks SET title='QuayMesh task' WHERE id='a'").run();
  f.resolveWith(async () => [{...f.activities[0]!, title: "Resolved user goal"}, f.activities[1]!]);
  const initial = await f.forward(user.credential, "tasks.get", {task_id: "a"}) as {title: string; state: string; current: boolean; activityState: string};
  assert.equal(initial.title, "Resolved user goal"); assert.equal(initial.state, "active");
  assert.equal(initial.current, true); assert.equal(initial.activityState, "recent");
  f.activities[0]!.lastProgressAt = 1;
  const idle = await f.forward(user.credential, "tasks.get", {task_id: "a"}) as typeof initial;
  assert.equal(idle.state, "active"); assert.equal(idle.current, false); assert.equal(idle.activityState, "idle");
  f.resolveWith(async () => []);
  const unknown = await f.forward(user.credential, "tasks.get", {task_id: "a"}) as typeof initial;
  assert.notEqual(unknown.title, "QuayMesh task"); assert.equal(unknown.current, false); assert.equal(unknown.activityState, "unknown");
});

test("model source comes from actual current dispatch; observation and peer scopes differ", async t => {
  const f = fixture(t);
  await assert.rejects(f.grants.issueModel("worker", "ia"), {code: "LOCAL_API_EXECUTION_BINDING_REQUIRED"});
  const a = await f.model("a"), b = await f.model("b");
  await assert.rejects(f.grants.recordCurrentDispatch("worker", a.trusted), {code: "LOCAL_API_EXECUTION_BINDING_REQUIRED"});
  await assert.rejects(f.grants.issueModel("other-node", "ia"), {code: "LOCAL_API_EXECUTION_BINDING_REQUIRED"});
  await assert.rejects(requestContextStorage.run(a.current, () => f.grants.recordCurrentDispatch("worker", {...a.trusted, task_id: "b"})),
    {code: "LOCAL_API_EXECUTION_BINDING_REQUIRED"});
  assert.deepEqual((await f.forward(a.issued.credential, "tasks.list") as {items: {taskId: string}[]}).items.map(item => item.taskId), ["a"]);
  await assert.rejects(f.forward(a.issued.credential, "events.read", {task_id: "b"}), {code: "LOCAL_API_TASK_SCOPE_DENIED"});
  await assert.rejects(f.forward(a.issued.credential, "peer.send", {target_task_id: "b", source_task_id: "foreign", message_key: "bad", body: "x"}),
    {code: "LOCAL_API_INVALID_REQUEST"});
  const sent = await f.forward(a.issued.credential, "peer.send", {target_task_id: "b", message_key: "one", body: "Please check"}) as {message: {id: string; sourceTaskId: string}};
  assert.equal(sent.message.sourceTaskId, "a");
  const received = await f.forward(b.issued.credential, "peer.receive", {request_key: "read"}) as {deliveryId: string; messages: {id: string}[]};
  const nextB = await f.model("b");
  assert.equal(nextB.issued.clientId, b.issued.clientId, "next terminal keeps the Task receiver identity");
  assert.equal(nextB.issued.grantId, b.issued.grantId, "retry rotates one dispatch grant rather than escaping its revocation");
  await f.forward(nextB.issued.credential, "peer.ack", {delivery_id: received.deliveryId, message_ids: [sent.message.id]});
  await f.grants.revoke(f.principal, b.issued.grantId);
  await assert.rejects(f.grants.issueModel("worker", "ib"), {code: "LOCAL_API_UNAUTHORIZED"});
  await assert.rejects(f.forward(a.issued.credential, "peer.send", {target_task_id: "foreign", message_key: "bad-owner", body: "x"}), {code: "TASK_ACCESS_DENIED"});
  f.advance(15 * 60_000);
  await assert.rejects(f.forward(a.issued.credential, "status.get"), {code: "LOCAL_API_UNAUTHORIZED"});
  await assert.rejects(f.grants.issueModel("worker", "ia"), {code: "LOCAL_API_EXECUTION_BINDING_REQUIRED"});
});

test("peer write rechecks central revocation after awaited actual Task observation", async t => {
  const f = fixture(t), a = await f.model("a");
  let resume!: (value: TaskPeerActivity[]) => void;
  f.resolveWith(() => new Promise(resolve => {resume = resolve;}));
  const sending = f.forward(a.issued.credential, "peer.send", {target_task_id: "b", message_key: "race", body: "x"});
  await f.grants.revoke(f.principal, a.issued.grantId); resume(f.activities);
  await assert.rejects(sending, {code: "LOCAL_API_UNAUTHORIZED"});
  assert.equal((f.db.prepare("SELECT count(*) AS n FROM qm_task_peer_messages").get() as {n: number}).n, 0);
});

async function socketFrames(endpoint: string, request: unknown, count = 1): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({path: endpoint}), frames: unknown[] = [];
    let buffer = "";
    const timer = setTimeout(() => {socket.destroy(); reject(new Error("test IPC deadline"));}, 3000);
    socket.on("error", reject); socket.once("close", () => {clearTimeout(timer); resolve(frames);});
    socket.once("connect", () => socket.write(typeof request === "string" ? request : JSON.stringify(request) + "\n"));
    socket.on("data", chunk => {
      buffer += chunk.toString("utf8");
      for (;;) {const at = buffer.indexOf("\n"); if (at < 0) break;
        frames.push(JSON.parse(buffer.slice(0, at))); buffer = buffer.slice(at + 1);
        if (frames.length >= count) {socket.destroy(); resolve(frames); return;}}
    });
    socket.once("end", () => resolve(frames));
  });
}

test("actual private Unix socket accepts only versioned methods and closes oversized frames", {timeout: 8000}, async t => {
  const f = fixture(t), user = await f.user(), configDir = await mkdtemp(join(tmpdir(), "qmla-"));
  const sessions = new LocalApiSessions(f.local, async (identity, method, params) => f.dispatcher.dispatch("worker", identity, method, params));
  const server = await startLocalUnixApi({configDir, nodeId: "worker", sessions});
  try {
    assert.equal((await lstat(server.endpoint)).mode & 0o777, 0o600);
    assert.equal((await lstat(join(configDir, "local-api"))).mode & 0o777, 0o700);
    const request = {protocol: LOCAL_USER_API_PROTOCOL, id: "test", credential: user.credential, method: "status.get", params: {}};
    const response = (await socketFrames(server.endpoint, request))[0] as {ok: boolean; result: {nodeId: string}};
    assert.equal(response.ok, true); assert.equal(response.result.nodeId, "worker");
    for (const bad of [{...request, credential: `qml1_${"x".repeat(43)}`}, {...request, method: "console.request"},
      {...request, params: {owner_id: "owner"}}, {...request, protocol: "quaymesh.local-user.v0"}]) {
      assert.equal(((await socketFrames(server.endpoint, bad))[0] as {ok: boolean}).ok, false);
    }
    assert.deepEqual(await socketFrames(server.endpoint, "x".repeat(LOCAL_USER_API_MAX_FRAME_BYTES + 1)), []);
  } finally {await server.close(); await rm(configDir, {recursive: true, force: true});}
});

test("actual socket watch revalidates revocation and sends bounded empty heartbeats", {timeout: 8000}, async t => {
  const f = fixture(t), user = await f.user(), configDir = await mkdtemp(join(tmpdir(), "qmla-"));
  let calls = 0;
  const sessions = new LocalApiSessions(f.local, async (identity, method, params) => {
    calls++; if (calls === 3) await f.grants.revoke(f.principal, user.grantId);
    return f.dispatcher.dispatch("worker", identity, method, params);
  }, {pollMs: 20, heartbeatMs: 10});
  const server = await startLocalUnixApi({configDir, nodeId: "worker", sessions});
  try {
    const frames = await socketFrames(server.endpoint, {protocol: LOCAL_USER_API_PROTOCOL, id: "watch", credential: user.credential,
      method: "events.watch", params: {task_id: "a"}}, 3) as {ok: boolean; done: boolean; result?: {heartbeat?: boolean}; error?: {code: string}}[];
    assert.equal(frames[0].done, false); assert.equal(frames[1].result?.heartbeat, true);
    assert.equal(frames[2].ok, false); assert.equal(frames[2].error?.code, "LOCAL_API_UNAUTHORIZED");
    assert.equal(calls, 3);
  } finally {await server.close(); await rm(configDir, {recursive: true, force: true});}
});

test("native Core channel uses actual framed IPC and cancels only the disconnected request", {timeout: 8000}, async t => {
  const f = fixture(t), user = await f.user(), directory = await mkdtemp(join(tmpdir(), "qmla-channel-"));
  const endpoint = join(directory, "test.sock"), server = createServer();
  await new Promise<void>((resolve, reject) => {server.once("error", reject); server.listen(endpoint, resolve);});
  const accepted = once(server, "connection");
  const readiness: boolean[] = [];
  let entered!: () => void, aborted!: () => void;
  let waiting = new Promise<void>(resolve => {entered = resolve;});
  let cancelled = new Promise<void>(resolve => {aborted = resolve;});
  const sessions = new LocalApiSessions(f.local, async (identity, method, params, signal) => {
    if (method === "events.read" && typeof params.cursor === "string") {
      entered();
      return new Promise<never>((_, reject) => signal.addEventListener("abort", () => {aborted(); reject(signal.reason);}, {once: true}));
    }
    return f.dispatcher.dispatch("worker", identity, method, params);
  }, {pollMs: 10});
  const channel = connectNativeUserChannel({endpoint: `\\\\.\\pipe\\QuayMesh.LocalUser.Core.${"a".repeat(32)}`, key: "b".repeat(64),
    nodeId: "worker", configDir: directory, sessions, ready: value => readiness.push(value),
    connect: () => createConnection({path: endpoint})});
  const [socket] = await accepted as [import("node:net").Socket];
  socket.on("error", () => undefined);
  const lines = createInterface({input: socket}), frames = lines[Symbol.asyncIterator]();
  const read = async () => JSON.parse((await frames.next()).value!) as Record<string, any>;
  const send = (value: unknown) => socket.write(JSON.stringify(value) + "\n");
  const request = (connectionId: string, method: string, params: unknown = {}, credential = user.credential) => ({kind: "request", connectionId,
    request: {protocol: LOCAL_USER_API_PROTOCOL, id: connectionId, method, params, credential}});
  try {
    const handshake = await read();
    assert.deepEqual(handshake, {protocol: "quaymesh.local-user.bridge.v1", key: "b".repeat(64), nodeId: "worker", configDir: directory});
    assert.equal(readiness.includes(true), false);
    // Deliberately split a real transport frame: the Core must not process a
    // partial ready envelope or consume application frames before it.
    socket.write('{"protocol":"quaymesh.local-user.bridge.v1",');
    socket.write('"kind":"ready"}\n');
    send(request("status", "status.get"));
    const status = await read(); assert.equal(status.connectionId, "status"); assert.equal(status.response.ok, true);
    assert.equal(status.response.result.nodeId, "worker"); assert.equal(readiness.at(-1), true);
    send(request("forged", "status.get", {}, `qml1_${"x".repeat(43)}`));
    assert.equal((await read()).response.error.code, "LOCAL_API_UNAUTHORIZED");
    send(request("watch-one", "events.watch", {task_id: "a"}));
    assert.equal((await read()).response.done, false); await waiting;
    send({kind: "cancel", connectionId: "watch-one"}); await cancelled;
    send(request("still-connected", "tasks.get", {task_id: "a"}));
    const after = await read(); assert.equal(after.connectionId, "still-connected"); assert.equal(after.response.result.taskId, "a");
    waiting = new Promise<void>(resolve => {entered = resolve;}); cancelled = new Promise<void>(resolve => {aborted = resolve;});
    send(request("watch-two", "events.watch", {task_id: "a"})); await read(); await waiting;
    const closed = once(socket, "close"); socket.end("x".repeat(LOCAL_USER_API_MAX_FRAME_BYTES + 1025));
    await closed; await cancelled;
    assert.equal(readiness.at(-1), false, "oversized private frames close the channel and cancel its remaining observations");
  } finally {
    socket.destroy(); lines.close(); await channel.close(); sessions.close();
    await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, {recursive: true, force: true});
  }
});
