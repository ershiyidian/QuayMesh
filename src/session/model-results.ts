import { textPage } from "../bounded-reply.js";
import type {
  AgentSummary,
  OperationRecord,
  RecoveryRow,
  SessionId,
  SessionRecord,
  SnapshotCapabilities,
} from "./types.js";

type OperationEffect = OperationRecord["effect"];

export interface ToolTextContent {
  type: "text";
  text: string;
}

export interface ModelToolReply {
  content: ToolTextContent[];
  structuredContent: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

export interface OperationReplyInput {
  id?: string;
  operation_id?: string;
  kind?: string;
  label?: string;
  state: string;
  effect: OperationEffect;
  result_ref?: string | null;
  command_id?: string | null;
  agent_id?: string | null;
  error_code?: string | null;
  error_message?: string | null;
}

export interface AgentResultReference {
  ref?: string | null;
  text?: string | null;
  include_text?: boolean;
  cursor?: number;
  max_bytes?: number;
}

export interface WorkspaceReplyDiscovery {
  execution?: {
    platform?: string;
    shell?: string;
  };
  first_delivery?: boolean;
  loaded_instructions?: Array<{ path: string }>;
  available_instructions?: Array<{ path: string }>;
  skills?: Array<{ name: string; description?: string | null; path: string }>;
  snapshot_ref?: string;
  capabilities?: SnapshotCapabilities;
}

export interface NextActionReference {
  tool: string;
  arguments?: Record<string, unknown>;
}

export interface ErrorReplyReferences {
  operation_id?: string | null;
  agent_id?: string | null;
  result_ref?: string | null;
}

export interface TruncatedResult {
  text: string;
  cursor: number;
  next_cursor: number | null;
  total_code_points: number;
  truncated: boolean;
}

const MODEL_TOOL_NAMES = new Set([
  "start_session",
  "workspace_catalog",
  "open_workspace",
  "attach_workspace",
  "read",
  "workspace_context",
  "apply_patch",
  "exec_command",
  "write_stdin",
  "spawn_agent",
  "followup_agent",
  "send_message",
  "wait_agent",
  "interrupt_agent",
  "list_agents",
  "copy_artifact",
]);

const PRIVATE_PAYLOAD_KEYS = new Set([
  "bootstrap",
  "claim",
  "claims",
  "environment",
  "internal_claims",
  "messages",
  "prompt",
  "raw_config",
  "snapshot",
  "snapshots",
  "token_totals",
  "tokens",
  "transcript",
  "ui",
  "usage",
  "usage_summary",
]);

export function operationReply(
  operation: OperationReplyInput,
  payload: Record<string, unknown>,
): ModelToolReply {
  const operationId = operation.operation_id ?? operation.id ?? "unknown";
  const summary = conciseOperationSummary(operation, payload);
  const page = textPage(summary, 0, 12 * 1024);
  const text = page.nextOffset === null
    ? page.text
    : `${page.text}\n[Result shortened. Read the stored result with its result_ref.]`;
  const cleanPayload = stripPrivatePayload(payload) as Record<string, unknown>;
  const structuredContent: Record<string, unknown> = {
    operation_id: operationId,
    state: operation.state,
    effect: operation.effect,
    ...cleanPayload,
  };

  return {
    content: [{ type: "text", text }],
    structuredContent,
    ...(operation.result_ref
      ? { _meta: { quaymesh: { projection_ref: operation.result_ref } } }
      : {}),
  };
}

export function agentReply(
  record: Pick<
    AgentSummary,
    "id" | "name" | "state" | "task" | "provider" | "model" | "effort" | "result_available" | "result_ref"
  > & { latestResponse?: string | null },
  resultReference: AgentResultReference = {},
): ModelToolReply {
  const resultRef = resultReference.ref ?? record.result_ref ?? null;
  const resultAvailable = record.result_available || resultRef !== null;
  const structuredContent: Record<string, unknown> = {
    agent_id: record.id,
    name: record.name,
    state: record.state,
    task: record.task,
    provider: record.provider,
    ...(record.model ? { model: record.model } : {}),
    ...(record.effort ? { effort: record.effort } : {}),
    result_available: resultAvailable,
    ...(resultRef ? { result_ref: resultRef } : {}),
  };

  const lines = [
    `Agent ${record.name} (${record.id}): ${record.state}.`,
    `Task: ${record.task}`,
  ];
  if (resultAvailable && !resultRef) lines.push("Result is available.");

  if (resultReference.include_text) {
    const sourceText = resultReference.text ?? record.latestResponse ?? null;
    if (sourceText !== null) {
      const page = truncateResult(sourceText, resultReference.cursor ?? 0, resultReference.max_bytes ?? 12 * 1024);
      const suffix = page.next_cursor === null ? "" : `\n[Result continues at cursor ${page.next_cursor}.]`;
      lines.push(page.text + suffix);
      structuredContent.result_cursor = page.cursor;
      structuredContent.result_next_cursor = page.next_cursor;
      structuredContent.result_truncated = page.truncated;
    }
  }

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent,
    ...(resultRef ? { _meta: { quaymesh: { projection_ref: resultRef } } } : {}),
  };
}

export function workspaceReply(
  workspace: {
    workspace_id: string;
    root: string;
    mode: "local" | "worktree" | "checkout";
    execution?: { platform?: string; shell?: string };
  },
  session: Pick<SessionRecord, "id" | "title" | "members">,
  discovery: WorkspaceReplyDiscovery,
  recovery: RecoveryRow[],
): ModelToolReply {
  const selectedMember = session.members[0];
  if (!selectedMember) throw new Error(`SESSION_MEMBER_NOT_FOUND: ${session.id}`);

  const firstDelivery = discovery.first_delivery === true;
  const loadedInstructions = firstDelivery ? discovery.loaded_instructions ?? [] : [];
  const availableInstructions = firstDelivery ? discovery.available_instructions ?? [] : [];
  const skills = firstDelivery ? discovery.skills ?? [] : [];
  const lines = [
    `Workspace ${workspace.workspace_id}: ${workspace.root}`,
    `Session ${session.id}: ${session.title}`,
    `Mode: ${workspace.mode}`,
  ];
  if (workspace.execution?.platform) lines.push(`Platform: ${workspace.execution.platform}`);
  if (workspace.execution?.shell) lines.push(`Shell: ${workspace.execution.shell}`);
  if (loadedInstructions.length > 0) {
    lines.push("Loaded instructions:");
    for (const item of loadedInstructions) lines.push(`- ${item.path}`);
  }
  if (availableInstructions.length > 0) {
    lines.push("Available instruction paths:");
    for (const item of availableInstructions) lines.push(`- ${item.path}`);
  }
  if (skills.length > 0) {
    lines.push("Available skills:");
    for (const skill of skills) {
      const description = skill.description ? `: ${skill.description}` : "";
      lines.push(`- ${skill.name} (${skill.path})${description}`);
    }
  }

  const recent = recovery.slice(0, 5);
  if (recent.length > 0) {
    lines.push("Recent recovery:");
    for (const row of recent) {
      lines.push(`- ${row.session_id}: ${row.execution_state}; ${row.next_step}`);
    }
  }

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: {
      workspace_id: workspace.workspace_id,
      session_id: session.id,
      root: workspace.root,
      mode: workspace.mode,
      execution: workspace.execution ?? {},
      loaded_instructions: loadedInstructions.map((item) => item.path),
      available_instructions: availableInstructions.map((item) => item.path),
      skills: skills.map((skill) => ({
        name: skill.name,
        description: skill.description ?? null,
        path: skill.path,
      })),
      recovery: recent.map((row) => ({
        session_id: row.session_id,
        execution_state: row.execution_state,
        updated_at: row.updated_at,
        next_step: row.next_step,
      })),
    },
    _meta: {
      quaymesh: {
        session_id: session.id,
        workspace_id: workspace.workspace_id,
        member_id: selectedMember.id,
        snapshot_ref: discovery.snapshot_ref ?? `session:${session.id}:member:${selectedMember.id}`,
        capabilities: discovery.capabilities ?? {
          refresh: true,
          revert: false,
          continue: false,
          open_file: false,
        },
      },
    },
  };
}

export function errorReply(
  code: string,
  message: string,
  effect: OperationEffect,
  refs: ErrorReplyReferences = {},
  nextAction?: NextActionReference,
): ModelToolReply {
  if (nextAction && !MODEL_TOOL_NAMES.has(nextAction.tool)) {
    throw new Error(`UNKNOWN_NEXT_ACTION_TOOL: ${nextAction.tool}`);
  }
  const lines = [`${code}: ${message}`, `Effect: ${effect}`];
  if (refs.operation_id) lines.push(`Operation: ${refs.operation_id}`);
  if (refs.agent_id) lines.push(`Agent: ${refs.agent_id}`);
  if (refs.result_ref) lines.push(`Result: ${refs.result_ref}`);
  if (nextAction) lines.push(`Next: ${nextAction.tool}`);

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: {
      code,
      message,
      effect,
      ...(refs.operation_id ? { operation_id: refs.operation_id } : {}),
      ...(refs.agent_id ? { agent_id: refs.agent_id } : {}),
      ...(refs.result_ref ? { result_ref: refs.result_ref } : {}),
      ...(nextAction ? { next_action: nextAction } : {}),
    },
    isError: true,
  };
}

export function truncateResult(text: string, cursor = 0, maxBytes = 12 * 1024): TruncatedResult {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("RESULT_BYTE_BUDGET_INVALID");
  const page = textPage(text, cursor, maxBytes);
  return {
    text: page.text,
    cursor: page.offset,
    next_cursor: page.nextOffset,
    total_code_points: page.totalCodePoints,
    truncated: page.nextOffset !== null,
  };
}

function conciseOperationSummary(
  operation: OperationReplyInput,
  payload: Record<string, unknown>,
): string {
  const label = operation.label ?? operation.kind ?? "Operation";
  const lines = [`${label}: ${operation.state} (${operation.effect}).`];
  const message = firstString(payload.summary, payload.message, payload.result);
  if (message) {
    const page = textPage(message, 0, 4 * 1024);
    lines.push(page.text);
    if (page.nextOffset !== null) lines.push(`Result continues at cursor ${page.nextOffset}.`);
  }
  if (operation.error_code || operation.error_message) {
    lines.push(`${operation.error_code ?? "ERROR"}: ${operation.error_message ?? "Operation failed."}`);
  }
  if (payload.exit_code !== undefined && payload.exit_code !== null) {
    lines.push(`Exit code: ${String(payload.exit_code)}`);
  }
  const nextCursor = payload.next_cursor ?? payload.next_offset;
  if (nextCursor !== undefined && nextCursor !== null) {
    lines.push(`Next cursor: ${String(nextCursor)}`);
  }
  if (operation.result_ref) lines.push(`Result reference: ${operation.result_ref}`);
  return lines.join("\n");
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function stripPrivatePayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stripPrivatePayload(item));
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (PRIVATE_PAYLOAD_KEYS.has(key)) continue;
    result[key] = stripPrivatePayload(item);
  }
  return result;
}
