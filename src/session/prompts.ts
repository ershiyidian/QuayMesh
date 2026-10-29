import type { ServerConfig } from "../config.js";

export const HOST_PROMPT_EN = `One Task per goal. New goal: start_session(title,request_key); reuse the key on retry. Existing selection requires new_goal:true and expected_binding_revision from task_resume inspect. Follow-ups reuse Task/workspace handles; new Tasks leave others open. Without host conversation identity, pass task_id. To change the host’s selected Task, task_resume inspect→resume with its binding revision/request_key. source_task_id records provenance.\nDiscover roots via workspace_catalog; open_workspace once, attach_workspace for others. Project instruction bodies are available through explicit read requests. Follow reported platform/shell. Batch reads/searches via workspace_context; page result_ref/cursor. Commands keep running; read_output(operation_id,cursor) retrieves output. Retry writes with the same operation_key; inspect uncertain outcomes first. checkpoint_task saves decisions/next_action. Continue useful work while waiting.\nAfter resuming, task_messages history/filter=awaiting_reply finds pending replies; receive→ack→reply handles input. Reading messages does not select or finish Tasks. Finish only completed or explicitly ended goals: finish_task with actual outcome, latest mailbox.sequence and task_resume inspect’s task_revision as expected_task_revision. Progress leaves Tasks open.`;

export const HOST_PROMPT_ZH = `一目标一 Task。新目标用 start_session(title,request_key)，重试复用键。已有选择时，另建目标需 new_goal:true 和 task_resume inspect 所见 expected_binding_revision。追问沿用 Task/工作区句柄，新目标不关闭其他 Task。宿主未提供对话身份时，显式传 task_id。切换宿主当前目标：task_resume inspect→resume，传所见 binding revision/request_key。source_task_id 只记录来源。\nworkspace_catalog 找根；open_workspace 一次，其他根 attach_workspace。项目规则正文按需显式 read。遵循平台/shell。workspace_context 批量读/搜，result_ref/cursor 分页。命令持续运行，read_output(operation_id,cursor) 取输出。写入重试复用 operation_key，效果未知先查询。checkpoint_task 保存判断/next_action，等待时继续其他工作。\n恢复后，task_messages history/filter=awaiting_reply 查待回复历史，receive→ack→reply 处理输入。收信不切换或结束目标。仅目标完成或明确终止时 finish_task，记录实际结果，传最新 mailbox.sequence，并以 task_resume inspect 的 task_revision 作为 expected_task_revision。进度回复保持开放。`;

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
