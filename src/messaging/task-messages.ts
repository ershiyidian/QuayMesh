import * as z from "zod/v4";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ServerConfig } from "../config.js";
import { jsonReply, REPLY_BYTES } from "../bounded-reply.js";
import { toolResultBytes } from "../mcp-tool-result.js";
import { conversationScopeIdFromRequestMeta } from "../request-meta.js";
import { taskPrincipalFromAuthInfo } from "../tasks/task-access.js";
import type { InvocationContext } from "../session/types.js";
import type { TaskMailboxMessage, TaskMailboxScope, TaskMailboxStore } from "./task-mailbox.js";
import type { TaskMessagePage, TaskMessageReceipt, TaskMessageView } from "./task-message-types.js";
import { MAX_TASK_MESSAGE_BYTES } from "./task-message-types.js";

interface TaskMessageCallContext {
  authInfo?: { clientId?: string; extra?: Record<string, unknown> };
  _meta?: unknown;
}

const id = z.string().min(1).max(256);
const body = z.string().min(1).max(MAX_TASK_MESSAGE_BYTES)
  .describe("New messages allow up to 16 KiB UTF-8 and 16 KiB JSON-escaped text; both returned body representations must fit 44 KiB. Exact-key retries preserve a saved message when its complete reply fits.");
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const writes = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const mailboxSchema = z.object({ sequence: z.number().int().nonnegative(), pending: z.number().int().nonnegative() }).strict();
const messageSchema = z.object({
  id, sequence: z.number().int().positive(), role: z.enum(["user", "assistant"]), reply_to: z.array(id), body,
  created_at: z.string(), offered_at: z.string().nullable(), acknowledged_at: z.string().nullable(),
  status: z.enum(["queued", "offered", "acknowledged", "replied"]),
}).strict();
const receiptSchema = z.object({ task_id: id, message: messageSchema, replayed: z.boolean(), mailbox: mailboxSchema }).strict();
const pageSchema = z.object({ task_id: id, messages: z.array(messageSchema),
  next_before_sequence: z.number().int().positive().nullable(), mailbox: mailboxSchema }).strict();
const messageAction = z.discriminatedUnion("action", [
  z.object({ action: z.literal("history"), task_id: id, before_sequence: z.number().int().positive().optional(),
    limit: z.number().int().min(1).max(50).optional(), filter: z.enum(["all", "awaiting_reply"]).optional() }).strict(),
  z.object({ action: z.literal("receive"), task_id: id, request_key: id }).strict(),
  z.object({ action: z.literal("ack"), task_id: id, delivery_id: id, message_ids: z.array(id).min(1).max(8) }).strict(),
  z.object({ action: z.literal("reply"), task_id: id, message_key: id, reply_to: z.array(id).min(1).max(8), body }).strict(),
]);

function failure(code: string, message: string): Error {
  return Object.assign(new Error(`${code}: ${message}`), { code, effect: "not_started" });
}

export function isTaskMessageAuthority(config: Pick<ServerConfig, "federation">): boolean {
  const federation = config.federation;
  return federation?.enabled === true && federation.capabilities.coordinator === true
    && Boolean(federation.coordinatorId) && federation.nodeId === federation.coordinatorId;
}

function requireAuthority(config: Pick<ServerConfig, "federation">): void {
  if (!isTaskMessageAuthority(config)) throw failure("TASK_MAILBOX_AUTHORITY_REQUIRED", "Use the configured Coordinator for Task messages.");
}

function scope(extra: TaskMessageCallContext, taskId: string): TaskMailboxScope {
  return { principal: taskPrincipalFromAuthInfo(extra.authInfo), taskId };
}

function receiverEntry(extra: TaskMessageCallContext): { clientId: string; correlationId: string } {
  const clientId = extra.authInfo?.clientId;
  const correlationId = conversationScopeIdFromRequestMeta(extra._meta);
  if (!clientId) throw failure("MISSING_AUTHENTICATED_CLIENT", "Task message receivers require the authenticated OAuth client.");
  if (!correlationId) throw failure("TASK_MAILBOX_ENTRY_REQUIRED", "The host did not supply a stable entry correlation. Messages remain queued.");
  return { clientId, correlationId };
}

export function taskMessageView(message: TaskMailboxMessage): TaskMessageView {
  return {
    id: message.id, sequence: message.sequence, role: message.role, reply_to: message.replyTo,
    body: message.body, created_at: message.createdAt, offered_at: message.offeredAt,
    acknowledged_at: message.acknowledgedAt, status: message.status,
  };
}

export function registerTaskMessageTools(
  server: Pick<McpServer, "registerTool">,
  dependencies: { config: Pick<ServerConfig, "federation">; mailbox: TaskMailboxStore },
): void {
  const { config, mailbox } = dependencies;
  registerAppTool(server, "qm_task_message_enqueue", {
    title: "Send a Task message", description: "Save a user message for this explicit Task.",
    inputSchema: z.object({ task_id: id, message_key: id, body }).strict(),
    outputSchema: receiptSchema,
    _meta: { ui: { visibility: ["app"] } }, annotations: writes,
  }, async (input, extra) => {
    requireAuthority(config);
    const access = scope(extra, input.task_id);
    const result = await mailbox.enqueue(access, { messageKey: input.message_key, body: input.body });
    const receipt: TaskMessageReceipt = { task_id: input.task_id, message: taskMessageView(result.message),
      replayed: result.replayed, mailbox: mailbox.inspect(access) };
    return jsonReply({ ...receipt }, "Message saved. It is awaiting model receipt.");
  });

  registerAppTool(server, "qm_task_messages", {
    title: "Read Task messages", description: "Read the Task conversation without claiming or acknowledging model input.",
    inputSchema: z.object({ task_id: id, before_sequence: z.number().int().positive().optional(),
      limit: z.number().int().min(1).max(50).optional() }).strict(),
    outputSchema: pageSchema,
    _meta: { ui: { visibility: ["app"] } }, annotations: readOnly,
  }, async (input, extra) => {
    requireAuthority(config);
    const result = mailbox.list(scope(extra, input.task_id), { beforeSequence: input.before_sequence, limit: input.limit });
    const page: TaskMessagePage = { task_id: input.task_id, messages: result.messages.map(taskMessageView),
      next_before_sequence: result.nextBeforeSequence, mailbox: result.snapshot };
    return jsonReply({ ...page });
  });

  server.registerTool("task_messages", {
    title: "Read and reply to Task messages",
    description: "history reads this Task's conversation without acknowledging input; filter=awaiting_reply returns acknowledged user messages with no saved linked reply. After resuming, read that history, receive pending input, ack exact IDs, and reply in the Task card. Other authorized entries may continue replies. Same message_key/input replays one saved reply; different keys permit parallel replies. Acknowledgement or reply does not prove completion. Return mailbox.sequence as finish_task message_sequence.",
    // MCP advertises an object input schema; action-specific validation remains strict below.
    inputSchema: z.object({ action: z.enum(["history", "receive", "ack", "reply"]), task_id: id,
      request_key: id.optional(), delivery_id: id.optional(), message_ids: z.array(id).min(1).max(8).optional(),
      message_key: id.optional(), reply_to: z.array(id).min(1).max(8).optional(), body: body.optional(),
      before_sequence: z.number().int().positive().optional(), limit: z.number().int().min(1).max(50).optional(),
      filter: z.enum(["all", "awaiting_reply"]).optional() }).strict(),
    outputSchema: z.object({ task_id: id, mailbox: mailboxSchema,
      status: z.enum(["empty", "leased", "offered", "acknowledged"]).optional(),
      delivery_id: id.optional(), lease_expires_at: z.number().optional(), retry_at: z.number().optional(),
      messages: z.array(messageSchema).optional(), message_ids: z.array(id).optional(),
      message: messageSchema.optional(), replayed: z.boolean().optional(),
      next_before_sequence: z.number().int().positive().nullable().optional() }).strict(),
    annotations: writes,
  }, async (raw, extra) => {
    requireAuthority(config);
    const parsed = messageAction.safeParse(raw);
    if (!parsed.success) throw failure("TASK_MAILBOX_INVALID_ACTION", "Provide only the fields required by history, receive, ack or reply.");
    const input = parsed.data;
    const access = scope(extra, input.task_id);
    if (input.action === "history") {
      // Task ownership authorizes history. Reading it neither creates a receiver
      // nor requires the former conversation, a live lease, or an open Task.
      const result = mailbox.list(access, { beforeSequence: input.before_sequence, limit: input.limit, filter: input.filter });
      return jsonReply({ task_id: input.task_id, messages: result.messages.map(taskMessageView),
        next_before_sequence: result.nextBeforeSequence, mailbox: result.snapshot },
        input.filter === "awaiting_reply"
          ? "These user messages were acknowledged but have no saved linked reply. History does not acknowledge input or prove requirements fulfilled; other entries may reply concurrently."
          : "Task conversation history. Original receipt facts are unchanged; receive pending input separately before acknowledging it.");
    }
    const receiverId = await mailbox.bindReceiver(access, receiverEntry(extra));
    if (input.action === "receive") {
      const result = await mailbox.claim(access, { receiverId, requestKey: input.request_key });
      if (result.status === "offered") return jsonReply({ task_id: input.task_id, status: result.status,
        delivery_id: result.deliveryId, lease_expires_at: result.leaseExpiresAt, replayed: result.replayed,
        messages: result.messages.map(taskMessageView), mailbox: result.snapshot },
        "User input follows. Read it, acknowledge these exact message IDs, then act and reply. Offered is not proof of receipt.");
      return jsonReply({ task_id: input.task_id, status: result.status, mailbox: result.snapshot,
        ...(result.status === "leased" ? { retry_at: result.retryAt } : {}),
        ...(result.status === "acknowledged" ? { delivery_id: result.deliveryId } : {}) });
    }
    if (input.action === "ack") {
      const snapshot = await mailbox.acknowledge(access, { receiverId, deliveryId: input.delivery_id, messageIds: input.message_ids });
      return jsonReply({ task_id: input.task_id, status: "acknowledged", message_ids: input.message_ids, mailbox: snapshot },
        "Receipt confirmed. This does not mark the user's request completed.");
    }
    const result = await mailbox.reply(access, { receiverId, messageKey: input.message_key, replyTo: input.reply_to, body: input.body });
    const receipt: TaskMessageReceipt = { task_id: input.task_id, message: taskMessageView(result.message),
      replayed: result.replayed, mailbox: mailbox.inspect(access) };
    return jsonReply({ ...receipt }, "Reply saved in the Task card.");
  });
}

/** At a reply boundary, outside persisted invocation receipts; includes accepted replies while work continues.
 * This small notice never claims a message or changes its state. */
export function withTaskMessageNotice<T>(
  config: Pick<ServerConfig, "federation">, mailbox: TaskMailboxStore, context: InvocationContext, result: T,
): T {
  if (!isTaskMessageAuthority(config) || !context.task_id || context.actor !== "model") return result;
  const reply = result as CallToolResult | null;
  if (!reply || typeof reply !== "object" || !Array.isArray(reply.content)) return result;
  try {
    const snapshot = mailbox.inspect({ principal: taskPrincipalFromAuthInfo({ extra: { owner_id: context.owner_id } }), taskId: context.task_id });
    if (!snapshot.pending) return result;
    const text = `QuayMesh Task ${context.task_id} has ${snapshot.pending} pending user message(s). Call task_messages with action=receive, task_id=${context.task_id}, and a new stable request_key before continuing or finishing. This notice contains no message body.`;
    const next = { ...reply, content: [...reply.content, { type: "text" as const, text }] };
    const measured = { ...next, content: next.content.filter(item => item.type !== "image" && item.type !== "audio") };
    if (toolResultBytes(measured) > REPLY_BYTES) return result;
    return next as T;
  } catch {
    // An optional notice must never turn a committed command into an apparent failure.
    return result;
  }
}
