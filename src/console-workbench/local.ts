import { basename, relative, sep } from "node:path";
import { statSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ServerConfig } from "../config.js";
import { assertAllowedPath } from "../roots.js";
import { WorkLedger, summarizeExecutions, type ExecutionRow, type WorkRunRow } from "../work-ledger.js";
import { runPresentation } from "../console-run-data.js";
import { workspaceHandle, rootHandle } from "../federation/routing.js";
import { readRunCheckpoint } from "../session/run-checkpoints.js";
import { runQuery, selectRunPage } from "./run-query.js";
import type { Query } from "./query.js";
import { active, stage } from "./query.js";
import type { LocalIndex, Project, Root, Run, Usage, WorkbenchEvent } from "./types.js";
import { WorkbenchError } from "./types.js";

export interface RunLink {
  session_id: string;
  task_id: string | null;
  member_id: string;
  run_id: string;
  node_id: string;
  revision: number;
  execution_state: string;
  workspace: string | null;
  owner_id: string;
  latest_run: string;
  task_title: string;
}

interface OperationRow {
  id: string; run_id: string; kind: string; label: string; status: string; created_at: string; finished_at: string | null;
}

export function permitted(config: ServerConfig, path: string): boolean {
  try { assertAllowedPath(path, config.allowedRoots); return true; }
  catch { return false; }
}

export function requireRun(config: ServerConfig, ledger: WorkLedger, id: string): WorkRunRow {
  const run = ledger.run(id);
  if (!permitted(config, ledger.getProject(run.project_id).root)) throw new WorkbenchError("此项目不在当前允许访问的目录内", 403, "project_scope");
  return run;
}

export function linkForRun(ledger: WorkLedger, runId: string): RunLink | undefined {
  return ledger.db.prepare(`SELECT l.*, m.node_id, m.revision, s.execution_state, s.owner_id, COALESCE(t.title,s.title) task_title,
    json_extract(m.snapshot_json,'$.workspace') workspace,
    (SELECT run_id FROM qm_run_links WHERE member_id=l.member_id AND task_id IS l.task_id ORDER BY rowid DESC LIMIT 1) latest_run
    FROM qm_run_links l JOIN qm_session_members m ON m.id=l.member_id
    JOIN qm_sessions s ON s.id=l.session_id LEFT JOIN qm_tasks t ON t.id=l.task_id WHERE l.run_id=?`).get(runId) as RunLink | undefined;
}

export function convertUsage(rows: ExecutionRow[]): Usage {
  const summary = summarizeExecutions(rows);
  const counts = summary.codexUsage;
  return { total: counts?.totalTokens ?? null, input: counts?.inputTokens ?? null,
    cached: counts?.cachedInputTokens ?? null, output: counts?.outputTokens ?? null,
    reasoning: counts?.reasoningOutputTokens ?? null, quality: summary.usageStatus };
}

function group<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const row of rows) { const id = key(row); const values = result.get(id) ?? []; values.push(row); result.set(id, values); }
  return result;
}

export function readLocalIndex(config: ServerConfig, runIds?: readonly string[]): LocalIndex {
  const ledger = new WorkLedger(config.stateDir);
  try {
    const nodeId = config.federation?.nodeId ?? "local";
    const projects = ledger.projects().filter((project) => permitted(config, project.root));
    const allowed = new Map(projects.map((project) => [project.id, project]));
    // 列表只读取摘要，不读取日志、代理回答或完整补丁，也不在刷新时导入历史。
    const parameters = runIds ?? [];
    const selected = (column: string) => runIds === undefined ? "1" : runIds.length ? `${column} IN (${runIds.map(() => "?").join(",")})` : "0";
    const rows = ledger.db.prepare(`SELECT r.*,i.title FROM console_work_runs r JOIN console_work_items i ON i.id=r.item_id
      WHERE ${selected("r.id")} ORDER BY r.created_at DESC,r.id`).all(...parameters) as WorkRunRow[];
    const operations = group(ledger.db.prepare(`SELECT id,run_id,kind,label,status,created_at,finished_at FROM console_operations WHERE ${selected("run_id")} ORDER BY rowid`).all(...parameters) as OperationRow[], (row) => row.run_id);
    const executions = group(ledger.db.prepare(`SELECT * FROM console_executions WHERE ${selected("run_id")} ORDER BY rowid`).all(...parameters) as ExecutionRow[], (row) => row.run_id);
    const links = ledger.db.prepare(`SELECT l.*, m.node_id, m.revision, s.execution_state, s.owner_id, COALESCE(t.title,s.title) task_title,
      json_extract(m.snapshot_json,'$.workspace') workspace,
      (SELECT run_id FROM qm_run_links WHERE member_id=l.member_id AND task_id IS l.task_id ORDER BY rowid DESC LIMIT 1) latest_run
      FROM qm_run_links l JOIN qm_session_members m ON m.id=l.member_id
      JOIN qm_sessions s ON s.id=l.session_id LEFT JOIN qm_tasks t ON t.id=l.task_id WHERE ${selected("l.run_id")}`).all(...parameters) as RunLink[];
    const linksByRun = new Map(links.map((link) => [link.run_id, link]));
    const classified = runQuery(ledger,nodeId,[...allowed.keys()],{days:'0'},Date.now());
    const states = new Map((ledger.db.prepare(`${classified.sql} SELECT id,execution,task_result,task_state,status,finished_ms FROM selected WHERE ${selected('id')}`)
      .all(...classified.params,...parameters) as Array<{id:string;execution:string;task_result:string|null;task_state:string|null;status:string;finished_ms:number|null}>)
      .map(row=>[row.id,row]));
    const files = new Map((ledger.db.prepare(`SELECT f.member_id,COUNT(*) files,
      CASE WHEN COUNT(f.additions)=COUNT(*) THEN SUM(f.additions) END additions,
      CASE WHEN COUNT(f.removals)=COUNT(*) THEN SUM(f.removals) END removals
      FROM qm_file_changes f
      JOIN qm_change_baselines b ON b.session_id=f.session_id AND b.member_id=f.member_id AND b.latest_ref=f.version_ref
      WHERE f.member_id IN (SELECT member_id FROM qm_run_links WHERE ${selected("run_id")}) GROUP BY f.member_id`).all(...parameters) as Array<{ member_id: string; files: number; additions: number | null; removals: number | null }>).map((row) => [row.member_id, row]));
    const roots: Root[] = (config.federation?.roots ?? config.allowedRoots.map((path, index) => ({
      id: `root-${index}`, nickname: basename(path) || path, path, description: "", tags: [], enabled: true,
    }))).map((root) => ({ id: workspaceHandle(nodeId, root.id), reference: rootHandle(nodeId, root.id), localId: root.id, nodeId, name: root.nickname,
      path: root.path, description: root.description, tags: root.tags, enabled: root.enabled, readOnly: false, revision: 0 }));

    const runs: Run[] = rows.filter((row) => allowed.has(row.project_id) && (!linksByRun.has(row.id) || linksByRun.get(row.id)!.node_id === nodeId)).map((row) => {
      const project = allowed.get(row.project_id)!;
      const ops = operations.get(row.id) ?? [];
      const execs = executions.get(row.id) ?? [];
      const link = linksByRun.get(row.id);
      const linked = link?.latest_run === row.id ? link : undefined;
      const classifiedState = states.get(row.id);
      let checkpoint = link ? readRunCheckpoint(ledger.db, row.id) : null;
      if (!checkpoint && link?.task_id && classifiedState?.task_state==='closed') {
        const taskSnapshot=ledger.db.prepare('SELECT revision,snapshot_json,files_json FROM qm_task_snapshots WHERE task_id=? AND member_id=?')
          .get(link.task_id,link.member_id) as {revision:number;snapshot_json:string;files_json:string}|undefined;
        if(taskSnapshot)checkpoint={revision:taskSnapshot.revision,snapshot:JSON.parse(taskSnapshot.snapshot_json),files:JSON.parse(taskSnapshot.files_json)};
      }
      const workspace = checkpoint?.snapshot.workspace ?? (linked?.workspace ? JSON.parse(linked.workspace) as { branch?: string; baseSha?: string } : undefined);
      const pending = [...ops, ...execs].filter((operation) => ["running", "starting", "queued"].includes(operation.status));
      const command = [...ops].reverse().find((operation) => ["command", "exec_command", "bash"].includes(operation.kind) && ["running", "starting"].includes(operation.status));
      let execution = row.status === "interrupted" || row.status === "reconciliation_required" ? "interrupted_recoverable" : row.status;
      if (row.status === "running" && pending.length > 0) execution = pending.every((operation) => operation.status === "queued") ? "queued" : "running";
      else if (row.status === "running" && [...ops, ...execs].some((operation) => ["unknown", "reconciliation_required"].includes(operation.status))) execution = "unknown";
      else if (row.status === "running" && linked) execution = "waiting";
      if (classifiedState) execution = classifiedState.execution;
      let file = linked ? files.get(linked.member_id) : undefined;
      if (link?.task_id) file = ledger.db.prepare(`SELECT COUNT(*) files,
        CASE WHEN COUNT(f.additions)=COUNT(*) THEN SUM(f.additions) END additions,
        CASE WHEN COUNT(f.removals)=COUNT(*) THEN SUM(f.removals) END removals
        FROM qm_task_file_changes f JOIN qm_task_change_baselines b ON b.task_id=f.task_id AND b.member_id=f.member_id AND b.latest_ref=f.version_ref
        WHERE f.task_id=? AND f.member_id=?`).get(link.task_id,link.member_id) as typeof file;
      let diff: Run["diff"] = file?.files ? { files: file.files, add: file.additions, del: file.removals } : null;
      const warnings: string[] = [];
      if (checkpoint) {
        const summaries = checkpoint.files;
        diff = summaries.length ? { files: summaries.length,
          add: summaries.every((file) => file.additions !== null) ? summaries.reduce((sum, file) => sum + file.additions!, 0) : null,
          del: summaries.every((file) => file.removals !== null) ? summaries.reduce((sum, file) => sum + file.removals!, 0) : null } : null;
      } else if (!linked) {
        try {
          const recorded = runPresentation(ledger, row).diffStat;
          if (recorded) diff = { files: recorded.files, add: recorded.additions, del: recorded.deletions };
        } catch (error) {
          warnings.push(`历史差异读取失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const lastAgent = execs.at(-1);
      const origin = JSON.parse(row.origin) as { entryPoint?: string };
      const acceptance = classifiedState?.task_result === 'completed' && row.status !== 'completed' ? 'not_required'
        : row.acceptance === "passed" ? "accepted" : row.acceptance === "failed" ? "rejected" : row.acceptance === "not_applicable" ? "not_required" : row.acceptance;
      return {
        id: workspaceHandle(nodeId, row.id), localId: row.id, title: link?.task_title || row.title || project.name,
        nodeId, projectId: workspaceHandle(nodeId, project.id), projectLocalId: project.id, projectName: project.name, root: project.root,
        executionStatus: execution, acceptanceStatus: acceptance, startedAt: Date.parse(row.created_at),
        finishedAt: classifiedState?.finished_ms ?? (row.finished_at ? Date.parse(row.finished_at) : null),
        lastActivityAt: Date.parse(row.last_activity_at ?? row.finished_at ?? row.created_at),
        revision: row.revision, workspaceRevision: checkpoint?.revision ?? linked?.revision ?? row.revision,
        sessionId: link?.session_id ?? null, taskId: link?.task_id ?? null, memberId: link?.member_id ?? null,
        usage: convertUsage(execs), diff, origin: origin.entryPoint ?? "legacy_unknown",
        branch: workspace?.branch ?? null, baseSha: workspace?.baseSha ?? null,
        command: command?.label ?? null, agent: lastAgent?.agent_id ?? null,
        reason: ["failed", "interrupted_recoverable"].includes(execution) ? row.summary || "执行结果需要核对" : null,
        reviewNote: (JSON.parse(row.evidence) as Array<{ label: string; reference: string }>).filter((entry) => entry.label === "用户验收").at(-1)?.reference ?? null,
        actions: { interrupt: execs.some((entry) => ["starting", "queued", "running"].includes(entry.status)),
          resume: execution === "interrupted_recoverable" && new Set(execs.map((entry) => entry.agent_id)).size === 1,
          review: execution === "completed" && acceptance === "pending", complete: execution === "waiting",
          revert: Boolean(linked && file?.files && pending.length === 0) }, warnings,
        phaseRefs: [workspaceHandle(nodeId, row.id)], nodeIds: [nodeId], workspaceCount: 1,
        workspaces:[{nodeId,projectId:workspaceHandle(nodeId,project.id),memberId:link?.member_id ?? null,name:project.name,root:project.root}],
        currentPhase: link ? Boolean(linked) : true,
      };
    });
    const byProject = group(runs, (run) => run.projectLocalId);
    const projectRows: Project[] = projects.map((project) => {
      const own = byProject.get(project.id) ?? [];
      const root = roots.filter((root) => { const path = relative(root.path, project.root); return path === "" || path !== ".." && !path.startsWith(`..${sep}`) && !/^[A-Za-z]:/.test(path); })
        .sort((a, b) => b.path.length - a.path.length)[0];
      return { id: workspaceHandle(nodeId, project.id), localId: project.id, nodeId, name: project.name, path: project.root,
        rootId: root?.id ?? null, active: own.filter(active).length, review: own.filter((run) => stage(run) === "review").length,
        total: own.length, updatedAt: Math.max(Date.parse(project.created_at), ...own.map((run) => run.lastActivityAt)),
        sessionCount:Number((ledger.db.prepare(`SELECT COUNT(DISTINCT session_id) count FROM qm_session_members
          WHERE node_id=? AND root=?`).get(nodeId,project.root) as {count:number}).count),
        threadCount:Number((ledger.db.prepare('SELECT COUNT(*) count FROM console_threads WHERE project_id=?').get(project.id) as {count:number}).count) };
    });
    const configPath = join(config.configDir, "config.jsonc");
    const revision = existsSync(configPath) ? statSync(configPath).mtimeMs : 0;
    for (const root of roots) root.revision = revision;
    const federation = config.federation;
    return { nodeId, runs, projects: projectRows, roots, observedAt: Date.now(),
      ...(federation ? { settings: { revision, nickname: federation.nickname, priority: federation.priority,
        egress: { enabled: federation.egress.enabled, config: federation.egress.mihomoConfig ?? null,
          port: Number(new URL(federation.egress.proxyUrl).port) || 80, probe: federation.egress.probeUrl,
          recovery: federation.egress.recoveryDelayMs / 1000, inherit: federation.egress.inheritProxy } } } : {}),
    };
  } finally { ledger.close(); }
}

export function readLocalActivity(config: ServerConfig, kind: string, query: { limit: number; q?: string; level?: string; hour?: string }): { items: WorkbenchEvent[]; total: number; bins: Array<{ start: number; count: number; errors: number; warnings: number }> } {
  const ledger = new WorkLedger(config.stateDir);
  try {
    const nodeId = config.federation?.nodeId ?? "local";
    const projects = ledger.projects().filter((project) => permitted(config, project.root)).map((project) => project.id);
    if (projects.length === 0) return { items: [], total: 0, bins: [] };
    const scope = projects.map(() => "?").join(",");
    const level = "CASE WHEN o.status='failed' THEN 'error' WHEN o.status='reconciliation_required' THEN 'warn' ELSE 'info' END";
    const hour = "CAST(strftime('%s',o.created_at) AS INTEGER)/3600";
    const search = query.q?.toLocaleLowerCase() ?? "";
    const filter = `r.project_id IN (${scope}) AND (?='' OR instr(lower(o.label||' '||i.title||' '||o.id),?)>0) AND (?='' OR ${level}=?)`;
    const params = [...projects, search, search, query.level ?? "", query.level ?? ""];
    const withHour = filter + ` AND (?='' OR ${hour}=CAST(? AS INTEGER))`;
    const rowParams = [...params, query.hour ?? "", query.hour ?? ""];
    const rows = ledger.db.prepare(`SELECT o.id,o.run_id,o.kind,o.label,o.status,o.created_at,o.finished_at,i.title,
      (SELECT tool_name FROM qm_invocations WHERE operation_id=o.id ORDER BY created_at DESC LIMIT 1) tool_name
      FROM console_operations o JOIN console_work_runs r ON r.id=o.run_id
      JOIN console_work_items i ON i.id=r.item_id WHERE ${withHour} ORDER BY o.created_at DESC,o.id LIMIT ?`).all(...rowParams, query.limit) as Array<OperationRow & { title: string; tool_name: string | null }>;
    const total = (ledger.db.prepare(`SELECT COUNT(*) n FROM console_operations o JOIN console_work_runs r ON r.id=o.run_id JOIN console_work_items i ON i.id=r.item_id WHERE ${withHour}`).get(...rowParams) as { n: number }).n;
    const bins = ledger.db.prepare(`SELECT ${hour}*3600000 start, COUNT(*) count, SUM(o.status='failed') errors,
      SUM(o.status='reconciliation_required') warnings FROM console_operations o JOIN console_work_runs r ON r.id=o.run_id
      JOIN console_work_items i ON i.id=r.item_id WHERE ${filter} AND o.created_at>=? GROUP BY ${hour}`)
      .all(...params, new Date(Date.now() - 86_400_000).toISOString()) as Array<{ start: number; count: number; errors: number; warnings: number }>;
    return { total, bins, items: rows.map((row) => ({
      id: workspaceHandle(nodeId, row.id), time: Date.parse(row.created_at), nodeId,
      level: row.status === "failed" ? "error" : row.status === "reconciliation_required" ? "warn" : "info",
      message: row.label, details: { run: workspaceHandle(nodeId, row.run_id), task: row.title, status: row.status, kind: row.kind },
      ...(kind === "calls" ? { tool: row.tool_name ?? row.kind, summary: row.label, rootId: null, state: row.status,
        duration: row.finished_at ? Date.parse(row.finished_at) - Date.parse(row.created_at) : null,
        ok: row.status === "completed" ? true : row.status === "failed" ? false : null,
        error: row.status === "failed" ? "执行失败" : null } : {}),
    })) };
  } finally { ledger.close(); }
}
