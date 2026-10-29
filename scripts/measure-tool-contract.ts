import {mkdir, writeFile} from "node:fs/promises";
import {join, resolve} from "node:path";
import {randomUUID} from "node:crypto";
import {execFileSync} from "node:child_process";
import {createRealTestServer, freePort} from "../test/session-card/server-fixture.js";
import {federationConfigSchema} from "../src/federation/schema.js";

const output = resolve(process.argv[2] ?? ".planning/tool-contract-20261005/final");
await mkdir(output, {recursive: true});
const fixture = await createRealTestServer({git: false, files: {"AGENTS.md": "# 项目规则\n" + "使用现有构建和测试入口。\n".repeat(100)},
  configure: async config => {
    const tokenFile = join(config.configDir, "cluster.token");
    await writeFile(tokenFile, randomUUID());
    return {...config, artifactsEnabled: true, skillsEnabled: false, agentDir: join(config.stateDir, "agent-home"),
      subagents: {...config.subagents, enabled: true, providers: []},
      federation: federationConfigSchema.parse({enabled: true, nodeId: "measure", coordinatorId: "measure",
        host: "127.0.0.1", port: await freePort(), ingressPort: await freePort(), tokenFile,
        capabilities: {coordinator: true, worker: true}, roots: [{id: "main", nickname: "测量工作区", path: config.allowedRoots[0]}],
        egress: {enabled: false}})};
  }});
try {
  const listing = await fixture.client.listTools();
  const tools = listing.tools.filter(tool => {
    const visibility = (tool._meta?.ui as {visibility?: string[]})?.visibility;
    return visibility === undefined || visibility.includes("model");
  }).sort((a, b) => a.name.localeCompare(b.name));
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
  const parts = tools.map(tool => ({name: tool.name, total: bytes(tool), description: bytes(tool.description),
    input: bytes(tool.inputSchema), output: bytes(tool.outputSchema), metadata: bytes({annotations: tool.annotations, _meta: tool._meta})}));
  const meta = {"openai/session": randomUUID()};
  const call = (name: string, args: Record<string, unknown>) => fixture.client.callTool({name, arguments: args, _meta: meta});
  const started = await call("start_session", {title: "接口测量", request_key: randomUUID()});
  if (started.isError) throw new Error(JSON.stringify(started));
  const opened = await call("open_workspace", {path: fixture.project});
  if (opened.isError) throw new Error(JSON.stringify(opened));
  const workspaceId = (opened.structuredContent as {workspace_id: string}).workspace_id;
  const program = join(fixture.project, "empty.mjs");
  await writeFile(program, "process.exitCode = 0;\n");
  const command = await call("exec_command", {workspace_id: workspaceId, cmd: `"${process.execPath}" "${program}"`, yield_time_ms: 2000});
  if (command.isError) throw new Error(JSON.stringify(command));
  const taskId = (started.structuredContent as {task_id: string}).task_id;
  const selected = await call("task_resume", {action: "inspect", task_id: taskId});
  if (selected.isError) throw new Error(JSON.stringify(selected));
  const finished = await call("finish_task", {task_id: taskId,
    expected_task_revision: (selected.structuredContent as {task_revision: number}).task_revision,
    message_sequence: 0, status: "completed", summary: "接口测量结束"});
  if (finished.isError) throw new Error(JSON.stringify(finished));
  const response = (result: typeof opened) => ({modelBytes: bytes({content: result.content, structuredContent: result.structuredContent}),
    contentBytes: bytes(result.content), structuredBytes: bytes(result.structuredContent), uiBytes: bytes(result._meta)});
  const report = {time: new Date().toISOString(), commit: execFileSync("git", ["rev-parse", "HEAD"], {encoding: "utf8"}).trim(),
    count: tools.length, toolBytes: bytes({tools}), parts, bootstrap: response(opened), emptyCommand: response(command)};
  await writeFile(join(output, "tools.json"), JSON.stringify({tools}));
  await writeFile(join(output, "responses.json"), JSON.stringify({started, opened, command}, null, 2));
  await writeFile(join(output, "instructions.txt"), fixture.client.getInstructions() ?? "");
  await writeFile(join(output, "summary.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {await fixture.dispose();}
