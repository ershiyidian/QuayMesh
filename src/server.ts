import { registerCheckpointTool } from "./session/checkpoints.js";
import { HANDOFF_FINALIZATION_CODE } from "./session/task-completion.js";
import { CARD_RESOURCES, type CardVersion, snapshotForCard } from './session/card-contract.js';
import { registerOperationTools } from "./tool-surfaces/operations.js";
import { createFederation } from "./federation/integration.js";
import { WorkRunReconciler } from "./work-run-reconciler.js";
import { federatedTools, registerFederationTools } from "./federation/mcp.js";
import { proxyEnvironment } from "./federation/egress.js";
import type { FederationRuntime } from "./federation/runtime.js";
import { randomUUID, createHash } from "node:crypto";
import { ConflictingToolAliasError, normalizeCachedToolCall } from "./mcp-cached-arguments.js";
import { workspaceOutputSchema } from "./workspace-bootstrap.js";
import {currentInvocation} from "./session/invocations.js";
import { registerTaskMessageTools, withTaskMessageNotice } from "./messaging/task-messages.js";
import { registerTaskResumeTool, taskBindingForRequest } from "./tasks/task-resume.js";
import { textPage, REPLY_BYTES, IMAGE_BYTES, jsonReply, compatibleToolReceipt, type TextPage } from "./bounded-reply.js";
import { toolResultBytes } from "./mcp-tool-result.js";
import { argumentFingerprint } from "./mcp-request-diagnostics.js";
import { ensureDesktopProject } from "./codex-projects.js";
import { WorkLedger as ProjectWorkLedger } from "./work-ledger.js";
import { admittedTools } from "./tool-admission.js";
import { localAgentProviderEnvironment } from "./local-agent-config.js";
import type { ExecutionCoordinator, RuntimeWorkLease } from "./execution-coordinator.js";
import { readFileSync } from "node:fs";
import { installationTransitionPending } from "./installation-transition.js";
import { isAdmissionPrecondition, sameAdmissionInstance } from "./admission-state.js";
import { processOwner } from "./process-identity.js";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { relative, resolve as resolveSessionPath } from "node:path";
import { parsePatch as parseMutationPaths } from "./apply-patch.js";
import type { WriteEvidence } from "./session/write-evidence.js";
import { describeWorkspace } from "./session/workspace-metadata.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHttpApp } from "./mcp-http-app.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { primeMcpSseResponse } from "./mcp-sse-response.js";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import express from "express";
import type { Request, Response } from "express";
import * as z from "zod/v4";
import { executionContract } from "./process-platform.js";
import { executionContractSchema } from "./execution-contract-schema.js";
import {
  isArtifactDownloadSupportedPlatform,
  registerArtifactTools,
} from "./artifact-tools.js";
import { loadConfig, type ServerConfig } from "./config.js";
import {
  createOpenAIIncomingArtifactAdapter,
  type IncomingArtifactAdapter,
} from "./incoming-artifacts.js";
import {
  logEvent,
  requestIp,
  requestPath,
} from "./logger.js";
import { readFileTool } from "./pi-tools.js";
import { SingleUserOAuthProvider } from "./oauth-provider.js";
import {
  compileMcpRegistrationSurface,
  markSessionRecordedTool,
  sessionRecordedTool,
  createModernMcpServerAdapter,
  modernMcpAdapterErrorLogFields,
  type McpRegistrationTarget,
} from "./mcp-modern-server.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { LocalAgentStore } from "./local-agent-store.js";
import { createSessionRuntime, type SessionRuntime } from "./session/runtime.js";
import { buildHostPrompt } from "./session/prompts.js";
import { OperationState, type Snapshot } from "./session/types.js";
import { classifyToolResultError, errorCode, recordedToolErrorResult, toolErrorResult } from "./session/outcome.js";
import { registerWorkspaceContextTool } from "./tool-surfaces/workspace-context.js";
import { createProjectConsoleRouter } from "./project-console-router.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { conversationScopeIdFromRequestMeta, sessionRequestIdentity } from "./request-meta.js";
import { withLocallyAuthenticatedTaskClient } from "./tasks/task-binding.js";
import { shutdownHttpServer } from "./server-shutdown.js";
import { createRuntimeControlServer, type RuntimeControlRequest } from "./runtime-control.js";
import { ServerDiagnostics, diagnosticError, httpDiagnosticRequestId } from "./server-diagnostics.js";
import { traceMcpRequest } from "./mcp-request-diagnostics.js";
import { registerReadDiagnostics } from './read-diagnostics.js';
import {taskReference} from './console-workbench/task-aggregation.js';
import { formatPathForPrompt } from "./skills.js";
import { QUAYMESH_VERSION } from "./version.js";
import { createWorkspaceStore } from "./workspace-store.js";
import { formatAgentsPath, WorkspaceRegistry } from "./workspaces.js";
import {
  getLocalAgentProviderAvailabilitySnapshot,
} from "./local-agent-availability.js";
import {
  buildLocalAgentCatalog,
  buildLocalAgentProviderStatuses,
  formatLocalAgentProviderStatusSummary,
  type LocalAgentProviderStatus,
} from "./local-agent-catalog.js";
import { getToolSurface } from "./tool-surfaces/index.js";
import { registerSubagentTools, type AgentClient as SubagentClient } from "./tool-surfaces/subagents.js";
import {
  contentText,
  logFailedToolResponse,
  logToolCall,
  resultOutputSchema,
  textBlock,
  workspaceAppDescriptorMeta,
} from "./tool-surfaces/shared.js";
import {
  WORKSPACE_APP_URI,
  toolNames,
  workspaceIdDescription,
  type ToolContent,
  type ToolSurface,
} from "./tool-surfaces/types.js";

function mcpServerInfo() {
  return {
    name: "quaymesh",
    title: "QuayMesh",
    version: QUAYMESH_VERSION,
    description:
      "Coding tools for project workspaces. Open each project or worktree once, then reuse its workspace_id.",
  };
}

interface RunningServer {
  app: ReturnType<typeof createMcpHttpApp>;
  config: ServerConfig;
  workspaceStore: ReturnType<typeof createWorkspaceStore>;
  localAgentProviders: LocalAgentProviderStatus[];
  federation?: FederationRuntime;
  execution: ExecutionCoordinator;
  ready: Promise<void>;
  close(): Promise<void>;
}

type TrackToolActivity = <T>(operation: () => Promise<T>) => Promise<T>;

class ToolActivityTracker {
  private readonly active = new Set<Promise<unknown>>();

  readonly track: TrackToolActivity = <T>(operation: () => Promise<T>): Promise<T> => {
    const promise = operation();
    this.active.add(promise);
    const remove = () => this.active.delete(promise);
    void promise.then(remove, remove);
    return promise;
  };

  async waitForIdle(): Promise<void> {
    while (this.active.size > 0) {
      await Promise.allSettled(Array.from(this.active));
    }
  }
}

function serverInstructions(config: ServerConfig): string {
  return buildHostPrompt(config);
}

function formatVisibleAgent(agent: {
  name: string;
  provider: string;
  model?: string;
  effort?: string;
}): string {
  const model = agent.model ? `, model ${agent.model}` : "";
  const effort = agent.effort ? `, effort ${agent.effort}` : "";
  return `${agent.name} (${agent.provider}${model}${effort})`;
}

function formatAvailableAgentProvider(provider: {
  id: string;
  model?: string;
  effort?: string;
  note?: string;
}): string {
  const details = [
    provider.model ? `model ${provider.model}` : undefined,
    provider.effort ? `effort ${provider.effort}` : undefined,
    provider.note,
  ].filter(Boolean).join(", ");
  return `${provider.id}${details ? ` (${details})` : ""}`;
}

const workspaceSkillOutputSchema = z.object({
  name: z.string(),
  description: z.string(),
  path: z.string(),
});

const workspaceAgentsFileOutputSchema = z.object({
  path: z.string(),
  content: z.string(),
});

const workspaceLocalAgentOutputSchema = z.object({
  name: z.string(),
  description: z.string(),
  provider: z.string(),
  model: z.string().optional(),
  effort: z.string().optional(),
});

const workspaceLocalAgentProviderOutputSchema = z.object({
  id: z.string(),
  model: z.string().optional(),
  effort: z.string().optional(),
  note: z.string().optional(),
});

const workspaceAvailableAgentsFileOutputSchema = z.object({
  path: z.string(),
});

function sendJsonRpcError(
  res: Response,
  status: number,
  code: number,
  message: string,
): void {
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}

function requestLogFields(req: Request, config: ServerConfig): Record<string, unknown> {
  return {
    ip: requestIp(req, config.logging.trustProxy),
    host: req.header("host"),
    userAgent: req.header("user-agent"),
    origin: req.header("origin"),
    referer: req.header("referer"),
    contentLength: req.header("content-length"),
  };
}

// 聊天卡片在构建期合并成单个自包含 HTML，脚本与样式随 MCP 资源一起返回。
function workspaceAppHtml(version: CardVersion): string {
  const html = readFileSync(fileURLToPath(new URL("../dist/ui-card/workspace-app.html", import.meta.url)), "utf8");
  return html.replace('</head>', `<meta name="quaymesh-card-version" content="${version}">\n</head>`);
}

function taskConsoleUrl(config:ServerConfig,taskId:string):string {
  const url=new URL('/console/',config.publicBaseUrl);
  url.hash='/tasks?'+new URLSearchParams({run:taskReference(taskId)});
  return url.href;
}

function appCsp(_config: ServerConfig): {
  resourceDomains: string[];
  connectDomains: string[];
} {
  return {
    resourceDomains: [],
    connectDomains: [],
  };
}

function uiBuildDirectory(): string {
  return fileURLToPath(new URL("../dist/ui", import.meta.url));
}

export function createMcpServer(
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  reviewCheckpoints: ReturnType<typeof createReviewCheckpointManager>,
  processSessions: ProcessSessionManager,
  resolveLocalAgentProviders: () => LocalAgentProviderStatus[],
  incomingArtifactAdapters: readonly IncomingArtifactAdapter[],
  trackToolActivity?: TrackToolActivity,
  registerProject: typeof ensureDesktopProject = ensureDesktopProject,
  sessionRuntime?: SessionRuntime,
  subagentClient?: SubagentClient,
): McpServer {
  const server = new McpServer(
    mcpServerInfo(),
    {
      instructions: serverInstructions(config),
    },
  );

  registerMcpSurface(
    server,
    config,
    workspaces,
    reviewCheckpoints,
    processSessions,
    resolveLocalAgentProviders,
    incomingArtifactAdapters,
    trackToolActivity,
    registerProject,
    sessionRuntime,
    subagentClient,
  );
  return server;
}

function registerMcpSurface(
  server: McpRegistrationTarget,
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  reviewCheckpoints: ReturnType<typeof createReviewCheckpointManager>,
  processSessions: ProcessSessionManager,
  resolveLocalAgentProviders: () => LocalAgentProviderStatus[],
  incomingArtifactAdapters: readonly IncomingArtifactAdapter[],
  trackToolActivity?: TrackToolActivity,
  registerProject: typeof ensureDesktopProject = ensureDesktopProject,
  sessionRuntime?: SessionRuntime,
  subagentClient?: SubagentClient,
): void {
  const registrationTarget = trackToolActivity
    ? withTrackedToolHandlers(server, trackToolActivity)
    : server;
  const modelTarget = sessionRuntime
    ? withSessionToolRecording(registrationTarget, sessionRuntime, workspaces, config)
    : registrationTarget;
  const toolSurface = getToolSurface(config.toolMode);

  if (sessionRuntime) {
    sessionRuntime.registerAppTools(registrationTarget as unknown as Parameters<SessionRuntime["registerAppTools"]>[0]);
    registerReadDiagnostics(registrationTarget, config);
    registerTaskMessageTools(registrationTarget as unknown as Parameters<typeof registerTaskMessageTools>[0], { config, mailbox: sessionRuntime.store.mailbox });
    registerTaskResumeTool(registrationTarget as unknown as Parameters<typeof registerTaskResumeTool>[0], { config, store: sessionRuntime.store });
  }

  if (config.uiEnabled) {
    for (const {version, uri} of CARD_RESOURCES) {
      registerAppResource(
        registrationTarget,
        `QuayMesh Session Card ${version}`,
        uri,
        {
          description: "Interactive QuayMesh workspace session card.",
          _meta: { ui: { csp: appCsp(config), availableDisplayModes:["inline","fullscreen"] } },
        },
        async () => ({
          contents: [{
            uri,
            mimeType: RESOURCE_MIME_TYPE,
            text: workspaceAppHtml(version),
            _meta: { ui: { csp: appCsp(config), availableDisplayModes:["inline","fullscreen"] } },
          }],
        }),
      );
    }
  }

  const registerToolOrApp = (name: string, def: Record<string, any>, handler: (input: any, extra: any) => any) => {
    if (config.uiEnabled) {
      (registerAppTool as any)(registrationTarget, name, def, handler);
    } else {
      const { _meta, ...cleanDef } = def;
      const remainingMeta = _meta ? Object.fromEntries(
        Object.entries(_meta).filter(([k]) => k !== "ui" && k !== "ui/resourceUri")
      ) : undefined;
      const finalDef = remainingMeta && Object.keys(remainingMeta).length > 0
        ? { ...cleanDef, _meta: remainingMeta }
        : cleanDef;
      (modelTarget.registerTool as any)(name, finalDef, handler);
    }
  };

  registerToolOrApp(
    "start_session",
    {
      title: "Start a QuayMesh task",
      description: "Create a Task for a new independent goal; reuse request_key and input on retry. If this entry already has a Task, a new goal requires new_goal:true and its observed binding revision; follow-ups reuse or resume the existing Task. Returned workspaces are usually empty; discover roots with workspace_catalog, then open_workspace.",
      inputSchema: {
        title: z.string().min(1).max(200).describe("Task title."),
        request_key: z.string().min(1).max(128).describe("Stable request key; reuse for retries."),
        source_task_id: z.string().min(1).optional().describe("Source task recorded on a newly created Task."),
        new_goal: z.literal(true).optional().describe("Explicitly create an independent goal; follow-ups reuse the current Task."),
        expected_binding_revision: z.number().int().nonnegative().optional().describe("Current entry revision from task_resume inspect or the selection conflict."),
      },
      outputSchema: {
        session_id: z.string(),
        task_id: z.string(),
        title: z.string(),
        workspaces: z.array(z.unknown()),
      },
      ...workspaceAppDescriptorMeta(config),
      annotations: { readOnlyHint:false, destructiveHint:false, idempotentHint:true, openWorldHint:false },
    },
    async ({ title, request_key, source_task_id, new_goal, expected_binding_revision }, extra) => {
      if (!sessionRuntime) throw new Error("SESSION_RUNTIME_UNAVAILABLE");
      const identity = sessionRequestIdentity(extra);
      let started: Awaited<ReturnType<SessionRuntime["service"]["startTask"]>>;
      try {
        if (!identity.task_entry && !identity.task_creation)
          throw Object.assign(new Error("TASK_CREATION_IDENTITY_REQUIRED: Create the Task through an authenticated Coordinator endpoint, then pass task_id on workspace calls."),
            {code: "TASK_CREATION_IDENTITY_REQUIRED", effect: "not_started"});
        started = await sessionRuntime.service.startTask(
          identity,
          title,
          request_key,
          source_task_id,
          { newGoal: new_goal, expectedBindingRevision: expected_binding_revision },
        );
      } catch (error) {
        if (error && typeof error === "object" && "effect" in error && error.effect === "not_started")
          return toolErrorResult(error);
        throw error;
      }
      const { session, task } = started;
      const projection = await sessionRuntime.projector.readTask(task.id, -1);
      const binding = taskBindingForRequest(sessionRuntime.store, extra, task.id, config);
      return {
        content: [{ type: "text", text: "QuayMesh Task " + task.id + ": " + task.title
          + "\n" + taskConsoleUrl(config,task.id)
          + (binding.can_continue ? "\nThis entry selects this Task. Reuse attached workspace handles; discover and open roots if the list is empty."
            : !binding.entry_available ? `\n${binding.reason}`
              : binding.can_resume ? "\nThis reply does not switch the entry back from newer work. Inspect and explicitly resume this Task before continuing it."
                : "\nThis Task cannot accept new work. Its history remains available; this reply does not reopen it.") }],
        _meta: {
          quaymesh: {
            session_id: session.id,
            task_id: task.id,
            task_binding: binding,
            snapshot_ref: "task:" + task.id,
            snapshot: projection.snapshot ? snapshotForCard({ ...projection.snapshot,
              capabilities: { ...projection.snapshot.capabilities, continue: binding.can_continue } }) : undefined,
            capabilities: { refresh: true, revert: false, continue: binding.can_continue, open_file: false },
          },
        },
        structuredContent: {
          session_id: session.id,
          task_id: task.id,
          title: task.title,
          workspaces: sessionRuntime.store.taskMemberIds(task.id).flatMap((memberId) => {
            const member = sessionRuntime.store.findMember(session.id, memberId);
            return member ? [{
            member_id: member.id,
            workspace_id: member.workspace_id,
            node_id: member.node_id,
            root: member.root,
            }] : [];
          }),
        },
      };
    },
  );

  modelTarget.registerTool("finish_task",{
    title:"结束工作目标",
    description:"仅目标完成或明确终止时保存最终结果；命令结束、进度回复和换对话都不关闭目标。交接先 checkpoint_task 保存进度，再在接收入口 task_resume 同一 Task。旧 handed_off 请求会被明确拒绝，Task 保持开放。",
    inputSchema:{
      task_id:z.string().min(1),
      status:z.enum(["completed","failed","cancelled","handed_off"]).describe("completed: goal achieved; failed/cancelled: goal explicitly ended. Legacy handed_off is rejected; use checkpoint_task and task_resume to keep the same Task open."),
      summary:z.string().min(1).max(4000),
      message_sequence:z.number().int().nonnegative().optional().describe("Latest mailbox.sequence returned by task_messages; required when this Task has messages."),
      expected_task_revision:z.number().int().nonnegative().optional().describe("task_revision from task_resume inspect; required for a new explicit finish after resumed work superseded an earlier finish."),
    },
    outputSchema:{task_id:z.string(),state:z.enum(["closed","finalizing"]),result_status:z.string().nullable(),
      accepted:z.boolean().optional(),poll_after_ms:z.number().optional(),
      next_action:z.object({tool:z.literal("finish_task"),arguments:z.object({task_id:z.string(),status:z.string(),summary:z.string(),message_sequence:z.number().int().nonnegative().optional(),expected_task_revision:z.number().int().nonnegative().optional()})}).optional()},
    annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:true,openWorldHint:false},
  },async({task_id,status,summary,message_sequence,expected_task_revision},extra)=>{
    if(!sessionRuntime)throw new Error("SESSION_RUNTIME_UNAVAILABLE");
    const owner=sessionRequestIdentity(extra).owner_id;
    const finished=await sessionRuntime.service.finishTaskWithinBudget(owner,task_id,status,summary,2000,message_sequence ?? 0,expected_task_revision).catch(error=>{
      // This specific guard rejects before persisting an intent. Other failures
      // may have already changed finalization state and retain their original path.
      const precondition=error && typeof error==="object" && "effect" in error && error.effect==="not_started"
        && ["TASK_REVISION_REQUIRED","TASK_REVISION_CONFLICT"].includes(errorCode(error));
      if(!precondition && (status!=="handed_off" || errorCode(error)!==HANDOFF_FINALIZATION_CODE))throw error;
      return toolErrorResult(error);
    });
    if("isError" in finished)return finished;
    const task=finished.task;
    if(finished.accepted)return {content:[{type:"text",text:"结束请求已保存，正在确认并归档各节点证据。卡片会在归档完成后更新。"}],
      structuredContent:{task_id,state:"finalizing",result_status:null,accepted:true,poll_after_ms:finished.pollAfterMs,
        next_action:{tool:"finish_task",arguments:{task_id,status,summary,message_sequence:message_sequence ?? 0}}}};
    return {content:[{type:"text",text:summary+'\n'+task_id+'\n'+taskConsoleUrl(config,task_id)}],structuredContent:{task_id,state:task.state,result_status:task.result_status}};
  });

  modelTarget.registerTool(
    "open_workspace",
    {
      title: "Open workspace",
      description:
        "Start work in a project directory or isolated worktree when no usable workspace_id exists for it. During continued work, reuse the existing workspace_id instead of calling this tool again. By default this uses the actual checkout; set mode=\"worktree\" for isolated or parallel work.",
      inputSchema: {
        create_directory: z.boolean().optional().describe("Create the directory when absent."),
        path: z
          .string()
          .describe(
            "Relative file path; workspace open accepts an absolute path.",
          ),
        mode: z
          .enum(["checkout", "worktree"])
          .optional()
          .describe(
            "checkout edits the source; worktree creates an isolated checkout.",
          ),
        base_ref: z
          .string()
          .optional()
          .describe("Worktree base; default HEAD."),
      },
      outputSchema: workspaceOutputSchema,
      annotations: { readOnlyHint:false, destructiveHint:true, openWorldHint:true },
    },
    async ({ path, mode, base_ref, create_directory }, extra) => {
      const { _meta } = extra;
      const requestIdentity = sessionRuntime ? sessionRequestIdentity(extra) : undefined;
      const executeOpen = async (capturedIdentity = requestIdentity, workspaceReuseScope?: string) => {
      const startedAt = performance.now();
      const baseRef = base_ref;
      const createDirectory = create_directory;
      const {
        workspace,
        agentsFiles,
        availableAgentsFiles,
        workspaceReused,
        includeBootstrapContext,
      } = await workspaces.openWorkspace(
        { path, mode, baseRef, createDirectory },
        { conversationScopeId: workspaceReuseScope ?? conversationScopeIdFromRequestMeta(_meta) },
      );
      const projectLedger = new ProjectWorkLedger(config.stateDir);
      let quaymeshProjectId: string;
      try { quaymeshProjectId = projectLedger.project(workspace.root).id; } finally { projectLedger.close(); }
      const codexEnabled = config.subagents.enabled && config.subagents.providers.some(provider => provider.id === "codex" && provider.enabled);
      const registration = codexEnabled
        ? await registerProject([workspace.root], [], localAgentProviderEnvironment(config.subagents,"codex",process.env))
        : {status:"not_configured",roots:[workspace.root]};
      const projectRegistration = { quaymeshProjectId, ...registration };
      // Task 已在首次修改前保存基线；打开目录无需另做旧版工作区快照。
      const review = sessionRuntime ? undefined : await reviewCheckpoints.initializeWorkspace({
        workspaceId: workspace.id,
        root: workspace.root,
      });
      const cardSkills = workspace.skills
        .filter((skill) => !skill.disableModelInvocation)
        .map((skill) => ({
          name: skill.name,
          description: skill.description,
          path: formatPathForPrompt(skill.filePath),
        }));
      const agentCatalog = buildLocalAgentCatalog(
        config.subagents,
        workspace.agentProfiles,
        resolveLocalAgentProviders(),
      );
      const cardAgentProviders = agentCatalog.providers
        .filter((provider) => provider.usable)
        .map((provider) => ({
          id: provider.id,
          model: provider.model,
          effort: provider.effort,
          note: provider.note,
        }));
      const cardAgents = agentCatalog.profiles;
      const cardAgentsFiles = agentsFiles.map((file) => ({
        path: formatAgentsPath(file.path, workspace.root),
        content: file.content,
      }));
      const cardAvailableAgentsFiles = availableAgentsFiles.map((file) => ({
        path: formatAgentsPath(file.path, workspace.root),
      }));
      const visibleSkills = includeBootstrapContext ? cardSkills : [];
      const visibleAgentProviders = includeBootstrapContext ? cardAgentProviders : [];
      const visibleAgents = includeBootstrapContext ? cardAgents : [];
      const loadedAgentsFiles = includeBootstrapContext ? cardAgentsFiles : [];
      const availableAgentsFileOutputs = includeBootstrapContext ? cardAvailableAgentsFiles : [];
      const cardInstruction = "Reuse this workspace_id. Read project instruction files only when requested.";
      const instruction = cardInstruction;
      let initialSnapshot: Snapshot | undefined;
      let currentTaskId: string | undefined;
      const sessionOpen = sessionRuntime
        ? await sessionRuntime.service.open(
            capturedIdentity!,
            {
              id: workspace.id,
              node: config.federation?.nodeId ?? "local",
              root: workspace.root,
              mode: workspace.mode === "worktree" ? "worktree" : "checkout",
              sourceRoot: workspace.sourceRoot ?? null,
              metadata: await describeWorkspace(workspace),
            },
            workspace.root,
          )
        : undefined;
      if (sessionOpen) {
        currentTaskId = sessionOpen.task.id;
        sessionRuntime!.context.registerDiscovered({
          sessionId: sessionOpen.session.id,
          taskId: currentTaskId,
          memberId: sessionOpen.member.id,
          workspace,
          loadedAgentsFiles: agentsFiles,
          availableAgentsFiles,
        });
        initialSnapshot = await sessionRuntime!.projector.materialize(sessionOpen.session.id, sessionOpen.member.id, currentTaskId);
      }
      const binding = sessionOpen ? taskBindingForRequest(sessionRuntime!.store, extra, sessionOpen.task.id, config) : undefined;
      const resultContent: ToolContent[] = [{type:"text",text:workspaceReused?"Workspace reused.":"Workspace opened."}];
      logToolCall(config, {
        tool: "open_workspace",
        workspaceId: workspace.id,
        path: workspace.root,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content: resultContent,
        _meta: {
          ...(sessionOpen
            ? {
                quaymesh: {
                  session_id: sessionOpen.session.id,
                  ...(currentTaskId ? { task_id: currentTaskId } : {}),
                  member_id: sessionOpen.member.id,
                  workspace_id: workspace.id,
                  task_binding: binding,
                  snapshot_ref: currentTaskId
                    ? `task:${currentTaskId}:member:${sessionOpen.member.id}`
                    : `session:${sessionOpen.session.id}:member:${sessionOpen.member.id}`,
                  snapshot: initialSnapshot ? snapshotForCard({ ...initialSnapshot,
                    capabilities: { ...initialSnapshot.capabilities, continue: binding?.can_continue === true } }) : undefined,
                  capabilities: { refresh: true, revert: true, continue: binding?.can_continue === true, open_file: true },
                },
              }
            : {}),
          card: {
            project_registration:projectRegistration,
            sessionId: sessionOpen?.session.id,
            memberId: sessionOpen?.member.id,
            workspaceId: workspace.id,
            root: workspace.root,
            path: workspace.root,
            mode: workspace.mode,
            workspaceReused,
            includeBootstrapContext,
            sourceRoot: workspace.sourceRoot,
            worktree: workspace.worktree,
            agentsFiles: cardAgentsFiles,
            availableAgentsFiles: cardAvailableAgentsFiles,
            skills: cardSkills,
            agentProviders: cardAgentProviders,
            agents: cardAgents,
            ...(review ? { review } : {}),
            instruction: cardInstruction,
            summary: {
              mode: workspace.mode,
              agentsFiles: cardAgentsFiles.length,
              availableAgentsFiles: cardAvailableAgentsFiles.length,
              skills: cardSkills.length,
              agentProviders: cardAgentProviders.length,
              agents: cardAgents.length,
            },
          },
        },
        structuredContent: {
          workspace_id:workspace.id,root:workspace.root,node_id:config.federation?.nodeId??"local",mode:workspace.mode,
          ...(sessionOpen?{session_id:sessionOpen.session.id,task_id:currentTaskId}:{}),
          ...(workspace.sourceRoot?{source_root:workspace.sourceRoot}:{}),
          ...(includeBootstrapContext?{
            execution:{platform:executionContract().platform,shell:executionContract().shell},
            ...(availableAgentsFileOutputs.length?{available_agents_files:availableAgentsFileOutputs}:{}),
          }:{}),
        },
      };
      };
      return sessionRuntime && requestIdentity
        ? sessionRuntime.service.withTaskExecution(requestIdentity, path, (captured, scope) => executeOpen(
          { ...requestIdentity, task_id: captured.task_id }, scope.session.conversation_id ?? scope.task.id))
        : executeOpen();
    },
  );

  modelTarget.registerTool(
    "attach_workspace",
    {
      title: "Attach another workspace",
      description:
        "Attach a project to the selected Task, or restore a pruned workspace with its existing workspace_id. Restoring retains its Task, directory, and saved tracked changes.",
      inputSchema: {
        create_directory: z.boolean().optional().describe("Create the directory when absent."),
        path: z.string().min(1).optional().describe("Project path; omit when restoring workspace_id."),
        workspace_id: z.string().min(1).optional().describe("Existing workspace in this session to restore; omit path, mode, base_ref, and create_directory."),
        mode: z.enum(["checkout", "worktree"]).optional().describe("checkout edits the source; worktree creates an isolated checkout."),
        base_ref: z.string().optional().describe("Worktree base; default HEAD."),
        session_id: z.string().optional().describe("Existing session."),
      },
      outputSchema: workspaceOutputSchema,
      annotations: { readOnlyHint:false, destructiveHint:true, openWorldHint:true },
    },
    async ({ path, workspace_id, mode, base_ref, create_directory, session_id }, extra) => {
      let effectStarted = false;
      try {
        if (!sessionRuntime) throw new Error("SESSION_RUNTIME_UNAVAILABLE");
        if ((path === undefined) === (workspace_id === undefined)) {
          throw new Error("INVALID_ARGUMENT: provide exactly one of path or workspace_id.");
        }
        if (workspace_id !== undefined && [mode, base_ref, create_directory].some(value => value !== undefined)) {
          throw new Error("INVALID_ARGUMENT: workspace_id restores the original workspace; omit mode, base_ref, and create_directory.");
        }
        const identity = sessionRequestIdentity(extra);
        const selected = sessionRuntime.service.selectedExecution(identity);
        if (!selected) throw Object.assign(new Error("TASK_EXECUTION_BINDING_REQUIRED: Select or resume a Task before attaching a workspace."),
          { code: "TASK_EXECUTION_BINDING_REQUIRED", effect: "not_started" });
        return await sessionRuntime.service.withTaskExecution({ ...identity, task_id: selected.task.id }, path ?? "QuayMesh task", async (captured, { session, task }) => {
        if (session_id && session_id !== session.id) throw new Error(`TASK_SESSION_MISMATCH: ${task.id}`);
        const nodeId = config.federation?.nodeId ?? "local";
        if (workspace_id !== undefined && !session.members.some(member => member.node_id === nodeId && member.workspace_id === workspace_id)) {
          throw new Error(`WORKSPACE_SESSION_MISMATCH: ${workspace_id} is not a member of session ${session.id}.`);
        }
        // 身份、原成员和任务先验证，再允许创建目录、运行 Git 或恢复修改。
        effectStarted = true;
        const opened = workspace_id !== undefined
          ? await workspaces.restoreWorkspace(workspace_id)
          : await workspaces.openWorkspace(
            { path: path!, mode, baseRef: base_ref, createDirectory: create_directory },
            // Reuse the Task's existing workspace namespace across external
            // entries; the legacy value is only an internal storage adapter key.
            { conversationScopeId: session.conversation_id ?? task.id },
          );
        const attached = await sessionRuntime.service.attach(
          captured,
          session.id,
          {
            id: opened.workspace.id,
            node: nodeId,
            root: opened.workspace.root,
            mode: opened.workspace.mode === "worktree" ? "worktree" : "checkout",
            sourceRoot: opened.workspace.sourceRoot ?? null,
            metadata: await describeWorkspace(opened.workspace),
          },
        );
        sessionRuntime.context.registerDiscovered({
          sessionId: session.id, taskId: task.id, memberId: attached.member.id, workspace: opened.workspace,
          loadedAgentsFiles: opened.agentsFiles, availableAgentsFiles: opened.availableAgentsFiles,
        });
        return {
          content:[{type:"text",text:"Workspace attached."}],
          _meta:{quaymesh:{session_id:session.id,task_id:task.id,member_id:attached.member.id,workspace_id:opened.workspace.id,
            task_binding:taskBindingForRequest(sessionRuntime.store,extra,task.id,config)}},
          structuredContent:{
            workspace_id:opened.workspace.id,root:opened.workspace.root,node_id:nodeId,
            session_id:session.id,task_id:task.id,mode:opened.workspace.mode,
            ...(opened.workspace.sourceRoot?{source_root:opened.workspace.sourceRoot}:{}),
            ...(opened.includeBootstrapContext?{
              execution:{platform:executionContract().platform,shell:executionContract().shell},
              ...(opened.availableAgentsFiles.length?{available_agents_files:opened.availableAgentsFiles.map(file=>({path:formatAgentsPath(file.path,opened.workspace.root)}))}:{}),
            }:{}),
          },
        };
        });
      } catch (error) {
        return toolErrorResult(error, { sideEffecting: effectStarted });
      }
    },
  );

  modelTarget.registerTool(
    toolNames.read,
    {
      title: "Read file",
      description: "Read text ranges or an image. Continue a truncated response with response_offset.",
      inputSchema: {
        response_offset: z.number().int().nonnegative().optional().describe("Code-point cursor; keep path and line selection unchanged."),
        workspace_id: z
          .string()
          .describe("Workspace handle."),
        path: z
          .string()
          .describe(
            "Relative file path; workspace open accepts an absolute path.",
          ),
        offset: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("First line (1-based)."),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum lines."),
      },
      outputSchema: resultOutputSchema({result_sha256: z.string().optional(),
        response_page: z.object({offset:z.number(),next_offset:z.number().nullable(),total_code_points:z.number()}).optional()}),
      annotations: { readOnlyHint:true, destructiveHint:false, openWorldHint:false },
    },
    async ({ workspace_id, response_offset, ...input }) => {
      const startedAt = performance.now();
      const workspaceId = workspace_id;
      const responseOffset = response_offset;
      const workspace = await workspaces.getWorkspace(workspaceId);
      const readPath = await workspaces.resolveReadPath(workspace, input.path);
      const response = await processSessions.readWorkspace(workspace.root, () => readFileTool(
        { ...input, path: readPath.absolutePath },
        {
          cwd: workspace.root,
        },
      ));

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.read,
          workspaceId,
          path: input.path,
        }, response.content, startedAt);
        return response;
      }

      logToolCall(config, {
        tool: toolNames.read,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      const images=response.content.filter((block):block is {type:"image";data:string;mimeType:string}=>block.type==="image");
      if(images.length){
        if(responseOffset!==undefined&&responseOffset!==0)throw new Error("IMAGE_RESPONSE_HAS_NO_TEXT_CURSOR");
        const valid=images.every(image=>/^image\/(png|jpeg|gif|webp)$/.test(image.mimeType)&&
          typeof image.data==="string"&&image.data.length>0);
        const bytes=images.reduce((sum,image)=>sum+Buffer.from(image.data,"base64").length,0);
        if(!valid||bytes>IMAGE_BYTES){
          const message=!valid?"UNSUPPORTED_IMAGE_CONTENT":`IMAGE_TOO_LARGE: ${bytes} bytes exceeds ${IMAGE_BYTES}`;
          return {content:[{type:"text" as const,text:message}],structuredContent:{result:message},isError:true};
        }
        return {content:response.content,
          _meta:{quaymesh:{argument_fingerprint:argumentFingerprint({action:"read",...input})}},
          structuredContent:{result:`已读取 ${input.path} 的图片，像素见原生 image 内容。`,
            operation_id:currentInvocation()?.operation_id,
            result_sha256:createHash("sha256").update(images.map(image=>image.data).join(":")).digest("hex"),
            response_page:{offset:0,next_offset:null,total_code_points:0}}};
      }

      const original = contentText(response.content);
      const resultHash = createHash("sha256").update(original).digest("hex");
      // 按完整回包选择页长，计入文本客户端所需的结构化结果镜像。
      const reply = (page: TextPage) => ({
        content: [{ type: "text" as const, text: `已读取 ${input.path}，正文见 result。` }],
        _meta:{quaymesh:{argument_fingerprint:argumentFingerprint({action:"read",...input})}},
        structuredContent: {result:page.text,operation_id:currentInvocation()?.operation_id,
          result_sha256: resultHash, response_page: {
            offset: page.offset,
            next_offset: page.nextOffset,
            total_code_points: page.totalCodePoints,
          }} });
      const page = textPage(original, responseOffset, REPLY_BYTES - 512, value => toolResultBytes(reply(value)));
      const result = reply(page);
      if (toolResultBytes(result) > REPLY_BYTES) return {
        content: [{ type: "text" as const, text: "Read response metadata exceeds response budget." }],
        structuredContent: { result: "Read response metadata exceeds response budget." }, isError: true };
      return result;
    },
  );

  registerWorkspaceContextTool({ server: modelTarget, config, workspaces, processSessions, sessionRuntime });
  registerOperationTools({server:modelTarget,config,workspaces,processSessions,sessionRuntime});
  registerCheckpointTool({server:modelTarget,config,workspaces,processSessions,sessionRuntime});

  toolSurface.register({
    server: modelTarget,
    config,
    workspaces,
    processSessions,
    sessionRuntime,
  });

  if (config.subagents.enabled || (config.federation?.enabled && config.federation.capabilities.coordinator)) {
    registerSubagentTools({
      server: modelTarget,
      config,
      workspaces,
      processSessions,
      sessionRuntime,
    }, subagentClient);
  }

  if (config.artifactsEnabled && isArtifactDownloadSupportedPlatform()) {
    registerArtifactTools(modelTarget, {
      config,
      workspaces,
      incomingArtifactAdapters,
    });
  }
}

function withTrackedToolHandlers(
  server: McpRegistrationTarget,
  trackToolActivity: TrackToolActivity,
): McpRegistrationTarget {
  return {
    registerTool: ((...args: unknown[]) => {
      const handler = args.at(-1) as (...handlerArgs: unknown[]) => unknown;
      const wrapped = (...handlerArgs: unknown[]) => trackToolActivity(
        () => Promise.resolve(handler(...handlerArgs)),
      );
      const recorder = sessionRecordedTool(handler);
      return (server.registerTool as (...callArgs: unknown[]) => unknown)(
        ...args.slice(0, -1),
        recorder
          ? markSessionRecordedTool(wrapped, (input, extra, operation, options) => recorder(
              input,
              extra,
              () => trackToolActivity(() => Promise.resolve(operation())),
              options,
            ))
          : wrapped,
      );
    }) as McpRegistrationTarget["registerTool"],
    registerResource: server.registerResource.bind(server),
  };
}

const SESSION_RECORDED_TOOLS = new Set([
  "read",
  "workspace_context",
  "write",
  "edit",
  "apply_patch",
  "download_artifact",
  "bash",
  "exec_command",
  "write_stdin",
  "read_output",
  "cancel_command",
  "checkpoint_task",
  "spawn_agent",
  "followup_agent",
  "send_message",
  "wait_agent",
  "interrupt_agent",
  "list_agents",
]);

const SUBAGENT_OPERATION_TOOLS = new Set([
  "spawn_agent",
  "followup_agent",
  "send_message",
  "wait_agent",
  "interrupt_agent",
  "list_agents",
]);

const PENDING_SUBAGENT_OPERATION_TOOLS = new Set([
  "spawn_agent",
  "followup_agent",
]);

function subagentResultState(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const structured = (result as Record<string, unknown>).structuredContent;
  if (!structured || typeof structured !== "object") return null;
  const value = structured as Record<string, unknown>;
  const state = value.state ?? value.status;
  return typeof state === "string" ? state : null;
}

function isPendingSubagentOperation(name: string, result: unknown): boolean {
  if (!PENDING_SUBAGENT_OPERATION_TOOLS.has(name)) return false;
  const state = subagentResultState(result);
  return state === "starting" || state === "queued" || state === "running";
}

function withSessionToolRecording(
  server: McpRegistrationTarget,
  runtime: SessionRuntime,
  workspaces: WorkspaceRegistry,
  config: ServerConfig,
): McpRegistrationTarget {
  return {
    registerTool: ((name: string, definition: Record<string, unknown>, handler: (input: any, extra: any) => any) => {
      if (!SESSION_RECORDED_TOOLS.has(name)) {
        return (server.registerTool as any)(name, definition, handler);
      }
      if (["exec_command","bash","apply_patch","write","edit","download_artifact","write_stdin","cancel_command"].includes(name)) {
        const key = z.string().min(1).max(128).optional()
          .describe("Retry key for one intended change.");
        const shape = definition.inputSchema as any;
        definition = {...definition,inputSchema:shape?.extend ? shape.extend({operation_key:key}) : {...shape,operation_key:key}};
      }
      const recordOperation = async (input: any, extra: any, operation: () => Promise<any>, forwarded = false) => {
        const workspaceId = typeof input?.workspace_id === "string" ? input.workspace_id : undefined;
        if (!workspaceId) throw new Error(`MISSING_WORKSPACE_ID: ${name}`);
        const identity = sessionRequestIdentity(extra);
        const operationKind = name === "bash" || name === "exec_command"
          ? "command"
          : name === "write" || name === "edit" || name === "apply_patch" || name === "download_artifact"
            ? "patch"
            : name === "workspace_context" && input?.action === "search"
              ? "search"
              : SUBAGENT_OPERATION_TOOLS.has(name)
                ? "agent_control"
                : "read";
        const affectsFiles = ["write", "edit", "apply_patch", "download_artifact", "bash", "exec_command"].includes(name)
          || (["spawn_agent", "followup_agent"].includes(name) && input.read_only !== true);
        const writePaths = name === "write" || name === "edit" || name === "download_artifact"
          ? (typeof input.path === "string" ? [input.path] : [])
          : name === "apply_patch" && typeof input.patch === "string"
            ? parseMutationPaths(input.patch).flatMap((action) => action.kind === "update" && action.moveTo ? [action.path, action.moveTo] : [action.path])
            : [];
        let writeEvidence: WriteEvidence[] = [];
        let knownWritePaths: string[] = [];
        // Signed attachment URLs can contain credentials. Persist a comparison
        // digest for exact retries, while only the live handler sees the URL.
        let recordedInput = input;
        if (name === "download_artifact" && input.file && typeof input.file === "object") {
          const { download_url, ...file } = input.file;
          recordedInput = { ...input, file: { ...file,
            download_url_sha256: createHash("sha256").update(String(download_url)).digest("hex") } };
        }
        const record = forwarded ? runtime.recorder.recordForwarded.bind(runtime.recorder) : runtime.recorder.record.bind(runtime.recorder);
        return record({
          identity,
          workspace_id: workspaceId,
          tool_name: name,
          kind: operationKind,
          label: name === "spawn_agent" && typeof input?.name === "string" ? input.name
            : name === "exec_command" ? String(input.cmd)
              : name === "bash" ? String(input.command ?? input.cmd ?? name) : name,
          input: recordedInput,
          affectsFiles,
          // This handler drains its own file work before settling. Other reads
          // and forwarded receipts do not establish a local physical boundary.
          ...(!forwarded && name === "workspace_context" && ["list", "capture", "search"].includes(input.action)
            ? {localCompletion: "handler_settled" as const} : {}),
          ...(["exec_command", "bash", "apply_patch", "write", "edit", "write_stdin"].includes(name) ? {
            replyWaitMs: name === "exec_command" || name === "bash"
              ? Math.max(1000, Math.min(5000, Number(input.yield_time_ms ?? 2000) + 1000)) : 2000,
            pendingResult: (context: import("./session/types.js").InvocationContext) => {
              const saved = runtime.store.findInvocationResultByOperation(context.owner_id, context.operation_id!);
              const envelope = saved?.result_json ? JSON.parse(saved.result_json) : null;
              if (envelope?.kind === "result") return envelope.value;
              const message = "操作已接收，准备或执行仍在继续。请按 operation_id 查询状态，无需重新提交。";
              const phase = forwarded ? "dispatching" : saved?.effect === "not_started" ? "preparing" : "running";
              return {...jsonReply({ operation_id: context.operation_id!, result: "",
                accepted: true, running: true,
                state: forwarded ? "accepted" : saved?.state ?? "accepted",
                effect: forwarded ? "unknown" : saved?.effect ?? "not_started", poll_after_ms: 2000,
                next_action: { tool: "workspace_context", arguments: {
                  workspace_id: workspaceId, action: "status", operation_id: context.operation_id,
                } } }, message), _meta: {quaymesh: {phase}}};
            },
          } : {}),
          beforeWrite: async (context) => {
            const member = runtime.store.getMember(context.session_id, context.member_id);
            const cwd = resolveSessionPath(member.root, typeof input.working_directory === "string" ? input.working_directory : ".");
            writeEvidence = await runtime.changes.prepareWrite(member, writePaths, cwd, context.task_id);
            knownWritePaths = writePaths.map(path => relative(member.root, resolveSessionPath(cwd, path)));
          },
          afterReply: (result, context, operationId) => withTaskMessageNotice(config, runtime.store.mailbox, context,
            recordedToolErrorResult(result, operationId, {sideEffecting: affectsFiles, forwarded})),
          afterResult: async (_result, context) => {
            if (writeEvidence.length) await runtime.changes.recordWrite(
              runtime.store.getMember(context.session_id, context.member_id), writeEvidence, context.task_id);
          },
          operation,
          isError: (result: any) => result?.isError === true,
          runningResult: (result: any) => isPendingSubagentOperation(name, result)
            || (name !== "write_stdin" && result?.structuredContent?.running === true),
          resultRef: (result: any) => {
            const value = result?.structuredContent;
            if (typeof value?.result_ref === "string" && value.result_ref.length > 0) return value.result_ref;
            if (typeof value?.operation_id === "string" && value.operation_id.length > 0) return value.operation_id;
            if (typeof value?.result_sha256 === "string" && value.result_sha256.length > 0) return `sha256:${value.result_sha256}`;
            return null;
          },
          operationStatus: (result: any, context) => {
            void context;
            if (result?.structuredContent?.state === "cancelled") {
              return { state: OperationState.cancelled, effect: result.structuredContent.effect ?? "completed", exit_code: null };
            }
            if (isPendingSubagentOperation(name, result)) {
              return { state: OperationState.running, effect: "started" as const, exit_code: null };
            }
            if (name !== "write_stdin" && result?.structuredContent?.running === true) {
              return { state: OperationState.running, effect: "started" as const, exit_code: result.structuredContent.exit_code ?? null };
            }
            if (result?.isError === true) {
              const outcome=classifyToolResultError(result,{sideEffecting:affectsFiles,forwarded});
              return { state: outcome.state, effect: outcome.effect, exit_code: null,
                error_code:outcome.code,error_message:outcome.message };
            }
            const exitCode=result?.structuredContent?.exit_code;
            return { state: typeof exitCode==="number" && exitCode!==0 ? OperationState.failed : OperationState.succeeded,
              effect: "completed" as const, exit_code: exitCode ?? null };
          },
          knownPaths: () => knownWritePaths,
          contextRead: async (result: any, context) => {
            if (name === toolNames.read) {
              const workspace = await workspaces.getWorkspace(workspaceId);
              const resolved = await workspaces.resolveReadPath(workspace, String(input.path));
              const content = typeof result?.structuredContent?.result === "string"
                ? result.structuredContent.result
                : contentText(result?.content ?? []);
              const explicitRange = input?.offset !== undefined || input?.limit !== undefined || Number(input?.response_offset ?? 0) > 0;
              const start = Number(input?.offset ?? 1);
              const end = start + Math.max(0, content.split(/\r?\n/u).length - 1);
              runtime.context.recordHostRead(context, resolved.absolutePath, content, explicitRange ? { start, end } : null);
              return;
            }
            if (name === "workspace_context" && Array.isArray(result?.structuredContent?.entries)) {
              const workspace = await workspaces.getWorkspace(workspaceId);
              for (const entry of result.structuredContent.entries) {
                if (typeof entry?.path !== "string" || !Array.isArray(entry.lines) || entry.error || !entry.lines.length) continue;
                const resolvedPath = resolveSessionPath(workspace.root,entry.path);
                const content = entry.lines.map((line: any) => typeof line?.text === "string" ? line.text : "").join("\n");
                const start = Number(entry.lines[0]?.line ?? 1);
                const end = Number(entry.lines.at(-1)?.line ?? start);
                runtime.context.recordHostRead(context, resolvedPath, content, { start, end });
              }
            }
          },
        }).then(compatibleToolReceipt);
      };
      const recordedHandler = (input: any, extra: any) => recordOperation(input, extra, async () => handler(input, extra)).catch(error => {
        if (["WORKSPACE_NOT_FOUND", "WORKSPACE_RESTORE_REQUIRED"].includes(errorCode(error))) return toolErrorResult(error);
        throw error;
      });
      return (server.registerTool as any)(name, definition, markSessionRecordedTool(
        recordedHandler,
        async (input, extra, operation, options) => recordOperation(input, extra, operation, options?.forwarded === true),
      ));
    }) as McpRegistrationTarget["registerTool"],
    registerResource: server.registerResource.bind(server),
  };
}

export interface CreateServerOptions {
  diagnostics?: Pick<ServerDiagnostics, "record">;
  incomingArtifactAdapters?: readonly IncomingArtifactAdapter[];
  registerProject?: typeof ensureDesktopProject;
}

export function createServer(
  config = loadConfig(),
  options: CreateServerOptions = {},
): RunningServer {
  const incomingArtifactAdapters = options.incomingArtifactAdapters
    ?? [createOpenAIIncomingArtifactAdapter()];
  const allowedHosts = config.allowedHosts.includes("*")
    ? undefined
    : Array.from(new Set([config.host, ...config.allowedHosts]));
  const app = createMcpHttpApp({
    host: config.host,
    ...(allowedHosts ? { allowedHosts } : {}),
    onRejected: (req, fields) => {
      const requestId = (req as Request & { [httpDiagnosticRequestId]?: string })[httpDiagnosticRequestId] ?? randomUUID();
      if (options.diagnostics) options.diagnostics.record("mcp_request_rejected", { requestId, ...fields }, "warn");
      else logEvent(config.logging, "warn", "mcp_request_rejected", { requestId, ...fields });
      return requestId;
    },
  });
  const mcpUrl = new URL("/mcp", config.publicBaseUrl);
  const resourceServerUrl = resourceUrlFromServerUrl(mcpUrl);
  const workspaceStore = createWorkspaceStore(config.stateDir);
  const workRunReconciler = new WorkRunReconciler(config.stateDir, 60_000, error => {
    if (options.diagnostics) options.diagnostics.record("work_run_reconcile_failed", diagnosticError(error), "error");
    else logEvent(config.logging, "error", "work_run_reconcile_failed", diagnosticError(error));
  });
  workRunReconciler.start();
  const workspaces = new WorkspaceRegistry(config, workspaceStore);
  const reviewCheckpoints = createReviewCheckpointManager();
  const processSessions = new ProcessSessionManager({ stateDir: config.stateDir,
    environment: () => config.federation?.enabled && config.federation.egress.enabled && config.federation.egress.inheritProxy
      ? proxyEnvironment(config.federation.egress.listenPort, { NO_PROXY: process.env.NO_PROXY ?? process.env.no_proxy }, config.federation.peers.filter((peer) => peer.url).map((peer) => new URL(peer.url).hostname)) : {},
    diagnostics: (event, fields, level) => options.diagnostics
      ? options.diagnostics.record(event, fields, level) : logEvent(config.logging, level, event, fields) });
  const installationTransitionFile = process.env.QUAYMESH_INSTALL_TRANSITION_FILE;
  const installationPending = () => installationTransitionPending(installationTransitionFile);
  const admissionInstance = Object.freeze({ pid: processOwner.pid, processStart: processOwner.start, token: processOwner.token });
  // A first install or an externally stopped old Core may have no persisted
  // pause. Keep direct peer calls and egress frozen during release validation,
  // before federation starts accepting connections.
  if (installationPending()) processSessions.executionCoordinator!.pause("node-maintenance");
  else processSessions.executionCoordinator!.resumeAfterRestart();
  const sessionLedger = new ProjectWorkLedger(config.stateDir);
  const localAgentStore = new LocalAgentStore(config.stateDir);
  const sessionRuntime = createSessionRuntime({
    config,
    workspaces,
    ledger: sessionLedger,
    agents: localAgentStore,
    execution: processSessions.executionCoordinator,
    processSessions,
    diagnostics: (event, fields, level) => options.diagnostics
      ? options.diagnostics.record(event, fields, level) : logEvent(config.logging, level ?? "info", event, fields),
  });
  const toolActivities = new ToolActivityTracker();
  const localAgentProviders = buildLocalAgentProviderStatuses(
    config.subagents,
    getLocalAgentProviderAvailabilitySnapshot(process.env, config.subagents),
  );
  const resolveLocalAgentProviders = () => buildLocalAgentProviderStatuses(
    config.subagents,
    getLocalAgentProviderAvailabilitySnapshot(process.env, config.subagents),
  );
  let projectConsole: ReturnType<typeof createProjectConsoleRouter>;
  const federation = createFederation(config, workspaces, resolveLocalAgentProviders,
    (method, path, body) => projectConsole.dispatch(method, path, body), sessionRuntime, processSessions.executionCoordinator,
    (event,fields,level)=>options.diagnostics ? options.diagnostics.record(event,fields,level) : logEvent(config.logging,level??"info",event,fields));
  const oauthProvider = new SingleUserOAuthProvider(config.oauth, mcpUrl, config.stateDir);
  const bearerAuth = requireBearerAuth({
    verifier: oauthProvider,
    requiredScopes: [config.oauth.scopes[0] ?? "quaymesh"],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
  });
  const bindModernMcpSurface = compileMcpRegistrationSurface((target) => {
    const admittedTarget = admittedTools(target, processSessions.executionCoordinator!);
    registerMcpSurface(
      federation ? federatedTools(admittedTarget, federation) : admittedTarget,
      config,
      workspaces,
      reviewCheckpoints,
      processSessions,
      resolveLocalAgentProviders,
      incomingArtifactAdapters,
      toolActivities.track,
      options.registerProject,
      sessionRuntime,
    );
    if (federation) registerFederationTools(admittedTarget, federation);
  });
  const logMcpHandlerError = (error: Error) => logEvent(
    config.logging,
    "error",
    "mcp_handler_error",
    modernMcpAdapterErrorLogFields(error),
  );
  const mcpHandler = createMcpHandler(() => {
    const adapter = createModernMcpServerAdapter(
      mcpServerInfo(),
      { instructions: serverInstructions(config) },
    );
    bindModernMcpSurface(adapter.registrationTarget);
    return adapter.server;
  }, {
    legacy: "stateless",
    // SSE 首帧由响应包装器补充；仅创建 Response 不会立即发出网络字节。
    responseMode: "sse",
    // SDK 自带 SSE 注释心跳。复用标准实现，避免与传输层同时写流。
    keepAliveMs: 5_000,
    onerror: logMcpHandlerError,
  });
  const mcpNodeHandler = toNodeHandler({
    fetch: async (request, options) => primeMcpSseResponse(await mcpHandler.fetch(request, options)),
  }, {
    onerror: logMcpHandlerError,
  });

  if (config.logging.trustProxy) {
    app.set("trust proxy", "loopback");
  }

  const healthLog = new Map<string,{count:number;started:number;maxMs:number}>();
  app.use((req, res, next) => {
    const requestId = (req as Request & { [httpDiagnosticRequestId]?: string })[httpDiagnosticRequestId] ?? randomUUID();
    const startedAt = performance.now();
    res.locals.requestId = requestId;

    res.on("finish", () => {
      const path = requestPath(req);
      if (!config.logging.requests) return;
      const durationMs=Math.round(performance.now()-startedAt);
      if(["/healthz","/readyz"].includes(path) && res.statusCode===200) {
        const sample=healthLog.get(path) ?? {count:0,started:Date.now(),maxMs:0};
        sample.count++;sample.maxMs=Math.max(sample.maxMs,durationMs);
        healthLog.set(path,sample);
        if(Date.now()-sample.started>=30000) {
          logEvent(config.logging,"info","health_request_summary",{path,count:sample.count,maxDurationMs:sample.maxMs,
            intervalMs:Date.now()-sample.started,status:200});
          healthLog.delete(path);
        }
        return;
      }

      logEvent(config.logging, "info", "http_request", {
        requestId,
        method: req.method,
        path,
        status: res.statusCode,
        durationMs: Math.round(performance.now() - startedAt),
        ...requestLogFields(req, config),
      });
    });

    next();
  });

  app.use(
    mcpAuthRouter({
      provider: oauthProvider,
      issuerUrl: new URL(config.publicBaseUrl),
      baseUrl: new URL(config.publicBaseUrl),
      resourceServerUrl,
      scopesSupported: config.oauth.scopes,
      resourceName: "QuayMesh",
    }),
  );

  app.get("/internal/quaymesh/idle", (req, res) => {
    const token = process.env[config.federation?.tokenEnv || "QUAYMESH_CLUSTER_TOKEN"];
    if (!token || req.headers.authorization !== `Bearer ${token}`) { res.status(401).json({error:"unauthorized"}); return; }
    res.json({ ok: true, ...processSessions.executionCoordinator!.admissionStatus(), instance: admissionInstance });
  });

  app.post("/internal/quaymesh/admission", express.json({ limit: "4kb" }), (req, res) => {
    const token = process.env[config.federation?.tokenEnv || "QUAYMESH_CLUSTER_TOKEN"];
    if (!token || req.headers.authorization !== `Bearer ${token}`) { res.status(401).json({ error: "unauthorized" }); return; }
    const action = req.body?.action;
    if (action !== "pause" && action !== "resume") { res.status(400).json({ error: "invalid_admission_action" }); return; }
    const conditional = Object.prototype.hasOwnProperty.call(req.body ?? {}, "expected");
    const expected: unknown = req.body?.expected;
    if (conditional && !isAdmissionPrecondition(expected)) {
      res.status(400).json({ error: "INVALID_ADMISSION_PRECONDITION" }); return;
    }
    const execution = processSessions.executionCoordinator!;
    if (conditional && isAdmissionPrecondition(expected) && !sameAdmissionInstance(expected.instance, admissionInstance)) {
      res.status(409).json({ error: "ADMISSION_PRECONDITION_FAILED", conflict: "instance",
        ...execution.admissionState(), instance: admissionInstance }); return;
    }
    if (conditional && action === "pause"
        && (typeof req.body.reason !== "string" || !req.body.reason.trim() || req.body.reason.length > 1024)) {
      res.status(400).json({ error: "invalid_admission_reason" }); return;
    }
    if (action === "resume" && installationPending()) {
      res.status(409).json({ error: "INSTALLATION_VALIDATION_PENDING", message: "发行切换仍在验证或等待恢复，准入保持暂停。" }); return;
    }
    if (conditional && isAdmissionPrecondition(expected)) {
      const result = execution.compareAndSetAdmission(expected, { accepting: action === "resume",
        reason: action === "pause" ? req.body.reason : null });
      if (!result.changed) {
        res.status(409).json({ error: "ADMISSION_PRECONDITION_FAILED", conflict: "state",
          ...result.state, instance: admissionInstance }); return;
      }
      federation?.refreshAdmission();
      res.json({ ok: true, ...execution.admissionStatus(), ...result.state, instance: admissionInstance }); return;
    }
    if (action === "pause") execution.pause(typeof req.body.reason === "string" ? req.body.reason : undefined);
    else execution.resume();
    federation?.refreshAdmission();
    res.json({ ok: true, ...execution.admissionStatus(), instance: admissionInstance });
  });

  app.post("/internal/quaymesh/console", express.json({ limit: "2mb" }), async (req, res) => {
    const token = process.env[config.federation?.tokenEnv || "QUAYMESH_CLUSTER_TOKEN"];
    if (!token || req.headers.authorization !== `Bearer ${token}`) { res.status(401).json({ error: "unauthorized" }); return; }
    if (!federation) { res.status(503).json({ error: "federation_unavailable" }); return; }
    const body = req.body as { nodeId?: string; request?: Record<string, unknown> };
    const nodeId = typeof body?.nodeId === "string" ? body.nodeId : federation.localId;
    try {
      const method = String(body.request?.method ?? "GET").toUpperCase();
      const request = () => federation.request(nodeId, "console.request", body?.request ?? {});
      const reply = await (["GET", "HEAD"].includes(method) ? request()
        : processSessions.executionCoordinator!.withWork({kind: "console"}, request));
      res.status(200).json(reply);
    } catch (error) {
      res.status(502).json({ code: "CONSOLE_REQUEST_FAILED", message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, name: "quaymesh", status: "healthy", pid: process.pid,
      uptimeSec: Math.floor(process.uptime()), port: config.port });
  });
  app.get("/readyz", (_req, res) => {
    if (federation?.startupError) {
      res.status(503).json({ ok: false, name: "quaymesh", status: "starting", pid: process.pid,
        uptimeSec: Math.floor(process.uptime()), port: config.port, error: federation.startupError });
      return;
    }
    const dbOk = workspaceStore.checkDatabase ? workspaceStore.checkDatabase() : true;
    if (!dbOk) {
      res.status(503).json({ ok: false, name: "quaymesh", status: "unhealthy", pid: process.pid,
        uptimeSec: Math.floor(process.uptime()), port: config.port, database: "error" });
      return;
    }
    res.json({ ok: true, name: "quaymesh", status: "healthy", pid: process.pid,
      uptimeSec: Math.floor(process.uptime()), port: config.port, database: "ok" });
  });

  projectConsole = createProjectConsoleRouter(config, { assetDirectory: uiBuildDirectory(), federation, sessionRuntime, processSessions, relayConsoleEnabled: true,
    fleetDirectory: fileURLToPath(new URL("./ui/fleet/", import.meta.url)) });
  app.get(/^\/console$/, (req, res) => res.redirect(303, `/console/${req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : ""}`));
  app.use("/console", async (req, res, next) => {
    // 浏览和刷新不需要执行占用，锁竞争期间仍能查看已有状态。
    if (["GET", "HEAD"].includes(req.method)) { next(); return; }
    const observation = ["/api/login", "/api/logout", "/api/fleet/transfers/cancel"].includes(req.path);
    let lease: RuntimeWorkLease;
    try { lease = await processSessions.executionCoordinator!.beginWorkAsync({kind:"console",allowWhilePaused:observation}); }
    catch (error) { res.status(503).json({error:diagnosticError(error).errorCode ?? "CONSOLE_ADMISSION_FAILED",message:error instanceof Error?error.message:String(error)}); return; }
    let released: Promise<void> | undefined;
    const release = () => { released ??= lease.releaseAsync().catch(error => {
      logEvent(config.logging, "warn", "console_work_release_pending", diagnosticError(error));
    }); };
    res.once("finish",release);res.once("close",release);
    if (res.destroyed || res.writableFinished) { release(); return; }
    lease.run(next);
  });
  app.use("/console", projectConsole.router);

  app.all("/mcp", async (req, res) => {
    const requestId = res.locals.requestId as string | undefined;
    const requestTrace = config.logging.requests ? traceMcpRequest(req, res, requestId ?? randomUUID(),
      (event, fields, level = "info") => options.diagnostics
        ? options.diagnostics.record(event, fields, level) : logEvent(config.logging, level, event, fields)) : undefined;

    await new Promise<void>((resolve, reject) => {
      bearerAuth(req, res, (error?: unknown) => {
        if (error) reject(error);
        else resolve();
      });
    });
    if (res.headersSent) return;

    if (!req.auth?.resource || !oauthProvider.isResourceAllowed(req.auth.resource)) {
      logEvent(config.logging, "warn", "auth_denied", {
        requestId,
        method: req.method,
        path: requestPath(req),
        reason: "invalid_oauth_resource",
        ...requestLogFields(req, config),
      });
      sendJsonRpcError(res, 401, -32001, "Unauthorized");
      return;
    }
    requestTrace?.authenticated();

    // 无状态 HTTP 请求每次使用独立的传输身份。客户端可以重复使用 JSON-RPC 序号，
    // 不能把同一对话里的不同调用当成同一次调用的重试。客户端提供 MCP 会话标识时，
    // 才使用该会话身份做跨请求去重。
    req.auth = withLocallyAuthenticatedTaskClient({ ...req.auth, extra: {
      ...req.auth.extra,
      transport_instance_id: typeof req.headers["mcp-session-id"] === "string"
        ? req.headers["mcp-session-id"]
        : `http:${requestId ?? randomUUID()}`,
    } });
    logEvent(config.logging, "debug", "mcp_request", {
      requestId,
      method: req.method,
    });

    try {
      await mcpNodeHandler(req, res, normalizeCachedToolCall(req.body));
    } catch (error) {
      if (error instanceof ConflictingToolAliasError) {
        if (!res.headersSent) sendJsonRpcError(res, 400, -32602, error.message);
        return;
      }
      logEvent(config.logging, "error", "mcp_request_error", {
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, -32603, "Internal server error");
      }
    }
  });

  let closePromise: Promise<void> | undefined;
  return {
    app,
    config,
    workspaceStore,
    localAgentProviders,
    federation,
    ready: federation?.start() ?? Promise.resolve(),
    execution: processSessions.executionCoordinator!,
    close: () => {
      closePromise ??= (async () => {
        await processSessions.executionCoordinator!.pauseAsync("服务正在退出");
        try {
          await mcpHandler.close();
        } catch (error) {
          logEvent(config.logging, "warn", "mcp_handler_close_failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        await workRunReconciler.close();
        await federation?.close();
        await toolActivities.waitForIdle();
        await processSessions.shutdown();
        await sessionRuntime.close();
        localAgentStore.close();
        sessionLedger.close();
        projectConsole.close();
        oauthProvider.close();
        workspaceStore.close?.();
      })();
      return closePromise;
    },
  };
}

async function isMainModule(): Promise<boolean> {
  if (!process.argv[1]) return false;

  const modulePath = await realpath(fileURLToPath(import.meta.url));
  const entrypointPath = await realpath(process.argv[1]);
  return modulePath === entrypointPath;
}

if (await isMainModule()) {
  const config = loadConfig();
  const diagnostics = new ServerDiagnostics(config);
  const { app, close, localAgentProviders, ready, execution } = diagnostics.start(() => createServer(config, { diagnostics }));
  await ready;
  const httpServer = app.listen(config.port, config.host, () => {
    console.log(
      `quaymesh listening on http://${config.host}:${config.port}/mcp`,
    );
    console.log(`allowed roots: ${config.allowedRoots.join(", ")}`);
    console.log("auth: oauth owner-token flow required");
    console.log(`logging: ${config.logging.level} ${config.logging.format}`);
    console.log(`request logging: ${config.logging.requests ? "enabled" : "disabled"}`);
    console.log(`asset logging: ${config.logging.assets ? "enabled" : "disabled"}`);
    console.log(`trust proxy: ${config.logging.trustProxy ? "enabled" : "disabled"}`);
    const artifactDownloadStatus = !config.artifactsEnabled
      ? "disabled"
      : isArtifactDownloadSupportedPlatform()
        ? "enabled"
        : `unsupported on ${process.platform}`;
    console.log(`native artifact download: ${artifactDownloadStatus}`);
    console.log(`subagent providers: ${formatLocalAgentProviderStatusSummary(localAgentProviders)}`);
  });

  diagnostics.attach(httpServer);
  let shuttingDown = false;
  let admissionStopped = false;
  let runtimeShutdown: (() => Promise<void>) | undefined;
  const runtimePipe = process.env.QUAYMESH_RUNTIME_CONTROL_PIPE;
  const runtimeInstance = process.env.QUAYMESH_RUNTIME_INSTANCE_ID;
  const runtimeStartedAt = process.env.QUAYMESH_RUNTIME_STARTED_AT;
  const runtime = runtimePipe && runtimeInstance && runtimeStartedAt
    ? createRuntimeControlServer({
      instanceId: runtimeInstance,
      pid: process.pid,
      startedAt: runtimeStartedAt,
      handle: async (request: RuntimeControlRequest) => {
        if (request.operation === "status") return { accepted: true, state: shuttingDown ? "stopping" : admissionStopped ? "received" : "saved" };
        if (request.operation === "stop_admission") { admissionStopped = true; execution.pause("服务准备停止"); return { accepted: true, state: "received" }; }
        if (!runtimeShutdown) return { accepted: false, state: "rejected", error: "shutdown_not_ready" };
        admissionStopped = true; execution.pause("服务准备停止");
        void runtimeShutdown();
        return { accepted: true, state: "stopping" };
      },
    })
    : undefined;
  if (runtime) {
    runtime.server.on("error", (error) => {
      const message = error instanceof Error ? error.message : String(error);
      diagnostics.record("runtime_control_listen_error", { error: message }, "error");
      console.error(`runtime control listen failed: ${message}`);
    });
    runtime.server.listen(runtimePipe, () => {
      diagnostics.record("runtime_control_listening", { pid: process.pid });
      console.log(`runtime control listening: ${runtimePipe}`);
    });
  }
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await shutdownHttpServer(httpServer, close, (event) => diagnostics.record(event));
    await runtime?.close();
    await diagnostics.flush();
    process.exit(0);
  };
  runtimeShutdown = shutdown;
  const handleShutdown = (signal: string) => {
    diagnostics.record("server_signal_received", { signal, shuttingDown });
    void shutdown().catch((error) => {
      diagnostics.record("server_shutdown_failed", diagnosticError(error), "error");
      console.error("quaymesh shutdown failed", error);
      process.exit(1);
    });
  };
  process.once("SIGINT", handleShutdown);
  process.once("SIGTERM", handleShutdown);
}
