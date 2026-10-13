import type { ServerConfig } from "./config.js";
import { assertAllowedPath } from "./roots.js";
import type { WorkLedger } from "./work-ledger.js";

export interface ConsoleOverviewQuery {
  source?: string;
  status?: string;
  after?: string;
  projectId?: string;
}

export interface ConsoleOverview {
  nodes: { nodeId: string; status: "online"; updatedAt: string; projectCount: number; stale: false }[];
  counters: { projects: number; tasks: number; activeTasks: number; needsAttention: number; complete: boolean; updatedAt: string };
  recentRuns: unknown[];
  activeRuns: unknown[];
  warnings: string[];
}

function permittedProjects(ledger: WorkLedger, config: ServerConfig, projectId?: string) {
  return ledger.projects().filter((project) => {
    if (projectId && project.id !== projectId) return false;
    try { assertAllowedPath(project.root, config.allowedRoots); return true; } catch { return false; }
  });
}

/** 汇总当前节点的短摘要。这里读取任务收据，不读取完整轨迹、日志或补丁。 */
export function getLocalConsoleOverview(ledger: WorkLedger, config: ServerConfig, query: ConsoleOverviewQuery = {}): ConsoleOverview {
  const projects = permittedProjects(ledger, config, query.projectId);
  const recent: { projectId: string; projectName: string; nodeId: string; run: unknown }[] = [];
  let tasks = 0;
  let activeTasks = 0;
  let needsAttention = 0;
  for (const project of projects) {
    const stats = ledger.projectUsage(project.id, query.after ?? "");
    tasks += stats.taskCount;
    // 已受理但尚未建立子执行记录的任务仍然处于 running；总览需要把它显示为活动任务。
    const active = ledger.db.prepare("select count(*) as count from console_work_runs where project_id=? and status='running' and created_at>=?")
      .get(project.id, query.after ?? "") as { count: number };
    activeTasks += active.count;
    needsAttention += stats.needsAttention;
    const page = ledger.listRuns(project.id, { limit: 6, source: query.source, status: query.status, after: query.after });
    for (const run of page.entries) recent.push({ projectId: project.id, projectName: project.name, nodeId: config.federation?.nodeId ?? "local", run });
  }
  recent.sort((a, b) => String((b.run as { createdAt?: string }).createdAt ?? "").localeCompare(String((a.run as { createdAt?: string }).createdAt ?? "")));
  const updatedAt = new Date().toISOString();
  const activeRuns = recent.filter((entry) => ["running", "starting", "queued"].includes(String((entry.run as { executionStatus?: string }).executionStatus)));
  return {
    nodes: [{ nodeId: config.federation?.nodeId ?? "local", status: "online", updatedAt, projectCount: projects.length, stale: false }],
    counters: { projects: projects.length, tasks, activeTasks, needsAttention, complete: true, updatedAt },
    recentRuns: recent.slice(0, 30),
    activeRuns,
    warnings: [],
  };
}
