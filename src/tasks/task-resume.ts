import * as z from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerConfig } from "../config.js";
import { jsonReply, REPLY_BYTES } from "../bounded-reply.js";
import { toolResultBytes } from "../mcp-tool-result.js";
import { conversationScopeIdFromRequestMeta } from "../request-meta.js";
import { parseWorkspaceHandle, workspaceHandle } from "../federation/routing.js";
import type { SessionStore } from "../session/store.js";
import { taskPrincipalFromAuthInfo } from "./task-access.js";
import { isTaskBindingAuthority, taskExecutionEntryFromAuthInfo, type TaskBindingState } from "./task-binding.js";

interface RequestEntry {
  authInfo?: { clientId?: string; extra?: Record<string, unknown> };
  _meta?: unknown;
}

const id = z.string().min(1).max(256);
const revision = z.number().int().nonnegative();
const bindingSchema = z.discriminatedUnion("entry_available", [z.object({ task_id: id, entry_available: z.literal(true), binding_revision: revision,
  selected_task_id: id.nullable(), status: z.enum(["selected", "unbound", "different_task", "closed", "finalizing"]),
  can_resume: z.boolean(), can_continue: z.boolean() }).strict(),
  z.object({task_id: id, entry_available: z.literal(false), binding_revision: z.null(), selected_task_id: z.null(),
    status: z.literal("entry_unavailable"), can_resume: z.literal(false), can_continue: z.literal(false), reason: z.string()}).strict()]);
const inputActions = z.discriminatedUnion("action", [
  z.object({ action: z.literal("inspect"), task_id: id, workspace_offset: revision.optional() }).strict(),
  z.object({ action: z.literal("resume"), task_id: id, expected_binding_revision: revision,
    request_key: z.string().min(1).max(128) }).strict(),
]);

function fail(code: string, message: string): never {
  throw Object.assign(new Error(`${code}: ${message}`), { code, effect: "not_started" });
}

function requireAuthority(config: Pick<ServerConfig, "federation">): void {
  if (!isTaskBindingAuthority(config)) {
    fail("TASK_BINDING_AUTHORITY_REQUIRED", "Use the configured Coordinator to select a Task for this entry.");
  }
}

/** 先授权显式 Task 再读取入口状态；此操作不建立或改变任何绑定。 */
export function taskBindingForRequest(store: SessionStore, extra: RequestEntry, taskId: string,
  config: Pick<ServerConfig, "federation">): TaskBindingState {
  const principal = taskPrincipalFromAuthInfo(extra.authInfo);
  const task = store.taskBindings.authorizeTask(principal, taskId);
  const unavailable = (reason: string): TaskBindingState => ({ task_id: taskId, entry_available: false,
    binding_revision: null, selected_task_id: null, status: "entry_unavailable", can_resume: false, can_continue: false,
    reason: task.state === "closed" ? "This Task is closed. Its history remains available; replaying start or inspecting it does not reopen it." : reason });
  if (!isTaskBindingAuthority(config))
    return unavailable("Task selection is maintained by the configured Coordinator. Read this Task there before resuming it.");
  const correlation = conversationScopeIdFromRequestMeta(extra._meta);
  if (!extra.authInfo?.clientId || !correlation)
    return unavailable("The host has no stable conversation ID. Pass this task_id on workspace calls; inspect does not change another entry's selection.");
  return store.taskBindings.inspect(taskExecutionEntryFromAuthInfo(extra.authInfo, correlation), taskId);
}

export function registerTaskResumeTool(server: Pick<McpServer, "registerTool">,
  dependencies: { config: Pick<ServerConfig, "federation">; store: SessionStore }): void {
  const { config, store } = dependencies;
  server.registerTool("task_resume", {
    title: "Resume an existing Task",
    description: "Inspect an authorized Task and its revision. Resume selects it for a stable host entry; clients without one pass task_id on workspace calls. Keeps the same Task and workspaces.",
    inputSchema: z.object({ action: z.enum(["inspect", "resume"]), task_id: id,
      expected_binding_revision: revision.optional(), request_key: z.string().min(1).max(128).optional(),
      workspace_offset: revision.optional() }).strict(),
    outputSchema: z.object({ task_id: id, session_id: id, title: z.string(), task_revision: revision, binding: bindingSchema,
      finalization: z.object({
        revision,
        status: z.enum(["completed", "failed", "cancelled", "handed_off"]),
        summary: z.string(),
        message_sequence: revision,
        recovery_state: z.enum(["safe", "reconcile", "superseded"]).nullable(),
        completed: z.boolean()
      }).strict().nullable(),
      replayed: z.boolean().optional(), workspaces: z.array(z.object({ member_id: id, workspace_id: z.string(), node_id: id }).strict()),
      workspace_page: z.object({ offset: revision, next_offset: revision.nullable(), total: revision }).strict() }).strict(),
    _meta: { ui: { visibility: ["model", "app"] } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (raw, extra) => {
    requireAuthority(config);
    const parsed = inputActions.safeParse(raw);
    if (!parsed.success) fail("TASK_BINDING_INVALID_INPUT", parsed.error.message);
    const input = parsed.data, context = extra as RequestEntry;
    const observedBinding = taskBindingForRequest(store, context, input.task_id, config);
    const entry = input.action === "resume"
      ? taskExecutionEntryFromAuthInfo(context.authInfo, conversationScopeIdFromRequestMeta(context._meta)) : undefined;
    const task = store.getTask(input.task_id), memberIds = store.taskMemberIds(task.id);
    const offset = input.action === "inspect" ? input.workspace_offset ?? 0 : 0;
    if (offset > memberIds.length) fail("TASK_BINDING_INVALID_INPUT", "workspace_offset exceeds the Task workspace count.");
    // Handles are enough to continue work. Full filesystem roots remain in the
    // existing workspace detail tools rather than expanding every resume reply.
    const workspaces = memberIds.slice(offset, offset + 20).map(memberId => {
      const member = store.getMember(task.session_id, memberId);
      return { member_id: member.id, workspace_id: parseWorkspaceHandle(member.workspace_id)
        || !config.federation?.enabled ? member.workspace_id : workspaceHandle(member.node_id, member.workspace_id), node_id: member.node_id };
    });
    const page = { offset, next_offset: offset + workspaces.length < memberIds.length ? offset + workspaces.length : null,
      total: memberIds.length };
    const format = (binding: TaskBindingState, replayed?: boolean) => {
      const intent = store.taskData.finalization(task.id);
      return jsonReply({
        task_id: task.id,
        session_id: task.session_id,
        title: task.title,
        task_revision: store.getTask(task.id).revision,
        binding,
        finalization: intent ? {
          revision: intent.finalization_revision,
          status: intent.status,
          summary: intent.summary,
          message_sequence: intent.mailbox_sequence,
          recovery_state: intent.recovery_state,
          completed: Boolean(intent.completed_at)
        } : null,
        ...(replayed === undefined ? {} : { replayed }), workspaces, workspace_page: page,
      }, `Task ${task.id}: ${binding.status}. ${binding.can_continue
        ? "Use its workspace handles; other entries and accepted operations keep their original Tasks. A new finish after resumed work must use task_revision as expected_task_revision."
          + (config.federation?.enabled ? " Before work, read task_messages history with filter=awaiting_reply; receive pending input separately." : "")
        : !binding.entry_available ? binding.reason
          : binding.can_resume ? `Inspect and explicitly resume with binding revision ${binding.binding_revision} before new workspace work.`
          : "This Task cannot accept new work. Reconcile the returned original finalization status/summary; confirm any newer mailbox cutoff before explicitly retrying it. Messages and original operation output remain readable."}`);
    };
    // Refuse malformed historical metadata before mutating the binding. A small
    // reserve covers the post-commit revision/status and replay flag changes.
    if (toolResultBytes(format(observedBinding)) > REPLY_BYTES - 1024)
      fail("TASK_BINDING_REPLY_TOO_LARGE", "The stored Task metadata exceeds this reply's budget.");
    let replayed: boolean | undefined;
    if (input.action === "resume") {
      const result = await store.taskBindings.resume(entry!, input.task_id, input.expected_binding_revision, input.request_key);
      replayed = result.replayed;
    }
    return format(taskBindingForRequest(store, context, input.task_id, config), replayed);
  });
}
