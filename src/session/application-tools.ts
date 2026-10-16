import { executionObservationSchema } from "./schema.js";
import { projectionForCard } from './card-contract.js';
import * as z from "zod/v4";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerConfig } from "../config.js";
import { jsonReply } from "../bounded-reply.js";
import { workspaceHandle } from "../federation/routing.js";
import {
  ExecutionState,
  HostState,
  type AgentSummary,
  type FileSummary,
  type SessionId,
  type SessionMember,
  type SessionRecord,
} from "./types.js";
import { appSchemas } from "./schema.js";
import type { SessionOutputStore } from "./output.js";
import type { SessionProjector } from "./projection.js";
import type { SessionChangeCollector } from "./changes.js";
import type { ContextReadRecorder } from "./context-reads.js";
import type { SessionReverter } from "./revert.js";
import type { SessionStore } from "./store.js";

export interface SessionAppToolDependencies {
  config: ServerConfig;
  store: SessionStore;
  projector: SessionProjector;
  changes: SessionChangeCollector;
  output: SessionOutputStore;
  context: ContextReadRecorder;
  reverter: SessionReverter;
}

interface AppCallContext {
  authInfo?: {
    clientId?: string;
    extra?: Record<string, unknown>;
  };
  sessionId?: string;
  requestId?: string | number;
}

interface AuthorizedSession {
  session: SessionRecord;
  member: SessionMember;
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const;

export function registerSessionAppTools(
  server: Pick<McpServer, "registerTool">,
  dependencies: SessionAppToolDependencies,
): void {
  const owner = (extra: AppCallContext): string => {
    const value = extra.authInfo?.extra?.owner_id;
    if (typeof value !== "string" || value.length === 0) {
      throw new Error("MISSING_AUTHENTICATED_OWNER");
    }
    return value;
  };

  const authorizedSession = (ownerId: string, sessionId: SessionId): AuthorizedSession => {
    const session = dependencies.store.requireSession(ownerId, sessionId);
    const member = session.members.find((item) => item.id === session.selected_member_id) ?? session.members[0];
    if (!member) throw new Error(`SESSION_MEMBER_NOT_FOUND: ${sessionId}`);
    return { session, member };
  };

  const authorizedSessionRecord = (ownerId: string, sessionId: SessionId): SessionRecord => {
    return dependencies.store.requireSession(ownerId, sessionId);
  };

  const bindTask = (ownerId: string, input: { session_id: string; task_id?: string }): void => {
    const session = dependencies.store.requireSession(ownerId, input.session_id);
    const task = input.task_id ? dependencies.store.getTask(input.task_id) : dependencies.store.currentTask(session.id);
    if (task && task.session_id !== session.id) throw new Error(`TASK_SESSION_MISMATCH: ${task.id}`);
    if (task) input.task_id = task.id;
  };

  const memberForRequest = (
    authorized: AuthorizedSession,
    memberId: string | undefined,
  ): SessionMember => {
    if (!memberId) return authorized.member;
    const member = authorized.session.members.find((item) => item.id === memberId);
    if (!member) throw new Error(`MEMBER_NOT_IN_SESSION: ${memberId}`);
    return member;
  };

  registerAppTool(
    server,
    "qm_widget_stage",
    {
      title:"Record Task Card lifecycle stage",
      description:"Records bounded Task Card delivery stages. It never records chat text, commands, files, or a heartbeat.",
      inputSchema:{
        session_id:z.string().min(1),task_id:z.string().min(1),member_id:z.string().min(1).optional(),
        stage:z.enum(["mount","initialized","first_snapshot","visible","hidden","teardown","error"]),
        resource_version:z.string().min(1).max(64),mount_id:z.string().uuid().optional(),display_mode:z.string().max(32).optional(),visible:z.boolean().optional(),
      },
      outputSchema:z.object({recorded:z.literal(true)}),
      _meta:{ui:{visibility:["app"]}},annotations:READ_ONLY,
    },
    async(input,extra)=>{
      const ownerId=owner(extra as AppCallContext);
      const session=dependencies.store.requireSession(ownerId,input.session_id);
      const task=dependencies.store.getTask(input.task_id);
      if(task.session_id!==session.id)throw new Error("TASK_SESSION_MISMATCH");
      // 已挂载的旧卡片会附带所选工作区；接受已授权身份，不把它当新执行。
      if(input.member_id&&!dependencies.store.findMember(session.id,input.member_id))throw new Error("MEMBER_NOT_IN_SESSION");
      dependencies.store.recordWidgetStage({taskId:task.id,sessionId:session.id,stage:input.stage,
        resourceVersion:input.resource_version,mountId:input.mount_id,displayMode:input.display_mode,visible:input.visible});
      return jsonReply({recorded:true});
    },
  );

  registerAppTool(
    server,
    "qm_session",
    {
      title: "Read session snapshot",
      description: "Reads the latest locally stored session snapshot without refreshing workspace state.",
      inputSchema: appSchemas.session,
      outputSchema: sessionOutputSchema(),
      _meta: { ui: { visibility: ["app"] } },
      annotations: READ_ONLY,
    },
    async (input, extra) => {
      const ownerId = owner(extra as AppCallContext);
      bindTask(ownerId, input);
      if (input.task_id) {
        const task = dependencies.store.getTask(input.task_id);
        if (task.session_id !== input.session_id) throw new Error(`TASK_SESSION_MISMATCH: ${input.task_id}`);
        dependencies.store.requireSession(ownerId, input.session_id);
        const result=projectionForCard(await dependencies.projector.readTask(input.task_id, input.since_rev, input.member_id, input.cursor), input.resource_version);
        if(input.mount_id&&input.resource_version){
          dependencies.store.recordWidgetStage({taskId:task.id,sessionId:task.session_id,stage:"mount",
            resourceVersion:input.resource_version,mountId:input.mount_id});
          if(result.unchanged===true||result.snapshot){
            dependencies.store.recordWidgetStage({taskId:task.id,sessionId:task.session_id,stage:"first_snapshot",
              resourceVersion:input.resource_version,mountId:input.mount_id});
          }
        }
        return jsonReply({...result});
      }
      if (!input.member_id) {
        const session = authorizedSessionRecord(ownerId, input.session_id);
        return jsonReply({...projectionForCard(await dependencies.projector.readSession(session.id, input.since_rev, input.cursor), input.resource_version)});
      }
      const authorized = authorizedSession(ownerId, input.session_id);
      const member = memberForRequest(authorized, input.member_id);
      return jsonReply({...projectionForCard(await dependencies.projector.read(authorized.session.id, member.id, input.since_rev, input.cursor), input.resource_version)});
    },
  );

  registerAppTool(
    server,
    "qm_file_diff",
    {
      title: "Read file diff",
      description: "Reads the stored diff for one file version already recorded in this session.",
      inputSchema: appSchemas.file_diff,
      outputSchema: z.object({
        patch: z.string().optional(),
        note: z.string().optional(),
        cursor: z.string().nullable(),
        done: z.boolean(),
      }),
      _meta: { ui: { visibility: ["app"] } },
      annotations: READ_ONLY,
    },
    async (input, extra) => {
      const ownerId = owner(extra as AppCallContext);
      bindTask(ownerId, input);
      const authorized = authorizedSession(ownerId, input.session_id);
      const member = memberForRequest(authorized, input.member_id);
      const { file, patch } = input.task_id
        ? await dependencies.changes.fileDiffForTask(input.task_id, authorized.session.id, input.file_id, input.hash)
        : await dependencies.changes.fileDiff(authorized.session.id, input.file_id, input.hash);
      if (file.member_id !== member.id) throw new Error(`FILE_NOT_IN_MEMBER: ${input.file_id}`);
      const page = pageTextForFileDiff(patch, input.cursor ?? "0");
      return jsonReply({
        patch: page.text,
        ...(file.binary ? { note: "Binary file change; textual diff is unavailable." } : {}),
        cursor: page.cursor,
        done: page.cursor === null,
      });
    },
  );

  registerAppTool(
    server,
    "qm_command_output",
    {
      title: "Read command output",
      description: "Reads command output using an independent view cursor. This never consumes model output.",
      inputSchema: appSchemas.command_output,
      outputSchema: z.object({
        chunk: z.string(),
        cursor: z.number().int().nonnegative(),
        done: z.boolean(),
        truncated: z.boolean().optional(),
        retained_from: z.number().int().nonnegative().optional(),
      }),
      _meta: { ui: { visibility: ["app"] } },
      annotations: READ_ONLY,
    },
    async (input, extra) => {
      const ownerId = owner(extra as AppCallContext);
      bindTask(ownerId, input);
      const authorized = authorizedSession(ownerId, input.session_id);
      const requestedMember = memberForRequest(authorized, input.member_id);
      const events = input.task_id
        ? dependencies.store.eventsForTask(input.task_id)
        : dependencies.store.eventsForSession(authorized.session.id);
      const command = events.find((event) => {
        if (event.type !== "operation_started" && event.type !== "operation_finished") return false;
        const operationId = String(event.payload.operation_id ?? event.source_id);
        const commandId = String(event.payload.command_id ?? operationId);
        return operationId === input.command_id || commandId === input.command_id;
      });
      if (!command) throw new Error(`COMMAND_NOT_FOUND: ${input.command_id}`);
      if (command.member_id !== requestedMember.id) throw new Error(`COMMAND_NOT_IN_MEMBER: ${input.command_id}`);
      const commandId = String(command.payload.command_id ?? command.payload.operation_id ?? command.source_id);
      const result = await dependencies.output.uiRead(
        authorized.session.id,
        commandId,
        input.cursor,
        input.max_bytes,
      );
      return jsonReply({
        chunk: result.chunk,
        cursor: result.nextCursor,
        done: result.done,
        ...(result.truncated ? { truncated: true } : {}),
        ...(result.retainedFrom > 0 ? { retained_from: result.retainedFrom } : {}),
      });
    },
  );

  registerAppTool(server,"qm_command_outputs",{
    title:"Read visible command output pages",
    description:"Reads up to eight opened command outputs in one workspace without consuming other readers.",
    inputSchema:z.object({
      session_id:z.string().min(1),task_id:z.string().min(1).optional(),member_id:z.string().min(1),
      commands:z.array(z.object({command_id:z.string().min(1),cursor:z.number().int().nonnegative()}).strict()).min(1).max(8),
    }).strict(),
    outputSchema:z.object({results:z.array(z.object({command_id:z.string(),chunk:z.string().optional(),
      cursor:z.number().optional(),done:z.boolean().optional(),truncated:z.boolean().optional(),
      retained_from:z.number().optional(),error:z.string().optional()})),partial:z.boolean()}),
    _meta:{ui:{visibility:["app"]}},annotations:READ_ONLY,
  },async(input,extra)=>{
    const ownerId=owner(extra as AppCallContext);
    bindTask(ownerId,input);
    const authorized=authorizedSession(ownerId,input.session_id);
    const member=memberForRequest(authorized,input.member_id);
    const events=input.task_id?dependencies.store.eventsForTask(input.task_id):dependencies.store.eventsForSession(input.session_id);
    for(const request of input.commands) {
      const event=events.find(e=>String(e.payload.command_id ?? e.payload.operation_id ?? e.source_id)===request.command_id);
      if(!event||event.member_id!==member.id)throw new Error(`COMMAND_NOT_IN_MEMBER: ${request.command_id}`);
    }
    const budget=Math.floor(10000/input.commands.length);
    const results=await Promise.all(input.commands.map(async request=>{
      try {
        const page=await dependencies.output.uiRead(authorized.session.id,request.command_id,request.cursor,budget);
        return {command_id:request.command_id,chunk:page.chunk,cursor:page.nextCursor,done:page.done,
          truncated:page.truncated,retained_from:page.retainedFrom};
      } catch(error) {
        return {command_id:request.command_id,error:error instanceof Error?error.message:String(error)};
      }
    }));
    return jsonReply({results,partial:results.some(result=>"error" in result)});
  });

  registerAppTool(
    server,
    "qm_instruction",
    {
      title: "Read session instruction",
      description: "Reads an instruction file already advertised for this session.",
      inputSchema: appSchemas.instruction,
      outputSchema: z.object({
        content: z.string().optional(),
        observed_at: z.string().nullable().optional(),
        scope: z.string().optional(),
      }),
      _meta: { ui: { visibility: ["app"] } },
      annotations: READ_ONLY,
    },
    async (input, extra) => {
      const ownerId = owner(extra as AppCallContext);
      bindTask(ownerId, input);
      const authorized = authorizedSession(ownerId, input.session_id);
      const member = memberForRequest(authorized, input.member_id);
      const result = await dependencies.context.readForCard(
        authorized.session.id,
        member.id,
        input.path,
        input.task_id,
      );
      if (!result) throw new Error(input.task_id && dependencies.store.getTask(input.task_id).state === "closed"
        ? `TASK_CONTEXT_NOT_CAPTURED: ${input.path}`
        : `INSTRUCTION_NOT_FOUND: ${input.path}`);
      const known = dependencies.store
        .contextReads(authorized.session.id, member.id)
        .find((row) => row.path === result.path);
      return jsonReply({
        content: result.content,
        observed_at: known?.observed_at ?? null,
        scope: known?.kind === "instruction" ? "workspace" : undefined,
      });
    },
  );

  registerAppTool(
    server,
    "qm_patch",
    {
      title: "Read cumulative patch",
      description: "Reads the cumulative patch recorded for this session member.",
      inputSchema: appSchemas.patch,
      outputSchema: z.object({
        patch: z.string(),
        cursor: z.string().nullable(),
        done: z.boolean(),
      }),
      _meta: { ui: { visibility: ["app"] } },
      annotations: READ_ONLY,
    },
    async (input, extra) => {
      const ownerId = owner(extra as AppCallContext);
      bindTask(ownerId, input);
      const authorized = authorizedSession(ownerId, input.session_id);
      const member = memberForRequest(authorized, input.member_id);
      const result = input.task_id
        ? await dependencies.changes.patchForTask(input.task_id, authorized.session.id, member.id, input.cursor)
        : await dependencies.changes.patch(authorized.session.id, member.id, input.cursor);
      return jsonReply({
        patch: result.patch,
        cursor: result.nextCursor,
        done: result.nextCursor === null,
      });
    },
  );

  registerAppTool(
    server,
    "qm_revert",
    {
      title: "Revert session changes",
      description: "Reverts only changes owned by this session after confirming the exact session revision.",
      inputSchema: appSchemas.revert,
      outputSchema: z.object({
        ok: z.literal(true),
        rev: z.number().int().nonnegative(),
        changed_files: z.array(z.string()),
      }),
      _meta: { ui: { visibility: ["app"] } },
      annotations: DESTRUCTIVE,
    },
    async (input, extra) => {
      const ownerId = owner(extra as AppCallContext);
      bindTask(ownerId, input);
      const authorized = authorizedSession(ownerId, input.session_id);
      if (input.task_id && dependencies.store.getTask(input.task_id).state === "closed") {
        throw new Error(`TASK_IS_HISTORICAL: ${input.task_id}`);
      }
      const member = memberForRequest(authorized, input.member_id);
      const result = await dependencies.reverter.revert(
        ownerId,
        input.session_id,
        member.id,
        input.expected_rev,
        input.confirm,
        undefined,
        input.task_id,
      );
      return jsonReply({
        ok: true as const,
        rev: result.revision,
        changed_files: result.changed_paths,
      });
    },
  );

  registerAppTool(
    server,
    "qm_file_url",
    {
      title: "Build file link",
      description: "Returns an authenticated Console project link for a file recorded in this session. It does not open an editor.",
      inputSchema: appSchemas.file_url,
      outputSchema: z.object({ url: z.string() }),
      _meta: { ui: { visibility: ["app"] } },
      annotations: READ_ONLY,
    },
    async (input, extra) => {
      const ownerId = owner(extra as AppCallContext);
      bindTask(ownerId, input);
      const authorized = authorizedSession(ownerId, input.session_id);
      const member = memberForRequest(authorized, input.member_id);
      const found = input.task_id
        ? findTaskFile(dependencies.store, input.task_id, authorized.session.id, member.id, input.path)
        : findSessionFile(dependencies.store, authorized.session.id, member.id, input.path);
      const base = dependencies.config.publicBaseUrl.replace(/\/+$/, "");
      const url = new URL(`${base}/console/`);
      url.searchParams.set("session", authorized.session.id);
      url.searchParams.set("root", found.member.root);
      url.searchParams.set("file", found.file.path);
      const runId = dependencies.store.runIdsForMember(authorized.session.id, member.id, input.task_id)[0];
      if (!runId) throw new Error("SESSION_RUN_NOT_FOUND");
      url.hash = "/changes?" + new URLSearchParams({ run: workspaceHandle(member.node_id, runId), tab: "diff", file: found.file.id });
      return jsonReply({ url: url.href });
    },
  );

  registerAppTool(
    server,
    "qm_session_continue",
    {
      title: "Prepare continuation message",
      description: "Builds a short continuation message for the user. It does not start model inference.",
      inputSchema: appSchemas.continue,
      outputSchema: z.object({
        message: z.string(),
        session_id: z.string(),
        agent_id: z.string().optional(),
        result_ref: z.string().optional(),
      }),
      _meta: { ui: { visibility: ["app"] } },
      annotations: READ_ONLY,
    },
    async (input, extra) => {
      const ownerId = owner(extra as AppCallContext);
      bindTask(ownerId, input);
      const authorized = authorizedSession(ownerId, input.session_id);
      const member = memberForRequest(authorized, input.member_id);
      const agent = continuationAgent(dependencies.store, authorized.session.id, member.id, input.agent_id);
      const pendingHostContinuation = authorized.session.execution_state === ExecutionState.active
        && authorized.session.host_state === HostState.disconnected;
      if (!agent && !pendingHostContinuation) {
        throw new Error("NO_CONTINUATION_RESULT");
      }
      const resultRef = agent?.result_ref ?? undefined;
      const parts = [`继续处理会话 ${authorized.session.id}`];
      if (agent?.id) parts.push(`代理 ${agent.id}`);
      if (resultRef) parts.push(`先读取结果 ${resultRef}`);
      return jsonReply({
        message: `${parts.join("；")}。`,
        session_id: authorized.session.id,
        ...(agent?.id ? { agent_id: agent.id } : {}),
        ...(resultRef ? { result_ref: resultRef } : {}),
      });
    },
  );
}

function continuationAgent(
  store: SessionStore,
  sessionId: string,
  memberId: string,
  agentId?: string,
): AgentSummary | null {
  const events = store.eventsForSession(sessionId).filter((event) => event.type === "agent_changed" && event.member_id === memberId);
  const candidates = events
    .map((event) => agentFromEvent(event))
    .filter((agent): agent is AgentSummary => agent !== null)
    .filter((agent) => agent.result_available);
  if (agentId) return candidates.find((agent) => agent.id === agentId) ?? null;
  return candidates.at(-1) ?? null;
}

function agentFromEvent(event: {
  member_id: string;
  source_id: string;
  timestamp: string;
  payload: Record<string, unknown>;
}): AgentSummary | null {
  const id = event.payload.agent_id ?? event.payload.agentId ?? event.source_id;
  if (typeof id !== "string" || id.length === 0) return null;
  const state = typeof event.payload.state === "string" ? event.payload.state : "unknown";
  const resultRef = typeof event.payload.result_ref === "string" ? event.payload.result_ref : null;
  return {
    id,
    member_id: event.member_id,
    role: event.payload.role === "main" ? "main" : "subagent",
    name: typeof event.payload.name === "string" ? event.payload.name : id,
    provider: typeof event.payload.provider === "string" ? event.payload.provider : "unknown",
    model: typeof event.payload.model === "string" ? event.payload.model : null,
    effort: typeof event.payload.effort === "string" ? event.payload.effort : null,
    state: state === "completed" ? "done" : state === "running" ? "working" : state === "failed" ? "failed" : state === "cancelled" ? "cancelled" : state === "queued" ? "queued" : "unknown",
    task: typeof event.payload.task === "string" ? event.payload.task : "",
    tokens: typeof event.payload.tokens === "number" ? event.payload.tokens : null,
    usage_quality: "unavailable",
    startedAt: Date.parse(event.timestamp),
    endedAt: null,
    steps: null,
    result_available: resultRef !== null,
    result_ref: resultRef,
  };
}

function findSessionFile(
  store: SessionStore,
  sessionId: string,
  memberId: string,
  requestedPath: string,
): { file: FileSummary & { patchRef: string; versionRef: string }; member: SessionMember } {
  const member = store.getMember(sessionId, memberId);
  const normalized = requestedPath.replaceAll("\\", "/");
  const file = store
    .fileSummaries(sessionId, member.id)
    .find((item) => item.path.replaceAll("\\", "/") === normalized && item.coverage === "session_owned");
  if (!file) throw new Error(`FILE_NOT_IN_SESSION: ${requestedPath}`);
  return { file, member };
}

function findTaskFile(
  store: SessionStore,
  taskId: string,
  sessionId: string,
  memberId: string,
  requestedPath: string,
): { file: FileSummary & { patchRef: string; versionRef: string }; member: SessionMember } {
  const task = store.getTask(taskId);
  if (task.session_id !== sessionId) throw new Error(`TASK_SESSION_MISMATCH: ${taskId}`);
  const member = store.getMember(sessionId, memberId);
  const normalized = requestedPath.replaceAll("\\", "/");
  const files = task.state === "closed"
    ? store.getTaskSnapshot(taskId, memberId)?.files ?? []
    : store.fileSummaries(sessionId, memberId,taskId);
  const file = files.find((item) => item.path.replaceAll("\\", "/") === normalized && item.coverage === "session_owned");
  if (!file) throw new Error(`FILE_NOT_IN_TASK: ${requestedPath}`);
  return { file, member };
}

function sessionOutputSchema() {
  return z.union([
    z.object({ unchanged: z.literal(true), rev: z.number().int(), observation:executionObservationSchema.optional() }),
    z.object({
      unchanged: z.literal(false),
      rev: z.number().int(),
      snapshot: z.unknown(),
      observation:executionObservationSchema.optional(),
    }),
  ]);
}

function pageTextForFileDiff(text: string, cursor: string): { text: string; cursor: string | null } {
  const offset = Number(cursor);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("FILE_DIFF_CURSOR_INVALID");
  const points = Array.from(text);
  const maximum = 12 * 1024;
  let low = 0;
  let high = Math.min(points.length - offset, maximum);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(points.slice(offset, offset + middle).join(""), "utf8") <= maximum) low = middle;
    else high = middle - 1;
  }
  const next = offset + low;
  return {
    text: points.slice(offset, next).join(""),
    cursor: next < points.length ? String(next) : null,
  };
}
