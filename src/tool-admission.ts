import type { McpRegistrationTarget } from "./mcp-modern-server.js";
import * as z from "zod/v4";
import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import type { ExecutionCoordinator } from "./execution-coordinator.js";
import { observationBudget, observeWithSignal } from "./observation-budget.js";
import { RecordedInvocationError, toolErrorResult } from "./session/outcome.js";

const taskIdField = z.string().min(1).max(256)
  .describe("Task for this call. Pass start_session's task_id when the host has no conversation ID.");
const taskScopeInput = z.object({task_id: taskIdField.optional()}).passthrough();

function withTaskScopeInput(value: unknown): StandardSchemaWithJSON {
  const schema = value && typeof value === "object" && "~standard" in value
    ? value as StandardSchemaWithJSON : z.object(value as z.ZodRawShape);
  const original = schema["~standard"];
  const properties = (shape: Record<string, unknown>, field: Record<string, unknown>) => ({...shape,
    properties: {...shape.properties as Record<string, unknown>, task_id: field}});
  return {"~standard": {...original,
    validate: async value => {
      const selected = taskScopeInput.safeParse(value);
      if (!selected.success) return {issues: selected.error.issues};
      const {task_id, ...parameters} = selected.data;
      const result = await original.validate(parameters);
      return result.issues ? result : {value: {...result.value as Record<string, unknown>, ...(task_id ? {task_id} : {})}};
    },
    jsonSchema: {
      input: options => properties(original.jsonSchema.input(options), taskIdField["~standard"].jsonSchema.input(options)),
      output: options => properties(original.jsonSchema.output(options), taskIdField["~standard"].jsonSchema.output(options)),
    },
  }};
}

export function isReadOnlyObservation(name: string, input: Record<string, unknown>): boolean {
  if (name === "task_resume") return input.action === "inspect";
  if (["read_output", "read_diagnostics", "list_agents", "wait_agent", "qm_session", "qm_task_messages"].includes(name)) return true;
  if (name === "workspace_context") return input.action === "status" || input.action === "recovery";
  return name === "write_stdin" && !input.chars && input.columns === undefined && input.rows === undefined;
}

export function observesAcceptedWork(name: string, input: Record<string, unknown>): boolean {
  if (name === "task_resume") return true;
  if (["read", "read_output", "read_diagnostics", "cancel_command", "checkpoint_task", "write_stdin", "wait_agent", "list_agents", "interrupt_agent", "finish_task",
    "workspace_catalog", "task_messages", "qm_task_message_enqueue", "qm_task_messages", "qm_session", "qm_command_output", "qm_file_diff", "qm_patch", "qm_instruction", "qm_file_url"].includes(name)) return true;
  if (name === "workspace_context") return true;
  if (name === "copy_artifact") return input.action === "observe" || input.action === "cancel";
  return false;
}

export function admittedTools(target: McpRegistrationTarget, execution: ExecutionCoordinator): McpRegistrationTarget {
  return {
    registerResource: target.registerResource.bind(target),
    registerTool: ((name: string, definition: Record<string, unknown>, handler: (...args: any[]) => unknown) => {
      const schema = definition.inputSchema as {shape?: Record<string, unknown>} | undefined;
      const shape = schema?.shape ?? schema;
      const scoped = shape && ("workspace_id" in shape || ["open_workspace", "attach_workspace", "copy_artifact"].includes(name));
      const addedTaskScope = scoped && !("task_id" in shape);
      const registered = addedTaskScope ? {...definition, inputSchema: withTaskScopeInput(definition.inputSchema)} : definition;
      return (target.registerTool as (...args: any[]) => unknown)(name, registered,
        (input: Record<string, unknown>, extra: Record<string, unknown>) => {
          if (scoped && input.task_id !== undefined) {
            const {task_id, ...parameters} = input;
            if (addedTaskScope) input = parameters;
            extra = {...extra, requestedTaskId: task_id};
          }
          // 历史状态与输出仍由 handler 授权；观察不争抢持久执行占用的写锁。
          if (isReadOnlyObservation(name, input)) return handler(input, extra);
          // 文件观察会保存读取证据，但等待这项记录的准入同样受请求期限约束。
          const observation=name==="workspace_context"&&["list","capture","search"].includes(String(input.action))
            ? observationBudget(name,input,extra as {signal?:AbortSignal;_meta?:unknown}) : undefined;
          const work=execution.withWork({ kind: "tool", allowWhilePaused: observesAcceptedWork(name, input) },
            () => Promise.resolve(handler(input,observation?{...extra,signal:observation.signal}:extra)),
            observation?{signal:observation.signal}:undefined).catch((error:unknown)=>{
              const conflict=error as {code?:unknown;details?:unknown};
              if(conflict?.code!=="EXECUTION_CONFLICT"&&conflict?.code!=="NODE_ADMISSION_PAUSED"
                &&!(error instanceof RecordedInvocationError))throw error;
              const result = toolErrorResult(error, { sideEffecting: (definition.annotations as {readOnlyHint?: boolean} | undefined)?.readOnlyHint !== true });
              if(conflict?.code!=="EXECUTION_CONFLICT")return result;
              const effect = result.structuredContent.effect;
              // Keep the legacy identity while exposing the standard error contract.
              // Explicit partial/unknown evidence must survive this outer boundary.
              return {...result, _meta:{quaymesh:{error:{code:conflict.code,details:conflict.details,
                ...(effect === "unknown" ? {} : {started: effect !== "not_started"}), effect}}}};
            });
          return observation?observeWithSignal(work,observation.signal).finally(()=>observation.dispose()):work;
        });
    }) as McpRegistrationTarget["registerTool"],
  };
}
