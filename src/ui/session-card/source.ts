import { executionObservationSchema, snapshotLiveStateSchema } from "../../session/schema.js";
import { WORKSPACE_APP_VERSION, type CardVersion } from '../../session/card-contract.js';
import type { App } from "@modelcontextprotocol/ext-apps";
import { snapshotFromSchema } from "./snapshot.js";
import type { Snapshot } from "../../session/types.js";
import type { TaskMessagePage, TaskMessageReceipt } from "../../messaging/task-message-types.js";
import * as z from "zod/v4";
import type { TaskBindingState, TaskBindingView } from "../../tasks/task-binding.js";
import { taskBindingErrorCode } from "./task-binding.js";

export interface FileDiffPage {
  patch?: string;
  note?: string;
  cursor: string | null;
  done: boolean;
}

export interface CommandOutputPage {
  chunk: string;
  cursor: number;
  done: boolean;
  truncated?: boolean;
  retained_from?: number;
}

export interface InstructionContent {
  content?: string;
  observed_at?: string | null;
  scope?: string;
}

export interface PatchPage {
  patch: string;
  cursor: string | null;
  done: boolean;
}

export interface RevertResult {
  ok: true;
  rev: number;
  changed_files: string[];
}

export interface ContinuationContent {
  message: string;
  session_id: string;
  task_id: string;
  agent_id?: string;
  result_ref?: string;
}

export interface OutputRequest {command_id:string;member_id:string;cursor:number}
export type OutputBatchRow = {command_id:string;error?:string} & Partial<CommandOutputPage>;

export interface SessionCardSource {
  readonly live: boolean;
  readonly supportsHostMessage?: boolean;
  readonly taskBinding?: TaskBindingState | null;
  snapshot(sinceRev: number, signal?: AbortSignal, memberId?: string, cursor?: string): Promise<Snapshot | null>;
  fileDiff(fileId: string, hash: string, cursor?: string, signal?: AbortSignal): Promise<FileDiffPage>;
  commandOutput(commandId: string, cursor: number, signal?: AbortSignal): Promise<CommandOutputPage>;
  commandOutputs(commands:OutputRequest[]):Promise<OutputBatchRow[]>;
  instruction(path: string, signal?: AbortSignal): Promise<InstructionContent>;
  patch(cursor: string | undefined, signal?: AbortSignal): Promise<PatchPage>;
  revert(expectedRev: number): Promise<RevertResult>;
  openFile(path: string): Promise<void>;
  openLink(url: string): Promise<void>;
  continueSession(agentId?: string): Promise<void>;
  taskMessages?(beforeSequence?: number, signal?: AbortSignal): Promise<TaskMessagePage>;
  enqueueTaskMessage?(messageKey: string, body: string, signal?: AbortSignal): Promise<TaskMessageReceipt>;
  inspectTaskBinding?(signal?: AbortSignal): Promise<TaskBindingView>;
  resumeTask?(expectedRevision: number, requestKey: string, signal?: AbortSignal): Promise<TaskBindingView>;
  requestHostTaskResume?(): Promise<void>;
  widgetStage(stage:"mount"|"initialized"|"first_snapshot"|"visible"|"hidden"|"teardown"|"error",options?:{displayMode?:string;visible?:boolean}):Promise<void>;
  dispose(): void;
}

type ToolName =
  | "qm_session"
  | "qm_file_diff"
  | "qm_command_output"
  | "qm_command_outputs"
  | "qm_instruction"
  | "qm_patch"
  | "qm_revert"
  | "qm_file_url"
  | "qm_session_continue"
  | "qm_task_messages"
  | "qm_task_message_enqueue"
  | "task_resume"
  | "qm_widget_stage";

export function createMcpSource(
  app: App,
  sessionId: string,
  taskId: string | undefined,
  initialSnapshot?: Snapshot,
  resourceVersion: CardVersion = WORKSPACE_APP_VERSION,
): SessionCardSource {
  if (!app.getHostCapabilities()?.serverTools) {
    throw new Error("SESSION_CARD_SERVER_TOOLS_REQUIRED");
  }
  let disposed = false;
  let currentSnapshot=initialSnapshot;
  const mountId = crypto.randomUUID();
  let mountSnapshotPending = true;
  let activeMemberId: string | undefined;
  let currentTaskBinding: TaskBindingState | null = null;
  let bindingGeneration = 0;
  let activeBindingRequest: number | null = null;
  const activeControllers = new Set<AbortController>();

  async function call<T>(
    name: ToolName,
    args: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<T> {
    if (disposed) throw new Error("SESSION_CARD_SOURCE_DISPOSED");
    // Page reads may continue during an explicit inspect/resume, but cannot
    // supersede that action's authority with an observation made before it commits.
    const bindingRequest = name === "task_resume" || name === "qm_session" && activeBindingRequest === null
      ? ++bindingGeneration : undefined;
    if (name === "task_resume") activeBindingRequest = bindingRequest!;
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    activeControllers.add(controller);
    const timeout=setTimeout(()=>controller.abort(new Error('SESSION_CARD_REQUEST_TIMEOUT')),name==='qm_revert'?60_000:15_000);
    try {
      const result = await app.callServerTool(
        {
          name,
          arguments: name === "qm_task_messages" || name === "qm_task_message_enqueue" || name === "task_resume" ? { ...args, task_id: taskId } : {
            session_id: sessionId,
            ...(taskId ? { task_id: taskId } : {}),
            ...(activeMemberId && name !== "qm_widget_stage" ? { member_id: activeMemberId } : {}),
            ...args,
          },
        },
        { signal: controller.signal },
      );
      if (disposed || controller.signal.aborted) throw controller.signal.reason ?? new Error("SESSION_CARD_REQUEST_CANCELLED");
      if (result.isError) {
        const message = result.content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("\n");
        const error=new Error(message || `${name} failed`) as Error & {retryAfterMs?:number;code?:string};
        const retry=(result.structuredContent as {retry_after_ms?:number}|undefined)?.retry_after_ms;
        if(typeof retry==="number")error.retryAfterMs=retry;
        const code=(result.structuredContent as {error_code?:unknown}|undefined)?.error_code;
        error.code=typeof code==="string"?code:taskBindingErrorCode(error)||undefined;
        throw error;
      }
      if (!result.structuredContent) {
        throw new Error(`${name}: missing structuredContent`);
      }
      if (bindingRequest !== undefined) {
        const binding = name === "task_resume"
          ? resumeBinding(result.structuredContent, taskId, sessionId)
          : bindingFromMeta(result._meta, taskId);
        // A late poll or page cannot replace a newer resume/inspect response.
        if (bindingRequest === bindingGeneration) currentTaskBinding = binding;
      }
      return result.structuredContent as T;
    } catch (error) {
      if (bindingRequest === bindingGeneration) currentTaskBinding = null;
      throw error;
    } finally {
      if (name === "task_resume" && activeBindingRequest === bindingRequest) activeBindingRequest = null;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      activeControllers.delete(controller);
    }
  }

  return {
    live: true,
    supportsHostMessage: Boolean(app.getHostCapabilities()?.message),
    get taskBinding() { return currentTaskBinding; },
    async snapshot(sinceRev, signal, memberId, cursor) {
      if (disposed) throw new Error("SESSION_CARD_SOURCE_DISPOSED");
      activeMemberId = memberId;
      const requestedMemberId = activeMemberId;
      const result = await call<{ unchanged: boolean; rev?: number; snapshot?: unknown; observation?:Snapshot['executionObservation']; live?:Snapshot['live'] }>(
        "qm_session",
        // 历史资源地址可以装载新渲染器；协议能力由当前代码声明。
        // The bootstrap may have been serialized for an older cached reader.
        // Negotiate this renderer's complete shape once, even at the same revision.
        { since_rev: mountSnapshotPending ? -1 : sinceRev, resource_version: WORKSPACE_APP_VERSION, file_recorded_at: true,
          ...(memberId ? { member_id: memberId } : {}), ...(cursor ? { cursor } : {}),
          ...(taskId && mountSnapshotPending ? { mount_id: mountId } : {}) },
        signal,
      );
      if (requestedMemberId !== activeMemberId) return null;
      if(result.unchanged){
        if(mountSnapshotPending)throw new Error("SESSION_CARD_FIRST_SNAPSHOT_UNCONFIRMED");
        if(!currentSnapshot||!result.observation&&!result.live)return null;
        const live=result.live?snapshotLiveStateSchema.parse(result.live):undefined;
        currentSnapshot=snapshotFromSchema({...currentSnapshot,
          ...(result.observation?{executionObservation:executionObservationSchema.parse(result.observation)}:{}),
          ...(live?{live,serverNow:live.observedAt,host_status:live.hostStatus,execution_status:live.executionStatus}:{})});
        return currentSnapshot;
      }
      const next=snapshotFromSchema(result.snapshot);
      if(next.sessionId!==sessionId||taskId&&next.taskId!==taskId)throw new Error("SESSION_CARD_SNAPSHOT_IDENTITY_MISMATCH");
      if(mountSnapshotPending&&next.rev<sinceRev&&(!currentSnapshot||currentSnapshot.workspace?.id===next.workspace?.id))
        throw new Error("SESSION_CARD_FIRST_SNAPSHOT_STALE");
      currentSnapshot=next;
      mountSnapshotPending = false;
      return currentSnapshot;
    },
    fileDiff: (fileId, hash, cursor, signal) => call<FileDiffPage>(
      "qm_file_diff",
      { file_id: fileId, hash, ...(cursor ? { cursor } : {}) },
      signal,
    ),
    commandOutput: (commandId, cursor, signal) => call<CommandOutputPage>(
      "qm_command_output",
      { command_id: commandId, cursor, max_bytes: 16384 },
      signal,
    ),
    async commandOutputs(commands) {
      const groups=new Map<string,OutputRequest[]>();
      for(const request of commands) {
        const rows=groups.get(request.member_id) ?? [];
        rows.push(request);groups.set(request.member_id,rows);
      }
      const results:OutputBatchRow[]=[];
      for(const [member_id,rows] of groups) {
        for(let offset=0;offset<rows.length;offset+=8) {
          const response=await call<{results:OutputBatchRow[]}>("qm_command_outputs",{
            member_id,commands:rows.slice(offset,offset+8).map(({command_id,cursor})=>({command_id,cursor})),
          });
          results.push(...response.results);
        }
      }
      return results;
    },
    instruction: (path, signal) => call<InstructionContent>(
      "qm_instruction",
      { path },
      signal,
    ),
    patch: (cursor, signal) => call<PatchPage>(
      "qm_patch",
      cursor ? { cursor } : {},
      signal,
    ),
    async revert(expectedRev) {
      return call<RevertResult>("qm_revert", {
        expected_rev: expectedRev,
        confirm: true,
      });
    },
    async openFile(path) {
      const result = await call<{ url: string }>("qm_file_url", { path });
      const opened = await app.openLink({ url: result.url });
      if (opened.isError) throw new Error("OPEN_FILE_REJECTED");
    },
    async openLink(url) {
      const opened = await app.openLink({ url });
      if (opened.isError) throw new Error("OPEN_LINK_REJECTED");
    },
    async continueSession(agentId) {
      if (!taskId) throw new Error("SESSION_CARD_TASK_REQUIRED");
      if (!app.getHostCapabilities()?.message) throw new Error("SESSION_CARD_HOST_MESSAGE_UNAVAILABLE");
      const continuation = await call<ContinuationContent>(
        "qm_session_continue",
        agentId ? { agent_id: agentId } : {},
      );
      if (continuation.task_id !== taskId || continuation.session_id !== sessionId) {
        throw new Error("SESSION_CARD_CONTINUATION_IDENTITY_MISMATCH");
      }
      const sent = await app.sendMessage({
        role: "user",
        content: [{ type: "text", text: continuation.message }],
      });
      if (sent.isError) throw new Error("CONTINUE_MESSAGE_REJECTED");
    },
    ...(taskId ? {
      async inspectTaskBinding(signal?: AbortSignal) {
        const result = await call<{ binding: TaskBindingView }>("task_resume", { action: "inspect" }, signal);
        return result.binding;
      },
      async resumeTask(expectedRevision: number, requestKey: string, signal?: AbortSignal) {
        const result = await call<{ binding: TaskBindingView }>("task_resume", {
          action: "resume", expected_binding_revision: expectedRevision, request_key: requestKey,
        }, signal);
        return result.binding;
      },
      async requestHostTaskResume() {
        if (disposed) throw new Error("SESSION_CARD_SOURCE_DISPOSED");
        if (!app.getHostCapabilities()?.message) throw new Error("SESSION_CARD_HOST_MESSAGE_UNAVAILABLE");
        const sent = await app.sendMessage({ role: "user", content: [{ type: "text", text:
          `请核对并恢复同一 QuayMesh 任务 ${taskId}，不要创建新任务。先调用 task_resume(${JSON.stringify({ action: "inspect", task_id: taskId })})；`
          + "若仍可恢复，使用返回的 binding_revision 和稳定 request_key 调用 action=resume，同一次请求超时后沿用原参数。恢复后先告知结果，等待我明确要求再执行后续任务。" }] });
        if (sent.isError) throw new Error("TASK_RESUME_HOST_MESSAGE_REJECTED");
      },
      async taskMessages(beforeSequence?: number, signal?: AbortSignal) {
        const page = await call<TaskMessagePage>("qm_task_messages", {
          limit: 20, ...(beforeSequence === undefined ? {} : { before_sequence: beforeSequence }),
        }, signal);
        if (page.task_id !== taskId) throw new Error("TASK_MESSAGES_IDENTITY_MISMATCH");
        return page;
      },
      async enqueueTaskMessage(messageKey: string, body: string, signal?: AbortSignal) {
        const receipt = await call<TaskMessageReceipt>("qm_task_message_enqueue", { message_key: messageKey, body }, signal);
        if (receipt.task_id !== taskId) throw new Error("TASK_MESSAGE_RECEIPT_MISMATCH");
        return receipt;
      },
    } : {}),
    async widgetStage(stage,options={}) {
      await call<{recorded:true}>("qm_widget_stage",{stage,resource_version:resourceVersion,mount_id:mountId,
        ...(options.displayMode ? { display_mode:options.displayMode } : {}),
        ...(options.visible===undefined ? {} : { visible:options.visible })});
    },
    dispose() {
      disposed = true;
      bindingGeneration++;
      activeBindingRequest = null;
      currentTaskBinding = null;
      for (const controller of activeControllers) controller.abort();
      activeControllers.clear();
    },
  };
}

const bindingId = z.string().min(1).max(256);
const bindingSchema = z.discriminatedUnion("entry_available", [
  z.object({ task_id: bindingId, entry_available: z.literal(true),
    binding_revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), selected_task_id: bindingId.nullable(),
    status: z.enum(["selected", "unbound", "different_task", "closed", "finalizing"]),
    can_resume: z.boolean(), can_continue: z.boolean() }),
  z.object({ task_id: bindingId, entry_available: z.literal(false), binding_revision: z.null(), selected_task_id: z.null(),
    status: z.literal("entry_unavailable"), can_resume: z.literal(false), can_continue: z.literal(false), reason: z.string() }),
]).refine(binding => !binding.entry_available || (
  (binding.status !== "selected" || binding.selected_task_id === binding.task_id)
  && (binding.status !== "unbound" || binding.selected_task_id === null)
  && (binding.status !== "different_task" || binding.selected_task_id !== null && binding.selected_task_id !== binding.task_id)
  && (!binding.can_continue || binding.status === "selected" && binding.can_resume)
  && (!["closed", "finalizing"].includes(binding.status) || !binding.can_resume && !binding.can_continue)
), "Inconsistent Task binding authority");

function bindingFromMeta(meta: unknown, taskId: string | undefined): TaskBindingState | null {
  const value = (meta as { quaymesh?: { task_binding?: unknown } } | undefined)?.quaymesh?.task_binding;
  const parsed = bindingSchema.safeParse(value);
  return parsed.success && parsed.data.task_id === taskId ? parsed.data : null;
}

function resumeBinding(value: unknown, taskId: string | undefined, sessionId: string): TaskBindingView {
  const result = value as { task_id?: unknown; session_id?: unknown; binding?: unknown };
  const parsed = bindingSchema.safeParse(result?.binding);
  if (result?.task_id !== taskId || result?.session_id !== sessionId || !parsed.success
    || !parsed.data.entry_available || parsed.data.task_id !== taskId) {
    throw new Error("TASK_RESUME_RECEIPT_IDENTITY_MISMATCH");
  }
  return parsed.data;
}

export function createStaticSource(initialSnapshot: Snapshot): SessionCardSource {
  let served = false;
  return {
    live: false,
    async snapshot() {
      if (served) return null;
      served = true;
      return initialSnapshot;
    },
    fileDiff: async () => { throw new Error("STATIC_SOURCE_READ_ONLY"); },
    commandOutput: async () => { throw new Error("STATIC_SOURCE_READ_ONLY"); },
    commandOutputs: async () => { throw new Error("STATIC_SOURCE_READ_ONLY"); },
    instruction: async () => { throw new Error("STATIC_SOURCE_READ_ONLY"); },
    patch: async () => { throw new Error("STATIC_SOURCE_READ_ONLY"); },
    revert: async () => { throw new Error("STATIC_SOURCE_READ_ONLY"); },
    openFile: async () => { throw new Error("STATIC_SOURCE_READ_ONLY"); },
    openLink: async () => { throw new Error("STATIC_SOURCE_READ_ONLY"); },
    continueSession: async () => { throw new Error("STATIC_SOURCE_READ_ONLY"); },
    widgetStage: async () => {},
    dispose() {},
  };
}
