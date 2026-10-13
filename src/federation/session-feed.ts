import { createHash } from "node:crypto";
import { sessionRequestIdentity } from "../request-meta.js";
import type { SessionProjector } from "../session/projection.js";
import type { SessionService, TaskOwnerReceipt } from "../session/service.js";
import type { SessionStore } from "../session/store.js";
import { validateSnapshot } from "../session/schema.js";
import { HostState, type SessionMember, type Snapshot } from "../session/types.js";
import type { FederationRuntime } from "./runtime.js";
import type { PeerLink } from "./transport.js";
import type { JsonRecord } from "./types.js";
import { parseWorkspaceHandle } from "./routing.js";
import type { SessionFeedRequest, SessionFeedUpdate, TrustedInvocationEnvelope } from "./session-types.js";

interface RemoteSubscription {
  nodeId: string;
  sessionId: string;
  memberId: string;
  taskId?: string;
  lastRevision: number;
  lastError?: string;
}

export class SessionFeed {
  private readonly subscriptions = new Map<string, RemoteSubscription>();
  private readonly pendingPublishes = new Map<string, NodeJS.Timeout>();
  private readonly subscribers = new Map<string, Set<string>>();
  private readonly disposeStore: () => void;
  private readonly disposeSettlements: Array<() => void> = [];
  private closed = false;

  constructor(
    private readonly runtime: FederationRuntime,
    private readonly store: SessionStore,
    private readonly projector: SessionProjector,
    private readonly service: SessionService,
  ) {
    this.disposeStore = store.onChange((change) => {
      const member = store.getMember(change.sessionId, change.memberId);
      if (member.node_id !== runtime.localId) return;
      this.publishLocalChange(change.sessionId, change.memberId, change.revision, change.taskId);
    });
    const onOffline = (nodeId: string) => { void this.onDisconnect(nodeId).catch(error=>runtime.emit("fault",error)); };
    const onOnline = (link: PeerLink) => { void this.onReconnect(link.peerId).catch(error=>runtime.emit("fault",error)); };
    runtime.transport.on("offline", onOffline);
    runtime.transport.on("online", onOnline);
    this.disposeSettlements.push(() => runtime.transport.off("offline", onOffline));
    this.disposeSettlements.push(() => runtime.transport.off("online", onOnline));
    runtime.setSessionFeed(this);
    service.setRemoteFinalizer(async (task,status,summary) => {
      const session=store.getSession(task.session_id);
      const members=store.taskMemberIds(task.id).map(id=>store.getMember(session.id,id)).filter(member=>member.node_id!==runtime.localId);
      const nodes=[...new Set(members.map(member=>member.node_id))];
      return Promise.all(nodes.map(async nodeId => {
        const member=members.find(candidate=>candidate.node_id===nodeId)!;
        const receipt=await runtime.request<TaskOwnerReceipt>(nodeId,"session.feed",{
          kind:"finalize",session_id:session.id,member_id:member.id,task_id:task.id,
          owner_id:session.owner_id,status,summary,
        } satisfies SessionFeedRequest);
        if(receipt.taskId!==task.id || receipt.nodeId!==nodeId || !Array.isArray(receipt.snapshots))throw new Error("TASK_OWNER_RECEIPT_INVALID");
        return receipt;
      }));
    });
    service.setRemoteArchiver(async task=>{
      const session=store.getSession(task.session_id);
      const members=store.taskMemberIds(task.id).map(id=>store.getMember(session.id,id)).filter(member=>member.node_id!==runtime.localId);
      const nodes=[...new Set(members.map(member=>member.node_id))];
      return Promise.all(nodes.map(async nodeId=>{
        const member=members.find(candidate=>candidate.node_id===nodeId)!;
        return runtime.request<TaskOwnerReceipt>(nodeId,"session.feed",{
          kind:"archive",session_id:session.id,member_id:member.id,task_id:task.id,owner_id:session.owner_id,
        } satisfies SessionFeedRequest);
      }));
    });
  }

  routeNodeFor(input: JsonRecord): string | undefined {
    const member = this.memberForInput(input);
    return member?.member.node_id;
  }

  trustedInvocation(name: string, input: JsonRecord, extra: JsonRecord): TrustedInvocationEnvelope | undefined {
    const auth = extra.authInfo as { extra?: Record<string, unknown> } | undefined;
    const ownerId = auth?.extra?.owner_id;
    if (typeof ownerId !== "string" || ownerId.length === 0) return undefined;
    const conversation = conversationId(extra);
    const identity = sessionRequestIdentity(extra);
    const current = typeof input.session_id === "string"
      ? this.store.requireSession(ownerId, input.session_id)
      : conversation ? this.store.findByConversation(ownerId, conversation) : null;
    const handle = typeof input.workspace_id === "string" ? parseWorkspaceHandle(input.workspace_id) : undefined;
    const found = current?.members.find((candidate) => candidate.id === input.member_id
      || (candidate.workspace_id === (handle?.local ?? input.workspace_id) && (!handle || candidate.node_id === handle.node)));
    const member = found && current ? { sessionId: current.id, member: found } : undefined;
    const sessionId = typeof input.session_id === "string"
      ? input.session_id
      : member?.sessionId
        ?? (conversation ? this.store.findByConversation(ownerId, conversation)?.id : undefined);
    const memberId = typeof input.member_id === "string" ? input.member_id : member?.member.id;
    if (!sessionId && name !== "open_workspace") return undefined;
    if (!memberId && name !== "open_workspace" && name !== "attach_workspace") return undefined;
    const requestedTaskId=typeof input.task_id==="string"?input.task_id:identity.task_id;
    const task = sessionId ? requestedTaskId ? this.store.getTask(requestedTaskId) : this.store.currentTask(sessionId) : null;
    return {
      invocation_id: invocationId(ownerId, identity.transport_instance_id, String(identity.request_id), name),
      owner_id: ownerId,
      conversation_id: conversation,
      transport_instance_id: identity.transport_instance_id,
      request_id: String(identity.request_id),
      ...(sessionId ? { session_id: sessionId } : {}),
      ...(current?.title ? { session_title: current.title } : {}),
      ...(task ? { task_id: task.id, task_title: task.title, task_created_at: task.created_at, ...(task.source_task_id ? {task_source_id:task.source_task_id} : {}) } : {}),
      ...(memberId ? { member_id: memberId } : {}),
      ...(typeof input.workspace_id === "string" || member?.member.workspace_id
        ? { workspace_id: typeof input.workspace_id === "string" ? input.workspace_id : member!.member.workspace_id }
        : {}),
      actor: "model",
    };
  }

  async prepareLocalTool(name: string, input: JsonRecord, envelope: TrustedInvocationEnvelope | undefined): Promise<void> {
    if (!envelope) return;
    const sessionId = typeof input.session_id === "string" ? input.session_id : envelope.session_id;
    if (!sessionId) return;
    this.store.adoptRemoteSession({
      id: sessionId,
      ownerId: envelope.owner_id,
      conversationId: envelope.conversation_id,
      title: envelope.session_title ?? "Federated session",
    });
    if (envelope.task_id) {
      await this.service.adoptTask(sessionId, envelope.task_id, envelope.task_title ?? envelope.session_title ?? "QuayMesh task", envelope.task_created_at, envelope.task_source_id);
    }
    void name;
  }

  async afterRemoteResult(
    name: string,
    input: JsonRecord,
    result: unknown,
    nodeId: string,
    envelope: TrustedInvocationEnvelope | undefined,
  ): Promise<void> {
    if (!envelope || nodeId === this.runtime.localId) return;
    const structured = result && typeof result === "object" && !Array.isArray(result)
      ? (result as JsonRecord).structuredContent as JsonRecord | undefined
      : undefined;
    if (!structured) return;
    const sessionId = typeof structured.session_id === "string" ? structured.session_id : envelope.session_id;
    const metadata=(result as JsonRecord)._meta as JsonRecord|undefined;
    const identity=metadata?.quaymesh as JsonRecord|undefined;
    const memberId=typeof structured.member_id==="string"?structured.member_id:typeof identity?.member_id==="string"?identity.member_id:undefined;
    const workspaceId = typeof structured.workspace_id === "string" ? structured.workspace_id : envelope.workspace_id;
    const root = typeof structured.root === "string" ? structured.root : "";
    if (name === "open_workspace" || name === "attach_workspace") {
      if (!sessionId || !memberId || !workspaceId || !root) throw new Error("SESSION_FEED_RESULT_ID_INVALID");
    } else if (!sessionId || !memberId || !workspaceId || !root) return;
    const mode = structured.mode === "worktree" ? "worktree" : "checkout";
    const localWorkspaceId = parseWorkspaceHandle(workspaceId)?.local ?? workspaceId;
    this.store.adoptRemoteSession({
      id: sessionId,
      ownerId: envelope.owner_id,
      conversationId: envelope.conversation_id,
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
      root,
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

  async handleRequest(params: SessionFeedRequest, peerId: string): Promise<unknown> {
    validateRequest(params);
    const session=this.store.getSession(params.session_id);
    const member=this.store.getMember(session.id,params.member_id);
    if(member.node_id!==this.runtime.localId)throw new Error(`SESSION_MEMBER_OWNER_MISMATCH: ${member.id}`);
    const task=params.task_id?this.store.getTask(params.task_id):null;
    if(task && task.session_id!==session.id)throw new Error("TASK_SESSION_MISMATCH");
    if(params.kind==="finalize"){
      if(!task || params.owner_id!==session.owner_id || !params.status || typeof params.summary!=="string")throw new Error("TASK_FINALIZATION_INVALID");
      if(this.runtime.config.coordinatorId && peerId!==this.runtime.config.coordinatorId)throw new Error("COORDINATOR_REQUIRED");
      return this.service.finishOwnedTask(session.owner_id,task.id,params.status,params.summary);
    }
    if(params.kind==="archive"){
      if(!task||params.owner_id!==session.owner_id)throw new Error("TASK_ARCHIVE_INVALID");
      if(this.runtime.config.coordinatorId&&peerId!==this.runtime.config.coordinatorId)throw new Error("COORDINATOR_REQUIRED");
      return this.service.archiveOwnedTask(session.owner_id,task.id);
    }
    const key=subscriptionKey(session.id,member.id,task?.id);
    if(params.kind==="unsubscribe"){
      const peers=this.subscribers.get(key);peers?.delete(peerId);
      if(!peers?.size)this.subscribers.delete(key);
      return null;
    }
    if(params.kind==="subscribe"){
      const peers=this.subscribers.get(key)??new Set<string>();peers.add(peerId);this.subscribers.set(key,peers);
    }
    const update=(snapshot?:Snapshot):SessionFeedUpdate=>({
      owner_id:session.owner_id,node_id:this.runtime.localId,session_id:session.id,member_id:member.id,
      ...(task?{task_id:task.id}:{}),
      revision:task?this.store.getTask(task.id).revision:this.store.memberRevision(member.id),
      observed_at:new Date().toISOString(),...(snapshot?{snapshot}:{})
    });
    if(params.kind==="revision")return update();
    const frozen=task?.state==="closed"?this.store.getTaskSnapshot(task.id,member.id)?.snapshot:null;
    const snapshot=validateSnapshot(frozen??await this.projector.materialize(session.id,member.id,task?.id)) as Snapshot;
    return update(params.kind==="subscribe"?compactSnapshot(snapshot):snapshot);
  }

  async receiveUpdate(value: unknown, peerId: string): Promise<void> {
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
    if(!received.snapshot&&received.revision>subscription.lastRevision){
      received=await this.runtime.request<SessionFeedUpdate>(peerId,"session.feed",{
        kind:"snapshot",session_id:session.id,member_id:member.id,
        ...(update.task_id?{task_id:update.task_id}:{}),known_revision:subscription.lastRevision,
      } satisfies SessionFeedRequest);
      if(this.closed)return;
      validateUpdate(received);
    }
    if(received.session_id!==session.id||received.member_id!==member.id||received.node_id!==peerId||
      received.task_id!==update.task_id||received.owner_id!==session.owner_id)throw new Error("SESSION_FEED_RESPONSE_MISMATCH");
    if(received.revision<subscription.lastRevision)return;
    if(received.snapshot){
      const snapshot=validateSnapshot(received.snapshot) as Snapshot;
      if((snapshot.taskId??undefined)!==received.task_id)throw new Error("TASK_SNAPSHOT_ID_MISMATCH");
      this.store.putRemoteSnapshot(session.id,member.id,received.revision,snapshot);
    }
    if(!update.task_id)this.store.setMemberRevision(member.id,received.revision);
    this.store.setMemberPresence(member.id,true,received.observed_at);
    subscription.lastRevision=Math.max(subscription.lastRevision,received.revision);
    subscription.lastError=undefined;
    this.runtime.emit("change");
  }

  async onDisconnect(nodeId: string): Promise<void> {
    if(this.closed)return;
    for(const peers of this.subscribers.values())peers.delete(nodeId);
    for(const [key,subscription] of this.subscriptions){
      if(subscription.nodeId!==nodeId)continue;
      const member=this.store.findMember(subscription.sessionId,subscription.memberId);
      if(!member){this.subscriptions.delete(key);continue;}
      this.store.setMemberPresence(member.id,false,new Date().toISOString());
    }
    this.runtime.emit("change");
  }

  async onReconnect(nodeId: string): Promise<void> {
    if(this.closed)return;
    for(const [key,subscription] of this.subscriptions){
      if(subscription.nodeId!==nodeId)continue;
      if(!this.store.findMember(subscription.sessionId,subscription.memberId)){this.subscriptions.delete(key);continue;}
      try {
        const update=await this.runtime.request<SessionFeedUpdate>(nodeId,"session.feed",{
          kind:"subscribe",session_id:subscription.sessionId,member_id:subscription.memberId,
          ...(subscription.taskId?{task_id:subscription.taskId}:{}),
        } satisfies SessionFeedRequest);
        await this.receiveUpdate(update,nodeId);
      } catch(error){this.recordSubscriptionFailure(key,error);}
    }
  }

  async fetchDetail(toolName: string, input: JsonRecord, extra: JsonRecord): Promise<unknown | undefined> {
    if (![
      "qm_file_diff",
      "qm_command_output",
      "qm_command_outputs",
      "qm_instruction",
      "qm_patch",
      "qm_revert",
      "qm_file_url",
      "qm_session_continue",
    ].includes(toolName)) return undefined;
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
    const existing=this.subscriptions.get(key);
    if(existing?.nodeId===nodeId)return;
    this.subscriptions.set(key,{nodeId,sessionId,memberId,taskId,lastRevision:-1});
    void this.runtime.request<SessionFeedUpdate>(nodeId,"session.feed",{
      kind:"subscribe",session_id:sessionId,member_id:memberId,...(taskId?{task_id:taskId}:{}),
    } satisfies SessionFeedRequest).then(update=>this.receiveUpdate(update,nodeId)).catch(error=>{
      if(!this.closed)this.recordSubscriptionFailure(key,error);
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.disposeStore();
    for (const dispose of this.disposeSettlements) dispose();
    for (const timer of this.pendingPublishes.values()) clearTimeout(timer);
    this.pendingPublishes.clear();
    this.subscriptions.clear();
    this.subscribers.clear();
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
        ...(snapshot&&compactSnapshot(snapshot)?{snapshot}:{})
      };
      for(const peerId of peers)this.runtime.transport.links.get(peerId)?.notify("session.feed.update",update);
    },0);
    timer.unref?.();this.pendingPublishes.set(key,timer);
    void revision;
  }

  subscriptionFailure(sessionId: string, memberId: string): string | null {
    return [...this.subscriptions.values()].find(value=>value.sessionId===sessionId&&value.memberId===memberId&&value.lastError)?.lastError??null;
  }

  private recordSubscriptionFailure(key: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const subscription = this.subscriptions.get(key);
    if (subscription) subscription.lastError = message;
    const { sessionId, memberId } = splitSubscriptionKey(key);
    this.store.markProjectionError(sessionId, memberId, message);
    this.runtime.emit("change");
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
    typeof update.observed_at !== "string"
  ) {
    throw new Error("SESSION_FEED_UPDATE_INVALID");
  }
}

function subscriptionKey(sessionId:string,memberId:string,taskId?:string):string {return JSON.stringify([sessionId,memberId,taskId??null]);}

function splitSubscriptionKey(key:string):{sessionId:string;memberId:string;taskId?:string}{const [sessionId,memberId,taskId]=JSON.parse(key) as [string,string,string|null];return {sessionId,memberId,...(taskId?{taskId}:{})};}
