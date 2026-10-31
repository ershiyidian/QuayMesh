import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { runSqliteWrite } from "../db/async-write.js";
import { REPLY_BYTES } from "../bounded-reply.js";
import { toolResultBytes } from "../mcp-tool-result.js";
import { taskActivityView } from "../task-view.js";
import { finalizationBlocksNewWork, type FinalizationFence } from "../session/task-finalization.js";
import { TaskAccessResolver, type TaskOwnerSource, type TaskPrincipal } from "../tasks/task-access.js";
import { taskMessageBodyFits } from "./task-message-types.js";

export type TaskPeerCapability = "peer:send" | "peer:read" | "peer:ack";
/** Supplied by the credential verifier, never parsed from request JSON. The
 * principal has the existing authenticated Symbol and assertCurrent is a
 * synchronous authorization check against the current persisted grant. */
export interface TaskPeerGrant {
  readonly principal: TaskPrincipal;
  readonly clientId: string;
  readonly grantId: string;
  readonly sourceTaskId: string | null;
  /** Verified persisted peer scope, not request input. Null is owner-wide;
   * optional only for existing in-process grant adapters. */
  readonly peerTaskIds?: readonly string[] | null;
  assertCurrent(capability: TaskPeerCapability, taskIds: readonly string[]): void;
}
export interface TaskPeerActivity {
  taskId: string;
  executionStatus: string;
  lastProgressAt: number | null;
  executionObservedAt: number | null;
  stale?: boolean;
}
/** Resolve actual Task progress and owner execution observations. An HTTP/cache
 * receive time or peer traffic must never populate either activity timestamp. */
export type TaskPeerActivityResolver = (taskIds: readonly string[]) => Promise<readonly TaskPeerActivity[]>;

export const MAX_TASK_PEER_BATCH = 8;
export const MAX_TASK_PEER_SOURCE_PER_MINUTE = 12;
export const MAX_TASK_PEER_TARGET_PER_MINUTE = 24;
const MESSAGE_BUDGET = REPLY_BYTES - 2 * 1024;

export interface TaskPeerMessage {
  id: string;
  role: "task";
  sourceTaskId: string;
  targetTaskId: string;
  sequence: number;
  body: string;
  replyTo: string | null;
  createdAt: string;
  acknowledgedAt: string | null;
}
export interface TaskPeerPage {
  deliveryId: string | null;
  messages: TaskPeerMessage[];
  nextSequence: number;
  hasMore: boolean;
  replayed: boolean;
}
interface MessageRow {
  id: string; source_task_id: string; target_task_id: string; sequence: number;
  body: string; reply_to_id: string | null; created_at: string; acknowledged_at: string | null;
}
interface DeliveryRow {
  id: string; task_id: string; receiver_client_id: string; request_key: string;
  after_sequence: number; page_limit: number; message_ids_json: string;
  next_sequence: number; has_more: number;
}
function failure(code: string, details?: Record<string, unknown>): Error {
  return Object.assign(new Error(code), { code, effect: "not_started", ...(details ? { details } : {}) });
}
function identifier(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 256) throw failure("TASK_PEER_INVALID_ID");
}
function view(row: MessageRow): TaskPeerMessage {
  return { id: row.id, role: "task", sourceTaskId: row.source_task_id, targetTaskId: row.target_task_id,
    sequence: row.sequence, body: row.body, replyTo: row.reply_to_id,
    createdAt: row.created_at, acknowledgedAt: row.acknowledged_at };
}
function fits(messages: TaskPeerMessage[]): boolean {
  return toolResultBytes({ content: [], structuredContent: { messages } }) <= MESSAGE_BUDGET;
}

/** Isolated peer inbox. No operation, Task entry, lifecycle, activity timestamp,
 * user-message row or user acknowledgement is created by these methods. */
export class TaskPeerMailboxStore {
  private readonly access: TaskAccessResolver;
  private readonly now: () => number;
  constructor(private readonly db: Database.Database, private readonly options: {
    ownerSource: TaskOwnerSource;
    activityResolver: TaskPeerActivityResolver;
    now?: () => number;
  }) {
    this.access = new TaskAccessResolver(db, options);
    this.now = options.now ?? Date.now;
  }

  async send(grant: TaskPeerGrant, input: {
    targetTaskId: string; messageKey: string; body: string; replyTo?: string;
  }): Promise<{message: TaskPeerMessage; replayed: boolean}> {
    const source = this.source(grant);
    identifier(input.targetTaskId); identifier(input.messageKey);
    if (source === input.targetTaskId) throw failure("TASK_PEER_SELF_MESSAGE");
    if (input.replyTo !== undefined) identifier(input.replyTo);
    if (typeof input.body !== "string" || !taskMessageBodyFits(input.body)) throw failure("TASK_PEER_INVALID_BODY");
    const tasks = [source,input.targetTaskId];
    const existing = this.db.transaction(() => {
      this.authorize(grant,"peer:send",tasks);
      return this.prior(grant,source,input);
    }).deferred();
    if (existing) return {message:view(existing),replayed:true};
    // Do not hold a SQLite transaction while observing another node. Both
    // authorization and the observation deadlines are rechecked after locking.
    const observations = await this.options.activityResolver(tasks);
    return runSqliteWrite(this.db, () => {
      this.authorize(grant,"peer:send",tasks);
      const repeated = this.prior(grant,source,input);
      if (repeated) return {message:view(repeated),replayed:true};
      const at = this.now();
      for (const taskId of tasks) {
        this.requireActive(taskId);
        const matches = observations.filter(item => item.taskId === taskId);
        if (matches.length !== 1 || !taskActivityView({requestState:"active",execution:matches[0].executionStatus,
          lastProgressAt:matches[0].lastProgressAt,executionObservedAt:matches[0].executionObservedAt,
          stale:matches[0].stale,now:at}).current) throw failure("TASK_PEER_TASK_INACTIVE",{taskId});
      }
      if (input.replyTo) {
        const original = this.message(input.replyTo);
        if (!original || original.source_task_id !== input.targetTaskId || original.target_task_id !== source)
          throw failure("TASK_PEER_REPLY_SCOPE_MISMATCH");
      }
      this.rateLimit(source,input.targetTaskId,at);
      const sequence = (this.db.prepare("SELECT COALESCE(MAX(sequence),0) FROM qm_task_peer_messages WHERE target_task_id=?")
        .pluck().get(input.targetTaskId) as number) + 1;
      const row: MessageRow = {id:`peer_${randomUUID()}`,source_task_id:source,target_task_id:input.targetTaskId,
        sequence,body:input.body,reply_to_id:input.replyTo ?? null,created_at:new Date(at).toISOString(),acknowledged_at:null};
      if (!fits([view(row)])) throw failure("TASK_PEER_BATCH_LIMIT");
      this.db.prepare(`INSERT INTO qm_task_peer_messages
        (id,source_task_id,target_task_id,sequence,sender_client_id,sender_grant_id,message_key,body,reply_to_id,created_at,created_at_ms)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(row.id,source,input.targetTaskId,sequence,grant.clientId,grant.grantId,
          input.messageKey,input.body,row.reply_to_id,row.created_at,at);
      return {message:view(row),replayed:false};
    });
  }

  async receive(grant: TaskPeerGrant, input: {requestKey: string; afterSequence?: number; limit?: number}): Promise<TaskPeerPage> {
    const target = this.source(grant), after = input.afterSequence ?? 0, limit = input.limit ?? 4;
    identifier(input.requestKey);
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_TASK_PEER_BATCH)
      throw failure("TASK_PEER_INVALID_PAGE");
    return runSqliteWrite(this.db, () => {
      this.authorize(grant,"peer:read",[target]);
      const previous = this.db.prepare(`SELECT * FROM qm_task_peer_deliveries
        WHERE task_id=? AND receiver_client_id=? AND request_key=?`).get(target,grant.clientId,input.requestKey) as DeliveryRow | undefined;
      if (previous) {
        if (previous.after_sequence !== after || previous.page_limit !== limit) throw failure("TASK_PEER_IDEMPOTENCY_CONFLICT");
        const rows = this.deliveryRows(previous);
        this.authorize(grant,"peer:read",[target,...rows.map(row=>row.source_task_id)]);
        const messages = rows.map(view);
        if (!fits(messages)) throw failure("TASK_PEER_BATCH_LIMIT");
        return {deliveryId:previous.id,messages,nextSequence:previous.next_sequence,hasMore:Boolean(previous.has_more),replayed:true};
      }
      // Filter before pagination: an out-of-scope sender must not block later
      // permitted inbox messages. Authorization above revalidates the grant;
      // each selected source is still checked against current permissions below.
      const sources = grant.peerTaskIds;
      const sourceFilter = sources ? sources.length
        ? `AND source_task_id IN (${sources.map(()=>"?").join(",")})` : "AND 0" : "";
      const candidates = this.db.prepare(`SELECT * FROM qm_task_peer_messages
        WHERE target_task_id=? AND sequence>? ${sourceFilter} ORDER BY sequence LIMIT ?`)
        .all(target,after,...(sources ?? []),limit+1) as MessageRow[];
      const rows: MessageRow[] = [];
      for (const row of candidates.slice(0,limit)) {
        if (!fits([...rows,row].map(view))) break;
        rows.push(row);
      }
      if (candidates.length && !rows.length) throw failure("TASK_PEER_BATCH_LIMIT");
      this.authorize(grant,"peer:read",[target,...rows.map(row=>row.source_task_id)]);
      const nextSequence = rows.at(-1)?.sequence ?? after, hasMore = candidates.length > rows.length;
      // Empty polling stores no receipt or Task activity. A later empty-poll
      // retry may observe new data; nonempty deliveries have immutable identity.
      if (!rows.length) return {deliveryId:null,messages:[],nextSequence,hasMore:false,replayed:false};
      const id = `peerdelivery_${randomUUID()}`;
      this.db.prepare(`INSERT INTO qm_task_peer_deliveries
        (id,task_id,receiver_client_id,receiver_grant_id,request_key,after_sequence,page_limit,message_ids_json,next_sequence,has_more,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id,target,grant.clientId,grant.grantId,input.requestKey,after,limit,
          JSON.stringify(rows.map(row=>row.id)),nextSequence,hasMore ? 1 : 0,new Date(this.now()).toISOString());
      return {deliveryId:id,messages:rows.map(view),nextSequence,hasMore,replayed:false};
    });
  }

  async ack(grant: TaskPeerGrant, input: {deliveryId: string; messageIds: string[]}): Promise<{acknowledged: number; replayed: boolean}> {
    const target = this.source(grant);
    identifier(input.deliveryId);
    if (!Array.isArray(input.messageIds) || !input.messageIds.length || input.messageIds.length > MAX_TASK_PEER_BATCH
      || new Set(input.messageIds).size !== input.messageIds.length) throw failure("TASK_PEER_INVALID_ACK");
    input.messageIds.forEach(identifier);
    return runSqliteWrite(this.db, () => {
      this.authorize(grant,"peer:ack",[target]);
      const delivery = this.db.prepare(`SELECT * FROM qm_task_peer_deliveries WHERE id=? AND task_id=? AND receiver_client_id=?`)
        .get(input.deliveryId,target,grant.clientId) as DeliveryRow | undefined;
      if (!delivery) throw failure("TASK_PEER_DELIVERY_MISMATCH");
      const delivered = this.deliveryRows(delivery);
      if (input.messageIds.some(id=>!delivered.some(row=>row.id===id))) throw failure("TASK_PEER_MESSAGE_NOT_DELIVERED");
      const rows = delivered.filter(row=>input.messageIds.includes(row.id));
      this.authorize(grant,"peer:ack",[target,...rows.map(row=>row.source_task_id)]);
      const pending = rows.filter(row=>!row.acknowledged_at), at = new Date(this.now()).toISOString();
      const update = this.db.prepare(`UPDATE qm_task_peer_messages SET acknowledged_at=?,acknowledged_by_client=?,acknowledged_by_grant=?
        WHERE id=? AND target_task_id=? AND acknowledged_at IS NULL`);
      for (const row of pending) update.run(at,grant.clientId,grant.grantId,row.id,target);
      return {acknowledged:rows.length,replayed:pending.length===0};
    });
  }

  private source(grant: TaskPeerGrant): string {
    if (!grant || typeof grant.assertCurrent !== "function") throw failure("TASK_PEER_VERIFIED_GRANT_REQUIRED");
    identifier(grant.clientId); identifier(grant.grantId);
    if (!grant.sourceTaskId) throw failure("TASK_PEER_SOURCE_BINDING_REQUIRED");
    identifier(grant.sourceTaskId);
    return grant.sourceTaskId;
  }
  private authorize(grant: TaskPeerGrant, capability: TaskPeerCapability, taskIds: readonly string[]): void {
    const unique = [...new Set(taskIds)];
    const checked: unknown = grant.assertCurrent(capability,unique);
    if (checked && typeof (checked as {then?: unknown}).then === "function") {
      void Promise.resolve(checked).catch(()=>{});
      throw failure("TASK_PEER_AUTHORIZATION_MUST_BE_SYNCHRONOUS");
    }
    for (const taskId of unique) this.access.resolveInTransaction(grant.principal,taskId);
  }
  private requireActive(taskId: string): void {
    const task = this.db.prepare("SELECT state FROM qm_tasks WHERE id=?").get(taskId) as {state:string};
    if (task.state !== "active") throw failure("TASK_PEER_TASK_INACTIVE",{taskId});
    const finalization = this.db.prepare("SELECT error,completed_at,recovery_state FROM qm_task_finalizations WHERE task_id=?")
      .get(taskId) as FinalizationFence | undefined;
    if (finalizationBlocksNewWork(finalization)) throw failure("TASK_PEER_TASK_FINISHING",{taskId});
  }
  private prior(grant: TaskPeerGrant, source: string, input: {targetTaskId:string;messageKey:string;body:string;replyTo?:string}): MessageRow | undefined {
    const row = this.db.prepare(`SELECT * FROM qm_task_peer_messages
      WHERE sender_client_id=? AND source_task_id=? AND target_task_id=? AND message_key=?`)
      .get(grant.clientId,source,input.targetTaskId,input.messageKey) as MessageRow | undefined;
    if (row && (row.body !== input.body || row.reply_to_id !== (input.replyTo ?? null))) throw failure("TASK_PEER_IDEMPOTENCY_CONFLICT");
    return row;
  }
  private message(id: string): MessageRow | undefined {
    return this.db.prepare("SELECT * FROM qm_task_peer_messages WHERE id=?").get(id) as MessageRow | undefined;
  }
  private deliveryRows(delivery: DeliveryRow): MessageRow[] {
    const ids: unknown = JSON.parse(delivery.message_ids_json);
    if (!Array.isArray(ids) || !ids.length || ids.length > MAX_TASK_PEER_BATCH || new Set(ids).size !== ids.length)
      throw failure("TASK_PEER_DELIVERY_INVALID");
    return ids.map(id=>{
      identifier(id);
      const row = this.message(id);
      if (!row || row.target_task_id !== delivery.task_id) throw failure("TASK_PEER_DELIVERY_INVALID");
      return row;
    });
  }
  private rateLimit(source: string, target: string, at: number): void {
    const since = at-60_000;
    const sent = this.db.prepare("SELECT COUNT(*) FROM qm_task_peer_messages WHERE source_task_id=? AND created_at_ms>?")
      .pluck().get(source,since) as number;
    const received = this.db.prepare("SELECT COUNT(*) FROM qm_task_peer_messages WHERE target_task_id=? AND created_at_ms>?")
      .pluck().get(target,since) as number;
    if (sent >= MAX_TASK_PEER_SOURCE_PER_MINUTE || received >= MAX_TASK_PEER_TARGET_PER_MINUTE)
      throw failure("TASK_PEER_RATE_LIMIT",{retryAfterMs:60_000});
  }
}
