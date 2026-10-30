import * as z from "zod/v4";
import { applyPatch, parsePatch } from "../apply-patch.js";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { currentInvocation } from "../session/invocations.js";
import { canonicalResourcePath, containsResource, type ExecutionResource } from "../execution-resources.js";
import { resolveCommandProfile } from "../command-profiles.js";
import {
  MAX_PROCESS_YIELD_MS,
  type ProcessSnapshot,
} from "../process-sessions.js";
import { jsonReply } from "../bounded-reply.js";
import { commandOutput } from "./operations.js";
import {
  EDIT_TOOL_ANNOTATIONS,
  shellToolAnnotations,
  toolNames,
  workspaceIdDescription,
  type ToolLogFields,
  type ToolRegistrationContext,
} from "./types.js";
import {
  contentText,
  resultOutputSchema,
  runLoggedToolOperation,
  textBlock,
} from "./shared.js";

type CodexRegistration = (context: ToolRegistrationContext) => void;

const CODEX_INSTRUCTIONS = `Use the reported shell. Batch related reads and run deterministic analysis as saved scripts. Delegate independent work only when appropriate.`;

export function codexInstructions(): string {
  return CODEX_INSTRUCTIONS;
}

export function registerCodexTools(context: ToolRegistrationContext): void {
  for (const register of CODEX_REGISTRATIONS) {
    register(context);
  }
}

const CODEX_REGISTRATIONS: readonly CodexRegistration[] = [
  registerApplyPatchTool,
  registerCodexProcessTools,
];

function processOutputSchema(): z.ZodRawShape {
  return {operation_id:z.string(),result:z.string(),running:z.boolean(),exit_code:z.number().optional(),
    signal:z.string().optional(),session_id:z.number().optional(),next_cursor:z.number().optional(),
    output_done:z.boolean().optional(),output_truncated:z.boolean().optional(),retained_from:z.number().optional(),
    state:z.string().optional(),accepted:z.boolean().optional(),effect:z.string().optional(),
    poll_after_ms:z.number().optional(),next_action:z.unknown().optional()};
}

async function processToolResponse(context:ToolRegistrationContext,workspaceId:string,snapshot:ProcessSnapshot,cursor=0,maxTokens=10000,accepted?:boolean) {
  const saved=context.sessionRuntime&&currentInvocation()&&snapshot.sessionId
    ? await commandOutput(context,workspaceId,snapshot.sessionId,cursor,Math.max(4,Math.min(16384,maxTokens*4)),true) : null;
  const unknown=saved?.operation_state==="reconciliation_required";
  const result={operation_id:snapshot.sessionId!,result:saved?.result??snapshot.output,
    running:unknown?false:saved?!saved.process_done:snapshot.running,
    ...(saved?.exit_code!==null&&saved?.exit_code!==undefined?{exit_code:saved.exit_code}:snapshot.exitCode!==undefined?{exit_code:snapshot.exitCode}:{}),
    ...(snapshot.signal?{signal:snapshot.signal}:{}),
    ...(snapshot.legacySessionId?{session_id:snapshot.legacySessionId}:{}),
    ...(saved?{next_cursor:saved.next_cursor,output_done:saved.done}:{}),
    ...(saved?.truncated?{output_truncated:true,retained_from:saved.retained_from}:{}),
    ...(unknown?{state:"reconciliation_required"}:{}),...(accepted!==undefined?{accepted}:{}),
  };
  return {...jsonReply(result,unknown?"Process ownership needs reconciliation.":result.running?"Command running.":result.exit_code===0?"Command completed.":"Command ended; inspect exit_code."),
    _meta:{quaymesh:{execution:snapshot.execution,phase:snapshot.phase,terminal_replay:snapshot.terminalReplay,
      wall_time_ms:snapshot.wallTimeMs,output_scope:saved?"absolute_cursor":snapshot.outputScope,
      ...(saved?{cursor:saved.cursor,total_bytes:saved.total_bytes,retained_from:saved.retained_from,retained_until:saved.retained_until}:{})}}};
}

function registerApplyPatchTool(context: ToolRegistrationContext): void {
  const { server, config, workspaces, processSessions } = context;

  server.registerTool(
    "apply_patch",
    {
      title: "Apply patch",
      description:
        "Apply a *** Begin Patch / *** End Patch patch using workspace-relative paths. If accepted, query workspace_context status with operation_id for the saved result.",
      inputSchema: {
        workspace_id: z.string().describe("Workspace handle."),
        patch: z
          .string()
          .describe(
            "Patch text enclosed by *** Begin Patch and *** End Patch markers.",
          ),
        expected_content:z.record(z.string(),z.string().nullable()).optional()
          .describe("Expected target text; null requires absence."),
      },
      outputSchema: resultOutputSchema({
        accepted: z.boolean().optional(),
        running: z.boolean().optional(),
        state: z.string().optional(),
        effect: z.string().optional(),
        poll_after_ms: z.number().optional(),
        next_action: z.unknown().optional(),
        additions: z.number().optional(),
        removals: z.number().optional(),
        files: z.array(
          z.object({
            path: z.string(),
            previous_path: z.string().optional(),
            operation: z.enum(["add", "update", "delete", "move"]),
          }),
        ).optional(),
      }),
      annotations: EDIT_TOOL_ANNOTATIONS,
    },
    async ({ workspace_id, patch, expected_content }) => {
      const workspaceId = workspace_id;
      const startedAt = performance.now();
      const applied = await runLoggedToolOperation(
        config,
        { tool: "apply_patch", workspaceId },
        startedAt,
        async () => {
          const workspace = await workspaces.getWorkspace(workspaceId);
          const paths=[...new Set(parsePatch(patch).flatMap(action=>action.kind==="update"&&action.moveTo?[action.path,action.moveTo]:[action.path]))];
          const scopes:ExecutionResource[]=paths.map(path=>({kind:"file",path:canonicalResourcePath(resolve(workspace.root,path)),access:"write"}));
          const root=canonicalResourcePath(workspace.root);
          if(scopes.some(scope=>scope.kind!=="named"&&!containsResource(root,scope.path)))throw new Error("补丁目标超出工作区");
          for(const path of Object.keys(expected_content??{}))if(!paths.includes(path))throw new Error(`内容前提需要对应补丁目标：${path}`);
          return processSessions.mutate(workspace.root, async()=>{
            for(const [path,expected] of Object.entries(expected_content??{})){
              const current=await readFile(resolve(workspace.root,path),"utf8").catch((error:NodeJS.ErrnoException)=>{
                if(error.code==="ENOENT")return null;throw error;
              });
              if(current!==expected)throw new Error(`FILE_CONTENT_CHANGED: ${path}；请重新读取再提交修改`);
            }
            return applyPatch(workspace.root,patch);
          },scopes);
        },
      );
      const result = `Updated ${applied.files.length} file(s).`;
      const content = [textBlock(result)];

      return {
        content,
        structuredContent: {
          result,
          operation_id:currentInvocation()?.operation_id,
          additions: applied.additions,
          removals: applied.removals,
          files: applied.files.map(({ previousPath, ...file }) => ({
            ...file,
            previous_path: previousPath,
          })),
        },
      };
    },
  );
}

function registerCodexProcessTools(context: ToolRegistrationContext): void {
  const { server, config, workspaces, processSessions } = context;

  server.registerTool(
    "exec_command",
    {
      title: "Execute command",
      description:
        "Run cmd or a configured profile using the workspace shell. Slow preparation returns accepted with operation_id; query workspace_context status, then read_output for command output.",
      inputSchema: {
    workspace_id:z.string(),cmd:z.string().min(1).optional(),profile:z.string().min(1).optional(),
    execution_scope:z.string().min(1).optional().describe("Affected project area for write scheduling, relative to workspace. Shell file access follows local OS permissions."),
    working_directory:z.string().optional(),tty:z.boolean().optional(),
    columns:z.number().int().min(1).max(1000).optional(),rows:z.number().int().min(1).max(1000).optional(),
    yield_time_ms:z.number().int().min(0).max(MAX_PROCESS_YIELD_MS).optional().describe("Initial wait; default 2000 ms."),
    max_output_tokens:z.number().int().positive().max(100000).optional().describe("Preview budget; remaining output stays readable."),
  },
      outputSchema: processOutputSchema(),
      annotations: shellToolAnnotations(config),
    },
    async ({
      workspace_id,
      cmd,
      profile,
      execution_scope,
      tty,
      columns,
      rows,
      working_directory,
      yield_time_ms,
      max_output_tokens,
    }) => {
      if(Boolean(cmd)===Boolean(profile))throw new Error("请且仅指定 cmd 或 profile");
      if(profile && execution_scope)throw new Error("profile 的执行范围由宿主配置确定");
      const startedAt = performance.now();
      const workspaceId = workspace_id;
      const workingDirectory = working_directory;
      const yieldTimeMs = yield_time_ms;
      const maxOutputTokens = max_output_tokens;
      const snapshot = await runLoggedToolOperation(
        config,
        {
          tool: "exec_command",
          workspaceId,
          workingDirectory: workingDirectory ?? ".",
          command: cmd,
          commandLength: cmd?.length ?? 0,
        },
        startedAt,
        async () => {
          const workspace = await workspaces.getWorkspace(workspaceId);
          const cwd = await workspaces.resolveWorkingDirectory(
            workspace,
            workingDirectory,
          );
          const scopeRoot=execution_scope ? await workspaces.resolveWorkingDirectory(workspace,execution_scope) : undefined;
          const operationId=currentInvocation()?.operation_id ?? `command_${randomUUID()}`;
          const plan=profile ? await resolveCommandProfile({name:profile,profiles:config.commandProfiles??{},
            workspaceRoot:workspace.root,cwd,stateDir:config.stateDir,operationId,env:process.env}) : undefined;
          return processSessions.start({
            workspaceId,
            command: cmd ?? `profile:${profile}`,
            cwd:plan?.cwd ?? cwd,
            workspaceRoot: workspace.root,
            sessionOperationId:operationId,
            scopeRoot,
            ...(plan ? {program:plan.program,scopes:plan.scopes} : {}),
            tty,
            columns,
            rows,
            yieldTimeMs,
            maxOutputTokens,
          });
        },
        processLogFields,
      );

      return processToolResponse(context, workspaceId, snapshot, 0, maxOutputTokens);
    },
  );

  server.registerTool(
    "write_stdin",
    {
      title: "Write to process",
      description:
        "Send stdin or resize a process. Empty calls read from cursor (default 0); prefer read_output. Retry input only with the same operation_key.",
      inputSchema: {
    workspace_id:z.string(),operation_id:z.string().min(1).max(256).optional(),
    session_id:z.union([z.number().int().positive(),z.string().min(1).max(256)]).optional().describe("Existing session."),
    chars:z.string().optional(),cursor:z.number().int().nonnegative().default(0),
    columns:z.number().int().min(1).max(1000).optional(),rows:z.number().int().min(1).max(1000).optional(),
    yield_time_ms:z.number().int().min(0).max(MAX_PROCESS_YIELD_MS).optional(),
    max_output_tokens:z.number().int().positive().max(100000).optional(),
  },
      outputSchema: processOutputSchema(),
      annotations: shellToolAnnotations(config),
    },
    async ({
      workspace_id,
      session_id,
      operation_id,
      cursor,
      chars,
      columns,
      rows,
      yield_time_ms,
      max_output_tokens,
    }) => {
      const startedAt = performance.now();
      const workspaceId = workspace_id;
      if ((session_id === undefined) === (operation_id === undefined)) throw new Error("Supply exactly one of session_id or operation_id.");
      const sessionId = processSessions.resolveHandle(operation_id ?? session_id!);
      if (!processSessions.findOperation(sessionId) && !chars && columns === undefined && rows === undefined) {
        const saved = await commandOutput(context,workspaceId,sessionId,cursor,Math.max(4,Math.min(16384,(max_output_tokens??10000)*4)));
        const invocation = currentInvocation()!;
        const workspace = await workspaces.getWorkspace(workspaceId);
        const recorded = context.sessionRuntime!.store.requireCommand(invocation.owner_id,config.federation?.nodeId ?? "local",workspace.canonicalRoot,sessionId);
        if (!recorded.execution || !saved.process_done) throw new Error("COMMAND_NOT_ATTACHED: use read_output to inspect saved evidence");
        return {...jsonReply({result:saved.result,operation_id:sessionId,
          ...(typeof session_id==="number"?{session_id}:{}),running:false,exit_code:saved.exit_code??undefined,
          next_cursor:saved.next_cursor,output_done:saved.done}),
          _meta:{quaymesh:{execution:recorded.execution,phase:"closed",terminal_replay:true}}};
      }
      const yieldTimeMs = yield_time_ms;
      const maxOutputTokens = max_output_tokens;
      const snapshot = await runLoggedToolOperation(
        config,
        { tool: "write_stdin", workspaceId },
        startedAt,
        async () => {
          await workspaces.getWorkspace(workspaceId);
          return processSessions.write({
            workspaceId,
            sessionId,
            chars,
            columns,
            rows,
            yieldTimeMs,
            maxOutputTokens,
          });
        },
        processLogFields,
      );

      return processToolResponse(context, workspaceId, snapshot, cursor, maxOutputTokens, chars?.length ? true : undefined);
    },
  );
}

export function processLogFields(result: ProcessSnapshot): Partial<ToolLogFields> {
  const success = result.running || (!result.signal && result.exitCode === 0);
  const termination = result.signal
    ? `Process terminated by signal ${result.signal}.`
    : `Process exited with code ${result.exitCode ?? "unknown"}.`;
  return {
    sessionId: result.sessionId,
    running: result.running,
    exitCode: result.exitCode,
    success,
    ...(success ? {} : { error: termination }),
  };
}
