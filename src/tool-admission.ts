import type { McpRegistrationTarget } from "./mcp-modern-server.js";
import type { ExecutionCoordinator } from "./execution-coordinator.js";
import { observationBudget, observeWithSignal } from "./observation-budget.js";

export function isReadOnlyObservation(name: string, input: Record<string, unknown>): boolean {
  if (["read_output", "read_diagnostics", "list_agents", "wait_agent"].includes(name)) return true;
  if (name === "workspace_context") return input.action === "status" || input.action === "recovery";
  return name === "write_stdin" && !input.chars && input.columns === undefined && input.rows === undefined;
}

export function observesAcceptedWork(name: string, input: Record<string, unknown>): boolean {
  if (["read", "read_output", "read_diagnostics", "cancel_command", "checkpoint_task", "write_stdin", "wait_agent", "list_agents", "interrupt_agent", "finish_task",
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
        (input: Record<string, unknown>, extra: Record<string, unknown>) => {
          // 历史状态与输出仍由 handler 授权；观察不争抢持久执行占用的写锁。
          if (isReadOnlyObservation(name, input)) return handler(input, extra);
          // 文件观察会保存读取证据，但等待这项记录的准入同样受请求期限约束。
          const observation=name==="workspace_context"&&["list","capture","search"].includes(String(input.action))
            ? observationBudget(name,input,extra as {signal?:AbortSignal;_meta?:unknown}) : undefined;
          const work=execution.withWork({ kind: "tool", allowWhilePaused: observesAcceptedWork(name, input) },
            () => Promise.resolve(handler(input,observation?{...extra,signal:observation.signal}:extra)),
            observation?{signal:observation.signal}:undefined).catch((error:unknown)=>{
              const conflict=error as {code?:unknown;details?:unknown};
              if(conflict?.code!=="EXECUTION_CONFLICT")throw error;
              const result=error instanceof Error?error.message:String(error);
              // 拒绝执行使用标准工具错误，不能套入各工具互不相同的成功输出 schema。
              return {isError:true,content:[{type:"text",text:result}],
                _meta:{quaymesh:{error:{code:conflict.code,details:conflict.details,started:false}}}};
            });
          return observation?observeWithSignal(work,observation.signal).finally(()=>observation.dispose()):work;
        });
    }) as McpRegistrationTarget["registerTool"],
  };
}
