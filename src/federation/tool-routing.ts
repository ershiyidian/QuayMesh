export type SessionToolRoute = "task" | "member" | "none";

const taskTools = new Set([
  "start_session", "finish_task", "qm_widget_stage", "qm_session", "qm_session_continue",
  "qm_task_messages", "qm_task_message_enqueue", "task_messages",
  "task_resume",
]);
const memberTools = new Set([
  "qm_file_diff", "qm_command_output", "qm_command_outputs", "qm_instruction", "qm_patch", "qm_revert", "qm_file_url",
]);

/** Route by the tool's ownership boundary, never by its public name prefix. */
export function sessionToolRoute(name: string): SessionToolRoute {
  if (taskTools.has(name)) return "task";
  if (memberTools.has(name)) return "member";
  return "none";
}
