import assert from "node:assert/strict";
import type {TestContext} from "node:test";
import {randomUUID} from "node:crypto";
import {writeFile} from "node:fs/promises";
import {join} from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import {createRealTestServer, freePort, type RealTestServerOptions} from "../session-card/server-fixture.js";
import {federationConfigSchema} from "../../src/federation/schema.js";

export async function fixture(t: TestContext, options: RealTestServerOptions = {}) {
  const server = await createRealTestServer(options);
  t.after(() => server.dispose());
  const meta = {"openai/session": randomUUID()};
  const raw = (name: string, args: Record<string, unknown>) => server.client.callTool({name, arguments: args, _meta: meta});
  const call = async (name: string, args: Record<string, unknown>): Promise<Record<string, any>> => {
    const value = await raw(name, args);
    assert.notEqual(value.isError, true, JSON.stringify(value));
    assert.ok(value.structuredContent, JSON.stringify(value));
    return value.structuredContent as Record<string, any>;
  };
  const task = await call("start_session", {title: "工具契约真实验证", request_key: randomUUID()});
  const workspace = await call("open_workspace", {path: server.project});
  const scope = {workspace_id: workspace.workspace_id};
  const execute = async (code: string, args: Record<string, unknown> = {}) => {
    const file = join(server.project, randomUUID() + ".mjs");
    await writeFile(file, code);
    return call("exec_command", {...scope, cmd: `"${process.execPath}" "${file}"`, yield_time_ms: 1000, ...args});
  };
  return {...server, meta, raw, call, task, workspace, scope, execute};
}

export async function until(check: () => Promise<boolean> | boolean, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {if (await check()) return; await delay(25);}
  throw new Error("实际状态未按时到达");
}

export async function twoNodes(t: TestContext, options: { git?: boolean } = {}) {
  const token = randomUUID(), ports = [await freePort(), await freePort()];
  const servers = [];
  for (const [index, name] of ["worker", "cloud"].entries()) {
    const server = await createRealTestServer({git: options.git ?? false, configure: async config => {
      const tokenFile = join(config.configDir, "cluster.token"); await writeFile(tokenFile, token);
      return {...config, network: {externalAccess: name !== "cloud"}, artifactsEnabled: true,
        subagents: {...config.subagents, enabled: false, providers: []},
        federation: federationConfigSchema.parse({enabled: true, nodeId: name, coordinatorId: "cloud",
          host: "127.0.0.1", port: ports[index], ingressPort: await freePort(), tokenFile,
          capabilities: {coordinator: name === "cloud", worker: name === "worker"},
          peers: [{id: name === "cloud" ? "worker" : "cloud", url: `http://127.0.0.1:${ports[1-index]}`}],
          roots: name === "cloud" ? [] : [{id: "main", nickname: "测试工作区", path: config.allowedRoots[0]}],
          egress: {enabled: false}, heartbeatMs: 1000})};
    }});
    servers.push(server); t.after(() => server.dispose());
  }
  const [worker, cloud] = servers;
  await until(() => cloud.running.federation!.nodes().some(node => node.id === "worker" && node.online));
  return {worker, cloud};
}
