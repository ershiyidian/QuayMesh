import * as z from "zod/v4";

// 主模型只取得定位与执行所需的初始化信息，完整视图仍由组件快照提供。
export const workspaceOutputSchema = {
  workspace_id:z.string(),root:z.string(),node_id:z.string(),mode:z.enum(["checkout","worktree"]),
  session_id:z.string().optional(),task_id:z.string().optional(),source_root:z.string().optional(),
  execution:z.object({platform:z.string(),shell:z.string()}).optional(),
  available_agents_files:z.array(z.object({path:z.string()})).optional(),
};
