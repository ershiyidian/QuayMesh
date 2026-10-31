import assert from "node:assert/strict";
import test from "node:test";
import {writeFile, readFile} from "node:fs/promises";
import {join} from "node:path";
import {createRealTestServer, freePort, structured, waitForFixture, type RealTestServer} from "../session-card/server-fixture.js";
import {openDatabase} from "../../src/db/client.js";
import {LocalUserClient} from "../../src/local-user-api/client.js";
import {rootHandle} from "../../src/federation/routing.js";

const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const meta = {"openai/session": "local-api-real-execution"};
async function call(server: RealTestServer, name: string, args: Record<string, unknown>) {
  const result = await server.client.callTool({name, arguments: args, _meta: meta});
  assert.notEqual(result.isError, true, JSON.stringify(result.content)); return structured(result);
}
async function probeThroughRealExec(gateway: RealTestServer, worker: RealTestServer, workspaceId: string, taskId: string) {
  const script = join(worker.project, "local-api-probe.mjs"), output = join(worker.project, "local-api-probe.json");
  // The child performs actual socket calls with injected credentials. Only
  // metadata and booleans are written; credentials never enter test output.
  await writeFile(script, `import {createConnection} from 'node:net';
import {writeFile} from 'node:fs/promises';
const credential=process.env.QUAYMESH_LOCAL_API_CREDENTIAL,endpoint=process.env.QUAYMESH_LOCAL_API_ENDPOINT;
async function request(method,params){return new Promise((resolve,reject)=>{
const socket=createConnection({path:endpoint});let text='';const timer=setTimeout(()=>{socket.destroy();reject(new Error('timeout'));},6000);
socket.on('error',reject);socket.once('close',()=>clearTimeout(timer));
socket.once('connect',()=>socket.write(JSON.stringify({protocol:'quaymesh.local-user.v1',id:'probe',credential,method,params})+'\\n'));
socket.on('data',chunk=>{text+=chunk;const end=text.indexOf('\\n');if(end<0)return;const frame=JSON.parse(text.slice(0,end));socket.destroy();frame.ok?resolve(frame.result):reject(new Error(frame.error.code));});});}
let result;try{if(!credential||!endpoint)throw new Error('missing_task_credential');
const status=await request('status.get',{}),task=await request('tasks.get',{task_id:${JSON.stringify(taskId)}});
result={ok:true,status,task,bridgeKeyInherited:Boolean(process.env.QUAYMESH_LOCAL_API_BRIDGE_KEY),
unexpectedLocalApiInherited:Object.keys(process.env).some(key=>/^QUAYMESH_LOCAL_API_/i.test(key)&&!['QUAYMESH_LOCAL_API_CREDENTIAL','QUAYMESH_LOCAL_API_ENDPOINT'].includes(key))};
}catch(error){result={ok:false,error:error.message};}await writeFile(${JSON.stringify(output)},JSON.stringify(result));
`, "utf8");
  const inheritedKey = "quaymesh_local_api_credential", previousCredential = process.env[inheritedKey];
  process.env[inheritedKey] = "non-secret inherited credential sentinel";
  try {
    await call(gateway, "exec_command", {workspace_id: workspaceId, cmd: `${shellQuote(process.execPath)} ${shellQuote(script)}`,
      execution_scope: ".", yield_time_ms: 1000, max_output_tokens: 1000});
  } finally {
    if (previousCredential === undefined) delete process.env[inheritedKey]; else process.env[inheritedKey] = previousCredential;
  }
  const result = await waitForFixture(gateway, {sessionId: "local-api-probe"}, "injected Task credential reaches the actual local API",
    async () => {try {return JSON.parse(await readFile(output, "utf8")) as Record<string, any>;} catch {return null;}}, value => value !== null, 12_000);
  assert.ok(result?.ok, JSON.stringify(result));
  assert.equal(result.status.sourceTaskId, taskId); assert.deepEqual(result.status.taskIds, [taskId]);
  assert.equal(result.task.taskId, taskId); assert.equal(result.bridgeKeyInherited, false);
  assert.equal(result.unexpectedLocalApiInherited, false, "inherited local API credentials are removed case-insensitively");
  return result;
}
async function login(server: RealTestServer) {
  const response = await fetch(server.baseUrl + "/console/api/login", {method: "POST",
    headers: {origin: server.baseUrl, "content-type": "application/json"}, body: JSON.stringify({password: server.config.oauth.ownerToken})});
  assert.equal(response.status, 200);
  const cookie = response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
  const session = await response.json() as {csrf: string}; return {cookie, csrf: session.csrf};
}

test("actual Core owner/CSRF enrollment and recorded exec inject a Task-scoped credential", {timeout: 45_000, skip: process.platform === "win32"}, async t => {
  const server = await createRealTestServer({git: false, prefix: "qmla-core-"}); t.after(() => server.dispose());
  const task = await call(server, "start_session", {title: "Local API real execution", request_key: "local-api-real"});
  const workspace = await call(server, "open_workspace", {path: server.project});
  assert.equal((await fetch(server.baseUrl + "/console/api/local-clients")).status, 401);
  const owner = await login(server), body = {nodeId: server.config.federation?.nodeId ?? "local", clientName: "Quaydock test", expiresAt: Date.now() + 60_000};
  const post = (path: string, value: unknown, csrf?: string) => fetch(server.baseUrl + "/console/api/local-clients" + path,
    {method: "POST", headers: {cookie: owner.cookie, origin: server.baseUrl, "content-type": "application/json", ...(csrf ? {"x-quaymesh-csrf": csrf} : {})}, body: JSON.stringify(value)});
  assert.equal((await post("", body)).status, 403);
  assert.equal((await post("", {...body, owner_id: "foreign"}, owner.csrf)).status, 409);
  const registered = await post("", body, owner.csrf); assert.equal(registered.status, 200, await registered.clone().text());
  const enrollment = await registered.json() as {endpoint: string; credential: string; grantId: string};
  const client = new LocalUserClient(enrollment);
  await client.request("tasks.get", {task_id: task.task_id});
  await assert.rejects(client.request("peer.send", {target_task_id: task.task_id, message_key: "forbidden", body: "x"}));
  await probeThroughRealExec(server, server, String(workspace.workspace_id), String(task.task_id));
  const db = openDatabase(server.config.stateDir);
  try {
    const route = db.sqlite.prepare(`SELECT d.invocation_id,d.task_id,g.source_task_id,g.node_id,i.state
      FROM qm_local_api_dispatches d JOIN qm_local_api_grants g ON g.id=d.grant_id JOIN qm_invocations i ON i.id=d.invocation_id WHERE d.task_id=?`)
      .get(task.task_id) as {task_id: string; source_task_id: string; node_id: string} | undefined;
    assert.ok(route, "a real recorded exec, not a manually inserted dispatch, issued the grant");
    assert.equal(route.task_id, task.task_id); assert.equal(route.source_task_id, task.task_id); assert.equal(route.node_id, body.nodeId);
  } finally {db.close();}
  assert.equal((await post(`/${enrollment.grantId}/revoke`, {}, owner.csrf)).status, 200);
  await assert.rejects(client.request("status.get"), {code: "LOCAL_API_UNAUTHORIZED"});
});

test("real federation dispatch binds worker terminal to the authority Task without forwarding its credential", {timeout: 60_000, skip: process.platform === "win32"}, async t => {
  const previous = process.env.QUAYMESH_CLUSTER_TOKEN; process.env.QUAYMESH_CLUSTER_TOKEN = "local-api-real-two-node-test-token-long-enough";
  t.after(() => {if (previous === undefined) delete process.env.QUAYMESH_CLUSTER_TOKEN; else process.env.QUAYMESH_CLUSTER_TOKEN = previous;});
  const centerPort = await freePort(), workerPort = await freePort();
  const capability = {coordinator: false, worker: true, discovery: false, egress: false, meshRelay: false, desktopUi: false, consoleRelay: false};
  const configure: Parameters<typeof createRealTestServer>[0] = {configure: async config => ({...config, federation: {...config.federation!, coordinatorId: "api-center"}})};
  const worker = await createRealTestServer({...configure, git: false, prefix: "qmla-worker-", federation: {nodeId: "api-worker", nickname: "Worker",
    capabilities: capability, priority: 1, port: workerPort, ingressPort: await freePort(), peers: [{id: "api-center", url: `http://127.0.0.1:${centerPort}`} ]}});
  t.after(() => worker.dispose());
  const center = await createRealTestServer({...configure, git: false, prefix: "qmla-center-", federation: {nodeId: "api-center", nickname: "Authority",
    capabilities: {...capability, coordinator: true}, priority: 10, port: centerPort, ingressPort: await freePort(), peers: [{id: "api-worker", url: `http://127.0.0.1:${workerPort}`} ]}});
  t.after(() => center.dispose());
  const task = await call(center, "start_session", {title: "Remote API actual dispatch", request_key: "remote-local-api"});
  await waitForFixture(center, {sessionId: String(task.session_id)}, "authenticated worker connection",
    async () => center.running.federation!.nodes(), nodes => nodes.some(node => node.id === "api-worker" && node.online));
  const workspace = await call(center, "open_workspace", {root_id: rootHandle("api-worker", "main")});
  const forwarded: unknown[] = [], runtime = worker.running.federation!, original = runtime.request.bind(runtime);
  runtime.request = (async (...args: Parameters<typeof runtime.request>) => {
    if (args[1] === "local-user.call") forwarded.push(args[2]);
    return original(...args);
  }) as typeof runtime.request;
  const result = await probeThroughRealExec(center, worker, String(workspace.workspace_id), String(task.task_id));
  assert.equal(result.status.nodeId, "api-worker"); assert.ok(forwarded.length >= 2);
  for (const value of forwarded) {
    assert.equal(JSON.stringify(value).includes("qml1_"), false);
    assert.deepEqual(Object.keys(value as object).sort(), ["grantId", "method", "params", "revision"]);
  }
  const db = openDatabase(center.config.stateDir);
  try {assert.equal((db.sqlite.prepare("SELECT node_id FROM qm_local_api_dispatches WHERE task_id=?").get(task.task_id) as {node_id: string}).node_id, "api-worker");}
  finally {db.close();}
});
