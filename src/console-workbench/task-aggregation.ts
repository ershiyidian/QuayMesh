import { parseWorkspaceHandle } from "../federation/routing.js";
import { dayAt, type Query } from "./query.js";
import type { TaskPhaseIndex } from "./local-queries.js";
import type { SessionTitleIndex } from "./local-queries.js";
import type { Run, Usage } from "./types.js";
export { taskStage } from '../console-task-state.js';

export const TASK_REFERENCE_PREFIX = "qmtask:";

export interface TaskIndex {
  key: string;
  sessionId: string | null;
  taskId: string | null;
  title: string;
  phaseRefs: string[];
  nodeIds: string[];
  projectIds: string[];
  projectNames: string[];
  roots: string[];
  executionStatus: string;
  acceptanceStatus: string;
  startedAt: number;
  finishedAt: number | null;
  lastActivityAt: number;
  tokens: number | null;
  changed: boolean;
  actionableInterruption: boolean;
  currentPhaseRefs: string[];
}

export function taskReference(taskId: string): string {
  return TASK_REFERENCE_PREFIX + taskId;
}

export function parseTaskReference(value: string): string | null {
  return value.startsWith(TASK_REFERENCE_PREFIX) && value.length > TASK_REFERENCE_PREFIX.length
    ? value.slice(TASK_REFERENCE_PREFIX.length)
    : null;
}

export function aggregateTasks(runs: Run[]): Run[] {
  const groups = new Map<string, Run[]>();
  for (const run of runs) {
    const key = taskKey(run);
    const group = groups.get(key);
    if (group) group.push(run);
    else groups.set(key, [run]);
  }
  return [...groups.values()].map(mergeTask);
}

export function aggregateTaskIndex(phases: TaskPhaseIndex[]): TaskIndex[] {
  const groups = new Map<string, TaskPhaseIndex[]>();
  for (const phase of phases) {
    const key = phase.taskId ? `task:${phase.taskId}` : phase.sessionId ? `session:${phase.sessionId}` : `run:${phase.id}`;
    const values = groups.get(key) ?? [];
    values.push(phase);
    groups.set(key, values);
  }
  return [...groups.entries()].map(([key, values]) => {
    const sessionId = values.find((value) => value.sessionId)?.sessionId ?? null;
    const taskId = values.find((value) => value.taskId)?.taskId ?? null;
    const current = values.filter((value) => value.currentPhase);
    const stateValues = current.length ? current : values;
    const tokenValues = values.map((value) => value.tokens).filter((value): value is number => value !== null);
    return {
      key,
      sessionId,
      taskId,
      title: chooseIndexTitle(values),
      phaseRefs: values.map((value) => value.id),
      nodeIds: [...new Set(values.map((value) => value.nodeId))],
      projectIds: [...new Set(values.map((value) => value.projectId))],
      projectNames: [...new Set(values.map((value) => value.projectName))],
      roots: [...new Set(values.map((value) => value.root))],
      executionStatus: aggregateExecution(stateValues.map((value) => value.executionStatus)),
      acceptanceStatus: aggregateAcceptance(stateValues.map((value) => value.acceptanceStatus)),
      startedAt: Math.min(...values.map((value) => value.startedAt)),
      finishedAt: values.every((value) => value.finishedAt !== null) ? Math.max(...values.map((value) => value.finishedAt!)) : null,
      lastActivityAt: Math.max(...values.map((value) => value.lastActivityAt)),
      tokens: tokenValues.length ? tokenValues.reduce((sum, value) => sum + value, 0) : null,
      changed: values.some((value) => value.changed),
      actionableInterruption: stateValues.some((value) => value.actionableInterruption),
      currentPhaseRefs: stateValues.map((value) => value.id),
    };
  });
}

export function resolveSessionTitles(rows: SessionTitleIndex[]): Map<string, string> {
  const grouped = new Map<string, SessionTitleIndex[]>();
  for (const row of rows) {
    const values = grouped.get(row.id) ?? [];
    values.push(row);
    grouped.set(row.id, values);
  }
  const result = new Map<string, string>();
  for (const [id, values] of grouped) {
    const sorted = [...values].sort((a, b) => b.revision - a.revision || b.lastActivityAt - a.lastActivityAt);
    const title = sorted.find((value) => isTaskTitle(value.title))?.title ?? sorted[0]?.title;
    if (title) result.set(id, title);
  }
  return result;
}

export function applyTaskTitles(tasks: TaskIndex[], titles: ReadonlyMap<string, string>): TaskIndex[] {
  return tasks.map((task) => !task.taskId && task.sessionId && titles.has(task.sessionId) ? { ...task, title: titles.get(task.sessionId)! } : task);
}

export function applyRunTitles(runs: Run[], titles: ReadonlyMap<string, string>): Run[] {
  return runs.map((run) => !run.taskId && run.sessionId && titles.has(run.sessionId) ? { ...run, title: titles.get(run.sessionId)! } : run);
}

export function filterTaskIndex(tasks: TaskIndex[], query: Query, at: number): TaskIndex[] {
  const search = (query.q ?? "").trim().toLocaleLowerCase();
  const days = Number(query.days ?? 7);
  const zone = query.tz || "UTC";
  return tasks.filter((task) => task.startedAt <= at
    && (!query.node || task.nodeIds.includes(query.node))
    && (!query.project || task.projectIds.includes(query.project))
    && (!query.session || task.sessionId === query.session)
    && (!query.root || task.roots.includes(query.root))
    && (!query.changed || task.changed)
    && (!query.execution || task.executionStatus === query.execution)
    && (!query.attention || task.executionStatus === "failed" || task.executionStatus === "unknown"
      || task.executionStatus === "interrupted_recoverable" && task.actionableInterruption)
    && (!query.date || dayAt(task.startedAt, zone) === query.date)
    && (!query.finishedDay || task.finishedAt !== null && dayAt(task.finishedAt, zone) === query.finishedDay)
    && (!search || [task.title, task.taskId ?? "", task.sessionId ?? "", ...task.phaseRefs, ...task.projectNames, ...task.nodeIds, ...task.roots]
      .some((value) => value.toLocaleLowerCase().includes(search)))
    && (!days || task.startedAt >= at - days * 86_400_000 || ["running", "queued", "stopping", "waiting"].includes(task.executionStatus)
      || Boolean(query.attention && task.executionStatus === "interrupted_recoverable" && task.actionableInterruption)));
}

export function compareTaskIndex(left: TaskIndex, right: TaskIndex, query: Query, at: number): number {
  const value = (task: TaskIndex) => query.sort === "tokens" ? task.tokens ?? -1
    : query.sort === "duration" ? (task.finishedAt ?? at) - task.startedAt : task.startedAt;
  const delta = value(left) - value(right);
  return (query.sort === "oldest" ? delta : -delta) || left.key.localeCompare(right.key);
}

export function taskKey(run: Run): string {
  return run.taskId ? `task:${run.taskId}` : run.sessionId ? `session:${run.sessionId}` : `run:${run.id}`;
}

export function fallbackTask(task: TaskIndex): Run {
  const reference = task.phaseRefs[0]!;
  const parsed = parseWorkspaceHandle(reference);
  const project = task.projectIds[0] ?? "";
  const projectParsed = parseWorkspaceHandle(project);
  return {
    id: task.taskId ? taskReference(task.taskId) : task.sessionId ? taskReference(task.sessionId) : reference,
    localId: task.taskId ?? task.sessionId ?? parsed?.local ?? reference,
    title: task.title,
    nodeId: task.nodeIds[0] ?? parsed?.node ?? "unknown",
    projectId: project,
    projectLocalId: projectParsed?.local ?? project,
    projectName: task.projectNames.length === 1 ? task.projectNames[0]! : `${task.projectNames.length} 个工作区`,
    root: task.roots[0] ?? "",
    executionStatus: task.executionStatus,
    acceptanceStatus: task.acceptanceStatus,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    lastActivityAt: task.lastActivityAt,
    revision: 0,
    workspaceRevision: 0,
    sessionId: task.sessionId,
    taskId: task.taskId,
    memberId: null,
    usage: { total: task.tokens, input: null, cached: null, output: null, reasoning: null, quality: task.tokens === null ? "unavailable" : "partial" },
    diff: null,
    origin: "session_index",
    branch: null,
    baseSha: null,
    command: null,
    agent: null,
    reason: task.actionableInterruption ? "执行记录需要核对" : null,
    actions: { interrupt: false, resume: false, review: false, revert: false, complete: false, patch: task.currentPhaseRefs.length === 1 },
    warnings: ["部分节点详情暂未取得"],
    phaseRefs: task.phaseRefs,
    currentPhaseRefs: task.currentPhaseRefs,
    nodeIds: task.nodeIds,
    workspaceCount: task.projectIds.length,
    currentPhase: true,
  };
}

function mergeTask(group: Run[]): Run {
  if (group.length === 1 && !group[0]!.taskId && !group[0]!.sessionId) return group[0]!;
  const current = [...group].sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0]!;
  const nodeIds = [...new Set(group.flatMap((run) => run.nodeIds ?? [run.nodeId]))];
  const memberIds = new Set(group.map((run) => run.memberId).filter((value): value is string => Boolean(value)));
  const projects = [...new Set(group.map((run) => run.projectName))];
  const workspaces = [...new Map(group.flatMap(run => run.workspaces ?? [{nodeId:run.nodeId,projectId:run.projectId,
    memberId:run.memberId,name:run.projectName,root:run.root}]).map(value=>[JSON.stringify([value.nodeId,value.root]),value])).values()];
  const currentRuns = group.filter((run) => run.currentPhase !== false);
  const stateRuns = currentRuns.length ? currentRuns : group;
  const nodeStates=Object.fromEntries([...new Set(stateRuns.map(run=>run.nodeId))].map(nodeId=>[
    nodeId,aggregateExecution(stateRuns.filter(run=>run.nodeId===nodeId).map(run=>run.executionStatus)),
  ]));
  const diffRows = stateRuns.map((run) => run.diff).filter((value): value is NonNullable<Run["diff"]> => value !== null);
  const executionStatus = aggregateExecution(stateRuns.map((run) => run.executionStatus));
  const acceptanceStatus = aggregateAcceptance(stateRuns.map((run) => run.acceptanceStatus));
  const usage = mergeUsage(group.map((run) => run.usage));
  const executions = stateRuns.map((run) => run.executionStatus);
  const taskCanComplete = stateRuns.some((run) => run.actions.complete)
    && executions.every((state) => state === "waiting" || state === "idle" || state === "completed");
  const taskCanReview = stateRuns.some((run) => run.actions.review)
    && executions.every((state) => state === "completed");
  return {
    ...current,
    workspaces,
    id: current.taskId ? taskReference(current.taskId) : current.sessionId ? taskReference(current.sessionId) : current.id,
    localId: current.taskId ?? current.sessionId ?? current.localId,
    title: chooseTaskTitle(group),
    projectName: projects.length === 1 ? projects[0]! : `${memberIds.size || projects.length} 个工作区`,
    executionStatus,
    acceptanceStatus,
    startedAt: Math.min(...group.map((run) => run.startedAt)),
    finishedAt: stateRuns.every((run) => run.finishedAt !== null) ? Math.max(...stateRuns.map((run) => run.finishedAt!)) : null,
    lastActivityAt: Math.max(...group.map((run) => run.lastActivityAt)),
    revision: group.reduce((sum, run) => sum + run.revision, 0),
    workspaceRevision: group.reduce((sum, run) => sum + run.workspaceRevision, 0),
    usage,
    diff: diffRows.length ? {
      files: diffRows.reduce((sum, value) => sum + value.files, 0),
      add: diffRows.every((value) => value.add !== null) ? diffRows.reduce((sum, value) => sum + value.add!, 0) : null,
      del: diffRows.every((value) => value.del !== null) ? diffRows.reduce((sum, value) => sum + value.del!, 0) : null,
    } : null,
    command: stateRuns.find((run) => run.executionStatus === "running")?.command ?? current.command,
    agent: stateRuns.find((run) => run.executionStatus === "running")?.agent ?? current.agent,
    reason: stateRuns.find((run) => run.reason)?.reason ?? null,
    actions: {
      interrupt: stateRuns.some((run) => run.actions.interrupt),
      resume: stateRuns.some((run) => run.actions.resume),
      review: taskCanReview,
      complete: taskCanComplete,
      revert: stateRuns.length === 1 && stateRuns.some((run) => run.actions.revert),
      patch: stateRuns.length === 1,
    },
    warnings: [...new Set(group.flatMap((run) => run.warnings))],
    phaseRefs: group.flatMap((run) => run.phaseRefs ?? [run.id]),
    currentPhaseRefs: stateRuns.flatMap((run) => run.phaseRefs ?? [run.id]),
    nodeIds,
    nodeStates,
    workspaceCount: workspaces.length,
    currentPhase: true,
  };
}

function chooseTaskTitle(group: Run[]): string {
  const candidates = group.map((run) => run.title.trim()).filter(Boolean);
  const meaningful = candidates.find(isTaskTitle);
  return meaningful ?? candidates[0] ?? "QuayMesh task";
}

function chooseIndexTitle(values: TaskPhaseIndex[]): string {
  const titles = values.map((value) => value.title.trim()).filter(Boolean);
  return titles.find(isTaskTitle) ?? titles[0] ?? "QuayMesh task";
}

function isTaskTitle(title: string): boolean {
  return !/^(?:Federated session|Workspace tq:[^\s]+|read|workspace_context|exec_command|write_stdin|apply_patch)$/i.test(title)
    && !/^(?:git|node|powershell|pwsh|python|pnpm|npm|yarn)\b/i.test(title);
}

function aggregateExecution(states: string[]): string {
  for (const state of ["running", "queued", "stopping", "unknown", "failed", "interrupted_recoverable", "waiting", "cancelled", "completed", "ended"]) {
    if (states.includes(state)) return state;
  }
  return states[0] ?? "unknown";
}

function aggregateAcceptance(states: string[]): string {
  if (states.includes("rejected")) return "rejected";
  if (states.includes("pending")) return "pending";
  if (states.every((state) => state === "accepted")) return "accepted";
  if (states.every((state) => state === "not_required")) return "not_required";
  return states.find((state) => state !== "unknown") ?? "unknown";
}

function mergeUsage(values: Usage[]): Usage {
  const qualities = values.map((value) => value.quality);
  const known = (value: Usage) => value.quality === "not_used" || value.quality === "complete" || value.quality === "partial";
  const sum = (field: keyof Omit<Usage, "quality">) => values.reduce((total, value) => {
    if (value.quality === "not_used") return total;
    return total + (typeof value[field] === "number" ? Number(value[field]) : 0);
  }, 0);
  const anyKnown = values.some(known);
  const allKnown = values.every(known);
  return {
    total: anyKnown ? sum("total") : null,
    input: allKnown ? sum("input") : null,
    cached: allKnown ? sum("cached") : null,
    output: allKnown ? sum("output") : null,
    reasoning: allKnown ? sum("reasoning") : null,
    quality: qualities.every((quality) => quality === "not_used") ? "not_used"
      : qualities.every((quality) => quality === "complete") ? "complete"
        : anyKnown ? "partial" : "unavailable",
  };
}
