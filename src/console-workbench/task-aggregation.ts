import { parseWorkspaceHandle } from "../federation/routing.js";
import { dayAt, type Query } from "./query.js";
import type { TaskPhaseIndex, TaskPhaseStateIndex } from "./local-queries.js";
import type { SessionTitleIndex } from "./local-queries.js";
import { WorkbenchError, type Run, type Usage } from "./types.js";
import { relevantExecution, taskStage, withTaskLifecycle, taskTimeEnd, type TaskLifecycle } from '../console-task-state.js';
import { taskView } from '../task-view.js';
import { placeholderTaskTitle, resolveTaskTitle } from '../task-title.js';
import { selectOverviewTasks, taskAttention } from './overview-tasks.js';
export { taskStage } from '../console-task-state.js';

export const TASK_REFERENCE_PREFIX = "qmtask:";
export const SESSION_REFERENCE_PREFIX = "qmsession:";

const latestTime = (times: Array<number | null | undefined>): number | null => {
  const known = times.filter((time): time is number => typeof time === 'number' && Number.isFinite(time));
  return known.length ? Math.max(...known) : null;
};

export interface TaskIndex {
  key: string;
  sessionId: string | null;
  taskId: string | null;
  sourceTaskId?: string | null;
  title: string;
  titleSource?: 'task' | 'session' | 'user_message' | 'work_item' | 'workspace' | 'fallback';
  lastProgressAt?: number | null;
  executionObservedAt?: number | null;
  phaseRefs: string[];
  nodeIds: string[];
  projectIds: string[];
  projectNames: string[];
  roots: string[];
  executionStatus: string;
  phaseExecutionStatus?: string;
  acceptanceStatus: string;
  startedAt: number;
  finishedAt: number | null;
  lastActivityAt: number;
  tokens: number | null;
  changed: boolean;
  actionableInterruption: boolean;
  currentPhaseRefs: string[];
  requestState?: string;
  taskRevision?: number;
  resultStatus?: string | null;
  finalization?: TaskLifecycle['finalization'];
  workspaces?: NonNullable<Run['workspaces']>;
  reason?: string | null;
  observedAt?: number | null;
  stale?: boolean;
}

/** State observations deliberately have no usage or change coverage. */
export type TaskStateIndex = Omit<TaskIndex, 'tokens' | 'changed'>;

export function taskReference(taskId: string): string {
  return TASK_REFERENCE_PREFIX + taskId;
}

export function parseTaskReference(value: string): string | null {
  return value.startsWith(TASK_REFERENCE_PREFIX) && value.length > TASK_REFERENCE_PREFIX.length
    ? value.slice(TASK_REFERENCE_PREFIX.length)
    : null;
}

export function sessionReference(sessionId: string): string {
  return SESSION_REFERENCE_PREFIX + sessionId;
}

export function parseSessionReference(value: string): string | null {
  return value.startsWith(SESSION_REFERENCE_PREFIX) && value.length > SESSION_REFERENCE_PREFIX.length
    ? value.slice(SESSION_REFERENCE_PREFIX.length) : null;
}

export function taskOnlyIndex(task: TaskLifecycle, at = Date.now()): TaskIndex {
  return {...taskOnlyStateIndex(task,at),tokens:0,changed:false};
}

export function taskOnlyStateIndex(task: TaskLifecycle, at = Date.now()): TaskStateIndex {
  const workspaces = task.workspaces ?? [];
  return withTaskLifecycle({
    key: `task:${task.id}`, sessionId:task.sessionId, taskId:task.id, title:task.title,
    titleSource:task.titleSource,lastProgressAt:task.lastProgressAt ?? task.lastActivityAt,executionObservedAt:null,
    phaseRefs:[], currentPhaseRefs:[], nodeIds:task.memberNodeIds?.length ? task.memberNodeIds : [task.nodeId ?? 'local'],
    projectIds:[...new Set(workspaces.map(value=>value.projectId).filter(Boolean))],
    projectNames:[...new Set(workspaces.map(value=>value.name))], roots:[...new Set(workspaces.map(value=>value.root))], workspaces,
    executionStatus:taskView({requestState:task.state,result:task.resultStatus,execution:'waiting',
      finalizing:Boolean(task.finalization),lastProgressAt:task.lastActivityAt,now:at}).status,
    acceptanceStatus:'not_required', startedAt:task.createdAt ?? task.lastActivityAt, finishedAt:task.finishedAt,
    lastActivityAt:task.lastActivityAt, actionableInterruption:false,
    reason:task.state==='active' ? '任务已创建，尚未登记后台执行；请求仍然开放' : null,
  },task);
}

export function mergeTaskWorkspaces<T extends {nodeId:string;root:string}>(left:readonly T[]|undefined,right:readonly T[]|undefined):T[] {
  return [...new Map([...(left??[]),...(right??[])].map(workspace=>[JSON.stringify([workspace.nodeId,workspace.root]),workspace])).values()];
}

/** Task membership also includes observed workspaces without an execution.
 * Keep their navigation metadata without inventing another phase or outcome. */
export function withTaskMembership<T extends TaskStateIndex>(task:T,lifecycle?:TaskLifecycle):T {
  if(!lifecycle||lifecycle.id!==task.taskId)return task;
  const workspaces=mergeTaskWorkspaces(task.workspaces,lifecycle.workspaces);
  return {...task,workspaces,
    nodeIds:[...new Set([...task.nodeIds,...(lifecycle.memberNodeIds??[]),...workspaces.map(value=>value.nodeId)])],
    projectIds:[...new Set([...task.projectIds,...workspaces.map(value=>value.projectId).filter(Boolean)])],
    projectNames:[...new Set([...task.projectNames,...workspaces.map(value=>value.name)])],
    roots:[...new Set([...task.roots,...workspaces.map(value=>value.root)])]};
}

export function aggregateTasks(runs: Run[], at = Date.now()): Run[] {
  const groups = new Map<string, Run[]>();
  for (const run of runs) {
    const key = taskKey(run);
    const group = groups.get(key);
    if (group) group.push(run);
    else groups.set(key, [run]);
  }
  return [...groups.values()].map(group => mergeTask(group, at));
}

function groupTaskPhases<T extends TaskPhaseStateIndex>(phases:readonly T[]):Map<string,T[]> {
  const groups = new Map<string, T[]>();
  for (const phase of phases) {
    const key = phase.taskId ? `task:${phase.taskId}` : phase.sessionId ? `session:${phase.sessionId}` : `run:${phase.id}`;
    const values = groups.get(key) ?? [];
    values.push(phase);
    groups.set(key, values);
  }
  return groups;
}

export function aggregateTaskIndex(phases: TaskPhaseIndex[], at = Date.now()): TaskIndex[] {
  return [...groupTaskPhases(phases)].map(([key,values])=>{
    const tokenValues=values.map(value=>value.tokens).filter((value):value is number=>value!==null);
    return {...mergeTaskState(key,values,at),
      tokens:tokenValues.length?tokenValues.reduce((sum,value)=>sum+value,0):null,
      changed:values.some(value=>value.changed)};
  });
}

export function aggregateTaskStateIndex(phases:TaskPhaseStateIndex[],at=Date.now()):TaskStateIndex[] {
  return [...groupTaskPhases(phases)].map(([key,values])=>mergeTaskState(key,values,at));
}

function mergeTaskState(key:string,values:TaskPhaseStateIndex[],at:number):TaskStateIndex {
    const sessionId = values.find((value) => value.sessionId)?.sessionId ?? null;
    const taskId = values.find((value) => value.taskId)?.taskId ?? null;
    const current = values.filter((value) => value.currentPhase);
    const stateValues = current.length ? values.filter(relevantExecution) : values;
    const lastActivityAt = Math.max(...values.map(value => value.lastActivityAt));
    const title = chooseIndexTitle(values);
    return {
      key,
      sessionId,
      taskId,
      title,
      titleSource:values.find(value=>value.title===title)?.titleSource,
      lastProgressAt:latestTime(values.map(value=>value.lastProgressAt ?? value.lastActivityAt)),
      executionObservedAt:latestTime(stateValues.filter(value=>!value.stale
        && ['running','starting','stopping','queued'].includes(value.executionStatus)).map(value=>value.executionObservedAt)),
      phaseRefs: values.map((value) => value.id),
      nodeIds: [...new Set(values.map((value) => value.nodeId))],
      projectIds: [...new Set(values.map((value) => value.projectId))],
      projectNames: [...new Set(values.map((value) => value.projectName))],
      roots: [...new Set(values.map((value) => value.root))],
      workspaces:mergeTaskWorkspaces([],values.map(value=>({nodeId:value.nodeId,projectId:value.projectId,
        memberId:value.memberId??null,name:value.projectName,root:value.root}))),
      executionStatus: aggregateExecution(stateValues, lastActivityAt, at),
      acceptanceStatus: aggregateAcceptance(stateValues.map((value) => value.acceptanceStatus)),
      startedAt: Math.min(...values.map((value) => value.startedAt)),
      finishedAt: stateValues.every((value) => value.finishedAt !== null) ? Math.max(...stateValues.map((value) => value.finishedAt!)) : null,
      lastActivityAt,
      observedAt: stateValues.every(value => value.observedAt != null) ? Math.min(...stateValues.map(value => value.observedAt!)) : null,
      stale: stateValues.some(value => value.stale),
      actionableInterruption: stateValues.some((value) => value.actionableInterruption),
      currentPhaseRefs: stateValues.map((value) => value.id),
      requestState:stateValues.find(value=>value.requestState)?.requestState,
      resultStatus:stateValues.find(value=>value.resultStatus)?.resultStatus ?? null,
      finalization:stateValues.find(value=>value.finalization)?.finalization ?? null,
    };
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

export function applyTaskTitles<T extends TaskStateIndex>(tasks:T[], titles: ReadonlyMap<string, string>):T[] {
  return tasks.map((task) => !task.taskId && task.sessionId && titles.has(task.sessionId) ? { ...task, title: titles.get(task.sessionId)! } : task);
}

export function applyRunTitles(runs: Run[], titles: ReadonlyMap<string, string>): Run[] {
  return runs.map((run) => !run.taskId && run.sessionId && titles.has(run.sessionId) ? { ...run, title: titles.get(run.sessionId)! } : run);
}

type FilterableTaskIndex = TaskStateIndex & {tokens?:number|null;changed?:boolean};

export function filterTaskIndex<T extends FilterableTaskIndex>(tasks: T[], query: Query, at: number, lastObservedExecuting: ReadonlySet<string> = new Set()): T[] {
  if(query.changed&&tasks.some(task=>typeof task.changed!=='boolean'))
    throw new WorkbenchError('改动筛选需要完整任务索引',500,'incomplete_task_projection','none');
  const search = (query.q ?? "").trim().toLocaleLowerCase();
  const days = Number(query.days ?? 7);
  const zone = query.tz || "UTC";
  const overview = ['current','olderOpen'].includes(query.overviewGroup ?? '')
    ? selectOverviewTasks(tasks,at,time=>dayAt(time,zone)===dayAt(at,zone),lastObservedExecuting) : null;
  const groupKeys = overview ? new Set((query.overviewGroup==='current' ? overview.current : overview.olderOpen).map(task=>task.key)) : null;
  return tasks.filter((task) => task.startedAt <= at
    && (!groupKeys || groupKeys.has(task.key))
    && (!query.node || task.nodeIds.includes(query.node))
    && (!query.project || task.projectIds.includes(query.project))
    && (!query.session || task.sessionId === query.session)
    && (!query.requestState || task.requestState === query.requestState)
    && (!query.resultStatus || task.resultStatus === query.resultStatus)
    && (!query.root || task.roots.includes(query.root))
    && (!query.changed || task.changed)
    && (!query.execution || task.executionStatus === query.execution)
    && (!query.stage || query.stage.split(',').includes(taskStage(task.executionStatus,task.acceptanceStatus)))
    && (!query.attention || taskAttention(task) !== null)
    && (!query.date || dayAt(task.startedAt, zone) === query.date)
    && (!query.finishedDay || task.finishedAt !== null && dayAt(task.finishedAt, zone) === query.finishedDay)
    && (!search || [task.title, task.taskId ?? "", task.sessionId ?? "", ...task.phaseRefs, ...task.projectNames, ...task.nodeIds, ...task.roots]
      .some((value) => value.toLocaleLowerCase().includes(search)))
    && (!days || task.startedAt >= at - days * 86_400_000 || task.requestState === 'active' || ["running", "queued", "stopping", "waiting"].includes(task.executionStatus)
      || taskAttention(task) !== null));
}

export function compareTaskIndex(left: FilterableTaskIndex, right: FilterableTaskIndex, query: Query, at: number): number {
  if(query.sort==='tokens'&&[left,right].some(task=>task.tokens===undefined))
    throw new WorkbenchError('用量排序需要完整任务索引',500,'incomplete_task_projection','none');
  const value = (task: FilterableTaskIndex) => {
    const end = taskTimeEnd(task, at);
    return query.sort === "tokens" ? task.tokens ?? -1
      : query.sort === "duration" ? end === null ? -1 : Math.max(0, end - task.startedAt) : task.startedAt;
  };
  const delta = value(left) - value(right);
  return (query.sort === "oldest" ? delta : -delta) || left.key.localeCompare(right.key);
}

export function taskKey(run: Run): string {
  return run.taskId ? `task:${run.taskId}` : run.sessionId ? `session:${run.sessionId}` : `run:${run.id}`;
}

export function fallbackTask(task: TaskStateIndex & {tokens?:number|null}): Run {
  const reference = task.phaseRefs[0] ?? taskReference(task.taskId ?? task.sessionId ?? task.key);
  const parsed = parseWorkspaceHandle(reference);
  const project = task.projectIds[0] ?? "";
  const projectParsed = parseWorkspaceHandle(project);
  const tokens=task.tokens??null;
  return {
    id: task.taskId ? taskReference(task.taskId) : task.sessionId ? sessionReference(task.sessionId) : reference,
    localId: task.taskId ?? task.sessionId ?? parsed?.local ?? reference,
    title: task.title,
    titleSource:task.titleSource,
    lastProgressAt:task.lastProgressAt ?? task.lastActivityAt,
    executionObservedAt:task.executionObservedAt ?? null,
    nodeId: task.nodeIds[0] ?? parsed?.node ?? "unknown",
    projectId: project,
    projectLocalId: projectParsed?.local ?? project,
    projectName: task.projectNames.length === 1 ? task.projectNames[0]! : task.projectNames.length ? `${task.projectNames.length} 个工作区` : '尚未关联工作区',
    root: task.roots[0] ?? "",
    executionStatus: task.executionStatus,
    phaseExecutionStatus:task.phaseExecutionStatus,
    acceptanceStatus: task.acceptanceStatus,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    lastActivityAt: task.lastActivityAt,
    observedAt: task.observedAt,
    stale: task.stale,
    revision: 0,
    workspaceRevision: 0,
    sessionId: task.sessionId,
    taskId: task.taskId,
    requestState:task.requestState,
    taskRevision:task.taskRevision,
    resultStatus:task.resultStatus,
    finalization:task.finalization,
    actionableInterruption:task.actionableInterruption,
    memberId: null,
    usage: !Object.hasOwn(task,'tokens') ? {total:null,input:null,cached:null,output:null,reasoning:null,quality:'unavailable'}
      : task.phaseRefs.length ? { total: tokens, input: null, cached: null, output: null, reasoning: null, quality: tokens === null ? "unavailable" : "partial" }
      : {total:0,input:0,cached:0,output:0,reasoning:0,quality:'not_used'},
    diff: null,
    origin: "session_index",
    branch: null,
    baseSha: null,
    command: null,
    agent: null,
    reason: task.reason ?? (task.actionableInterruption ? "执行记录需要核对" : null),
    actions: { interrupt: false, resume: false, review: false, revert: false, complete: !task.phaseRefs.length && task.requestState==='active', patch: task.currentPhaseRefs.length === 1 },
    warnings: task.phaseRefs.length ? ["部分节点详情暂未取得"] : [],
    phaseRefs: task.phaseRefs,
    currentPhaseRefs: task.currentPhaseRefs,
    nodeIds: task.nodeIds,
    workspaceCount: task.workspaces?.length || task.projectIds.length,
    workspaces:task.workspaces,
    currentPhase: true,
  };
}

function mergeTask(group: Run[], at: number): Run {
  if (group.length === 1 && !group[0]!.taskId && !group[0]!.sessionId) return group[0]!;
  const current = [...group].sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0]!;
  const nodeIds = [...new Set(group.flatMap((run) => run.nodeIds ?? [run.nodeId]))];
  const memberIds = new Set(group.map((run) => run.memberId).filter((value): value is string => Boolean(value)));
  const projects = [...new Set(group.map((run) => run.projectName))];
  const workspaces = [...new Map(group.flatMap(run => run.workspaces ?? [{nodeId:run.nodeId,projectId:run.projectId,
    memberId:run.memberId,name:run.projectName,root:run.root}]).map(value=>[JSON.stringify([value.nodeId,value.root]),value])).values()];
  const currentRuns = group.filter((run) => run.currentPhase !== false);
  const stateRuns = currentRuns.length ? group.filter(relevantExecution) : group;
  const lastActivityAt = Math.max(...group.map(run => run.lastActivityAt));
  const nodeStates = Object.fromEntries([...new Set(stateRuns.map(run => run.nodeId))].map(nodeId => {
    const values = stateRuns.filter(run => run.nodeId === nodeId);
    return [nodeId, aggregateExecution(values, Math.max(...values.map(run => run.lastActivityAt)), at)];
  }));
  const diffRows = stateRuns.map((run) => run.diff).filter((value): value is NonNullable<Run["diff"]> => value !== null);
  const executionStatus = aggregateExecution(stateRuns, lastActivityAt, at);
  const acceptanceStatus = aggregateAcceptance(stateRuns.map((run) => run.acceptanceStatus));
  const usage = mergeUsage(group.map((run) => run.usage));
  const executions = stateRuns.map((run) => run.executionStatus);
  const taskCanComplete = stateRuns.some((run) => run.actions.complete)
    && stateRuns.every(run => run.actions.complete || ['completed','ended','handed_off'].includes(run.executionStatus));
  const taskCanReview = stateRuns.some((run) => run.actions.review)
    && executions.every((state) => state === "completed");
  return {
    ...current,
    workspaces,
    id: current.taskId ? taskReference(current.taskId) : current.sessionId ? sessionReference(current.sessionId) : current.id,
    localId: current.taskId ?? current.sessionId ?? current.localId,
    title: chooseTaskTitle(group),
    titleSource:group.find(run=>run.title===chooseTaskTitle(group))?.titleSource,
    lastProgressAt:latestTime(group.map(run=>run.lastProgressAt ?? run.lastActivityAt)),
    executionObservedAt:latestTime(stateRuns.filter(run=>!run.stale
      && ['running','starting','stopping','queued'].includes(run.executionStatus)).map(run=>run.executionObservedAt)),
    projectName: projects.length === 1 ? projects[0]! : `${memberIds.size || projects.length} 个工作区`,
    executionStatus,
    acceptanceStatus,
    actionableInterruption:stateRuns.some(run=>run.actionableInterruption),
    finalization:stateRuns.find(run=>run.finalization)?.finalization ?? null,
    startedAt: Math.min(...group.map((run) => run.startedAt)),
    finishedAt: stateRuns.every((run) => run.finishedAt !== null) ? Math.max(...stateRuns.map((run) => run.finishedAt!)) : null,
    lastActivityAt,
    observedAt: stateRuns.every(run => run.observedAt != null) ? Math.min(...stateRuns.map(run => run.observedAt!)) : null,
    stale: stateRuns.some(run => run.stale),
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
    reason: stateRuns.find(run => run.executionStatus === executionStatus && run.reason)?.reason ?? null,
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
  return meaningful ?? resolveTaskTitle({workspaceNames:group.map(run=>run.projectName),createdAt:Math.min(...group.map(run=>run.startedAt))}).title;
}

function chooseIndexTitle(values: TaskPhaseStateIndex[]): string {
  const titles = values.map((value) => value.title.trim()).filter(Boolean);
  return titles.find(isTaskTitle) ?? resolveTaskTitle({workspaceNames:values.map(value=>value.projectName),createdAt:Math.min(...values.map(value=>value.startedAt))}).title;
}

function isTaskTitle(title: string): boolean {
  return !placeholderTaskTitle(title) && !/^(?:Federated session|Workspace tq:[^\s]+|read|workspace_context|exec_command|write_stdin|apply_patch)$/i.test(title)
    && !/^(?:git|node|powershell|pwsh|python|pnpm|npm|yarn)\b/i.test(title);
}

function aggregateExecution(
  values: ReadonlyArray<Pick<Run, 'executionStatus' | 'requestState' | 'resultStatus' | 'finalization' | 'stale'>>,
  lastActivityAt: number,
  at: number,
): string {
  // 闲置由全任务最新活动判定，成员已经计算出的 stalled 不参与优先级竞争。
  const states = values.map(value => value.stale && ['running', 'stopping', 'starting', 'queued'].includes(value.executionStatus)
    ? 'unknown' : value.executionStatus === 'stalled' ? 'waiting' : value.executionStatus);
  const execution = ['running', 'stopping', 'queued', 'unknown', 'finalizing', 'failed', 'interrupted_recoverable',
    'waiting', 'cancelled', 'completed', 'handed_off', 'ended'].find(state => states.includes(state)) ?? states[0] ?? 'unknown';
  const active = states.some(state => ['running', 'stopping', 'starting'].includes(state));
  const queued = states.includes('queued');
  return taskView({
    requestState: values.find(value => value.requestState === 'closed')?.requestState ?? values.find(value => value.requestState)?.requestState,
    result: values.find(value => value.resultStatus)?.resultStatus,
    execution, active, queued, unresolved: states.includes('unknown'),
    stale: !active && !queued && values.some(value => value.stale && (value.requestState === 'active'
      || !['completed', 'failed', 'cancelled', 'handed_off', 'ended'].includes(value.executionStatus))),
    finalizing: values.some(value => Boolean(value.finalization)),
    finalizationFailed: values.some(value => Boolean(value.finalization?.error)),
    lastProgressAt: lastActivityAt, now: at,
  }).status;
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
