import type { FleetIndex, Run, Usage } from "./types.js";
import { taskStage,activeExecution,needsAttention } from '../console-task-state.js';

export type Query = Record<string, string | undefined>;
const dayFormatters = new Map<string, Intl.DateTimeFormat>();

export function dayAt(time: number, zone = "UTC"): string {
  let formatter = dayFormatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" });
    if (dayFormatters.size >= 16) dayFormatters.clear();
    dayFormatters.set(zone, formatter);
  }
  const parts = formatter.formatToParts(time);
  const part = (name: string) => parts.find((value) => value.type === name)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function stage(run: Pick<Run, "executionStatus" | "acceptanceStatus">): string {
  return taskStage(run.executionStatus,run.acceptanceStatus);
}

export function active(run: Run): boolean {
  return activeExecution(run.executionStatus);
}

export function filterRuns(runs: Run[], query: Query, now = Date.now()): Run[] {
  const days = Number(query.days ?? "7");
  const search = (query.q ?? "").trim().toLocaleLowerCase();
  const zone = query.tz || "UTC";
  return runs.filter((run) => (!query.node || run.nodeId === query.node)
    && (!query.project || run.projectId === query.project)
    && (!query.session || run.sessionId === query.session)
    && (!query.requestState || run.requestState === query.requestState)
    && (!query.root || run.root === query.root)
    && (!query.changed || run.diff !== null)
    && (!query.execution || run.executionStatus === query.execution)
    && (!query.stage || query.stage.split(',').includes(stage(run)))
    && (!query.date || dayAt(run.startedAt, zone) === query.date)
    && (!query.finishedDay || run.finishedAt !== null && dayAt(run.finishedAt, zone) === query.finishedDay)
    && (!query.attention || needsAttention(run))
    && (!search || [run.title, run.localId, run.id, run.projectName, run.nodeId].some((value) => value.toLocaleLowerCase().includes(search)))
    && (!days || run.startedAt >= now - days * 86_400_000 || run.requestState === 'active' || active(run)
      || run.executionStatus==='waiting' || needsAttention(run)));
}

export function totals(runs: Pick<Run, "usage">[]) {
  const keys = ["total", "input", "cached", "output", "reasoning"] as const;
  const sum = (key: keyof Omit<Usage, "quality">) => {
    const values = runs.map((run) => run.usage.quality === "not_used" ? 0 : run.usage[key]).filter((value): value is number => value !== null);
    return !runs.length || values.length ? values.reduce((a, b) => a + b, 0) : null;
  };
  return {
    total: sum("total"), input: sum("input"), cached: sum("cached"), output: sum("output"), reasoning: sum("reasoning"),
    fieldMissing: Object.fromEntries(keys.map((key) => [key, runs.filter((run) => run.usage.quality !== "not_used" && run.usage[key] === null).length])) as Record<typeof keys[number], number>,
    records: runs.length,
    missing: runs.filter((run) => run.usage.quality === "unavailable").length,
    partial: runs.filter((run) => run.usage.quality === "partial").length,
    notUsed: runs.filter((run) => run.usage.quality === "not_used").length,
  };
}

export type UsageTotals = ReturnType<typeof totals>;

export function mergeTotals(values: UsageTotals[]): UsageTotals {
  const result = totals([]);
  for (const key of ["total", "input", "cached", "output", "reasoning"] as const) {
    const actual = values.filter((value) => value.records > 0);
    const known = actual.filter((value) => value[key] !== null);
    result[key] = actual.length && !known.length ? null : known.reduce((sum, value) => sum + value[key]!, 0);
    result.fieldMissing[key] = values.reduce((sum, value) => sum + value.fieldMissing[key], 0);
  }
  for (const key of ["records", "missing", "partial", "notUsed"] as const) result[key] = values.reduce((sum, value) => sum + value[key], 0);
  return result;
}

export function pageRuns(index: FleetIndex, query: Query, now = Date.now()) {
  const scoped = filterRuns(index.runs, query, now);
  const counts: Record<string, number> = { all: scoped.length };
  for (const run of scoped) { const state = stage(run); counts[state] = (counts[state] ?? 0) + 1; }
  const selected = scoped.filter((run) => !query.status || stage(run) === query.status);
  const order = query.sort ?? "newest";
  selected.sort((left, right) => (order === "oldest" ? left.startedAt - right.startedAt
    : order === "tokens" ? (right.usage.total ?? -1) - (left.usage.total ?? -1)
      : order === "duration" ? ((right.finishedAt ?? now) - right.startedAt) - ((left.finishedAt ?? now) - left.startedAt)
        : right.startedAt - left.startedAt) || left.id.localeCompare(right.id));
  const offset = Math.max(0, Number(query.cursor ?? 0));
  const limit = Math.min(100, Math.max(1, Number(query.limit ?? 25)));
  return { items: selected.slice(offset, offset + limit), total: selected.length, counts, offset, limit,
    nextCursor: offset + limit < selected.length ? String(offset + limit) : null,
    observedAt: index.observedAt, sources: index.sources, complete: index.complete };
}

export function overview(index: FleetIndex, zone = "UTC", now = Date.now()) {
  const today = dayAt(now, zone);
  const todayRuns = index.runs.filter((run) => dayAt(run.startedAt, zone) === today);
  const activeRuns = index.runs.filter(active).sort((a, b) => a.startedAt - b.startedAt);
  return {
    active: activeRuns,
    runningCount: activeRuns.filter((run) => run.executionStatus !== "queued").length,
    queuedCount: activeRuns.filter((run) => run.executionStatus === "queued").length,
    reviewCount: index.runs.filter((run) => stage(run) === "review").length,
    completedToday: index.runs.filter((run) => run.executionStatus === "completed" && run.finishedAt !== null && dayAt(run.finishedAt, zone) === today).length,
    failedToday: todayRuns.filter((run) => run.executionStatus === "failed").length,
    todayUsage: totals(todayRuns),
    attention: index.runs.filter((run) => run.executionStatus === "interrupted_recoverable" || run.executionStatus === "unknown"
      || run.executionStatus === "failed" && run.lastActivityAt >= now - 86_400_000)
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
      .map((run) => ({ id: run.id, kind: stage(run), title: run.title, detail: run.reason ?? "查看保存的执行记录", nodeId: run.nodeId })),
    recent: index.runs.filter((run) => !active(run)).sort((a, b) => (b.finishedAt ?? b.lastActivityAt) - (a.finishedAt ?? a.lastActivityAt)).slice(0, 6),
    projects: index.projects.map((project) => ({ ...project, usage: totals(todayRuns.filter((run) => run.projectId === project.id)).total }))
      .sort((a, b) => (b.usage ?? 0) - (a.usage ?? 0)).slice(0, 4),
    observedAt: index.observedAt, sources: index.sources, complete: index.complete,
  };
}

export function usageReport(index: FleetIndex, query: Query, now = Date.now()) {
  const days = Math.min(30, Math.max(1, Number(query.days) || 14));
  const zone = query.tz || "UTC";
  const dates = Array.from({ length: days }, (_, day) => dayAt(now - (days - day - 1) * 86_400_000, zone));
  const allowed = new Set(dates);
  const runs = filterRuns(index.runs, { ...query, days: "0", status: undefined }, now).filter((run) => allowed.has(dayAt(run.startedAt, zone)));
  return { ...totals(runs),
    daily: dates.map((day) => ({ day, ...totals(runs.filter((run) => dayAt(run.startedAt, zone) === day)) })),
    projects: index.projects.map((project) => ({ ...project, ...totals(runs.filter((run) => run.projectId === project.id)) }))
      .filter((project) => project.records > 0).sort((a, b) => (b.total ?? 0) - (a.total ?? 0)),
    top: runs.filter((run) => (run.usage.total ?? 0) > 0).sort((a, b) => (b.usage.total ?? 0) - (a.usage.total ?? 0)).slice(0, 8),
    sources: index.sources, complete: index.complete, observedAt: index.observedAt,
  };
}
