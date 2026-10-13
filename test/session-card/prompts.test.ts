import assert from "node:assert/strict";
import test from "node:test";
import { HOST_PROMPT_EN, SUBAGENT_PROMPT_EN } from "../../src/session/prompts.js";
import { createRealTestServer, structured } from "./server-fixture.js";

const SUBAGENT_TOOL_NAMES = ["spawn_agent", "followup_agent", "send_message", "wait_agent", "interrupt_agent", "list_agents"];
const MODEL_TOOL_NAMES = ["start_session", "finish_task", "open_workspace", "attach_workspace", "read", "workspace_context", "apply_patch", "exec_command", "write_stdin"];

function englishWords(value: string): string[] {
  return value.match(/[A-Za-z0-9][A-Za-z0-9_./:-]*/g) ?? [];
}
test("real MCP initialize and open_workspace expose the shortened prompt and real tool names", async (t) => {
  const server = await createRealTestServer({ uiEnabled: true, subagents: { enabled: true, instructions: "on-demand", providers: [] } });
  t.after(() => server.dispose());
  const instructions = server.client.getInstructions();
  assert.ok(instructions);
  // 服务器提示词由三部分组合而成，这里分别按仓库约定的上限检查，避免整句拼接后把限额算成一份。
  assert.ok(englishWords(HOST_PROMPT_EN).length <= 180);
  assert.ok(englishWords(SUBAGENT_PROMPT_EN).length <= 90);
  assert.match(instructions, /Call start_session once/);
  assert.match(instructions, /use workspace_catalog/);
  assert.doesNotMatch(instructions, /show_changes|work_task|agent_task/);
  assert.doesNotMatch(instructions, /为每个代理说明任务/);

  const opened = await server.client.callTool({
    name: "open_workspace",
    arguments: { path: server.project },
    _meta: { "openai/session": "f111-prompts" },
  });
  assert.equal(opened.isError, undefined);
  const out = structured(opened);
  assert.equal(typeof out.session_id, "string");
  const tools = await server.client.listTools();
  const names = new Set(tools.tools.map((tool) => tool.name));
  for (const tool of MODEL_TOOL_NAMES) assert.ok(names.has(tool), "model surface missing " + tool);
  for (const tool of SUBAGENT_TOOL_NAMES) assert.ok(names.has(tool), "subagent surface missing " + tool);
  for (const retired of ["show_changes", "work_task", "agent_task"]) assert.equal(names.has(retired), false, "retired tool present: " + retired);
});
