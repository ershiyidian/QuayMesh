import type { ServerConfig } from "../config.js";
import { WorkLedger, type ExecutionRow } from "../work-ledger.js";
import { workspaceHandle } from "../federation/routing.js";
import { permitted, convertUsage, readLocalIndex } from "./local.js";
import { dayAt, totals, type Query } from "./query.js";

export function readLocalUsage(config: ServerConfig, input: Query, at = Date.now(), options: { includeRuns?: boolean } = {}) {
  const ledger = new WorkLedger(config.stateDir);
  try {
    const node = config.federation?.nodeId ?? "local", zone = input.tz || "UTC";
    const projects = ledger.projects().filter(project => permitted(config, project.root)
      && (!input.node || input.node === node)
      && (!input.project || input.project === workspaceHandle(node, project.id))
      && (!input.root || input.root === project.root));
    const days = Math.min(30, Math.max(1, Number(input.days) || 14));
    const dates = Array.from({ length: days }, (_, index) => dayAt(at - (days - index - 1) * 86_400_000, zone))
      .filter(day => !input.date || input.date === day);
    const allowedDates = new Set(dates);
    const search = (input.q ?? "").trim().toLocaleLowerCase();
    const rows = projects.length ? ledger.db.prepare(`SELECT e.*,r.project_id,
      COALESCE(t.title,i.title) title,l.task_id,l.session_id FROM console_executions e
      JOIN console_work_runs r ON r.id=e.run_id JOIN console_work_items i ON i.id=r.item_id
      LEFT JOIN qm_run_links l ON l.run_id=r.id LEFT JOIN qm_tasks t ON t.id=l.task_id
      LEFT JOIN qm_session_members m ON m.id=l.member_id
      WHERE r.project_id IN (${projects.map(() => "?").join(",")}) AND e.provider='codex'
        AND (e.finished_at IS NULL OR e.finished_at>=?) AND (?='' OR instr(lower(COALESCE(t.title,i.title)||' '||r.id||' '||COALESCE(l.task_id,'')),?)>0)
        AND (?='' OR l.session_id=?) AND (l.run_id IS NULL OR m.node_id=?) ORDER BY e.finished_at,e.id`)
      .all(...projects.map(project => project.id), new Date(at - (days + 1) * 86_400_000).toISOString(), search, search, input.session ?? "", input.session ?? "", node) as Array<ExecutionRow & { project_id: string; title: string; task_id: string | null }> : [];
    const completed = rows.filter(row => row.finished_at && allowedDates.has(dayAt(Date.parse(row.finished_at), zone)));
    const pending = rows.filter(row => !row.finished_at && ["starting", "queued", "running"].includes(row.status));
    const undated = rows.filter(row => !row.finished_at && !["starting", "queued", "running"].includes(row.status));
    const accounted = completed.map(row => ({ ...row, usage: convertUsage([row]) }));
    const byRun = new Map<string, ExecutionRow[]>();
    for (const row of completed) {
      const selected = byRun.get(row.run_id) ?? [];
      selected.push(row); byRun.set(row.run_id, selected);
    }
    // 所有本地候选都交给协调端按 Task 汇总，避免分片截断改变排名。
    const topIds = options.includeRuns === false ? [] : [...byRun].filter(([, values]) => (convertUsage(values).total ?? 0) > 0).map(([id]) => id);
    const top = topIds.length ? readLocalIndex(config, topIds).runs.map(run => ({ ...run, usage: convertUsage(byRun.get(run.localId)!) })) : [];
    return { ...totals(accounted), basis: "execution_finished_at" as const, unit: "execution" as const,
      pendingUsage: totals(pending.map(row => ({ usage: convertUsage([row]) }))),
      undatedUsage: totals(undated.map(row => ({ usage: convertUsage([row]) }))),
      daily: dates.map(day => ({ day, ...totals(accounted.filter(row => dayAt(Date.parse(row.finished_at!), zone) === day)) })),
      projects: projects.map(project => ({ id: workspaceHandle(node, project.id), localId: project.id, nodeId: node,
        name: project.name, path: project.root,
        ...totals(accounted.filter(row => row.project_id === project.id)) })).filter(project => project.records > 0),
      runIds: [...byRun.keys()].map(id => workspaceHandle(node, id)), top, observedAt: Date.now() };
  } finally { ledger.close(); }
}
