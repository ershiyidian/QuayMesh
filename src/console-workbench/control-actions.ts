import type { ServerConfig } from "../config.js";
import { WorkLedger } from "../work-ledger.js";
import { LocalAgentStore } from "../local-agent-store.js";
import { createLocalAgentClient } from "../local-agent-client.js";
import type { ProcessSessionManager } from "../process-sessions.js";
import type { SessionRuntime } from "../session/runtime.js";
import { cancelManagedCommand } from "../managed-command-control.js";
import { linkForRun, requireRun } from "./local.js";
import { ConsoleAudit } from "./audit.js";
import { WriteReceipts, writeEffect, type WriteEffect, type VerifiedReceipt } from "./receipts.js";
import { WorkbenchError } from "./types.js";

export interface ControlInput { action: "resume" | "interrupt"; expectedRevision: number; requestKey: string }
interface Target { id: string; kind: "agent" | "command"; executionIds: string[]; turnId?: string }
interface Plan { targets: Target[]; action: ControlInput["action"] }
export interface ControlOutcome {
  id: string; kind: Target["kind"]; status: "completed" | "accepted" | "rejected" | "unknown";
  effect: WriteEffect; error?: string; code?: string; executionIds?: string[];
}

function summarize(targets: ControlOutcome[]) {
  const counts = { completed: 0, accepted: 0, rejected: 0, unknown: 0 };
  for (const target of targets) counts[target.status]++;
  const successful = counts.completed + counts.accepted;
  const status = successful && counts.rejected + counts.unknown ? "partial"
    : counts.unknown ? "unknown" : counts.rejected ? "rejected" : counts.accepted ? "accepted" : "completed";
  const effect: WriteEffect = status === "partial" ? "partial" : status === "unknown" ? "unknown" : status === "rejected" ? "none" : "applied";
  return { status, effect, outcome: effect, targets, counts };
}

export async function controlRun(config: ServerConfig, session: SessionRuntime | undefined, processes: ProcessSessionManager | undefined,
  id: string, input: ControlInput) {
  const ledger = new WorkLedger(config.stateDir), store = new LocalAgentStore(config.stateDir);
  const receipts = new WriteReceipts(config.stateDir), audit = new ConsoleAudit(config.stateDir, config.federation?.nodeId ?? "local");
  try {
    const run = requireRun(config, ledger, id);
    if (run.revision !== input.expectedRevision) throw new WorkbenchError("任务已更新，请刷新后继续", 409, "revision_conflict", "none");
    const executions = ledger.executions(id), active = executions.filter(value => ["starting", "queued", "running"].includes(value.status));
    let targets: Target[];
    if (input.action === "resume") {
      if (!["interrupted", "reconciliation_required"].includes(run.status)) throw new WorkbenchError("当前任务不处于可恢复的中断状态", 409, "resume_unavailable", "none");
      const agentIds = [...new Set(executions.map(value => value.agent_id))];
      if (agentIds.length !== 1) throw new WorkbenchError("请从原工作入口选择要继续的代理", 409, "resume_target_required", "none");
      targets = [{ id: agentIds[0]!, kind: "agent", executionIds: executions.map(value => value.id), turnId: store.getById(agentIds[0]!)?.providerTurnId }];
    } else {
      targets = [...new Set(active.map(value => value.agent_id))].map(agentId => ({ id: agentId, kind: "agent" as const,
        executionIds: active.filter(value => value.agent_id === agentId).map(value => value.id),
        turnId: active.filter(value => value.agent_id === agentId).at(-1)?.provider_turn_id ?? undefined }));
      const commands = ledger.db.prepare(`SELECT id FROM console_operations WHERE run_id=?
        AND kind IN ('command','exec_command','bash') AND status IN ('starting','queued','running') ORDER BY created_at,id`).all(id) as Array<{ id: string }>;
      targets.push(...commands.map(command => ({ id: command.id, kind: "command" as const, executionIds: [] })));
      if (!targets.length) throw new WorkbenchError("当前任务已经没有可停止的受管执行", 409, "no_active_target", "none");
    }
    const plan = await receipts.execute<Plan>(`control-plan:${id}`, input.requestKey, "control-plan", input,
      () => ({ action: input.action, targets }));
    const outcomes: ControlOutcome[] = [], warnings: string[] = [];
    const client = createLocalAgentClient(config);
    for (const target of plan.targets) {
      const scope = `control-target:${id}:${target.kind}:${target.id}`;
      try {
        const outcome = await receipts.execute<ControlOutcome>(scope, input.requestKey, "control-target", { action: plan.action, target }, async () => {
          if (target.kind === "command") {
            const link = linkForRun(ledger, id);
            if (!session || !processes || !link) throw new WorkbenchError("当前节点缺少此命令的运行时控制句柄", 409, "command_control_unavailable", "none");
            const result = await cancelManagedCommand({ runtime: session, processSessions: processes,
              ownerId: link.owner_id, nodeId: config.federation?.nodeId ?? "local",
              workspaceRoot: ledger.getProject(run.project_id).root, operationId: target.id });
            return { id: target.id, kind: target.kind, status: result.state === "stopping" ? "accepted" : "completed", effect: "applied" };
          }
          const agent = store.getById(target.id);
          if (!agent) throw new WorkbenchError("受管代理记录已不存在，请核对原执行", 409, "agent_unavailable", "none");
          const agentScope = { workspaceId: agent.workspaceId, workspaceRoot: agent.workspaceRoot };
          if (plan.action === "resume") {
            ledger.resume(id);
            const result = await client.continue(agent.id, "继续完成当前任务。先检查已经保存的工作进度和执行结果，再完成尚未结束的部分。",
              { workRunId: id, requestKey: input.requestKey }, agentScope);
            if (result.isErr()) {
              if (!ledger.hasActiveChild(id)) ledger.db.prepare("UPDATE console_work_runs SET status='reconciliation_required',summary=?,revision=revision+1 WHERE id=? AND status='running'")
                .run(`恢复请求尚未确认：${result.error.message}`, id);
              throw new WorkbenchError(result.error.message, 409, "resume_outcome_unknown", "unknown");
            }
            const resumed = ledger.executions(id).filter(value => value.agent_id === target.id && !target.executionIds.includes(value.id));
            // 恢复请求成功后只绑定唯一的新轮次，后续核验不能误取再之后的其他请求。
            const executionIds = resumed.length === 1 ? [resumed[0]!.id] : undefined;
            const terminal = executionIds && resumed.every(value => ["completed", "failed", "cancelled"].includes(value.status));
            return { id: target.id, kind: target.kind, status: terminal ? "completed" : "accepted", effect: "applied",
              ...(executionIds ? { executionIds } : {}) };
          }
          const remaining = target.executionIds.filter(executionId => ["starting", "queued", "running"].includes(ledger.execution(executionId).status));
          if (!remaining.length) return { id: target.id, kind: target.kind, status: "completed", effect: "none" };
          if (target.turnId && agent.providerTurnId !== target.turnId) throw new WorkbenchError("代理已切换到另一轮执行，原目标需要核对", 409, "control_turn_changed", "none");
          const result = agent.status === "queued" || agent.status === "starting"
            ? await client.cancelQueued(agent.id, agentScope)
            : await client.control({ agentId: agent.id, action: "interrupt", workRunId: id,
              requestKey: input.requestKey, expectedTurnId: target.turnId ?? agent.providerTurnId, scope: agentScope });
          if (result.isErr()) throw result.error;
          const terminal = target.executionIds.every(executionId => ["completed", "failed", "cancelled"].includes(ledger.execution(executionId).status));
          return { id: target.id, kind: target.kind, status: terminal ? "completed" : "accepted", effect: "applied" };
        });
        outcomes.push(outcome);
      } catch (error) {
        const effect = writeEffect(error);
        outcomes.push({ id: target.id, kind: target.kind, status: effect === "none" ? "rejected" : "unknown", effect,
          error: error instanceof Error ? error.message : String(error), code: error instanceof WorkbenchError ? error.code : "control_outcome_unknown" });
      }
      try { audit.record(`run.${plan.action}.target`, id, target, outcomes.at(-1), input.requestKey); }
      catch (error) { warnings.push(`目标 ${target.id} 已保留回执，审计追加失败：${error instanceof Error ? error.message : String(error)}`); }
    }
    const result = summarize(outcomes);
    try { audit.record(`run.${plan.action}`, id, plan, result, input.requestKey); }
    catch (error) { warnings.push(`汇总审计追加失败：${error instanceof Error ? error.message : String(error)}`); }
    return { ...result, warnings };
  } finally { store.close(); ledger.close(); }
}

export function reconcileControl(config: ServerConfig, id: string, requestKey: string): VerifiedReceipt {
  const ledger = new WorkLedger(config.stateDir), receipts = new WriteReceipts(config.stateDir);
  try {
    requireRun(config, ledger, id);
    const plan = receipts.get(`control-plan:${id}`, requestKey)?.response as Plan | undefined;
    if (!plan) return { verified: false };
    const targets = plan.targets.map((target): ControlOutcome => {
      const prior = receipts.get(`control-target:${id}:${target.kind}:${target.id}`, requestKey);
      if (prior?.effect === "none" && prior.error) return { id: target.id, kind: target.kind, status: "rejected", effect: "none", error: prior.error.message, code: prior.error.code };
      const accepted = prior?.response as ControlOutcome | undefined;
      if (accepted?.status === "completed") return accepted;
      const executionIds = plan.action === "interrupt" ? target.executionIds : accepted?.executionIds;
      if (target.kind === "agent" && !executionIds?.length) return accepted?.status === "accepted" ? accepted
        : { id: target.id, kind: target.kind, status: "unknown", effect: "unknown" };
      const rows = target.kind === "command"
        ? ledger.db.prepare("SELECT status FROM console_operations WHERE id=? AND run_id=?").all(target.id, id) as Array<{ status: string }>
        : ledger.executions(id).filter(value => value.agent_id === target.id && executionIds!.includes(value.id));
      const complete = rows.length === (target.kind === "command" ? 1 : executionIds!.length);
      const terminal = complete && rows.every(value => ["completed", "failed", "cancelled"].includes(value.status));
      const pending = complete && accepted?.status === "accepted"
        && rows.every(value => ["starting", "queued", "running", "stopping", "completed", "failed", "cancelled"].includes(value.status));
      return { id: target.id, kind: target.kind, status: terminal ? "completed" : pending ? "accepted" : "unknown",
        effect: terminal || pending ? "applied" : "unknown", ...(accepted?.executionIds ? { executionIds: accepted.executionIds } : {}) };
    });
    const response = summarize(targets);
    return { verified: !targets.some(target => target.status === "unknown"), effect: response.effect, response };
  } finally { ledger.close(); }
}
