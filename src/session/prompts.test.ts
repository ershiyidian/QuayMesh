import assert from "node:assert/strict";
import test from "node:test";
import type { ServerConfig } from "../config.js";
import {
  HOST_PROMPT_EN,
  HOST_PROMPT_ZH,
  SUBAGENT_PROMPT_EN,
  SUBAGENT_PROMPT_ZH,
  buildHostPrompt,
  buildWorkerBrief,
} from "./prompts.js";

function promptConfig(overrides: {
  subagentsEnabled?: boolean;
  artifactsEnabled?: boolean;
} = {}): Pick<ServerConfig, "subagents" | "artifactsEnabled"> {
  return {
    subagents: {
      enabled: overrides.subagentsEnabled ?? false,
      instructions: "on-demand",
      providers: [],
    },
    artifactsEnabled: overrides.artifactsEnabled ?? false,
  };
}

function englishWords(value: string): string[] {
  return value.match(/[A-Za-z0-9][A-Za-z0-9_./:-]*/g) ?? [];
}

test("host and subagent prompts stay within their word budgets", () => {
  assert.ok(englishWords(HOST_PROMPT_EN).length <= 180, `host prompt has ${englishWords(HOST_PROMPT_EN).length} words`);
  assert.ok(englishWords(SUBAGENT_PROMPT_EN).length <= 90, `subagent prompt has ${englishWords(SUBAGENT_PROMPT_EN).length} words`);
  assert.ok(HOST_PROMPT_ZH.length > 0);
  assert.ok(SUBAGENT_PROMPT_ZH.length > 0);
});

test("buildHostPrompt injects one language and only enabled sections", () => {
  const english = buildHostPrompt(promptConfig(), { language: "en" });
  assert.equal(english, HOST_PROMPT_EN);
  assert.doesNotMatch(english, /workspace_catalog 选择项目/);
  assert.doesNotMatch(english, /Give each agent/);

  const chinese = buildHostPrompt(promptConfig(), { language: "zh" });
  assert.equal(chinese, HOST_PROMPT_ZH);
  assert.doesNotMatch(chinese, /Use workspace_catalog/);
  assert.doesNotMatch(chinese, /为每个代理说明任务/);

  const withSubagents = buildHostPrompt(promptConfig({ subagentsEnabled: true }));
  assert.equal(withSubagents, `${HOST_PROMPT_EN} ${SUBAGENT_PROMPT_EN}`);

  const chineseWithSubagents = buildHostPrompt(promptConfig({ subagentsEnabled: true }), { language: "zh" });
  assert.equal(chineseWithSubagents, `${HOST_PROMPT_ZH} ${SUBAGENT_PROMPT_ZH}`);
});

test("buildHostPrompt adds the artifact instruction only when the tool is exposed", () => {
  const disabled = buildHostPrompt(promptConfig());
  const enabled = buildHostPrompt(promptConfig({ artifactsEnabled: true }));
  assert.equal(enabled, `${disabled} Use download_artifact for an attached or generated file that must enter the workspace.`);

  const chosen = buildHostPrompt(promptConfig(), { language: "zh", artifactsEnabled: true });
  assert.equal(chosen, `${HOST_PROMPT_ZH} Use download_artifact for an attached or generated file that must enter the workspace.`);
});

test("prompts omit retired model entry points and internal accounting prose", () => {
  const combined = `${buildHostPrompt(promptConfig({ subagentsEnabled: true, artifactsEnabled: true }))}\n${HOST_PROMPT_ZH}\n${SUBAGENT_PROMPT_ZH}`;
  assert.doesNotMatch(combined, /show_changes|work_task|agent_task/);
  assert.doesNotMatch(combined, /usage|receipt|lease|claim|queue limit|checksum/i);
});

test("buildWorkerBrief preserves the task and prepared facts without parent prompt text", () => {
  const brief = buildWorkerBrief("检查登录流程", {
    summary: "只处理身份验证路径",
    files: [{ path: "src/auth.ts", sha256: "abc123" }],
  });
  assert.match(brief, /^检查登录流程/);
  assert.match(brief, /Context: 只处理身份验证路径/);
  assert.match(brief, /src\/auth\.ts \(sha256 abc123\)/);
  assert.match(brief, /Project instructions in the selected workspace still apply\./);
  assert.doesNotMatch(brief, /Use workspace_catalog to locate the requested project/);
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SUBAGENT_TOOL_NAMES = ["spawn_agent", "followup_agent", "send_message", "wait_agent", "interrupt_agent", "list_agents"];
const HOST_TOOL_NAMES = ["workspace_catalog", "open_workspace", "attach_workspace", "read", "workspace_context", "apply_patch", "exec_command", "write_stdin"];
const REAL_MODEL_TOOL_NAMES = new Set([
  "workspace_catalog", "open_workspace", "attach_workspace", "read", "workspace_context", "apply_patch", "exec_command", "write_stdin",
  "spawn_agent", "followup_agent", "send_message", "wait_agent", "interrupt_agent", "list_agents", "download_artifact", "copy_artifact",
]);

test("the injected subagents skill body stays short and names only real tools", () => {
  const skillPath = fileURLToPath(new URL("../../skills/subagents/SKILL.md", import.meta.url));
  const source = readFileSync(skillPath, "utf8");
  const body = source.split("---").slice(2).join("---");
  assert.ok(englishWords(body).length <= 90, "skill body has " + englishWords(body).length + " words");
  assert.doesNotMatch(body, /work_task|agent_task|show_changes/);
  assert.doesNotMatch(body, /request_key|work_run_id|usage|receipt|lease|claim|queue/i);
  const mentioned = SUBAGENT_TOOL_NAMES.filter((tool) => body.includes(tool));
  assert.ok(mentioned.length >= 4, "skill names too few subagent tools: " + mentioned.join(", "));
  assert.ok(mentioned.includes("spawn_agent") && mentioned.includes("wait_agent"), "skill omits core subagent tools");
});

test("host prompt names only current model tools", () => {
  const prompt = buildHostPrompt(promptConfig({ subagentsEnabled: true, artifactsEnabled: true }));
  const referenced = (prompt.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? []).filter((name) => REAL_MODEL_TOOL_NAMES.has(name) || ["show_changes", "work_task", "agent_task", "request_key", "work_run_id"].includes(name));
  assert.ok(referenced.includes("workspace_catalog"), "prompt omits workspace_catalog");
  assert.ok(referenced.includes("attach_workspace"), "prompt omits attach_workspace");
  assert.ok(referenced.includes("download_artifact"), "prompt omits download_artifact");
  // request_key 是当前 start_session 的正式输入参数，宿主提示词需要主动告知模型。
  for (const tool of ["show_changes", "work_task", "agent_task", "work_run_id"]) {
    assert.equal(referenced.includes(tool), false, "prompt mentions " + tool);
  }
  assert.equal(referenced.includes("request_key"), true, "prompt must name request_key");
});

test("worker brief keeps the stable profile separate from the current task", () => {
  const brief = buildWorkerBrief("实现卡片过滤", undefined);
  assert.equal(brief.split(String.fromCharCode(10,10))[0], "实现卡片过滤");
  assert.doesNotMatch(brief, /You are a subagent|stable profile/i);
  assert.match(brief, /Project instructions in the selected workspace still apply/);
});

test("host prompt only offers explicit instruction reads, without automatic project rule injection", () => {
  const prompt = buildHostPrompt(promptConfig());
  assert.match(prompt, /Project instruction bodies are available through explicit read requests/);
  assert.doesNotMatch(prompt, /Read applicable project instructions/);
  assert.doesNotMatch(prompt, /AGENTS.md contents:/);
});

