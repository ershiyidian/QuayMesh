import type { McpRegistrationTarget } from "./mcp-modern-server.js";
import type { ExecutionCoordinator } from "./execution-coordinator.js";

export function observesAcceptedWork(name: string, input: Record<string, unknown>): boolean {
  if (["read", "read_output", "cancel_command", "checkpoint_task", "write_stdin", "wait_agent", "list_agents", "interrupt_agent", "finish_task",
    "workspace_catalog", "qm_session", "qm_command_output", "qm_file_diff", "qm_patch", "qm_instruction", "qm_file_url"].includes(name)) return true;
  if (name === "workspace_context") return true;
  if (name === "copy_artifact") return input.action === "observe" || input.action === "cancel";
  return false;
}

export function admittedTools(target: McpRegistrationTarget, execution: ExecutionCoordinator): McpRegistrationTarget {
  return {
    registerResource: target.registerResource.bind(target),
    registerTool: ((name: string, definition: Record<string, unknown>, handler: (...args: any[]) => unknown) => {
      return (target.registerTool as (...args: any[]) => unknown)(name, definition,
        (input: Record<string, unknown>, extra: Record<string, unknown>) =>
          execution.withWork({ kind: "tool", allowWhilePaused: observesAcceptedWork(name, input) },
            () => Promise.resolve(handler(input, extra))).catch((error:unknown)=>{
              const conflict=error as {code?:unknown;details?:unknown};
              if(conflict?.code!=="EXECUTION_CONFLICT")throw error;
              const result=error instanceof Error?error.message:String(error);
              return {isError:true,content:[{type:"text",text:result}],
                structuredContent:{result,error:{code:conflict.code,details:conflict.details,started:false}}};
            }));
    }) as McpRegistrationTarget["registerTool"],
  };
}
