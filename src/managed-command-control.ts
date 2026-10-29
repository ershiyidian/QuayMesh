import { jsonReply } from "./bounded-reply.js";
import type { ProcessSessionManager } from "./process-sessions.js";
import type { SessionRuntime } from "./session/runtime.js";
import { OperationState } from "./session/types.js";

export async function cancelManagedCommand(input: {
  runtime: SessionRuntime; processSessions: ProcessSessionManager; ownerId: string;
  nodeId: string; workspaceRoot: string; operationId: string;
}) {
  const { runtime, processSessions, ownerId, nodeId, workspaceRoot, operationId } = input;
  const recorded = runtime.store.requireCommand(ownerId, nodeId, workspaceRoot, operationId);
  const active = processSessions.findOperation(operationId);
  if (["completed", "failed", "cancelled"].includes(recorded.status)) {
    return { operation_id: operationId, state: recorded.status, cancel_requested: false };
  }
  const saved = runtime.store.findInvocationSummaryByOperation(ownerId, operationId);
  if (!saved) throw Object.assign(new Error("命令缺少对应的调用身份，请核对原操作"), { code: "COMMAND_IDENTITY_UNKNOWN", effect: "unknown" });
  if (saved.effect === "not_started" && !active) {
    const result = jsonReply({ operation_id: operationId, result: "命令在启动前已取消。", running: false,
      accepted: true, state: "cancelled", effect: "not_started" });
    runtime.store.updateInvocation({ ownerId: saved.owner_id, transportInstanceId: saved.transport_instance_id,
      requestId: saved.request_id, state: OperationState.cancelled, effect: "not_started",
      result: { kind: "result", value: result }, finished: true, responded: true });
    await runtime.service.finishOperationById(operationId, { status: OperationState.cancelled,
      effect: "not_started", result_ref: operationId });
    return { operation_id: operationId, state: "cancelled", cancel_requested: true };
  }
  if (!active?.running) throw Object.assign(new Error("COMMAND_NOT_ATTACHED: 命令进程尚未关联，请先核对原进程归属"), { code: "COMMAND_NOT_ATTACHED", effect: "unknown" });
  processSessions.terminate(active.workspace_id, operationId);
  return { operation_id: operationId, state: "stopping", cancel_requested: true };
}
