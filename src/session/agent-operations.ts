import { createHash } from "node:crypto";
import type { LocalAgentStore } from "../local-agent-store.js";
import { OperationState, type AgentId, type SessionId } from "./types.js";
import type { SessionService } from "./service.js";
import type { SessionStore } from "./store.js";
import { summarizeExecutions, type WorkLedger } from "../work-ledger.js";

export interface AgentOperationIdentity {
  operationId: string;
  agentId: AgentId;
  sessionId: SessionId;
  memberId: string;
}

export interface AgentOperationTrackerOptions {
  intervalMs?: number;
  ledger?: WorkLedger;
  onError?: (error: unknown, identity: AgentOperationIdentity, retry: { attempt: number; delayMs: number }) => void;
}

/**
 * Watches durable subagent records and closes the model operation that
 * launched them. The tracker only reads the local agent store; it never
 * starts, repeats or cancels provider work.
 */
export class AgentOperationTracker {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly failures = new Map<string, number>();
  private readonly intervalMs: number;
  private closed = false;
  private readonly observations = new Map<string, string>();

  constructor(
    private readonly agents: LocalAgentStore,
    private readonly service: SessionService,
    private readonly store: SessionStore,
    private readonly options: AgentOperationTrackerOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? 1_000;
  }

  restore(): void {
    if (this.closed) throw new Error("AGENT_OPERATION_TRACKER_CLOSED");
    // 身份已经持久化；恢复时先安装后台重试边界，无需再次争取写锁。
    for (const identity of this.store.pendingAgentOperations()) {
      if (!this.pending.has(identity.operationId)) this.schedule(identity);
    }
  }

  track(identity: AgentOperationIdentity): void {
    if (this.closed) throw new Error("AGENT_OPERATION_TRACKER_CLOSED");
    if (this.timers.has(identity.operationId) || this.pending.has(identity.operationId)) return;
    this.store.rememberAgentOperation(identity);
    this.schedule(identity);
  }

  private schedule(identity: AgentOperationIdentity, delayMs = this.intervalMs): void {
    if (this.closed || this.timers.has(identity.operationId)) return;
    const timer = setTimeout(() => {
      this.timers.delete(identity.operationId);
      const pending = this.poll(identity).then(() => {
        this.failures.delete(identity.operationId);
      }, error => {
        const attempt = (this.failures.get(identity.operationId) ?? 0) + 1;
        this.failures.set(identity.operationId, attempt);
        const retryDelayMs = Math.min(30_000, this.intervalMs * 2 ** Math.min(attempt, 10));
        // 诊断回调自身失败也不能产生未处理的 Promise 拒绝。
        try { this.options.onError?.(error, identity, { attempt, delayMs: retryDelayMs }); } catch { /* 继续重试 */ }
        // 保留持久化操作并持续重试；只重读已有结果，不重新启动提供方工作。
        this.schedule(identity, retryDelayMs);
      }).finally(() => { this.pending.delete(identity.operationId); });
      this.pending.set(identity.operationId, pending);
    }, delayMs);
    timer.unref?.();
    this.timers.set(identity.operationId, timer);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await Promise.allSettled(this.pending.values());
    this.failures.clear();
    this.observations.clear();
  }

  private async poll(identity: AgentOperationIdentity): Promise<void> {
    const record = this.agents.getById(identity.agentId);
    if (!record) {
      await this.service.finishOperationById(identity.operationId, {
        status: OperationState.unknown,
        effect: "unknown",
        error_code: "AGENT_RECORD_MISSING",
        error_message: `Subagent record ${identity.agentId} is no longer available.`,
        result_ref: `agent:${identity.agentId}:missing`,
      });
      this.store.completeAgentOperation(identity.operationId);
      return;
    }

    const usage = this.options.ledger
      ? summarizeExecutions(this.store.runIdsForMember(identity.sessionId, identity.memberId)
        .flatMap((runId) => this.options.ledger!.executions(runId)).filter((item) => item.agent_id === record.id))
      : null;
    const state = record.status === "idle" ? "completed" : record.status === "error" ? "failed"
      : record.status === "stopped" ? "cancelled" : record.status === "starting" ? "queued" : record.status;
    const payload = {
      agent_id: record.id, name: record.taskName ?? record.profileName, provider: record.provider,
      model: record.model ?? null, effort: record.effort ?? null, state,
      task: this.store.findOperationEvent(identity.operationId)?.payload.label ?? record.taskName ?? record.profileName,
      started_at: record.progress?.startedAt ?? record.createdAt,
      tokens: usage?.codexUsage?.totalTokens ?? null, usage_quality: usage?.usageStatus ?? "unavailable",
      steps: record.progress ? [{ label: record.progress.toolCategory ?? record.progress.phase, state: state === "completed" ? "done" : "cur" }] : null,
      result_available: state === "completed" && record.latestResponse !== undefined,
      result_ref: state === "completed" && record.latestResponse !== undefined ? `agent:${record.id}:${record.controlRevision}` : null,
    };
    const observation = JSON.stringify(payload);
    if (this.observations.get(identity.operationId) !== observation) {
      // 订阅者报错时事件可能已经提交；稳定身份确保重试和重启恢复均不重复追加。
      const source_id = `agent-operation:${identity.operationId}:${createHash("sha256")
        .update(JSON.stringify([record.controlRevision, record.updatedAt, observation])).digest("hex")}`;
      await this.service.agentEvent(identity.sessionId, identity.memberId, { ...payload, source_id },
        this.store.findOperationEvent(identity.operationId)?.task_id ?? undefined);
      this.observations.set(identity.operationId, observation);
    }

    if (record.status === "starting" || record.status === "queued" || record.status === "running") {
      if(this.options.ledger?.hasConfirmedAgent(identity.agentId))this.options.ledger.observeOperations([identity.operationId]);
      this.schedule(identity);
      return;
    }

    const resultRef = `agent:${record.id}:${record.controlRevision}`;
    if (record.status === "idle") {
      await this.service.finishOperationById(identity.operationId, {
        status: OperationState.succeeded,
        effect: "completed",
        result_ref: resultRef,
      });
      this.store.completeAgentOperation(identity.operationId);
      this.observations.delete(identity.operationId);
      return;
    }
    if (record.status === "stopped") {
      await this.service.finishOperationById(identity.operationId, {
        status: OperationState.cancelled,
        effect: "completed",
        error_code: record.errorCode ?? "AGENT_STOPPED",
        error_message: record.error ?? "The subagent stopped.",
        result_ref: resultRef,
      });
      this.store.completeAgentOperation(identity.operationId);
      this.observations.delete(identity.operationId);
      return;
    }
    await this.service.finishOperationById(identity.operationId, {
      status: OperationState.failed,
      effect: "completed",
      error_code: record.errorCode ?? "AGENT_FAILED",
      error_message: record.error ?? "The subagent failed.",
      result_ref: resultRef,
    });
    this.store.completeAgentOperation(identity.operationId);
    this.observations.delete(identity.operationId);
  }
}
