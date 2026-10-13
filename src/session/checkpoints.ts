import * as z from "zod/v4";
import type { SessionStore } from "./store.js";
import type { InvocationContext } from "./types.js";
import { currentInvocation } from "./invocations.js";
import type { ToolRegistrationContext } from "../tool-surfaces/types.js";
import { jsonReply } from "../bounded-reply.js";

export const checkpointSchema = z.object({
  goal:z.string().min(1).max(2000),
  decisions:z.array(z.string().min(1).max(1000)).max(12),
  next_action:z.string().min(1).max(2000),
  evidence_refs:z.array(z.string().min(1).max(1024)).max(24).default([]),
}).strict();
export type TaskCheckpoint = z.infer<typeof checkpointSchema>;
export function saveCheckpoint(store: SessionStore, context: InvocationContext, input: TaskCheckpoint): void {
  if(!context.task_id) throw new Error("CHECKPOINT_TASK_REQUIRED");
  const task=store.getTask(context.task_id);
  store.requireSession(context.owner_id,task.session_id);
  store.taskData.requireScope(task.id,context.session_id,context.member_id);
  if(task.state!=="active") throw new Error("CHECKPOINT_TASK_CLOSED");
  store.saveCheckpoint(task.id,context.member_id,checkpointSchema.parse(input));
}
export function registerCheckpointTool(context: ToolRegistrationContext): void {
  if(!context.sessionRuntime) return;
  context.server.registerTool("checkpoint_task",{
    title:"保存任务判断与下一步",
    description:"Save model-authored decisions separately from recorded execution facts. No extra model is invoked.",
    inputSchema:{workspace_id:z.string().min(1),...checkpointSchema.shape},
    annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false},
  },async ({workspace_id,...checkpoint})=>{
    const invocation=currentInvocation();
    if(!invocation||!context.sessionRuntime)throw new Error("MISSING_OPERATION_CONTEXT");
    await context.workspaces.getWorkspace(workspace_id);
    saveCheckpoint(context.sessionRuntime.store,invocation,checkpoint);
    return jsonReply({task_id:invocation.task_id,saved:true,source:"model",next_action:checkpoint.next_action},"已保存判断与下一步");
  });
}
