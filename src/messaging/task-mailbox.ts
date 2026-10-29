import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { runSqliteWrite } from "../db/async-write.js";
import { REPLY_BYTES } from "../bounded-reply.js";
import { toolResultBytes } from "../mcp-tool-result.js";
import { TaskAccessResolver, type TaskOwnerSource, type TaskPrincipal } from "../tasks/task-access.js";
import { taskMessageBodyFits } from "./task-message-types.js";

export { MAX_TASK_MESSAGE_BYTES } from "./task-message-types.js";
// Account for both content representations, reserving the remaining 2 KiB for
// Task/delivery IDs, mailbox state, cursors, and the tool's explanation.
export const MAX_TASK_MESSAGE_BATCH_BYTES = REPLY_BYTES - 2 * 1024;
const MAX_BATCH_MESSAGES = 8;
const DEFAULT_LEASE_MS = 5 * 60_000;

/** The authenticated owner authorizes the explicit Task; external conversations are not parents. */
export interface TaskMailboxScope {
  principal: TaskPrincipal;
  taskId: string;
}

export interface TaskMailboxMessage {
  id: string;
  taskId: string;
  sequence: number;
  role: "user" | "assistant";
  body: string;
  replyTo: string[];
  status: "queued" | "offered" | "acknowledged" | "replied";
  offeredAt: string | null;
  createdAt: string;
  acknowledgedAt: string | null;
}

export interface TaskMailboxSnapshot {
  sequence: number;
  pending: number;
}

export type TaskMailboxClaim =
  | { status: "empty"; snapshot: TaskMailboxSnapshot }
  | { status: "leased"; retryAt: number; snapshot: TaskMailboxSnapshot }
  | { status: "acknowledged"; deliveryId: string; snapshot: TaskMailboxSnapshot }
  | {
    status: "offered";
    deliveryId: string;
    leaseExpiresAt: number;
    messages: TaskMailboxMessage[];
    replayed: boolean;
    snapshot: TaskMailboxSnapshot;
  };

interface MessageRow {
  id: string;
  task_id: string;
  sequence: number;
  message_key: string;
  body: string;
  role: "user" | "assistant";
  reply_to_json: string;
  sender_receiver_id: string | null;
  created_at: string;
  offered_at?: string | null;
  delivery_id: string | null;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
}

interface DeliveryRow {
  id: string;
  task_id: string;
  receiver_id: string;
  request_key: string;
  message_ids_json: string;
  created_at: string;
  lease_expires_at: number;
}

function failure(code: string): Error & { code: string } {
  const message = code === "TASK_MAILBOX_LEASE_EXPIRED" || code === "TASK_MAILBOX_DELIVERY_SUPERSEDED"
    ? `${code}: Call task_messages receive with a new request_key, then acknowledge only the new delivery.`
    : code === "TASK_MAILBOX_BATCH_LIMIT"
      ? `${code}: This saved message or prior delivery cannot fit a complete tool reply. Its content and receipt state remain unchanged.` : code;
  return Object.assign(new Error(message), { code, effect: "not_started" });
}

function identifier(value: string): void {
  if (typeof value !== "string" || !value.trim() || value.length > 256) {
    throw failure("TASK_MAILBOX_INVALID_ID");
  }
}

function message(row: MessageRow): TaskMailboxMessage {
  return {
    id: row.id,
    taskId: row.task_id,
    sequence: row.sequence,
    role: row.role,
    body: row.body,
    replyTo: JSON.parse(row.reply_to_json) as string[],
    status: row.role === "assistant" ? "replied" : row.acknowledged_at ? "acknowledged" : row.delivery_id ? "offered" : "queued",
    offeredAt: row.offered_at ?? null,
    createdAt: row.created_at,
    acknowledgedAt: row.acknowledged_at,
  };
}

function messagesFit(messages: TaskMailboxMessage[]): boolean {
  return toolResultBytes({ content: [], structuredContent: { messages } }) <= MAX_TASK_MESSAGE_BATCH_BYTES;
}

/** Main-task inbox. The caller owns migrations, notification publication, and receiver identity. */
export class TaskMailboxStore {
  private readonly access: TaskAccessResolver;
  private readonly now: () => number;

  constructor(private readonly db: Database.Database, options: { ownerSource: TaskOwnerSource; now?: () => number }) {
    this.access = new TaskAccessResolver(db, { ownerSource: options.ownerSource });
    this.now = options.now ?? Date.now;
  }

  enqueue(
    scope: TaskMailboxScope,
    input: { messageKey: string; body: string },
  ): Promise<{ message: TaskMailboxMessage; replayed: boolean }> {
    identifier(input.messageKey);
    return runSqliteWrite(this.db, () => {
      const task = this.requireScope(scope);
      const existing = this.db.prepare(
        "SELECT * FROM qm_task_messages WHERE task_id = ? AND message_key = ?",
      ).get(scope.taskId, input.messageKey) as MessageRow | undefined;
      if (existing) {
        if (existing.body !== input.body || existing.role !== "user") throw failure("TASK_MAILBOX_IDEMPOTENCY_CONFLICT");
        const saved = message(this.getMessage(scope.taskId, existing.id));
        if (!messagesFit([saved])) throw failure("TASK_MAILBOX_BATCH_LIMIT");
        return { message: saved, replayed: true };
      }
      validateBody(input.body);
      this.requireWritable(scope.taskId, task.state);
      const sequence = this.snapshot(scope.taskId).sequence + 1;
      const id = `message_${randomUUID()}`;
      const createdAt = new Date(this.now()).toISOString();
      this.db.prepare(`INSERT INTO qm_task_messages
        (id, task_id, sequence, message_key, body, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(id, scope.taskId, sequence, input.messageKey, input.body, createdAt);
      return { message: message(this.getMessage(scope.taskId, id)), replayed: false };
    });
  }

  inspect(scope: TaskMailboxScope): TaskMailboxSnapshot {
    this.requireScope(scope);
    return this.snapshot(scope.taskId);
  }

  claim(
    scope: TaskMailboxScope,
    input: { receiverId: string; requestKey: string; maxMessages?: number; leaseMs?: number },
  ): Promise<TaskMailboxClaim> {
    identifier(input.receiverId);
    identifier(input.requestKey);
    const limit = input.maxMessages ?? 4;
    const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_BATCH_MESSAGES
      || !Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 60 * 60_000) {
      return Promise.reject(failure("TASK_MAILBOX_INVALID_CLAIM"));
    }
    return runSqliteWrite<TaskMailboxClaim>(this.db, () => {
      const task = this.requireScope(scope);
      this.requireReceiver(scope, input.receiverId);
      const previous = this.db.prepare(`SELECT * FROM qm_task_message_deliveries
        WHERE task_id = ? AND receiver_id = ? AND request_key = ?`)
        .get(scope.taskId, input.receiverId, input.requestKey) as DeliveryRow | undefined;
      if (previous) return this.replayClaim(previous);
      if (task.state === "closed") throw failure("TASK_MAILBOX_TASK_CLOSED");

      const rows = this.pending(scope.taskId, limit);
      const head = rows[0];
      if (!head) return { status: "empty", snapshot: this.snapshot(scope.taskId) };
      const now = this.now();
      if (head.delivery_id) {
        const lease = this.getDelivery(scope.taskId, head.delivery_id);
        if (lease.lease_expires_at > now) {
          return { status: "leased", retryAt: lease.lease_expires_at, snapshot: this.snapshot(scope.taskId) };
        }
      }

      const id = `delivery_${randomUUID()}`, createdAt = new Date(now).toISOString();
      const selected: TaskMailboxMessage[] = [];
      for (const row of rows) {
        // A live lease anywhere in the prefix prevents claiming past it.
        if (row.delivery_id && this.getDelivery(scope.taskId, row.delivery_id).lease_expires_at > now) break;
        const offered = message({ ...row, delivery_id: id, offered_at: createdAt });
        if (!messagesFit([...selected, offered])) break;
        selected.push(offered);
      }
      if (!selected.length) throw failure("TASK_MAILBOX_BATCH_LIMIT");
      const expiresAt = now + leaseMs;
      this.db.prepare(`INSERT INTO qm_task_message_deliveries
        (id, task_id, receiver_id, request_key, message_ids_json, created_at, lease_expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(id, scope.taskId, input.receiverId, input.requestKey,
          JSON.stringify(selected.map(row => row.id)), createdAt, expiresAt);
      const assign = this.db.prepare("UPDATE qm_task_messages SET delivery_id = ? WHERE id = ? AND task_id = ?");
      for (const row of selected) assign.run(id, row.id, scope.taskId);
      return {
        status: "offered",
        deliveryId: id,
        leaseExpiresAt: expiresAt,
        messages: selected,
        replayed: false,
        snapshot: this.snapshot(scope.taskId),
      };
    });
  }

  acknowledge(
    scope: TaskMailboxScope,
    input: { receiverId: string; deliveryId: string; messageIds: string[] },
  ): Promise<TaskMailboxSnapshot> {
    identifier(input.receiverId);
    identifier(input.deliveryId);
    if (!Array.isArray(input.messageIds) || !input.messageIds.length
      || input.messageIds.length > MAX_BATCH_MESSAGES
      || new Set(input.messageIds).size !== input.messageIds.length) {
      return Promise.reject(failure("TASK_MAILBOX_INVALID_ACK"));
    }
    for (const id of input.messageIds) identifier(id);
    return runSqliteWrite(this.db, () => {
      const task = this.requireScope(scope);
      this.requireReceiver(scope, input.receiverId);
      const delivery = this.getDelivery(scope.taskId, input.deliveryId);
      if (delivery.receiver_id !== input.receiverId) throw failure("TASK_MAILBOX_RECEIVER_MISMATCH");
      const deliveredIds = new Set(this.deliveryMessageIds(delivery));
      if (input.messageIds.some(id => !deliveredIds.has(id))) throw failure("TASK_MAILBOX_MESSAGE_NOT_OFFERED");
      const rows = input.messageIds.map(id => this.getMessage(scope.taskId, id));
      if (rows.some(row => row.delivery_id !== delivery.id)) throw failure("TASK_MAILBOX_DELIVERY_SUPERSEDED");
      const unread = rows.filter(row => row.acknowledged_at === null);
      if (!unread.length) return this.snapshot(scope.taskId);
      if (task.state === "closed") throw failure("TASK_MAILBOX_TASK_CLOSED");
      if (delivery.lease_expires_at <= this.now()) throw failure("TASK_MAILBOX_LEASE_EXPIRED");
      const prefix = this.pending(scope.taskId, unread.length);
      if (unread.some((row, index) => prefix[index]?.id !== row.id)) {
        throw failure("TASK_MAILBOX_ACK_OUT_OF_ORDER");
      }
      const acknowledgedAt = new Date(this.now()).toISOString();
      const acknowledge = this.db.prepare(`UPDATE qm_task_messages
        SET acknowledged_at = ?, acknowledged_by = ? WHERE id = ? AND task_id = ?`);
      for (const row of unread) acknowledge.run(acknowledgedAt, input.receiverId, row.id, scope.taskId);
      return this.snapshot(scope.taskId);
    });
  }

  /** Call inside the same synchronous transaction that commits the task's terminal state. */
  assertReadyToFinishInTransaction(scope: TaskMailboxScope, expectedSequence: number): void {
    if (!this.db.inTransaction) throw failure("TASK_MAILBOX_TRANSACTION_REQUIRED");
    this.access.resolveInTransaction(scope.principal, scope.taskId);
    assertTaskMailboxReadyInTransaction(this.db, scope.taskId, expectedSequence);
  }

  /** OAuth owner authorizes the Task; the host correlation only selects a receiver binding. */
  bindReceiver(scope: TaskMailboxScope, entry: { clientId: string; correlationId: string }): Promise<string> {
    identifier(entry.clientId);
    if (typeof entry.correlationId !== "string" || !entry.correlationId.trim() || entry.correlationId.length > 2048) {
      return Promise.reject(failure("TASK_MAILBOX_ENTRY_REQUIRED"));
    }
    const entryKey = createHash("sha256").update(entry.correlationId).digest("hex");
    return runSqliteWrite(this.db, () => {
      const task = this.requireScope(scope);
      const existing = this.db.prepare(`SELECT id FROM qm_task_message_receivers
        WHERE task_id=? AND owner_id=? AND client_id=? AND entry_key=? AND revoked_at IS NULL`)
        .get(scope.taskId, scope.principal.ownerId, entry.clientId, entryKey) as { id: string } | undefined;
      if (existing) return existing.id;
      if (task.state === "closed") throw failure("TASK_MAILBOX_TASK_CLOSED");
      const id = `receiver_${randomUUID()}`;
      this.db.prepare(`INSERT INTO qm_task_message_receivers(id,task_id,owner_id,client_id,entry_key,created_at)
        VALUES(?,?,?,?,?,?)`).run(id, scope.taskId, scope.principal.ownerId, entry.clientId, entryKey, new Date(this.now()).toISOString());
      return id;
    });
  }

  list(scope: TaskMailboxScope, input: { beforeSequence?: number; limit?: number; filter?: "all" | "awaiting_reply" } = {}): {
    messages: TaskMailboxMessage[]; nextBeforeSequence: number | null; snapshot: TaskMailboxSnapshot;
  } {
    this.requireScope(scope);
    const limit = input.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50
      || input.beforeSequence !== undefined && (!Number.isSafeInteger(input.beforeSequence) || input.beforeSequence < 1)) {
      throw failure("TASK_MAILBOX_INVALID_CURSOR");
    }
    if (input.filter !== undefined && input.filter !== "all" && input.filter !== "awaiting_reply") {
      throw failure("TASK_MAILBOX_INVALID_FILTER");
    }
    // Build the answered-ID set once for this Task, using the existing Task/sequence
    // index. A linked reply is a saved response, not proof that a request was fulfilled.
    const awaitingReply = input.filter === "awaiting_reply";
    const rows = this.db.prepare(`SELECT m.*,d.created_at AS offered_at FROM qm_task_messages m
      LEFT JOIN qm_task_message_deliveries d ON d.id=m.delivery_id
      WHERE m.task_id=? ${awaitingReply ? `AND m.role='user' AND m.acknowledged_at IS NOT NULL
        AND m.id NOT IN (SELECT target.value FROM qm_task_messages replies, json_each(replies.reply_to_json) target
          WHERE replies.task_id=? AND replies.role='assistant' AND target.type='text')` : ""}
      ${input.beforeSequence === undefined ? "" : "AND m.sequence<?"}
      ORDER BY m.sequence DESC LIMIT ?`).all(scope.taskId, ...(awaitingReply ? [scope.taskId] : []),
        ...(input.beforeSequence === undefined ? [] : [input.beforeSequence]), limit + 1) as MessageRow[];
    const selected: TaskMailboxMessage[] = [];
    for (const row of rows.slice(0, limit)) {
      const item = message(row);
      if (!messagesFit([...selected, item])) break;
      selected.push(item);
    }
    if (rows.length && !selected.length) throw failure("TASK_MAILBOX_BATCH_LIMIT");
    const hasMore = selected.length < rows.length;
    const nextBeforeSequence = hasMore && selected.length ? selected.at(-1)!.sequence : null;
    return { messages: selected.reverse(), nextBeforeSequence, snapshot: this.snapshot(scope.taskId) };
  }

  reply(scope: TaskMailboxScope, input: {
    receiverId: string; messageKey: string; replyTo: string[]; body: string;
  }): Promise<{ message: TaskMailboxMessage; replayed: boolean }> {
    identifier(input.messageKey);
    identifier(input.receiverId);
    if (!Array.isArray(input.replyTo) || !input.replyTo.length || input.replyTo.length > MAX_BATCH_MESSAGES
      || new Set(input.replyTo).size !== input.replyTo.length) return Promise.reject(failure("TASK_MAILBOX_INVALID_REPLY"));
    for (const id of input.replyTo) identifier(id);
    const replyToJson = JSON.stringify([...input.replyTo].sort());
    return runSqliteWrite(this.db, () => {
      const task = this.requireScope(scope);
      this.requireReceiver(scope, input.receiverId);
      const existing = this.db.prepare("SELECT * FROM qm_task_messages WHERE task_id=? AND message_key=?")
        .get(scope.taskId, input.messageKey) as MessageRow | undefined;
      if (existing) {
        if (existing.role !== "assistant" || existing.body !== input.body
          || existing.reply_to_json !== replyToJson) throw failure("TASK_MAILBOX_IDEMPOTENCY_CONFLICT");
        // A retry may arrive through another authorized entry. The original
        // sender remains part of the immutable saved reply, never overwritten.
        const saved = message(this.getMessage(scope.taskId, existing.id));
        if (!messagesFit([saved])) throw failure("TASK_MAILBOX_BATCH_LIMIT");
        return { message: saved, replayed: true };
      }
      validateBody(input.body);
      this.requireWritable(scope.taskId, task.state);
      for (const id of input.replyTo) {
        const row = this.getMessage(scope.taskId, id);
        // Acknowledgement records who received the input. It grants no permanent
        // ownership over replies to this Task, which other entries may continue.
        if (row.role !== "user" || !row.acknowledged_at) {
          throw failure("TASK_MAILBOX_REPLY_NOT_ACKNOWLEDGED");
        }
      }
      const id = `message_${randomUUID()}`, sequence = this.snapshot(scope.taskId).sequence + 1;
      this.db.prepare(`INSERT INTO qm_task_messages
        (id,task_id,sequence,message_key,body,role,reply_to_json,sender_receiver_id,created_at)
        VALUES(?,?,?,?,?,'assistant',?,?,?)`).run(id, scope.taskId, sequence, input.messageKey, input.body,
          replyToJson, input.receiverId, new Date(this.now()).toISOString());
      return { message: message(this.getMessage(scope.taskId, id)), replayed: false };
    });
  }

  private requireScope(scope: TaskMailboxScope): { state: "active" | "closed" } {
    return this.db.inTransaction
      ? this.access.resolveInTransaction(scope.principal, scope.taskId)
      : this.access.resolve(scope.principal, scope.taskId);
  }

  private requireReceiver(scope: TaskMailboxScope, receiverId: string): void {
    if (!this.db.prepare(`SELECT 1 FROM qm_task_message_receivers
      WHERE id=? AND task_id=? AND owner_id=? AND revoked_at IS NULL`)
      .get(receiverId, scope.taskId, scope.principal.ownerId)) throw failure("TASK_MAILBOX_RECEIVER_MISMATCH");
  }

  private requireWritable(taskId: string, state: "active" | "closed"): void {
    if (state === "closed") throw failure("TASK_MAILBOX_TASK_CLOSED");
    if (this.db.prepare("SELECT 1 FROM qm_task_finalizations WHERE task_id=? AND completed_at IS NULL AND error IS NULL").get(taskId)) {
      throw failure("TASK_MAILBOX_TASK_FINISHING");
    }
  }

  private snapshot(taskId: string): TaskMailboxSnapshot {
    return taskMailboxSnapshot(this.db, taskId);
  }

  private pending(taskId: string, limit: number): MessageRow[] {
    return this.db.prepare(`SELECT * FROM qm_task_messages
      WHERE task_id = ? AND role = 'user' AND acknowledged_at IS NULL ORDER BY sequence LIMIT ?`)
      .all(taskId, limit) as MessageRow[];
  }

  private getMessage(taskId: string, id: string): MessageRow {
    const row = this.db.prepare(`SELECT m.*,d.created_at AS offered_at FROM qm_task_messages m
      LEFT JOIN qm_task_message_deliveries d ON d.id=m.delivery_id WHERE m.task_id = ? AND m.id = ?`)
      .get(taskId, id) as MessageRow | undefined;
    if (!row) throw failure("TASK_MAILBOX_MESSAGE_NOT_FOUND");
    return row;
  }

  private getDelivery(taskId: string, id: string): DeliveryRow {
    const row = this.db.prepare("SELECT * FROM qm_task_message_deliveries WHERE task_id = ? AND id = ?")
      .get(taskId, id) as DeliveryRow | undefined;
    if (!row) throw failure("TASK_MAILBOX_DELIVERY_NOT_FOUND");
    return row;
  }

  private deliveryMessageIds(delivery: DeliveryRow): string[] {
    const ids: unknown = JSON.parse(delivery.message_ids_json);
    if (!Array.isArray(ids) || !ids.length || ids.length > MAX_BATCH_MESSAGES
      || ids.some(id => typeof id !== "string")) throw failure("TASK_MAILBOX_CORRUPT_DELIVERY");
    return ids;
  }

  private replayClaim(delivery: DeliveryRow): TaskMailboxClaim {
    const rows = this.deliveryMessageIds(delivery).map(id => this.getMessage(delivery.task_id, id));
    if (rows.some(row => row.delivery_id !== delivery.id)) throw failure("TASK_MAILBOX_DELIVERY_SUPERSEDED");
    const unread = rows.filter(row => row.acknowledged_at === null);
    const snapshot = this.snapshot(delivery.task_id);
    if (!unread.length) return { status: "acknowledged", deliveryId: delivery.id, snapshot };
    if (delivery.lease_expires_at <= this.now()) throw failure("TASK_MAILBOX_LEASE_EXPIRED");
    const messages = unread.map(message);
    if (!messagesFit(messages)) throw failure("TASK_MAILBOX_BATCH_LIMIT");
    return {
      status: "offered",
      deliveryId: delivery.id,
      leaseExpiresAt: delivery.lease_expires_at,
      messages,
      replayed: true,
      snapshot,
    };
  }
}

function validateBody(body: string): void {
  if (typeof body !== "string" || !taskMessageBodyFits(body)) throw failure("TASK_MAILBOX_INVALID_BODY");
}

/** Internal transaction helpers; callers must authorize the explicit Task before use. */
export function taskMailboxSnapshot(db: Database.Database, taskId: string): TaskMailboxSnapshot {
  const row = db.prepare(`SELECT
    (SELECT COALESCE(MAX(sequence), 0) FROM qm_task_messages WHERE task_id = ?) AS sequence,
    (SELECT COUNT(*) FROM qm_task_messages WHERE task_id = ? AND role='user' AND acknowledged_at IS NULL) AS pending`)
    .get(taskId, taskId) as TaskMailboxSnapshot;
  return { sequence: row.sequence, pending: row.pending };
}

export function assertTaskMailboxReadyInTransaction(db: Database.Database, taskId: string, expectedSequence: number): void {
  if (!db.inTransaction) throw failure("TASK_MAILBOX_TRANSACTION_REQUIRED");
  if (!Number.isSafeInteger(expectedSequence) || expectedSequence < 0) throw failure("TASK_MAILBOX_INVALID_SEQUENCE");
  const snapshot = taskMailboxSnapshot(db, taskId);
  if (snapshot.sequence !== expectedSequence) throw failure("TASK_MAILBOX_CHANGED");
  if (snapshot.pending !== 0) throw failure("TASK_MAILBOX_INPUT_PENDING");
}
