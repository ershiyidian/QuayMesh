import type { ServerConfig } from "../config.js";

export const HOST_PROMPT_EN = `Call start_session once for each new user request, with a title and unique request_key before workspace work; retry with the same key. One conversation retains one Session; each request creates one Task. Continuations may specify source_task_id. Then use workspace_catalog to locate projects, open the first workspace once, attach additional roots with attach_workspace, and reuse handles. Project instruction bodies are available through explicit read requests. Use the reported platform and shell. Batch related selections and queries with workspace_context; continue saved results with result_ref and cursor. Prefer direct tools for deterministic work. Commands continue independently after a running response. Read results through read_output using operation_id and cursor. Reuse operation_key only for retries of the same intended write; inspect uncertain outcomes before repeating effects. Save decisions and next_action with checkpoint_task at milestones. Recover task facts and decisions with workspace_context recovery. Avoid repeatedly polling unchanged output. Before replying, call finish_task with task_id and the actual outcome; use handed_off while background work continues.`;

export const HOST_PROMPT_ZH = `每一条新的用户请求只要使用 QuayMesh，都先调用一次 start_session，用简体中文填写本轮任务的简短标题和新的 request_key，再开始工作区操作。同一请求重试时复用 request_key。同一段对话长期保留一个 Session，每条用户请求建立独立 Task 和独立卡片。然后使用 workspace_catalog 选择项目，调用 open_workspace 打开第一个根目录；其他根目录使用 attach_workspace，并复用返回的工作区句柄。项目指令正文仅按需显式读取。直接工具用于调查和确定性操作；需要独立工作时再委派子代理。操作结果未知时，先检查已有操作状态，再决定后续动作。最终回复之前调用 finish_task，传入 task_id 和实际交付结果；后台任务继续执行时使用 handed_off。使用工作区返回的平台和命令解释器。 相关文件选区和搜索词合并到 workspace_context，分页使用 result_ref 与 cursor。命令结果使用 read_output 的 operation_id 和 cursor 读取；返回运行状态后，命令独立继续。同一次写操作重试复用 operation_key，明确重新执行时使用新值。在形成重要判断时通过 checkpoint_task 保存判断与下一步；recovery 的 task_id 查询分别返回执行事实和模型检查点。新的继续请求可在 start_session 指明 source_task_id。避免连续查询没有变化的状态；处理其他独立工作，后台执行继续时通过 handed_off 交付。`;

export const SUBAGENT_PROMPT_EN = `Give each agent a clear task, relevant paths, constraints, and an expected result. Continue a related agent when its context is useful. Do not redo delegated work. While agents run, perform useful non-overlapping work. Wait only when a result blocks the next step. A pending agent may continue after the current response ends.`;

export const SUBAGENT_PROMPT_ZH = `为每个代理说明任务、相关路径、约束和预期结果。相关后续工作继续使用已有代理。避免重复完成已委派的任务。代理工作期间处理互不重复的其他内容；下一步依赖代理结果时再短暂等待。当前回复结束以后，已接受的代理任务可以继续执行。`;

export interface HostPromptOptions {
  language?: "en" | "zh";
  artifactsEnabled?: boolean;
}

export function buildHostPrompt(
  config: Pick<ServerConfig, "subagents" | "artifactsEnabled">,
  options: HostPromptOptions = {},
): string {
  const useChinese = options.language === "zh";
  const host = useChinese ? HOST_PROMPT_ZH : HOST_PROMPT_EN;
  const subagent = useChinese ? SUBAGENT_PROMPT_ZH : SUBAGENT_PROMPT_EN;
  const artifact = options.artifactsEnabled ?? config.artifactsEnabled
    ? " Use download_artifact for an attached or generated file that must enter the workspace."
    : "";
  return `${host}${config.subagents.enabled ? ` ${subagent}` : ""}${artifact}`;
}

export function buildWorkerBrief(
  message: string,
  context?: { summary: string; files: Array<{ path: string; sha256: string }> },
): string {
  const parts = [message.trim()];
  if (context?.summary) parts.push(`Context: ${context.summary}`);
  if (context?.files.length) {
    parts.push(`Relevant files:\n${context.files.map((file) => `- ${file.path} (sha256 ${file.sha256})`).join("\n")}`);
  }
  parts.push("Project instructions in the selected workspace still apply.");
  return parts.join("\n\n");
}
