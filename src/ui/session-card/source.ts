import { executionObservationSchema } from "../../session/schema.js";
import { WORKSPACE_APP_VERSION, type CardVersion } from '../../session/card-contract.js';
import type { App } from "@modelcontextprotocol/ext-apps";
import { snapshotFromSchema } from "./snapshot.js";
import type { Snapshot } from "../../session/types.js";

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
  agent_id?: string;
  result_ref?: string;
}

export interface OutputRequest {command_id:string;member_id:string;cursor:number}
export type OutputBatchRow = {command_id:string;error?:string} & Partial<CommandOutputPage>;

export interface SessionCardSource {
  readonly live: boolean;
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
  let servedInitial = false;
  let currentSnapshot=initialSnapshot;
  const mountId = crypto.randomUUID();
  let mountSnapshotPending = true;
  let activeMemberId: string | undefined;
  const activeControllers = new Set<AbortController>();

  async function call<T>(
    name: ToolName,
    args: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<T> {
    if (disposed) throw new Error("SESSION_CARD_SOURCE_DISPOSED");
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    activeControllers.add(controller);
    try {
      const result = await app.callServerTool(
        {
          name,
          arguments: {
            session_id: sessionId,
            ...(taskId ? { task_id: taskId } : {}),
            ...(activeMemberId && name !== "qm_widget_stage" ? { member_id: activeMemberId } : {}),
            ...args,
          },
        },
        { signal: controller.signal },
      );
      if (result.isError) {
        const message = result.content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("\n");
        const error=new Error(message || `${name} failed`) as Error & {retryAfterMs?:number};
        const retry=(result.structuredContent as {retry_after_ms?:number}|undefined)?.retry_after_ms;
        if(typeof retry==="number")error.retryAfterMs=retry;
        throw error;
      }
      if (!result.structuredContent) {
        throw new Error(`${name}: missing structuredContent`);
      }
      return result.structuredContent as T;
    } finally {
      signal?.removeEventListener("abort", abort);
      activeControllers.delete(controller);
    }
  }

  return {
    live: true,
    async snapshot(sinceRev, signal, memberId, cursor) {
      if (disposed) throw new Error("SESSION_CARD_SOURCE_DISPOSED");
      activeMemberId = memberId;
      const requestedMemberId = activeMemberId;
      if(initialSnapshot&&!servedInitial) {
        servedInitial=true;
        if(sinceRev<0)return initialSnapshot;
      }
      const result = await call<{ unchanged: boolean; rev?: number; snapshot?: unknown; observation?:Snapshot['executionObservation'] }>(
        "qm_session",
        { since_rev: sinceRev, resource_version: resourceVersion,
          ...(memberId ? { member_id: memberId } : {}), ...(cursor ? { cursor } : {}),
          ...(taskId && mountSnapshotPending ? { mount_id: mountId } : {}) },
        signal,
      );
      mountSnapshotPending = false;
      if (requestedMemberId !== activeMemberId) return null;
      if(result.unchanged){
        if(!currentSnapshot||!result.observation)return null;
        currentSnapshot={...currentSnapshot,executionObservation:executionObservationSchema.parse(result.observation)};
        return currentSnapshot;
      }
      currentSnapshot=snapshotFromSchema(result.snapshot);
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
      const continuation = await call<ContinuationContent>(
        "qm_session_continue",
        agentId ? { agent_id: agentId } : {},
      );
      const sent = await app.sendMessage({
        role: "user",
        content: [{ type: "text", text: continuation.message }],
      });
      if (sent.isError) throw new Error("CONTINUE_MESSAGE_REJECTED");
    },
    async widgetStage(stage,options={}) {
      await call<{recorded:true}>("qm_widget_stage",{stage,resource_version:resourceVersion,mount_id:mountId,
        ...(options.displayMode ? { display_mode:options.displayMode } : {}),
        ...(options.visible===undefined ? {} : { visible:options.visible })});
    },
    dispose() {
      disposed = true;
      for (const controller of activeControllers) controller.abort();
      activeControllers.clear();
    },
  };
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
