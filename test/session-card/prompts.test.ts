import assert from "node:assert/strict";
import test from "node:test";
import { HOST_PROMPT_EN, SUBAGENT_PROMPT_EN } from "../../src/session/prompts.js";
import { createRealTestServer, structured } from "./server-fixture.js";

const SUBAGENT_TOOL_NAMES = ["spawn_agent", "followup_agent", "send_message", "wait_agent", "interrupt_agent", "list_agents"];
const MODEL_TOOL_NAMES = ["start_session", "finish_task", "task_resume", "task_messages", "checkpoint_task", "open_workspace", "attach_workspace",
  "read", "read_output", "workspace_context", "apply_patch", "exec_command", "write_stdin"];

function englishWords(value: string): string[] {
  return value.match(/[A-Za-z0-9][A-Za-z0-9_./:-]*/g) ?? [];
}
test("real MCP initialize and open_workspace expose the shortened prompt and real tool names", async (t) => {
  const server = await createRealTestServer({ uiEnabled: true, subagents: { enabled: true, instructions: "on-demand", providers: [] } });
  t.after(() => server.dispose());
  const instructions = server.client.getInstructions();
  assert.ok(instructions);
  // 宿主与子代理分别守住预算，真实 initialize 必须且只注入启用的两部分。
  assert.ok(englishWords(HOST_PROMPT_EN).length <= 180);
  assert.ok(englishWords(SUBAGENT_PROMPT_EN).length <= 90);
  assert.equal(instructions, `${HOST_PROMPT_EN} ${SUBAGENT_PROMPT_EN}`);
  assert.ok(englishWords(instructions).length <= 270);
  assert.match(instructions, /One Task per goal/);
  assert.match(instructions, /New goal: start_session\(title,request_key\); reuse the key on retry/);
  assert.match(instructions, /new_goal:true and expected_binding_revision from task_resume inspect/);
  assert.match(instructions, /Follow-ups reuse Task\/workspace handles; new Tasks leave others open/);
  assert.match(instructions, /Without host conversation identity, pass task_id/);
  assert.match(instructions, /task_resume inspect→resume with its binding revision\/request_key/);
  assert.match(instructions, /Discover roots via workspace_catalog; open_workspace once, attach_workspace for others/);
  assert.match(instructions, /Retry writes with the same operation_key; inspect uncertain outcomes first/);
  assert.match(instructions, /Finish only completed or explicitly ended goals/);
  assert.match(instructions, /task_revision as expected_task_revision/);
  assert.doesNotMatch(instructions, /show_changes|work_task|agent_task/);
  assert.doesNotMatch(instructions, /为每个代理说明任务/);

  const opened = await server.client.callTool({
    name: "open_workspace",
    arguments: { path: server.project },
    _meta: { "openai/session": "f111-prompts" },
  });
  assert.notEqual(opened.isError, true, JSON.stringify(opened));
  const out = structured(opened);
  const identity = (opened._meta as { quaymesh?: Record<string, unknown> } | undefined)?.quaymesh;
  assert.ok(identity, "open_workspace must retain the real Task/card identity metadata");
  for (const key of ["session_id", "task_id", "member_id", "workspace_id"]) {
    assert.equal(typeof identity[key], "string", "missing workspace identity " + key);
    if (out[key] !== undefined) assert.equal(out[key], identity[key], key + " differs between public data and card metadata");
  }
  assert.equal(out.workspace_id, identity.workspace_id);
  const tools = await server.client.listTools();
  const names = new Set(tools.tools.map((tool) => tool.name));
  for (const tool of MODEL_TOOL_NAMES) assert.ok(names.has(tool), "model surface missing " + tool);
  for (const tool of SUBAGENT_TOOL_NAMES) assert.ok(names.has(tool), "subagent surface missing " + tool);
  for (const retired of ["show_changes", "work_task", "agent_task"]) assert.equal(names.has(retired), false, "retired tool present: " + retired);
});
