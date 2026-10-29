import { executionObservationSchema } from "../session/schema.js";
import { createHash } from "node:crypto";
import { sessionRequestIdentity } from "../request-meta.js";
import { sessionToolRoute } from "./tool-routing.js";
import type { SessionProjector } from "../session/projection.js";
import type { SessionService, TaskOwnerReceipt } from "../session/service.js";
import type { SessionStore } from "../session/store.js";
import { validateSnapshot } from "../session/schema.js";
import { HostState, type SessionMember, type Snapshot } from "../session/types.js";
import type { FederationRuntime } from "./runtime.js";
import type { PeerLink } from "./transport.js";
import type { JsonRecord } from "./types.js";
import { parseWorkspaceHandle } from "./routing.js";
import { assertTaskBindingEnvelope, type SessionFeedRequest, type SessionFeedUpdate, type TrustedInvocationEnvelope } from "./session-types.js";
import { isReadOnlyObservation } from "../tool-admission.js";
import { jsonReply } from "../bounded-reply.js";
import { errorCode } from "../session/outcome.js";
import { savedOperationStatus, operationReceiptSummary, operationStatusBatch } from "../session/operation-status.js";
import { EXECUTION_OBSERVATION_TTL_MS } from "../execution-observation.js";
import { filesForReader } from "../session/file-contract.js";
import { locallyUnsentPeerRequest } from "./read-retry.js";
import { FinalizationDispatchError } from "../session/task-finalization.js";
import { taskBindingForRequest } from "../tasks/task-resume.js";

const TASK_REFRESH_WAIT_MS = 750;
const TASK_REFRESH_TIMEOUT_MS = 5_000;
type SnapshotReader = Pick<SessionFeedRequest, "command_identity" | "file_recorded_at">;

function observedOperationIds(name: string, input: JsonRecord): string[] {
  if (!isReadOnlyObservation(name, input)) return [];
  if (name !== "read_output" && name !== "write_stdin" && !(name === "workspace_context" && input.action === "status")) return [];
  if (typeof input.operation_id === "string") return [input.operation_id];
  if (name === "write_stdin" && typeof input.session_id === "string") return [input.session_id];
  if (name === "workspace_context" && Array.isArray(input.operation_ids))
    return input.operation_ids.filter((value): value is string => typeof value === "string");
  if (name === "read_output" && Array.isArray(input.outputs)) return input.outputs.flatMap(value =>
    value && typeof value === "object" && typeof (value as JsonRecord).operation_id === "string"
      ? [String((value as JsonRecord).operation_id)] : []);
  return [];
}

interface RemoteSubscription {
  nodeId: string;
  sessionId: string;
  memberId: string;
  taskId?: string;
  lastRevision: number;
  confirmedAt: number;
  generation: number;
  lastError?: string;
}

export class SessionFeed {
  private readonly subscriptions = new Map<string, RemoteSubscription>();
  private readonly refreshing = new Map<string, Promise<void>>();
  private readonly snapshots = new Map<string, Promise<SessionFeedUpdate>>();
  private readonly refreshController = new AbortController();
  private readonly pendingPublishes = new Map<string, NodeJS.Timeout>();
  private readonly subscribers = new Map<string, Map<string, SnapshotReader>>();
  private readonly disposeStore: () => void;
  private readonly disposeSettlements: Array<() => void> = [];
  private closed = false;
  private readonly observationTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly runtime: FederationRuntime,
    private readonly store: SessionStore,
    private readonly projector: SessionProjector,
    private readonly service: SessionService,
  ) {
    this.observationTimer=setInterval(()=>this.publishObservations(),10_000);
    this.observationTimer.unref();
    this.disposeStore = store.onChange((change) => {
      const member = store.getMember(change.sessionId, change.memberId);
      if (member.node_id !== runtime.localId) return;
      this.publishLocalChange(change.sessionId, change.memberId, change.revision, change.taskId);
    });
    const onOffline = (nodeId: string) => { void this.onDisconnect(nodeId).catch(error=>{if(!this.closed)runtime.emit("fault",error);}); };
    const onOnline = (link: PeerLink) => { void this.onReconnect(link.peerId).catch(error=>{if(!this.closed)runtime.emit("fault",error);}); };
    runtime.transport.on("offline", onOffline);
    runtime.transport.on("online", onOnline);
    this.disposeSettlements.push(() => runtime.transport.off("offline", onOffline));
    this.disposeSettlements.push(() => runtime.transport.off("online", onOnline));
    runtime.setSessionFeed(this);
    projector.setRemoteTaskRefresher((taskId,memberId)=>this.refreshTask(taskId,memberId));
    service.setRemoteFinalizer(async (task,status,summary) => {
      const session=store.getSession(task.session_id);
      const members=store.taskMemberIds(task.id).map(id=>store.getMember(session.id,id)).filter(member=>member.node_id!==runtime.localId);
      const nodes=[...new Set(members.map(member=>member.node_id))];
      const results = await Promise.allSettled(nodes.map(async nodeId => {
        const member=members.find(candidate=>candidate.node_id===nodeId)!;
        const receipt=await runtime.request<TaskOwnerReceipt>(nodeId,"session.feed",{
          kind:"finalize",session_id:session.id,member_id:member.id,task_id:task.id,
          owner_id:session.owner_id,status,summary,command_identity:true,file_recorded_at:true,
        } satisfies SessionFeedRequest);
        if(receipt.taskId!==task.id || receipt.nodeId!==nodeId || !Array.isArray(receipt.snapshots))throw new Error("TASK_OWNER_RECEIPT_INVALID");
        return receipt;
      }));
      const failed = results.filter((value): value is PromiseRejectedResult => value.status === "rejected");
      if (failed.length) {
        // Wait for the whole fan-out. A local offline error on one node cannot
        // erase another owner's successful/unknown finalization side effects.
        const allNotSent = failed.length === results.length
          && failed.every(value => locallyUnsentPeerRequest(value.reason));
        throw new FinalizationDispatchError(failed.map(value => value.reason), allNotSent);
      }
      return results.map(value => (value as PromiseFulfilledResult<TaskOwnerReceipt>).value);
    });
  }

  routeNodeFor(input: JsonRecord): string | undefined {
    const member = this.memberForInput(input);
    return member?.member.node_id;
  }

  async recoverOperationStatus(input: JsonRecord, identity: TrustedInvocationEnvelope | undefined,
    ownerNodeId: string, queryOwner: () => Promise<unknown>): Promise<unknown> {
    if (ownerNodeId===this.runtime.localId || input.action!=="status" || input.environment===true
      || !identity?.session_id || !identity.member_id) return queryOwner();
    const ids=typeof input.operation_id==="string" ? [input.operation_id]
      : Array.isArray(input.operation_ids) ? input.operation_ids.filter((value):value is string=>typeof value==="string") : [];
    if (!ids.length || ids.length>8) return queryOwner();
    const member=this.store.getMember(identity.session_id,identity.member_id);
    if (member.node_id!==ownerNodeId) throw new Error("WORKSPACE_SESSION_MISMATCH");
    const workspaceId=parseWorkspaceHandle(member.workspace_id)?member.workspace_id:`qm:${ownerNodeId}:${member.workspace_id}`;
    const context={owner_id:identity.owner_id,session_id:identity.session_id,member_id:identity.member_id};
    const receipts=new Map(ids.map(id=>[id,savedOperationStatus(this.store,context,workspaceId,id,
      {offset:typeof input.offset==="number"?input.offset:0})]));
    let reply:unknown, failure:unknown;
    try {reply=await queryOwner();} catch(error) {failure=error;}
    const envelope=reply&&typeof reply==="object"?reply as JsonRecord:{};
    const body=envelope.structuredContent&&typeof envelope.structuredContent==="object"?envelope.structuredContent as JsonRecord:{};
    if (![...receipts.values()].some(Boolean)) {
      if (failure) throw failure;
      // 旧 Worker 不认识新的回包预算，入口仍按最终文本/JSON 结果计费。
      if (Array.isArray(input.operation_ids) && Array.isArray(body.results) && envelope.isError !== true)
        return {...envelope,...jsonReply(operationStatusBatch(body.results as JsonRecord[],body.partial===true,workspaceId,identity.task_id))};
      return reply;
    }
    const join=(operationId:string,owner:JsonRecord|undefined):JsonRecord=>{
      const receipt=receipts.get(operationId);
      const rows=Array.isArray(owner?.operations)?owner.operations as JsonRecord[]:[];
      const found=owner?.lookup==="found" || rows.some(row=>row.operation_id===operationId);
      const unreachable=Boolean(failure || envelope.isError===true || owner?.error && !found);
      const lookup=unreachable?"unreachable":found?"found":"not_found";
      const base=found ? owner! : receipt ?? {operation_id:operationId,operation_state:"unknown",effect:"unknown",operations:[],unknown_effects:[operationId],result_ready:false};
      return {...base,receipt_node_id:this.runtime.localId,owner_node_id:ownerNodeId,owner_lookup:lookup,
        ...(receipt?{entry_receipt:operationReceiptSummary(receipt)}:{}),
        ...(!found?{poll_after_ms:2000,next_action:{tool:"workspace_context",arguments:{workspace_id:workspaceId,action:"status",operation_id:operationId}}}:{}),
        ...(unreachable?{observation_error:{code:failure?errorCode(failure):String(body.error_code??"OWNER_STATUS_UNAVAILABLE")}}:{})};
    };
    if (typeof input.operation_id==="string") return jsonReply(join(input.operation_id,body));
    const remoteRows=Array.isArray(body.results)?body.results as JsonRecord[]:[];
    const results=ids.map(id=>join(id,remoteRows.find(row=>row.operation_id===id)));
    return jsonReply(operationStatusBatch(results,results.some(row=>row.owner_lookup!=="found"),workspaceId,identity.task_id));
  }

  async trustedInvocation(name: string, input: JsonRecord, extra: JsonRecord): Promise<TrustedInvocationEnvelope | undefined> {
    // App Task controls and member detail reads authorize their explicit scope in
    // their own handlers. They must not borrow the model's selected execution Task.
    if (sessionToolRoute(name) !== "none") return undefined;
    const auth = extra.authInfo as { extra?: Record<string, unknown> } | undefined;
    const ownerId = auth?.extra?.owner_id;
    if (typeof ownerId !== "string" || ownerId.length === 0) return undefined;
    const identity = sessionRequestIdentity(extra);
    const observing = isReadOnlyObservation(name, input);
    // Explicit observations may use their durable original operation. This does
    // not change the entry binding or authorize new work in that operation's Task.
    const operation = observedOperationIds(name, input).map(id => this.store.findInvocationSummaryByOperation(ownerId, id))
      .find(saved => saved?.task_id);
    const historicalTaskId = observing && typeof input.task_id === "string" ? input.task_id : operation?.task_id ?? undefined;
    const captured = historicalTaskId ? { ...identity, task_id: historicalTaskId } : identity;
    const existing = this.service.selectedExecution(captured);
    const selected = name === "open_workspace" || !observing && !captured.task_id && existing
      ? await this.service.resolveExecution(captured, "QuayMesh task") : existing;
    if (!selected) return undefined;
    const { session, task } = selected;
    if (name !== "write_stdin" && typeof input.session_id === "string" && input.session_id !== session.id) {
      throw Object.assign(new Error(`TASK_SESSION_MISMATCH: ${task.id}`), { code: "TASK_SESSION_MISMATCH", effect: "not_started" });
    }
    const handle = typeof input.workspace_id === "string" ? parseWorkspaceHandle(input.workspace_id) : undefined;
    const member = session.members.find(candidate => candidate.id === input.member_id
      || (candidate.workspace_id === (handle?.local ?? input.workspace_id) && (!handle || candidate.node_id === handle.node)));
    if (!member && name !== "open_workspace" && name !== "attach_workspace") return undefined;
    if (name === "attach_workspace" && task.state !== "active") {
      throw Object.assign(new Error(`TASK_NOT_ACTIVE: ${task.id}`), { code: "TASK_NOT_ACTIVE", effect: "not_started" });
    }
    const independentBinding = session.conversation_id !== identity.conversation_id || this.store.currentTask(session.id)?.id !== task.id;
    return {
      invocation_id: invocationId(ownerId, identity.transport_instance_id, String(identity.request_id), name),
      owner_id: ownerId, conversation_id: identity.conversation_id,
      transport_instance_id: identity.transport_instance_id, request_id: String(identity.request_id),
      session_id: session.id, session_title: session.title,
      task_id: task.id, task_title: task.title, task_created_at: task.created_at,
      ...(task.source_task_id ? { task_source_id: task.source_task_id } : {}),
      ...(independentBinding ? { task_binding_version: 1 as const, canonical_conversation_id: session.conversation_id } : {}),
      ...(member ? { member_id: member.id } : {}),
      ...(typeof input.workspace_id === "string" || member?.workspace_id
        ? { workspace_id: typeof input.workspace_id === "string" ? input.workspace_id : member!.workspace_id } : {}),
      actor: "model",
    };
  }

  async prepareLocalTool(name: string, input: JsonRecord, envelope: TrustedInvocationEnvelope | undefined): Promise<TrustedInvocationEnvelope | undefined> {
    if (!envelope) return;
    assertTaskBindingEnvelope(envelope);
    // Explicit historical observations can recover their original scope from
    // the execution owner's receipt even if the Coordinator predates that receipt.
    // This neither selects a Task nor authorizes new work under the old operation.
    const ownerId = envelope.owner_id;
    const operation = observedOperationIds(name, input).map(id => this.store.findInvocationSummaryByOperation(ownerId, id))
      .find(saved => saved?.task_id);
    if (operation?.task_id) {
      const task = this.store.getTask(operation.task_id), session = this.store.requireSession(envelope.owner_id, operation.session_id);
      const member = this.store.getMember(session.id, operation.member_id);
      const workspace = typeof input.workspace_id === "string" ? input.workspace_id : envelope.workspace_id;
      const handle = workspace ? parseWorkspaceHandle(workspace) : undefined;
      if (task.session_id !== session.id || member.node_id !== this.runtime.localId
        || handle && handle.node !== this.runtime.localId || !workspace || member.workspace_id !== (handle?.local ?? workspace))
        throw Object.assign(new Error("WORKSPACE_SESSION_MISMATCH"), { code: "WORKSPACE_SESSION_MISMATCH", effect: "not_started" });
      envelope = { ...envelope, session_id: session.id, task_id: task.id, task_title: task.title, task_created_at: task.created_at,
        task_source_id: task.source_task_id ?? undefined, member_id: member.id, task_binding_version: 1,
        canonical_conversation_id: session.conversation_id };
    }
    const sessionId = name !== "write_stdin" && typeof input.session_id === "string" ? input.session_id : envelope.session_id;
    if (!sessionId) return envelope;
    if (envelope.session_id && envelope.session_id !== sessionId) throw Object.assign(new Error("SESSION_SCOPE_MISMATCH"),
      { code: "SESSION_SCOPE_MISMATCH", effect: "not_started" });
    const existingTask = envelope.task_id ? this.store.findTask(envelope.task_id) : null;
    if (existingTask && existingTask.session_id !== sessionId) throw Object.assign(new Error("TASK_SESSION_MISMATCH"),
      { code: "TASK_SESSION_MISMATCH", effect: "not_started" });
    if (existingTask) this.store.requireSession(envelope.owner_id, existingTask.session_id);
    if (isReadOnlyObservation(name, input)) {
      // 观察只使用已有归属，不能同步标题、补建远端会话或推进当前 Task。
      if (envelope.session_id && envelope.session_id !== sessionId) throw new Error("SESSION_SCOPE_MISMATCH");
      const session = this.store.requireSession(envelope.owner_id, sessionId);
      if (envelope.task_binding_version !== 1 && envelope.conversation_id && session.conversation_id && envelope.conversation_id !== session.conversation_id)
        throw new Error("SESSION_SCOPE_MISMATCH");
      const workspaceId = typeof input.workspace_id === "string" ? input.workspace_id : envelope.workspace_id;
      // qm_session 在入口读成员投影；原 handler 的 requireSession/readTask.requireScope
      // 核验 owner、session、task/member 归属，不在该成员的工作区执行操作。
      if (workspaceId && name !== "qm_session") {
        if (!envelope.member_id) throw new Error("REMOTE_SESSION_MEMBER_REQUIRED");
        const member = this.store.getMember(sessionId, envelope.member_id);
        const handle = parseWorkspaceHandle(workspaceId);
        if (member.node_id !== this.runtime.localId || handle && handle.node !== this.runtime.localId
          || member.workspace_id !== (handle?.local ?? workspaceId)) throw new Error("WORKSPACE_SESSION_MISMATCH");
      }
      const claimedTask = existingTask;
      if (claimedTask && claimedTask.session_id !== sessionId) throw new Error("TASK_SESSION_MISMATCH");
      if (envelope.task_binding_version === 1 && typeof input.task_id === "string" && input.task_id !== envelope.task_id)
        throw Object.assign(new Error("TASK_SCOPE_MISMATCH"), { code: "TASK_SCOPE_MISMATCH", effect: "not_started" });
      // An explicit captured Task with no mirror has no local history. Never
      // substitute another Task or create mirror rows as a side effect of reading.
      const task = typeof input.task_id === "string" ? this.store.findTask(input.task_id)
        : envelope.task_id ? claimedTask : this.store.currentTask(sessionId);
      if (!task && (envelope.task_id || typeof input.task_id === "string")) throw Object.assign(
        new Error("TASK_REMOTE_HISTORY_UNAVAILABLE: This Worker has no records for the requested Task; the Task selection was not changed."),
        { code: "TASK_REMOTE_HISTORY_UNAVAILABLE", effect: "not_started", retryHint: "fix_input" });
      if (!task) throw new Error("TASK_NOT_FOUND");
      if (task.session_id !== sessionId) throw new Error("TASK_SESSION_MISMATCH");
      return {...envelope, task_id: task.id, task_title: task.title, task_created_at: task.created_at,
        task_source_id: task.source_task_id ?? undefined};
    }
    this.store.adoptRemoteSession({
      id: sessionId,
      ownerId: envelope.owner_id,
      conversationId: envelope.task_binding_version === 1 ? envelope.canonical_conversation_id ?? null : envelope.conversation_id,
      title: envelope.session_title ?? "Federated session",
    });
    this.store.requireSession(envelope.owner_id, sessionId);
    if (envelope.task_id) {
      await this.service.adoptTask(sessionId, envelope.task_id, envelope.task_title ?? envelope.session_title ?? "QuayMesh task", envelope.task_created_at, envelope.task_source_id);
    }
    return envelope;
  }

  private requireTaskWorkScope(envelope: TrustedInvocationEnvelope): void {
    const task = envelope.task_id ? this.store.getTask(envelope.task_id) : null;
    if (task && task.session_id !== envelope.session_id) throw Object.assign(new Error(`TASK_SESSION_MISMATCH: ${task.id}`),
      { code: "TASK_SESSION_MISMATCH", effect: "not_started" });
    if (envelope.session_id) this.store.requireSession(envelope.owner_id, envelope.session_id);
    if (!task || task.state !== "active") throw Object.assign(new Error(`TASK_NOT_ACTIVE: ${envelope.task_id ?? "missing"}`),
      { code: "TASK_NOT_ACTIVE", effect: "not_started" });
  }

  async admitTaskWork(envelope: TrustedInvocationEnvelope): Promise<void> {
    await this.store.writeAsync(()=>{
      this.requireTaskWorkScope(envelope);
      this.store.taskData.admitWorkInTransaction(envelope.task_id!);
    });
  }

  async recordTaskWork(envelope: TrustedInvocationEnvelope): Promise<void> {
    this.requireTaskWorkScope(envelope);
    if (!envelope.task_id || !envelope.member_id) throw Object.assign(new Error("TASK_MEMBER_REQUIRED"),
      { code: "TASK_MEMBER_REQUIRED", effect: "not_started" });
    const taskId = envelope.task_id, memberId = envelope.member_id;
    await this.store.writeAsync(() => {
      // 等待写锁时任务可能已结束；先复核，再登记目标节点以参与任务收尾。
      this.requireTaskWorkScope(envelope);
      this.store.taskData.admitWorkInTransaction(taskId);
      this.store.touchTaskMember(taskId, memberId);
    });
  }

  async afterRemoteResult(
    name: string,
    input: JsonRecord,
    result: unknown,
    nodeId: string,
    envelope: TrustedInvocationEnvelope | undefined,
  ): Promise<void> {
    if (!envelope || nodeId === this.runtime.localId) return;
    if (name !== "open_workspace" && name !== "attach_workspace") {
      const member=envelope.session_id&&envelope.member_id
        ? this.store.findMember(envelope.session_id,envelope.member_id) : null;
      if(member?.node_id===nodeId){
        const key=subscriptionKey(envelope.session_id!,member.id,envelope.task_id);
        const subscription=this.subscriptions.get(key);
        if(subscription&&!isReadOnlyObservation(name,input))subscription.confirmedAt=0;
        this.subscribe(envelope.session_id!,member.id,nodeId,envelope.task_id);
      }
      return;
    }
    const mismatch = (message: string) => Object.assign(new Error(`TASK_REMOTE_SCOPE_MISMATCH: ${message}`),
      { code: "TASK_REMOTE_SCOPE_MISMATCH", effect: "unknown", retryHint: "query_original",
        details: { task_id: envelope.task_id, session_id: envelope.session_id, owner_node_id: nodeId } });
    const raw = result && typeof result === "object" && !Array.isArray(result) ? (result as JsonRecord).structuredContent : undefined;
    const structured = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as JsonRecord : undefined;
    if (!structured) {
      if (envelope.task_binding_version === 1) throw mismatch("The Worker omitted the captured Task and workspace identity.");
      return;
    }
    const sessionId = typeof structured.session_id === "string" ? structured.session_id : envelope.session_id;
    if (envelope.session_id && sessionId !== envelope.session_id
      || envelope.task_id && typeof structured.task_id === "string" && structured.task_id !== envelope.task_id
      || envelope.task_binding_version === 1 && (structured.task_id !== envelope.task_id || structured.session_id !== envelope.session_id
        || structured.node_id !== nodeId || typeof structured.workspace_id !== "string")) {
      // The Worker may already have performed workspace side effects. Preserve
      // the expected identity and report uncertainty; never adopt another Task.
      throw mismatch("The Worker returned a different Task or canonical storage identity.");
    }
    const metadata=(result as JsonRecord)._meta as JsonRecord|undefined;
    const identity=metadata?.quaymesh as JsonRecord|undefined;
    const memberId=typeof structured.member_id==="string"?structured.member_id:typeof identity?.member_id==="string"?identity.member_id:undefined;
    const workspaceId = typeof structured.workspace_id === "string" ? structured.workspace_id : envelope.workspace_id;
    const root = typeof structured.root === "string" ? structured.root : "";
    if (name === "open_workspace" || name === "attach_workspace") {
      if (!sessionId || !memberId || !workspaceId || !root) {
        if (envelope.task_binding_version === 1) throw mismatch("The Worker omitted the workspace member identity.");
        throw new Error("SESSION_FEED_RESULT_ID_INVALID");
      }
    } else if (!sessionId || !memberId || !workspaceId || !root) return;
    const mode = structured.mode === "worktree" ? "worktree" : "checkout";
    const handle = parseWorkspaceHandle(workspaceId), localWorkspaceId = handle?.local ?? workspaceId;
    const expected = envelope.workspace_id ? parseWorkspaceHandle(envelope.workspace_id) : undefined;
    const existingMember = this.store.findMember(sessionId, memberId);
    if (handle && handle.node !== nodeId || envelope.member_id && envelope.member_id !== memberId
      || envelope.workspace_id && localWorkspaceId !== (expected?.local ?? envelope.workspace_id)
      || existingMember && (existingMember.node_id !== nodeId || existingMember.workspace_id !== localWorkspaceId)) {
      throw mismatch("The Worker returned a different workspace member.");
    }
    this.store.adoptRemoteSession({
      id: sessionId,
      ownerId: envelope.owner_id,
      conversationId: envelope.task_binding_version === 1 ? envelope.canonical_conversation_id ?? null : envelope.conversation_id,
      title: envelope.session_title ?? "Federated session",
    });
    if (envelope.task_id) {
      await this.service.adoptTask(sessionId, envelope.task_id, envelope.task_title ?? envelope.session_title ?? "QuayMesh task", envelope.task_created_at, envelope.task_source_id);
    }
    const member = this.store.upsertRemoteMember({
      id: memberId,
      sessionId,
      nodeId,
      workspaceId: localWorkspaceId,
      // Remote paths belong to the Worker's filesystem. Keep the owner's known
      // canonical metadata until its feed refreshes it; an open reply can carry
      // a logical alias which the Coordinator cannot resolve on its own host.
      root: existingMember?.root ?? root,
      sourceRoot: typeof structured.source_root === "string" ? structured.source_root : null,
      mode,
      online: true,
      revision: 0,
    });
    if (envelope.task_id) this.store.touchTaskMember(envelope.task_id, member.id);
    this.subscribe(sessionId, member.id, nodeId, envelope.task_id);
    void name;
    void input;
  }

  /** Worker snapshots carry Task state; only the authority can describe this caller's live entry binding. */
  workspaceResultForEntry(result: unknown, extra: JsonRecord, taskId: string): unknown {
    if (!result || typeof result !== "object" || Array.isArray(result)) return result;
    const reply = result as JsonRecord, metadata = reply._meta as JsonRecord | undefined;
    const existing = metadata?.quaymesh as JsonRecord | undefined;
    const binding = taskBindingForRequest(this.store, extra, taskId, { federation: this.runtime.config });
    const snapshot = existing?.snapshot as Snapshot | undefined;
    return { ...reply, _meta: { ...metadata, quaymesh: { ...existing, task_binding: binding,
      ...(snapshot ? { snapshot: { ...snapshot, capabilities: { ...snapshot.capabilities, continue: binding.can_continue } } } : {}),
      ...(existing?.capabilities ? { capabilities: { ...(existing.capabilities as JsonRecord), continue: binding.can_continue } } : {}),
    } } };
  }

  async handleRequest(params: SessionFeedRequest, peerId: string, signal?: AbortSignal): Promise<unknown> {
    const deadline=Date.now()+TASK_REFRESH_TIMEOUT_MS;
    signal?.throwIfAborted();
    validateRequest(params);
    const session=this.store.getSession(params.session_id);
    const member=this.store.getMember(session.id,params.member_id);
    if(member.node_id!==this.runtime.localId)throw new Error(`SESSION_MEMBER_OWNER_MISMATCH: ${member.id}`);
    const task=params.task_id?this.store.getTask(params.task_id):null;
    if(task && task.session_id!==session.id)throw new Error("TASK_SESSION_MISMATCH");
    if(params.kind==="finalize"){
      if(!task || params.owner_id!==session.owner_id || !params.status || typeof params.summary!=="string")throw new Error("TASK_FINALIZATION_INVALID");
      if(this.runtime.config.coordinatorId && peerId!==this.runtime.config.coordinatorId)throw new Error("COORDINATOR_REQUIRED");
      const receipt = await this.service.finishOwnedTask(session.owner_id,task.id,params.status,params.summary);
      return taskReceiptForPeer(receipt, params);
    }
    if(params.kind==="archive"){
      if(!task||params.owner_id!==session.owner_id)throw new Error("TASK_ARCHIVE_INVALID");
      if(this.runtime.config.coordinatorId&&peerId!==this.runtime.config.coordinatorId)throw new Error("COORDINATOR_REQUIRED");
      const receipt = await this.service.archiveOwnedTask(session.owner_id,task.id);
      return taskReceiptForPeer(receipt, params);
    }
    const key=subscriptionKey(session.id,member.id,task?.id);
    if(params.kind==="unsubscribe"){
      const peers=this.subscribers.get(key);peers?.delete(peerId);
      if(!peers?.size)this.subscribers.delete(key);
      return null;
    }
    if(params.kind==="subscribe"){
      const peers=this.subscribers.get(key)??new Map<string,SnapshotReader>();
      peers.set(peerId,{command_identity:params.command_identity===true,file_recorded_at:params.file_recorded_at===true});
      this.subscribers.set(key,peers);
    }
    const update=(snapshot?:Snapshot,revision=snapshot?.rev??(task?this.store.getTask(task.id).revision:this.store.memberRevision(member.id))):SessionFeedUpdate=>({
      owner_id:session.owner_id,node_id:this.runtime.localId,session_id:session.id,member_id:member.id,
      ...(task?{task_id:task.id}:{}),
      revision, observed_at:new Date().toISOString(),...(snapshot?{snapshot}:{}),
      ...(task?{observation:this.projector.observeTask(task.id,member.id)}:{}),
    });
    if(params.kind==="revision")return update();
    if(params.kind==="subscribe"&&params.known_revision===(task?this.store.getTask(task.id).revision:this.store.memberRevision(member.id)))return update();
    const frozen=task?.state==="closed"?this.store.getTaskSnapshot(task.id,member.id):null;
    const cached=task?this.store.taskData.projection(task.id,member.id):this.store.getSnapshot(session.id,member.id);
    const currentRevision=task?this.store.getTask(task.id).revision:this.store.memberRevision(member.id);
    const snapshot=validateSnapshot(frozen&&frozen.revision>=task!.revision?frozen.snapshot
      :cached?.snapshot&&cached.revision===currentRevision?cached.snapshot
      :await this.projector.materialize(session.id,member.id,task?.id,{
        timeoutMs:Math.max(0,deadline-Date.now()),
        signal:signal?AbortSignal.any([signal,this.refreshController.signal]):this.refreshController.signal,
      })) as Snapshot;
    const selected = snapshotForPeer(snapshot, params);
    return update(params.kind==="subscribe"?compactSnapshot(selected):selected,snapshot.rev);
  }

  async receiveUpdate(value: unknown, peerId: string, deadline=Date.now()+TASK_REFRESH_TIMEOUT_MS): Promise<void> {
    const update=value as SessionFeedUpdate;validateUpdate(update);
    const key=subscriptionKey(update.session_id,update.member_id,update.task_id);
    const subscription=this.subscriptions.get(key);
    if(this.closed||!subscription||subscription.nodeId!==peerId)return;
    const session=this.store.requireSession(update.owner_id,update.session_id);
    const member=this.store.getMember(session.id,update.member_id);
    if(member.node_id!==peerId)throw new Error("SESSION_FEED_OWNER_MISMATCH");
    if(update.task_id && this.store.getTask(update.task_id).session_id!==session.id)throw new Error("TASK_SESSION_MISMATCH");
    if(update.revision<subscription.lastRevision)return;
    let received=update;
    while(!received.snapshot&&received.revision>subscription.lastRevision){
      const latest=await this.fetchSnapshot(key,subscription,deadline);
      if(this.closed)return;
      validateUpdate(latest);
      if(latest.revision<update.revision)continue;
      received=latest;
    }
    if(received.session_id!==session.id||received.member_id!==member.id||received.node_id!==peerId||
      received.task_id!==update.task_id||received.owner_id!==session.owner_id)throw new Error("SESSION_FEED_RESPONSE_MISMATCH");
    if(received.revision<subscription.lastRevision)return;
    const snapshot=received.snapshot?validateSnapshot(received.snapshot) as Snapshot:undefined;
    if(snapshot&&(snapshot.taskId??undefined)!==received.task_id)throw new Error("TASK_SNAPSHOT_ID_MISMATCH");
    const observation=received.observation??received.snapshot?.executionObservation;
    const remaining=deadline-Date.now();
    if(remaining<=0)throw new Error("SESSION_REFRESH_TIMEOUT");
    const saved=await this.store.writeAsync(()=>{
      // 等锁期间可能已有更新抵达，不能用旧响应回写快照、在线状态或观测。
      if(this.closed||this.subscriptions.get(key)!==subscription)return false;
      const cached=update.task_id?this.store.taskData.projection(update.task_id,member.id):this.store.getSnapshot(session.id,member.id);
      if(received.revision<Math.max(subscription.lastRevision,cached?.revision??-1))return false;
      if(snapshot)this.store.putRemoteSnapshot(session.id,member.id,received.revision,snapshot);
      if(update.task_id&&observation)this.store.taskData.observeProjection(update.task_id,member.id,observation);
      if(!update.task_id)this.store.setMemberRevision(member.id,received.revision);
      const current=this.store.getMember(session.id,member.id);
      this.store.setMemberPresence(member.id,true,new Date(Math.max(Date.parse(current.last_observed_at),Date.parse(received.observed_at))).toISOString());
      return true;
    },{timeoutMs:remaining,signal:this.refreshController.signal});
    if(!saved||this.closed||this.subscriptions.get(key)!==subscription)return;
    subscription.lastRevision=Math.max(subscription.lastRevision,received.revision);
    subscription.confirmedAt=Date.now();
    subscription.generation++;
    subscription.lastError=undefined;
    this.runtime.emit("change");
  }

  async onDisconnect(nodeId: string): Promise<void> {
    if(this.closed)return;
    for(const peers of this.subscribers.values())peers.delete(nodeId);
    const disconnected:Array<{key:string;subscription:RemoteSubscription;generation:number}>=[];
    for(const [key,subscription] of this.subscriptions){
      if(subscription.nodeId!==nodeId)continue;
      const member=this.store.findMember(subscription.sessionId,subscription.memberId);
      if(!member){this.subscriptions.delete(key);continue;}
      subscription.confirmedAt=0;
      disconnected.push({key,subscription,generation:subscription.generation});
    }
    if(!disconnected.length)return;
    const observedAt=new Date().toISOString();
    await this.store.writeAsync(()=>{
      for(const {key,subscription,generation} of disconnected){
        if(this.closed||this.subscriptions.get(key)!==subscription||subscription.generation!==generation)continue;
        this.store.setMemberPresence(subscription.memberId,false,observedAt);
      }
    },{timeoutMs:TASK_REFRESH_TIMEOUT_MS,signal:this.refreshController.signal});
    if(this.closed)return;
    this.runtime.emit("change");
  }

  async onReconnect(nodeId: string): Promise<void> {
    if(this.closed)return;
    const pending:Promise<void>[]=[];
    for(const [key,subscription] of this.subscriptions){
      if(subscription.nodeId!==nodeId)continue;
      if(!this.store.findMember(subscription.sessionId,subscription.memberId)){this.subscriptions.delete(key);continue;}
      subscription.confirmedAt=0;
      pending.push(this.refreshSubscription(key,subscription));
    }
    await Promise.all(pending);
  }

  async fetchDetail(toolName: string, input: JsonRecord, extra: JsonRecord): Promise<unknown | undefined> {
    if (sessionToolRoute(toolName) !== "member") return undefined;
    const member = this.memberForTool(toolName, input);
    if (!member) return detailUnavailable("member_not_found", null, null, null);
    if (member.member.node_id === this.runtime.localId) return undefined;
    if (!member.member.online) {
      return detailUnavailable("offline", member.member.id, member.member.node_id, member.member.last_observed_at);
    }
    const auth = extra.authInfo as { clientId?: string; extra?: Record<string, unknown> } | undefined;
    const ownerId = auth?.extra?.owner_id;
    const context = {
      _meta: extra._meta,
      requestId: extra.requestId,
      ...(typeof ownerId === "string" && ownerId.length > 0
        ? { authInfo: { ...(auth?.clientId ? { clientId: auth.clientId } : {}), extra: { owner_id: ownerId } } }
        : {}),
    };
    return this.runtime.request(member.member.node_id, "tool", { name: toolName, input, extra: context });
  }

  subscribe(sessionId: string, memberId: string, nodeId: string, taskId?: string): void {
    const key=subscriptionKey(sessionId,memberId,taskId);
    const subscription=this.ensureSubscription(sessionId,memberId,nodeId,taskId);
    if(subscription.confirmedAt&&Date.now()-subscription.confirmedAt<EXECUTION_OBSERVATION_TTL_MS&&!subscription.lastError)return;
    void this.refreshSubscription(key,subscription);
  }

  private ensureSubscription(sessionId:string,memberId:string,nodeId:string,taskId?:string):RemoteSubscription {
    const key=subscriptionKey(sessionId,memberId,taskId);
    const existing=this.subscriptions.get(key);
    if(existing?.nodeId===nodeId)return existing;
    const cached=taskId?this.store.taskData.projection(taskId,memberId):this.store.getSnapshot(sessionId,memberId);
    const subscription:RemoteSubscription={nodeId,sessionId,memberId,taskId,lastRevision:cached?.snapshot?cached.revision:-1,confirmedAt:0,generation:0};
    this.subscriptions.set(key,subscription);
    return subscription;
  }

  private async refreshTask(taskId:string,memberId?:string):Promise<void> {
    if(this.closed)return;
    const task=this.store.getTask(taskId);
    const ids=memberId?[memberId]:this.store.taskMemberIds(taskId);
    const pending:Promise<void>[]=[];
    for(const id of ids){
      const member=this.store.getMember(task.session_id,id);
      if(member.node_id===this.runtime.localId)continue;
      if(task.state==="closed"){
        const projection=this.store.taskData.projection(taskId,id);
        const frozen=this.store.getTaskSnapshot(taskId,id);
        const snapshot=projection&&projection.revision>(frozen?.revision??-1)?projection.snapshot:frozen?.snapshot;
        const observation=snapshot?.executionObservation;
        if(!observation?.activeOperationIds.length&&!observation?.preparingOperationIds.length&&!observation?.staleOperationIds.length
          &&!snapshot?.commands.some(command=>command.status==="run"||command.status==="queued")
          &&!snapshot?.agents.some(agent=>agent.state==="working"||agent.state==="queued"))continue;
      }
      const subscription=this.ensureSubscription(task.session_id,id,member.node_id,taskId);
      if(subscription.confirmedAt&&Date.now()-subscription.confirmedAt<EXECUTION_OBSERVATION_TTL_MS&&!subscription.lastError)continue;
      pending.push(this.refreshSubscription(subscriptionKey(task.session_id,id,taskId),subscription));
    }
    if(!pending.length)return;
    let timer:ReturnType<typeof setTimeout>;
    try {
      await Promise.race([Promise.all(pending),new Promise<void>(resolve=>{timer=setTimeout(resolve,TASK_REFRESH_WAIT_MS);})]);
    } finally {clearTimeout(timer!);}
  }

  private refreshSubscription(key:string,subscription:RemoteSubscription):Promise<void> {
    const existing=this.refreshing.get(key);
    if(existing)return existing;
    const generation=subscription.generation;
    const deadline=Date.now()+TASK_REFRESH_TIMEOUT_MS;
    const pending=this.runtime.request<SessionFeedUpdate>(subscription.nodeId,"session.feed",{
      kind:"subscribe",session_id:subscription.sessionId,member_id:subscription.memberId,
      known_revision:subscription.lastRevision,command_identity:true,file_recorded_at:true,...(subscription.taskId?{task_id:subscription.taskId}:{}),
    } satisfies SessionFeedRequest,TASK_REFRESH_TIMEOUT_MS,undefined,this.refreshController.signal)
      .then(update=>this.receiveUpdate(update,subscription.nodeId,deadline))
      .catch(async error=>{
        // 请求期间收到的新状态优先；较早请求的失败不能覆盖它。
        if(!this.closed&&this.subscriptions.get(key)===subscription&&subscription.generation===generation)await this.recordSubscriptionFailure(key,error,deadline);
      }).finally(()=>{if(this.refreshing.get(key)===pending)this.refreshing.delete(key);});
    this.refreshing.set(key,pending);
    return pending;
  }

  private async fetchSnapshot(key:string,subscription:RemoteSubscription,deadline:number):Promise<SessionFeedUpdate> {
    const remaining=deadline-Date.now();
    if(remaining<=0)throw new Error("SESSION_REFRESH_TIMEOUT");
    const existing=this.snapshots.get(key);
    if(existing){
      let timer:ReturnType<typeof setTimeout>;
      try {return await Promise.race([existing,new Promise<never>((_,reject)=>{
        timer=setTimeout(()=>reject(new Error("SESSION_REFRESH_TIMEOUT")),remaining);
      })]);}finally{clearTimeout(timer!);}
    }
    const pending=this.runtime.request<SessionFeedUpdate>(subscription.nodeId,"session.feed",{
      kind:"snapshot",session_id:subscription.sessionId,member_id:subscription.memberId,
      ...(subscription.taskId?{task_id:subscription.taskId}:{}),known_revision:subscription.lastRevision,command_identity:true,file_recorded_at:true,
    } satisfies SessionFeedRequest,remaining,undefined,this.refreshController.signal)
      .finally(()=>{if(this.snapshots.get(key)===pending)this.snapshots.delete(key);});
    this.snapshots.set(key,pending);
    return pending;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.refreshController.abort();
    this.projector.setRemoteTaskRefresher(undefined);
    clearInterval(this.observationTimer);
    this.disposeStore();
    for (const dispose of this.disposeSettlements) dispose();
    for (const timer of this.pendingPublishes.values()) clearTimeout(timer);
    this.pendingPublishes.clear();
    this.subscriptions.clear();
    this.refreshing.clear();
    this.snapshots.clear();
    this.subscribers.clear();
  }

  private publishObservations(): void {
    if(this.closed)return;
    for(const [key,peers] of this.subscribers){
      const [sessionId,memberId,taskId]=JSON.parse(key) as [string,string,string|null];
      if(!taskId||!peers.size)continue;
      const task=this.store.findTask(taskId),session=this.store.findSession(sessionId),member=this.store.findMember(sessionId,memberId);
      if(!task||!session||!member||member.node_id!==this.runtime.localId)continue;
      const observation=this.projector.observeTask(taskId,memberId);
      if(task.state==='closed'&&!observation.activeOperationIds.length&&!observation.preparingOperationIds.length&&!observation.staleOperationIds.length)continue;
      const update:SessionFeedUpdate={owner_id:session.owner_id,node_id:this.runtime.localId,session_id:sessionId,member_id:memberId,
        task_id:taskId,revision:task.revision,observed_at:new Date(observation.observedAt).toISOString(),observation};
      for(const peer of peers.keys())this.runtime.transport.links.get(peer)?.notify('session.feed.update',update);
    }
  }

  private publishLocalChange(sessionId: string, memberId: string, revision: number, taskId?: string): void {
    if(this.closed)return;
    const key=subscriptionKey(sessionId,memberId,taskId);
    const peers=this.subscribers.get(key);
    if(!peers?.size)return;
    const previous=this.pendingPublishes.get(key);if(previous)clearTimeout(previous);
    const timer=setTimeout(()=>{
      this.pendingPublishes.delete(key);
      const session=this.store.findSession(sessionId),member=this.store.findMember(sessionId,memberId);
      if(!session||!member||member.node_id!==this.runtime.localId)return;
      const sourceRevision=taskId?this.store.getTask(taskId).revision:this.store.memberRevision(memberId);
      const stored=taskId?this.store.taskData.projection(taskId,memberId):this.store.getSnapshot(sessionId,memberId);
      const snapshot=stored?.revision===sourceRevision?stored.snapshot:null;
      const update:SessionFeedUpdate={
        owner_id:session.owner_id,node_id:this.runtime.localId,session_id:sessionId,member_id:memberId,
        ...(taskId?{task_id:taskId}:{}),revision:sourceRevision,observed_at:new Date().toISOString(),
      };
      for(const [peerId,reader] of peers){
        const selected=snapshot?compactSnapshot(snapshotForPeer(snapshot,reader)):undefined;
        this.runtime.transport.links.get(peerId)?.notify("session.feed.update",{...update,...(selected?{snapshot:selected}:{})});
      }
    },0);
    timer.unref?.();this.pendingPublishes.set(key,timer);
    void revision;
  }

  subscriptionFailure(sessionId: string, memberId: string): string | null {
    return [...this.subscriptions.values()].find(value=>value.sessionId===sessionId&&value.memberId===memberId&&value.lastError)?.lastError??null;
  }

  private async recordSubscriptionFailure(key: string, error: unknown, deadline: number): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const subscription = this.subscriptions.get(key);
    if(!subscription)return;
    subscription.lastError=message;
    subscription.confirmedAt=0;
    const generation=subscription.generation;
    try {
      await this.store.writeAsync(()=>{
        if(this.closed||this.subscriptions.get(key)!==subscription||subscription.generation!==generation)return;
        if(subscription.taskId){
          const observation=this.store.taskData.projection(subscription.taskId,subscription.memberId)?.snapshot.executionObservation;
          if(observation)this.store.taskData.observeProjection(subscription.taskId,subscription.memberId,{...observation,stale:true});
        }
        this.store.markProjectionError(subscription.sessionId,subscription.memberId,message);
      },{timeoutMs:Math.max(0,deadline-Date.now()),signal:this.refreshController.signal});
    } catch(persistenceError) {
      if(this.closed)return;
      // 失败标记仍共享原截止时间；锁未释放时保留内存错误，不再同步等第二轮锁。
      const code=errorCode(persistenceError);
      if(code!=="SQLITE_BUSY"&&!code.startsWith("SQLITE_BUSY_"))this.runtime.emit("fault",persistenceError);
    }
    if(!this.closed)this.runtime.emit("change");
  }

  private memberForTool(toolName: string, input: JsonRecord): { sessionId: string; member: SessionMember } | undefined {
    const sessionId = typeof input.session_id === "string" ? input.session_id : undefined;
    const explicitMemberId = typeof input.member_id === "string" ? input.member_id : undefined;
    if (sessionId && explicitMemberId) {
      try {
        return { sessionId, member: this.store.getMember(sessionId, explicitMemberId) };
      } catch {
        return undefined;
      }
    }
    if (sessionId && toolName === "qm_file_diff") {
      const fileId = typeof input.file_id === "string" ? input.file_id : undefined;
      const hash = typeof input.hash === "string" ? input.hash : undefined;
      const file = this.store.fileSummariesForSession(sessionId)
        .find((candidate) => candidate.id === fileId && candidate.hash === hash);
      if (file) return this.memberInSession(sessionId, file.member_id);
    }
    if (sessionId && toolName === "qm_command_output") {
      const commandId = typeof input.command_id === "string" ? input.command_id : undefined;
      const event = this.store.eventsForSession(sessionId).find((candidate) => {
        if (candidate.type !== "operation_started" && candidate.type !== "operation_finished") return false;
        const operationId = String(candidate.payload.operation_id ?? candidate.source_id);
        const command = String(candidate.payload.command_id ?? operationId);
        return operationId === commandId || command === commandId;
      });
      if (event) return this.memberInSession(sessionId, event.member_id);
    }
    if (sessionId && toolName === "qm_instruction") {
      const path = typeof input.path === "string" ? input.path : undefined;
      const read = this.store.contextReads(sessionId).find((candidate) => candidate.path === path);
      if (read) return this.memberInSession(sessionId, read.member_id);
    }
    return this.memberForInput(input);
  }

  private memberInSession(sessionId: string, memberId: string): { sessionId: string; member: SessionMember } | undefined {
    try {
      return { sessionId, member: this.store.getMember(sessionId, memberId) };
    } catch {
      return undefined;
    }
  }

  private memberForInput(input: JsonRecord): { sessionId: string; member: SessionMember } | undefined {
    if (typeof input.session_id === "string" && typeof input.member_id === "string") {
      try {
        return { sessionId: input.session_id, member: this.store.getMember(input.session_id, input.member_id) };
      } catch {
        return undefined;
      }
    }
    if (typeof input.session_id === "string") {
      try {
        const session = this.store.getSession(input.session_id);
        const member = session.members.find((candidate) => candidate.id === session.selected_member_id) ?? session.members[0];
        return member ? { sessionId: session.id, member } : undefined;
      } catch {
        return undefined;
      }
    }
    if (typeof input.workspace_id === "string") {
      const handle = parseWorkspaceHandle(input.workspace_id);
      const candidates = this.store.membersByWorkspaceIds(handle
        ? [input.workspace_id, handle.local]
        : [input.workspace_id]);
      for (const candidate of candidates) {
        if (!handle || candidate.member.node_id === handle.node) return candidate;
      }
    }
    return undefined;
  }

  private notifyLocalProjection(sessionId: string, memberId: string): void {
    void sessionId;void memberId;
    this.runtime.emit("change");
  }
}

function invocationId(ownerId: string, transport: string, requestId: string, toolName: string): string {
  return "inv_" + createHash("sha256").update(JSON.stringify([ownerId, transport, requestId, toolName])).digest("hex").slice(0, 32);
}

function conversationId(extra: JsonRecord): string | null {
  const meta = extra._meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const value = (meta as Record<string, unknown>)["openai/session"];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function compactSnapshot(snapshot: Snapshot): Snapshot | undefined {
  return Buffer.byteLength(JSON.stringify(snapshot)) <= 64 * 1024 ? snapshot : undefined;
}

function snapshotForPeer(snapshot: Snapshot, reader: SnapshotReader): Snapshot {
  const compatible = { ...snapshot, files: filesForReader(snapshot.files, reader.file_recorded_at === true) };
  if (reader.command_identity === true) return compatible;
  const legacyCommand = ({invocation_id: _invocation, effect: _effect, ...command}: Snapshot["commands"][number]) => command;
  return {
    ...compatible,
    commands: snapshot.commands.map(legacyCommand),
    ...(snapshot.currentCommand ? {currentCommand: legacyCommand(snapshot.currentCommand)} : {}),
    ...(snapshot.runningCommand ? {runningCommand: legacyCommand(snapshot.runningCommand)} : {}),
    ...(snapshot.lastCommand ? {lastCommand: legacyCommand(snapshot.lastCommand)} : {}),
  };
}

function taskReceiptForPeer(receipt: TaskOwnerReceipt, reader: SnapshotReader): TaskOwnerReceipt {
  return {...receipt,
    snapshots: receipt.snapshots.map(value => ({...value, snapshot: snapshotForPeer(value.snapshot, reader),
      files: filesForReader(value.files, reader.file_recorded_at === true)})),
  };
}

function detailUnavailable(
  reason: "member_not_found" | "offline",
  memberId: string | null,
  nodeId: string | null,
  lastObservedAt: string | null,
): Record<string, unknown> {
  const message = reason === "offline"
    ? `Remote member is offline. Last observed at ${lastObservedAt ?? "unknown"}.`
    : "The session member that owns this detail no longer exists.";
  return {
    isError: true,
    content: [{ type: "text", text: message }],
    structuredContent: {
      unavailable: true,
      reason,
      member_id: memberId,
      node_id: nodeId,
      last_observed_at: lastObservedAt,
    },
  };
}

function validateRequest(value: unknown): asserts value is SessionFeedRequest {
  if (!value || typeof value !== "object") throw new Error("SESSION_FEED_REQUEST_INVALID");
  const request = value as Record<string, unknown>;
  if (!["subscribe", "revision", "snapshot", "unsubscribe", "finalize", "archive"].includes(String(request.kind))) {
    throw new Error("SESSION_FEED_KIND_INVALID");
  }
  if (typeof request.session_id !== "string" || typeof request.member_id !== "string") {
    throw new Error("SESSION_FEED_ID_INVALID");
  }
}

function validateUpdate(value: unknown): asserts value is SessionFeedUpdate {
  if (!value || typeof value !== "object") throw new Error("SESSION_FEED_UPDATE_INVALID");
  const update = value as Record<string, unknown>;
  if (
    typeof update.owner_id !== "string" ||
    typeof update.node_id !== "string" ||
    typeof update.session_id !== "string" ||
    typeof update.member_id !== "string" ||
    typeof update.revision !== "number" ||
    !Number.isSafeInteger(update.revision) ||
    update.revision < 0 ||
    typeof update.observed_at !== "string" || !Number.isFinite(Date.parse(update.observed_at))
  ) {
    throw new Error("SESSION_FEED_UPDATE_INVALID");
  }
  if(update.observation!==undefined)executionObservationSchema.parse(update.observation);
}

function subscriptionKey(sessionId:string,memberId:string,taskId?:string):string {return JSON.stringify([sessionId,memberId,taskId??null]);}
