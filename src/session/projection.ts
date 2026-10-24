import { activityTimes, currentOperationEvents, latestActivity } from "./activity.js";
import { join } from "node:path";
import { ExecutionState, ReviewState, HostState } from "./types.js";
import { aggregateReviewStates } from './review-state.js';
import { taskView } from '../task-view.js';
import type {
  AgentSummary,
  CommandSummary,
  FileSummary,
  InstructionSummary,
  SessionEvent,
  SessionId,
  SessionMember,
  SessionRecord,
  SkillSummary,
  Snapshot,
  SnapshotLiveState,
  TaskRecord,
} from "./types.js";
import type { SessionStore } from "./store.js";
import type { SqliteWriteOptions } from "../db/async-write.js";

import { mergeExecutionObservations, EXECUTION_OBSERVATION_TTL_MS, type ExecutionObservation } from "../execution-observation.js";

export interface ProjectionReadResult {
  observation?: ExecutionObservation;
  live?: SnapshotLiveState;
  unchanged: boolean;
  snapshot?: Snapshot;
  rev?: number;
}

export interface ProjectionRevertEligibility {
  allowed: boolean;
  reason: string | null;
  revision: number;
}

const PAGE_ROWS = 50;

export class SessionProjector {
  private readonly scheduled = new Map<string, Promise<void>>();
  private refreshRemoteTask?: (taskId: string, memberId?: string) => Promise<void>;
  private closed = false;

  constructor(
    private readonly store: SessionStore,
    private readonly stateDir: string,
    private readonly consoleUrl: string | null = null,
    private readonly revertEligibility?: (sessionId: SessionId, memberId: string, taskId?: string) => Promise<ProjectionRevertEligibility>,
    private readonly localNodeId?: string,
  ) {}

  setRemoteTaskRefresher(refresh?: (taskId: string, memberId?: string) => Promise<void>): void {
    this.refreshRemoteTask = refresh;
  }

  observeTask(taskId: string, memberId?: string): ExecutionObservation {
    const task=this.store.getTask(taskId),at=Date.now();
    const ids=memberId?[memberId]:this.store.taskMemberIds(taskId);
    const values:ExecutionObservation[]=ids.map(id=>{
      const member=this.store.getMember(task.session_id,id);
      if(this.localNodeId!==undefined&&member.node_id!==this.localNodeId){
        const cached=this.store.taskData.projection(taskId,id)?.snapshot;
        const observation=cached?.executionObservation;
        if(observation)return member.online?observation:{...observation,stale:true,
          activeOperationIds:[],preparingOperationIds:[],
          staleOperationIds:[...new Set([...observation.staleOperationIds,...observation.activeOperationIds,...observation.preparingOperationIds])]};
        return {observedAt:0,activeOperationIds:cached?.commands.filter(c=>c.status==='run'||c.status==='queued').map(c=>c.operation_id)??[],preparingOperationIds:[],staleOperationIds:[]};
      }
      const value:ExecutionObservation={observedAt:at,activeOperationIds:[],preparingOperationIds:[],staleOperationIds:[],operationObservedAt:{}};
      for(const row of this.store.taskData.operationObservations(taskId,id)){
        const observedAt=Date.parse(row.observed_at??'');
        if(Number.isFinite(observedAt))value.operationObservedAt![row.id]=observedAt;
        if(['unknown','reconciliation_required'].includes(row.status)||!Number.isFinite(observedAt)||at-observedAt>EXECUTION_OBSERVATION_TTL_MS)value.staleOperationIds.push(row.id);
        else if(row.effect==='not_started'||row.status==='queued')value.preparingOperationIds.push(row.id);
        else value.activeOperationIds.push(row.id);
      }
      return value;
    });
    return mergeExecutionObservations(values,at);
  }

  private liveTaskState(taskId: string, memberId: string | undefined, observation: ExecutionObservation): SnapshotLiveState {
    const task = this.store.getTask(taskId);
    const members = (memberId ? [memberId] : this.store.taskMemberIds(taskId)).map(id => this.store.getMember(task.session_id, id));
    const states = observation.activeOperationIds.length || observation.preparingOperationIds.length || observation.staleOperationIds.length ? []
      : members.map(member => this.localNodeId === undefined || member.node_id === this.localNodeId
        ? memberExecutionState(this.store, taskId, member.id, observation)
        : this.store.taskData.projection(taskId, member.id)?.snapshot.execution_status ?? ExecutionState.idle);
    return {
      observedAt: Date.now(),
      hostStatus: members.some(member => !member.online) ? HostState.disconnected : members.length ? HostState.connected : HostState.unknown,
      executionStatus: observation.activeOperationIds.length || observation.preparingOperationIds.length ? ExecutionState.active
        : observation.stale || observation.staleOperationIds.length ? ExecutionState.interrupted : aggregateExecutionStates(states),
    };
  }

  private finalizationView(task: TaskRecord): Snapshot['finalization'] {
    const value = this.store.taskData.finalization(task.id);
    if (!value || value.completed_at && task.state === 'closed') return null;
    return {state: value.error ? 'failed' : 'pending', requestedAt: Date.parse(value.requested_at), error: value.error};
  }

  schedule(sessionId: SessionId, memberId: string, taskId?: string): void {
    if (this.closed) return;
    const selectedTask = taskId ?? this.store.currentTask(sessionId)?.id;
    const key = JSON.stringify([sessionId,memberId,selectedTask??null]);
    if (this.scheduled.has(key)) return;
    let observedRevision = -1;
    let successful = false;
    const pending = Promise.resolve()
      .then(() => this.materialize(sessionId, memberId, selectedTask))
      .then(snapshot => { observedRevision=snapshot.rev;successful=true; })
      .catch(error => { this.store.markProjectionError(sessionId,memberId,error instanceof Error?error.message:String(error)); throw error; })
      .finally(() => {
        this.scheduled.delete(key);
        const newer=selectedTask ? this.store.getTask(selectedTask).revision>observedRevision : this.hasPendingSnapshot(sessionId,memberId);
        if (!this.closed && successful && newer) {
          this.schedule(sessionId, memberId, selectedTask);
        }
      });
    this.scheduled.set(key, pending);
    void pending.catch(()=>{});
  }

  async materialize(sessionId: SessionId, memberId: string, taskId?: string, writeOptions?: SqliteWriteOptions): Promise<Snapshot> {
    const deadline=writeOptions?Date.now()+(writeOptions.timeoutMs??5000):undefined;
    writeOptions?.signal?.throwIfAborted();
    const session = this.store.getSession(sessionId);
    const member = this.store.getMember(sessionId, memberId);
    const memberRevisionBefore = member.revision;
    const task = taskId ? this.store.getTask(taskId) : null;
    if (task && task.session_id !== sessionId) throw new Error(`TASK_SESSION_MISMATCH: ${task.id}`);
    const revisionBefore = task?.revision ?? member.revision;
    const events = task ? this.store.eventsForTask(task.id) : this.store.eventsForSession(sessionId);
    const metadata = this.store.openingMetadata(sessionId,memberId);
    const files = this.store.fileSummaries(sessionId, memberId, task?.id).map(({ patchRef: _patchRef, versionRef: _versionRef, ...file }) => file);
    const commands = this.commands(events, member.id);
    const agents = this.agents(events, member.id);
    const instructions = this.instructions(sessionId, member.id, task?.id);
    const skills = this.skills(sessionId, member.id, task?.id);
    // 验收随 Task 和执行成员保存；当前会话的后续任务不能改写历史卡片。
    const reviewState = task ? this.store.taskReviewState(task.id, memberId) : session.review_state;
    const localMember = this.localNodeId === undefined || member.node_id === this.localNodeId;
    const observation = task ? this.observeTask(task.id,member.id) : undefined;
    // 执行结果同样绑定本 Task/member；Session 当前状态可能属于后续请求。
    const executionState = task ? localMember
      ? memberExecutionState(this.store,task.id,member.id,observation!)
      : this.store.taskData.projection(task.id,member.id)?.snapshot.execution_status ?? ExecutionState.idle
      : session.execution_state;
    const revert = !localMember
      ? { allowed: false, reason: "remote_member", revision: member.revision }
      : this.revertEligibility
      ? await this.revertEligibility(sessionId, memberId, task?.id)
      : {
          allowed: files.length > 0 && files.every((file) => file.revertible && file.coverage === "session_owned"),
          reason: files.length > 0 && files.every((file) => file.revertible && file.coverage === "session_owned") ? null : "not_eligible",
          revision: member.revision,
        };
    const notices: string[] = [];
    if (!revert.allowed && revert.reason) notices.push(`Revert unavailable: ${revert.reason}`);
    if(task?.closure_reason==="superseded")notices.push("上一请求已归档，未收到明确交付结果");
    if(task?.change_summary_state==="incomplete")notices.push(`文件变化摘要未完整取得${task.change_summary_error?`：${task.change_summary_error}`:""}`);
    const runningCommand=commands.find(command=>command.status==="run"||command.status==="queued")??null;
    const lastCommand=[...commands].sort((a,b)=>(b.endedAt??b.startedAt??0)-(a.endedAt??a.startedAt??0))[0]??null;
    const activity=activityTimes(events,member.id);
    const lastOperation=latestActivity(events,member.id);

    const snapshot: Snapshot = {
      sessionId,
      taskId: task?.id ?? null,
      ...(task?{sourceTaskId:task.source_task_id??null,executionObservation:observation,
        live:this.liveTaskState(task.id,member.id,observation!),finalization:this.finalizationView(task)}:{}),
      taskState:task?.state,
      taskResult:task?.result_status,
      lastOperation,
      lastActivityAt:maxTime([activity.lastModelToolAt,activity.lastExecutionActivityAt,activity.lastOutputAt]),
      lastModelToolAt:activity.lastModelToolAt,
      lastExecutionActivityAt:activity.lastExecutionActivityAt,
      lastOutputAt:activity.lastOutputAt,
      serverNow:Date.now(),
      currentCommand:runningCommand??lastCommand,
      runningCommand,
      lastCommand,
      closureReason:task?.closure_reason??null,
      archivedAt:task?.archived_at?Date.parse(task.archived_at):null,
      deliveryEndedAt:task?.delivery_ended_at?Date.parse(task.delivery_ended_at):null,
      sourceKind:task?.source_kind??"legacy_unknown",
      changeSummary:{state:task?.change_summary_state??"not_started",error:task?.change_summary_error??null},
      rev: revisionBefore,
      changeRev: memberRevisionBefore,
      title: task?.title ?? session.title,
      status: task?.state === "closed" ? task.result_status === "completed" ? "done" : task.result_status === "failed" ? "failed" : "idle" : outerStatus(session,reviewState,executionState),
      execution_status: executionState,
      review_status: reviewState,
      host_status: session.host_state,
      startedAt: Date.parse(task?.created_at ?? session.created_at),
      endedAt: task ? (task.delivery_ended_at ? Date.parse(task.delivery_ended_at) : null)
        : executionState === ExecutionState.idle ? Date.parse(session.last_activity_at) : null,
      observedAt: Date.now(),
      consoleUrl: this.consoleUrl,
      workspace: {
        id: member.id,
        node_id: member.node_id,
        workspace_id: member.workspace_id,
        online: member.online,
        observedAt: Date.parse(member.last_observed_at),
        root: member.root,
        sourceRoot: member.source_root,
        branch: typeof metadata?.branch === "string" ? metadata.branch : null,
        baseRef: typeof metadata?.baseRef === "string" ? metadata.baseRef : null,
        baseSha: typeof metadata?.baseSha === "string" ? metadata.baseSha : null,
        dirtySource: typeof metadata?.dirtySource === "boolean" ? metadata.dirtySource : null,
        mode: member.mode === "worktree" ? "worktree" : "local",
      },
      workspaces: session.members,
      files,
      commands,
      agents,
      instructions,
      skills,
      totals: { files: files.length, commands: commands.length, agents: agents.filter((agent) => agent.role !== "main").length },
      cursors: { files: null, commands: null, agents: null },
      capabilities: {
        refresh: true,
        revert: revert.allowed && revert.revision === memberRevisionBefore,
        continue: agents.some((agent) => agent.result_available || agent.state === "working" || agent.state === "queued"),
        open_file: files.length > 0,
      },
      notices,
    };
    const persist=()=>{
      const current=task?this.store.getTask(task.id):null;
      const currentTask=current&&this.store.getSession(sessionId).current_task_id===current.id&&current.state==="active";
      if(task&&current?.revision===revisionBefore)this.store.taskData.putProjection(task.id,memberId,revisionBefore,snapshot);
      if((!task||currentTask)&&this.store.memberRevision(memberId)===memberRevisionBefore)
        this.store.putSnapshot(sessionId,memberId,memberRevisionBefore,snapshot);
    };
    // 联邦只读请求可取消地等待缓存写锁，其余既有调用保留原有行为。
    if(writeOptions)await this.store.writeAsync(persist,{...writeOptions,timeoutMs:Math.max(0,deadline!-Date.now())});
    else persist();
    return snapshot;
  }

  async readTask(taskId: string, sinceRev: number, memberId?: string, cursor?: string): Promise<ProjectionReadResult> {
    const initialTask = this.store.getTask(taskId);
    this.store.taskData.requireScope(taskId,initialTask.session_id,memberId);
    // 先补齐来源，再比较显示版本；进程重启和 unchanged 读取同样能够恢复订阅。
    await this.refreshRemoteTask?.(taskId,memberId);
    const task = this.store.getTask(taskId);
    const session = this.store.getSession(task.session_id);
    const observation=this.observeTask(taskId,memberId);
    const live=this.liveTaskState(taskId,memberId,observation);
    if (task.revision === sinceRev && !cursor) return { unchanged: true, rev: task.revision, observation, live };

    if (task.state === "closed") {
      const frozen = this.store.taskSnapshots(task.id);
      const selected = memberId ? frozen.filter((item) => item.memberId === memberId) : frozen;
      if (memberId && selected.length === 0) throw new Error(`TASK_MEMBER_NOT_FOUND: ${memberId}`);
      const current = await Promise.all(selected.map(async item => {
        const member=this.store.getMember(session.id,item.memberId);
        const cached=this.store.taskData.projection(task.id,item.memberId);
        // 同一毫秒内也可能收到验收或执行终态；版本比较不会漏掉这些更新。
        const revision=Math.max(item.revision,cached?.revision??-1);
        if(task.revision>revision && (this.localNodeId===undefined||member.node_id===this.localNodeId))return this.materialize(session.id,item.memberId,task.id);
        return cached && cached.revision>item.revision ? cached.snapshot : item.snapshot;
      }));
      const taskMembers=this.store.taskMemberIds(task.id);
      const snapshot = this.aggregateTaskSnapshot(task, session, current, taskMembers, memberId?[memberId]:taskMembers);
      return { unchanged: false, snapshot: pageSnapshot({...snapshot,executionObservation:observation,live,
        host_status:live.hostStatus,execution_status:live.executionStatus}, cursor), rev: task.revision, observation, live };
    }

    const taskMembers = this.store.taskMemberIds(task.id);
    if (memberId && !session.members.some((member) => member.id === memberId)) throw new Error(`MEMBER_NOT_IN_SESSION: ${memberId}`);
    const selectedIds = memberId ? [memberId] : taskMembers;
    const snapshots = await Promise.all(selectedIds.map(async (id) => {
      const member=this.store.getMember(session.id,id);
      const cached = this.store.taskData.projection(task.id, id);
      const local=this.localNodeId===undefined || member.node_id===this.localNodeId;
      if(local) return cached?.revision===task.revision ? cached.snapshot : this.materialize(session.id,id,task.id);
      if(cached)return {...cached.snapshot,workspace:cached.snapshot.workspace ? {...cached.snapshot.workspace,online:member.online,observedAt:Date.parse(member.last_observed_at)} : null,
        host_status:member.online?HostState.connected:HostState.disconnected,workspaces:session.members};
      const empty=emptySnapshot(this.store,session.id,id,member.revision,member.root,member.source_root,member.mode,this.consoleUrl);
      return {...empty,taskId:task.id,title:task.title,execution_status:ExecutionState.idle,review_status:ReviewState.unknown,
        notices:[...empty.notices,"尚未取得所属节点的任务数据"]};
    }));
    const snapshot = this.aggregateTaskSnapshot(task, session, snapshots, taskMembers,selectedIds);
    return { unchanged: false, snapshot: pageSnapshot({...snapshot,executionObservation:observation,live,
      host_status:live.hostStatus,execution_status:live.executionStatus}, cursor), rev: task.revision, observation, live };
  }

  private aggregateTaskSnapshot(task: TaskRecord, session: SessionRecord, snapshots: Snapshot[], taskMemberIds: string[], selectedMemberIds=taskMemberIds): Snapshot {
    const membersById = new Map((task.state === "closed" ? snapshots.flatMap(item=>item.workspaces) : session.members).map((member) => [member.id, member]));
    const members = [...new Set(taskMemberIds)].flatMap((id) => membersById.get(id) ? [membersById.get(id)!] : []);
    const files = snapshots.flatMap((snapshot) => snapshot.files);
    const commands = snapshots.flatMap((snapshot) => snapshot.commands);
    const agents = snapshots.flatMap((snapshot) => snapshot.agents);
    const instructions = snapshots.flatMap((snapshot) => snapshot.instructions);
    const skills = snapshots.flatMap((snapshot) => snapshot.skills);
    const notices = snapshots.flatMap((snapshot) => snapshot.notices);
    const lastOperation=snapshots.map(snapshot=>snapshot.lastOperation).filter((item):item is NonNullable<Snapshot["lastOperation"]>=>Boolean(item))
      .sort((a,b)=>(b.endedAt ?? b.startedAt)-(a.endedAt ?? a.startedAt))[0] ?? null;
    const active=commands.some(command=>command.status==="run"||command.status==="queued")
      ||agents.some(agent=>agent.state==="working"||agent.state==="queued");
    const runningCommand=commands.find(command=>command.status==="run"||command.status==="queued")??null;
    const lastCommand=[...commands].sort((a,b)=>(b.endedAt??b.startedAt??0)-(a.endedAt??a.startedAt??0))[0]??null;
    const lastModelToolAt=maxTime(snapshots.map(snapshot=>snapshot.lastModelToolAt));
    const lastExecutionActivityAt=maxTime(snapshots.map(snapshot=>snapshot.lastExecutionActivityAt));
    const lastOutputAt=maxTime(snapshots.map(snapshot=>snapshot.lastOutputAt));
    const finalization=this.store.taskData.finalization(task.id);
    const finalizing=Boolean(finalization&&(!finalization.completed_at||task.state==='active'));
    if(finalizing)notices.push(finalization!.error?`任务结束尚未确认：${finalization!.error}`:"正在确认各节点的任务结果");
    const reviewStates=snapshots.map(snapshot=>snapshot.review_status);
    if(snapshots.length<selectedMemberIds.length)reviewStates.push(ReviewState.unknown);
    const reviewState=aggregateReviewStates(reviewStates);
    const executionState=aggregateExecutionStates(snapshots.map(snapshot=>{
      const member=snapshot.workspace?membersById.get(snapshot.workspace.id):undefined;
      // 旧版本可能持久化了同 revision 的 idle；完整读取仍按本地账本核对，
      // 无须等待下一次业务事件才能修正当前展示。远端只使用所属节点的快照。
      return member&&(this.localNodeId===undefined||member.node_id===this.localNodeId)
        ? memberExecutionState(this.store,task.id,member.id,this.observeTask(task.id,member.id))
        : snapshot.execution_status;
    }));
    if(task.closure_reason==="superseded")notices.push("上一请求已归档，未收到明确交付结果");
    if(task.change_summary_state==="incomplete")notices.push(`文件变化摘要未完整取得${task.change_summary_error?`：${task.change_summary_error}`:""}`);
    if (members.length === 0) notices.push("No workspace has been used in this task yet.");
    else if (members.length > 1) notices.push(`Showing ${members.length} workspaces in this task.`);
    return {
      sessionId: session.id,
      taskId: task.id,
      sourceTaskId:task.source_task_id??null,
      taskState:task.state,
      taskResult:task.result_status,
      finalization:this.finalizationView(task),
      lastOperation,
      lastActivityAt:maxTime([lastModelToolAt,lastExecutionActivityAt,lastOutputAt]),
      lastModelToolAt,
      lastExecutionActivityAt,
      lastOutputAt,
      serverNow:Date.now(),
      currentCommand:runningCommand??lastCommand,
      runningCommand,
      lastCommand,
      closureReason:task.closure_reason??null,
      archivedAt:task.archived_at?Date.parse(task.archived_at):null,
      deliveryEndedAt:task.delivery_ended_at?Date.parse(task.delivery_ended_at):null,
      sourceKind:task.source_kind??"legacy_unknown",
      changeSummary:{state:task.change_summary_state??"not_started",error:task.change_summary_error??null},
      rev: task.revision,
      changeRev: snapshots.length === 1 ? snapshots[0]?.changeRev ?? null : null,
      title: task.title,
      status: active ? "running" : task.state === "closed" ? task.result_status === "completed" ? "done" : task.result_status === "failed" ? "failed" : "idle" : outerStatus(session,reviewState,executionState),
      execution_status: executionState,
      review_status: reviewState,
      // A member-scoped Task card reports the selected Worker's current
      // connectivity. The aggregate conversation state can still be unknown.
      host_status: snapshots.length === 1 ? snapshots[0]!.host_status : session.host_state,
      startedAt: Date.parse(task.created_at),
      endedAt: task.delivery_ended_at
        ? Date.parse(task.delivery_ended_at)
        : null,
      observedAt: task.state === "closed" ? Math.max(Date.parse(task.created_at),...snapshots.map(item=>item.observedAt)) : Date.now(),
      consoleUrl: this.consoleUrl,
      workspace: snapshots.length === 1 ? snapshots[0]?.workspace ?? null : null,
      workspaces: members,
      files,
      commands,
      agents,
      instructions,
      skills,
      totals: { files: files.length, commands: commands.length, agents: agents.filter((agent) => agent.role !== "main").length },
      cursors: { files: null, commands: null, agents: null },
      capabilities: {
        refresh: task.state === "active" || active || finalizing,
        revert: task.state === "active" && snapshots.length === 1 && Boolean(snapshots[0]?.capabilities.revert),
        continue: task.state === "active" && agents.some((agent) => agent.result_available || agent.state === "working" || agent.state === "queued"),
        open_file: files.length > 0,
      },
      notices: [...new Set(notices)],
    };
  }

  async readSession(sessionId: SessionId, sinceRev: number, cursor?: string): Promise<ProjectionReadResult> {
    const session = this.store.getSession(sessionId);
    const rev = this.sessionRevision(session);
    if (rev === sinceRev && !cursor) return { unchanged: true, rev };
    const snapshot = await this.sessionSnapshot(session, rev);
    return { unchanged: false, snapshot: pageSnapshot(snapshot, cursor), rev };
  }

  private sessionRevision(session: SessionRecord): number {
    return session.members.reduce((total, member) => total + this.store.memberRevision(member.id), session.revision);
  }

  private async sessionSnapshot(session: SessionRecord, rev: number): Promise<Snapshot> {
    const members = session.members;
    const files: FileSummary[] = [];
    const commands: CommandSummary[] = [];
    const agents: AgentSummary[] = [];
    const instructions: InstructionSummary[] = [];
    const skills: SkillSummary[] = [];
    for (const member of members) {
      const stored = await this.workspaceView(session.id, member);
      files.push(...stored.files);
      commands.push(...stored.commands);
      agents.push(...stored.agents);
      instructions.push(...stored.instructions);
      skills.push(...stored.skills);
    }
    const primary = members.length === 1 ? (await this.workspaceView(session.id, members[0]!)).workspace : null;
    const notices: string[] = [];
    if (members.length === 0) notices.push("No workspace is open in this session yet.");
    else if (members.length > 1) notices.push(`Showing ${members.length} workspaces in this session.`);
    return {
      sessionId: session.id,
      rev,
      title: session.title,
      status: outerStatus(session),
      execution_status: session.execution_state,
      review_status: session.review_state,
      host_status: session.host_state,
      startedAt: Date.parse(session.created_at),
      endedAt: session.execution_state === ExecutionState.idle ? Date.parse(session.last_activity_at) : null,
      observedAt: Date.now(),
      consoleUrl: this.consoleUrl,
      workspace: primary,
      workspaces: members,
      files,
      commands,
      agents,
      instructions,
      skills,
      totals: {
        files: files.length,
        commands: commands.length,
        agents: agents.filter((agent) => agent.role !== "main").length,
      },
      cursors: { files: null, commands: null, agents: null },
      capabilities: {
        refresh: true,
        revert: false,
        continue: agents.some((agent) => agent.result_available || agent.state === "working" || agent.state === "queued"),
        open_file: files.length > 0,
      },
      notices,
    };
  }

  private async workspaceView(sessionId: SessionId, member: SessionMember): Promise<Snapshot> {
    const stored = this.store.getSnapshot(sessionId, member.id).snapshot;
    if (stored) return stored;
    return this.materialize(sessionId, member.id);
  }
  read(sessionId: SessionId, memberId: string, sinceRev: number, cursor?: string): ProjectionReadResult {
    const stored = this.store.getSnapshot(sessionId, memberId);
    const members = this.store.getMembers(sessionId);
    const member = members.find(item => item.id === memberId);
    if (!member) throw new Error(`MEMBER_NOT_IN_SESSION: ${memberId}`);
    if (!stored.snapshot) {
      const empty = emptySnapshot(this.store, sessionId, member.id, member.revision, member.root, member.source_root, member.mode, this.consoleUrl);
      return { unchanged: false, snapshot: pageSnapshot(empty, cursor), rev: member.revision };
    }
    const membershipChanged = JSON.stringify(stored.snapshot.workspaces.map((member) => [member.id, member.online]))
      !== JSON.stringify(members.map((member) => [member.id, member.online]));
    if (stored.revision === sinceRev && !cursor && !membershipChanged) return { unchanged: true, rev: stored.revision };
    return {
      unchanged: false,
      // A stored remote snapshot can precede a transport disconnect by hours.
      // Never mask current member presence behind its old host_status field.
      snapshot: pageSnapshot({ ...stored.snapshot, workspaces: members,
        host_status:member.online ? HostState.connected : HostState.disconnected,
        workspace:stored.snapshot.workspace ? {...stored.snapshot.workspace,
          online:member.online,observedAt:Date.parse(member.last_observed_at)} : null,
      }, cursor),
      rev: stored.revision,
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.scheduled.values()]);
    this.scheduled.clear();
  }

  private hasPendingSnapshot(sessionId: SessionId, memberId: string): boolean {
    const stored = this.store.getSnapshot(sessionId, memberId);
    return stored.revision < this.store.memberRevision(memberId);
  }

  private commands(events: SessionEvent[], memberId: string): CommandSummary[] {
    const records = new Map<string, CommandSummary>();
    for (const event of currentOperationEvents(events)) {
      if (event.member_id !== memberId) continue;
      if (event.type !== "operation_started" && event.type !== "operation_finished") continue;
      const operationId = String(event.payload.operation_id ?? event.source_id);
      const existing = records.get(operationId);
      if (!existing && event.payload.kind !== "command") continue;
      const isFinished = event.type === "operation_finished";
      if (!isFinished && existing?.endedAt !== null && existing?.endedAt !== undefined) continue;
      const status = isFinished ? String(event.payload.status ?? "unknown") : "running";
      const commandStatus = mapCommandStatus(status);
      const startedAt = existing?.startedAt ?? (event.type === "operation_started" ? Date.parse(event.timestamp) : null);
      const endedAt = isFinished ? Date.parse(event.timestamp) : null;
      const resultRef = typeof event.payload.output_ref === "string" ? event.payload.output_ref : existing?.output_ref ?? operationId;
      records.set(operationId, {
        id: operationId,
        operation_id: operationId,
        member_id: memberId,
        cmd: String(event.payload.label ?? event.payload.kind ?? existing?.cmd ?? "command"),
        agent: String(event.payload.agent ?? event.payload.agent_id ?? existing?.agent ?? "host"),
        status: commandStatus,
        startedAt,
        endedAt,
        exitCode: event.payload.exit_code === null || event.payload.exit_code === undefined
          ? existing?.exitCode ?? null
          : Number(event.payload.exit_code),
        signal: event.payload.signal === null || event.payload.signal === undefined
          ? existing?.signal ?? null
          : String(event.payload.signal),
        attempt: existing?.attempt ?? null,
        supersededBy: existing?.supersededBy ?? null,
        summary: event.payload.error_message === null || event.payload.error_message === undefined
          ? existing?.summary ?? null
          : String(event.payload.error_message),
        output_ref: resultRef,
        output_available: event.payload.output_available === true || existing?.output_available === true,
      });
    }
    return [...records.values()];
  }

  private agents(events: SessionEvent[], memberId: string): AgentSummary[] {
    const records = new Map<string, AgentSummary>();
    for (const event of events) {
      if (event.member_id !== memberId || event.type !== "agent_changed") continue;
      const payload = event.payload;
      const id = String(payload.agent_id ?? payload.agentId ?? event.source_id);
      const previous = records.get(id);
      const state = String(payload.state ?? previous?.state ?? "unknown");
      const resultRef = payload.result_ref === null || payload.result_ref === undefined
        ? previous?.result_ref ?? null
        : String(payload.result_ref);
      records.set(id, {
        id,
        member_id: memberId,
        role: payload.role === "main" ? "main" : previous?.role ?? "subagent",
        name: String(payload.name ?? payload.agent_name ?? previous?.name ?? "subagent"),
        provider: String(payload.provider ?? previous?.provider ?? "unknown"),
        model: payload.model === null || payload.model === undefined ? previous?.model ?? null : String(payload.model),
        effort: payload.effort === null || payload.effort === undefined ? previous?.effort ?? null : String(payload.effort),
        state: mapAgentState(state),
        task: String(payload.task ?? previous?.task ?? ""),
        tokens: payload.tokens === null || payload.tokens === undefined ? previous?.tokens ?? null : Number(payload.tokens),
        usage_quality: payload.usage_quality === "complete" ? "complete" : payload.usage_quality === "partial" ? "partial" : payload.usage_quality === "not_used" ? "not_used" : previous?.usage_quality ?? "unavailable",
        startedAt: typeof payload.started_at === "string" ? Date.parse(payload.started_at) : previous?.startedAt ?? Date.parse(event.timestamp),
        endedAt: ["completed", "failed", "cancelled", "done"].includes(state) ? Date.parse(event.timestamp) : previous?.endedAt ?? null,
        steps: Array.isArray(payload.steps) ? payload.steps.flatMap((step) => normalizeStep(step)) : previous?.steps ?? null,
        result_available: payload.result_available === true,
        result_ref: resultRef,
      });
    }
    return [...records.values()];
  }

  private instructions(sessionId: SessionId, memberId: string, taskId?: string): InstructionSummary[] {
    const merged=new Map<string,InstructionSummary>();
    for(const row of this.store.contextReads(sessionId,memberId,taskId).filter(item=>item.kind==="instruction")) {
      const candidate:InstructionSummary={
        path:row.path,
        status:row.state==="loaded"||row.state==="read"?"loaded":"available",
        actor_id:row.actor_id,
        source:row.actor_id==="host"?"workspace":"nested",
        observed_at:row.observed_at??null,
        content_ref:row.content_ref,
      };
      const previous=merged.get(row.path);
      if(!previous||previous.status==="available"&&candidate.status==="loaded")merged.set(row.path,candidate);
    }
    return [...merged.values()];
  }

  private skills(sessionId: SessionId, memberId: string, taskId?: string): SkillSummary[] {
    return this.store
      .contextReads(sessionId, memberId, taskId)
      .filter((row) => row.kind === "skill")
      .map((row) => ({
        name: row.path.split(/[\\/]/).filter(Boolean).at(-2) ?? row.path,
        description: null,
        path: row.path,
        actor_id: row.actor_id,
        state: row.state === "read" ? "read" : "available",
        uses: row.read_count > 0 ? row.read_count : null,
      }));
  }
}

function maxTime(values:Array<number|null|undefined>):number|null {
  const finite=values.filter((value):value is number=>typeof value==="number"&&Number.isFinite(value));
  return finite.length?Math.max(...finite):null;
}

function mapCommandStatus(status: string): CommandSummary["status"] {
  if (status === "succeeded") return "ok";
  if (status === "failed") return "fail";
  if (status === "cancelled") return "cancelled";
  if (status === "accepted" || status === "queued") return "queued";
  if (status === "running") return "run";
  return "unknown";
}

function normalizeStep(value: unknown): Array<{ label: string; state: "done" | "cur" | "todo" }> {
  if (typeof value === "string") return [{ label: value, state: "todo" }];
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const label = record.label;
  const state = record.state;
  if (typeof label !== "string") return [];
  return [{ label, state: state === "done" || state === "cur" ? state : "todo" }];
}

function mapAgentState(state: string): AgentSummary["state"] {
  if (state === "running" || state === "working") return "working";
  if (state === "completed" || state === "done") return "done";
  if (state === "failed") return "failed";
  if (state === "cancelled" || state === "stopped") return "cancelled";
  if (state === "queued" || state === "starting") return "queued";
  return "unknown";
}

function pageSnapshot(snapshot: Snapshot, cursor?: string): Snapshot {
  const decoded = decodeCursor(cursor);
  const files = pageRows(snapshot.files, decoded.files, (row) => row.id);
  const commands = pageRows(snapshot.commands, decoded.commands, (row) => row.id, (row) => row.status === "run" || row.status === "queued" || row.id === snapshot.currentCommand?.id);
  const agents = pageRows(snapshot.agents, decoded.agents, (row) => row.id, (row) => row.state === "working" || row.state === "queued" || row.result_available);
  return {
    ...snapshot,
    files: files.rows,
    commands: commands.rows,
    agents: agents.rows,
    cursors: {
      files: files.nextCursor ? encodeCursor({ files: files.nextCursor }) : null,
      commands: commands.nextCursor ? encodeCursor({ commands: commands.nextCursor }) : null,
      agents: agents.nextCursor ? encodeCursor({ agents: agents.nextCursor }) : null,
    },
  };
}

function pageRows<T>(
  rows: T[],
  cursor: string | null,
  idOf: (row: T) => string,
  keepActive: (row: T) => boolean = () => false,
): { rows: T[]; nextCursor: string | null } {
  const start = cursor ? rows.findIndex((row) => idOf(row) === cursor) + 1 : 0;
  const page = rows.slice(start, start + PAGE_ROWS);
  const visible = new Map(page.map((row) => [idOf(row), row]));
  for (const row of rows) if (keepActive(row)) visible.set(idOf(row), row);
  const next = start + page.length < rows.length ? idOf(page.at(-1)!) : null;
  return { rows: [...visible.values()], nextCursor: next };
}

function encodeCursor(cursor: { files?: string; commands?: string; agents?: string }): string {
  return JSON.stringify(cursor);
}

function decodeCursor(cursor?: string): { files: string | null; commands: string | null; agents: string | null } {
  if (!cursor) return { files: null, commands: null, agents: null };
  if (cursor.length > 4096) throw new Error("SNAPSHOT_CURSOR_INVALID");
  const parsed = JSON.parse(cursor) as { files?: unknown; commands?: unknown; agents?: unknown };
  return {
    files: typeof parsed.files === "string" ? parsed.files : null,
    commands: typeof parsed.commands === "string" ? parsed.commands : null,
    agents: typeof parsed.agents === "string" ? parsed.agents : null,
  };
}

function memberExecutionState(store:SessionStore,taskId:string,memberId:string,observation:ExecutionObservation):ExecutionState {
  const result=store.taskData.latestRunResult(taskId,memberId);
  const status=taskView({execution:result?.status??'idle',lastOutcome:result?.last_outcome,
    active:observation.activeOperationIds.length>0,queued:observation.preparingOperationIds.length>0,
    unresolved:observation.staleOperationIds.length>0}).status;
  if(['running','queued','stopping'].includes(status))return ExecutionState.active;
  if(status==='failed')return ExecutionState.failed;
  if(['unknown','interrupted_recoverable','cancelled'].includes(status))return ExecutionState.interrupted;
  return ExecutionState.idle;
}

function aggregateExecutionStates(states:ExecutionState[]):ExecutionState {
  return [ExecutionState.active,ExecutionState.failed,ExecutionState.interrupted].find(state=>states.includes(state))??ExecutionState.idle;
}

function outerStatus(session: SessionRecord, reviewState=session.review_state,executionState=session.execution_state): Snapshot["status"] {
  if (executionState === ExecutionState.active) return "running";
  if (executionState === ExecutionState.failed) return "failed";
  if (reviewState === ReviewState.passed) return "done";
  return "idle";
}
function emptySnapshot(
  store: SessionStore,
  sessionId: SessionId,
  memberId: string,
  revision: number,
  root: string,
  sourceRoot: string | null,
  mode: "checkout" | "worktree",
  consoleUrl: string | null,
): Snapshot {
  const session = store.getSession(sessionId);
  const member = store.getMember(sessionId, memberId);
  return {
    sessionId,
    rev: revision,
    title: session.title,
    status: outerStatus(session),
    execution_status: session.execution_state,
    review_status: session.review_state,
    host_status: session.host_state,
    startedAt: Date.parse(session.created_at),
    endedAt: session.execution_state === ExecutionState.idle ? Date.parse(session.last_activity_at) : null,
    observedAt: Date.now(),
    consoleUrl,
    workspace: {
      id: memberId,
      node_id: member.node_id,
      workspace_id: member.workspace_id,
      online: member.online,
      observedAt: Date.parse(member.last_observed_at),
      root,
      sourceRoot,
      branch: null,
      baseRef: null,
      baseSha: null,
      dirtySource: null,
      mode: mode === "worktree" ? "worktree" : "local",
    },
    workspaces: session.members,
    files: [],
    commands: [],
    agents: [],
    instructions: [],
    skills: [],
    totals: { files: 0, commands: 0, agents: 0 },
    cursors: { files: null, commands: null, agents: null },
    capabilities: { refresh: true, revert: false, continue: false, open_file: false },
    notices: ["Snapshot is being prepared."],
  };
}
