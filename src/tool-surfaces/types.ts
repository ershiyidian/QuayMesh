import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ProcessSessionManager } from "../process-sessions.js";
import type { ServerConfig } from "../config.js";
import type { WorkspaceRegistry } from "../workspaces.js";
import type { SessionRuntime } from "../session/runtime.js";

export { WORKSPACE_APP_URI, WORKSPACE_APP_VERSION } from '../session/card-contract.js';

export const toolNames = {
  openWorkspace: "open_workspace",
  read: "read",
  write: "write",
  edit: "edit",
  shell: "bash",
} as const;

export const workspaceIdDescription =
  "Workspace to use. Reuse the current project's workspace_id.";

export const WRITE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

export const EDIT_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

export const SHELL_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

export function shellToolAnnotations(
  _config: Pick<ServerConfig, "dangerouslySkipCommandReview">,
): typeof SHELL_TOOL_ANNOTATIONS {
  // 免确认只改变授权流程；Shell 的覆盖、删除和网络能力保持不变。
  return SHELL_TOOL_ANNOTATIONS;
}

export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface ToolLogFields {
  tool: string;
  workspaceId?: string;
  path?: string;
  workingDirectory?: string;
  command?: string;
  commandLength?: number;
  sessionId?: string;
  running?: boolean;
  exitCode?: number;
  success: boolean;
  durationMs: number;
  error?: string;
}

export interface DiffStats {
  additions: number;
  removals: number;
}

export interface ToolDefinitionMeta extends Record<string, unknown> {
  ui: {
    resourceUri: string;
    visibility: ["model"];
    availableDisplayModes?: ["inline", "fullscreen"];
  };
}

export type EmptyToolDefinitionMeta = Record<string, unknown> & {
  "ui/resourceUri"?: string;
};

export interface ToolWidgetDescriptorMeta {
  _meta: ToolDefinitionMeta | EmptyToolDefinitionMeta;
}

export interface ToolRegistrationContext {
  server: Pick<McpServer, "registerTool" | "registerResource">;
  config: ServerConfig;
  workspaces: WorkspaceRegistry;
  processSessions: ProcessSessionManager;
  sessionRuntime?: SessionRuntime;
}

export interface ToolInstructionContext {
  agents: string;
  skills: string;
}

export interface ToolSurface {
  register(context: ToolRegistrationContext): void;
  instructions(context: ToolInstructionContext): string;
}
