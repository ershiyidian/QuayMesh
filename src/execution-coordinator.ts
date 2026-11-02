import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import { runSqliteWrite, type SqliteWriteOptions } from "./db/async-write.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { pidAlive } from "./process-liveness.js";
import { processOwner } from "./process-identity.js";
import { recoverExecutionClaim } from "./execution-claim-recovery.js";
import { readMaintenanceStatus } from "./maintenance-status.js";
import { changeAdmission, readAdmissionState, type AdmissionState, type AdmissionChange } from "./admission-state.js";
import { canonicalResourcePath, normalizeExecutionResources, resourcesConflict,
  resourceContains, type ExecutionResource } from "./execution-resources.js";

import { canonicalExecutionRoot, overlaps, claimResources, exclusiveConflict, readExecutionClaims,
  readExecutionWaitingState, type ClaimRow, type WaiterRow } from "./execution-inspection.js";
export { canonicalExecutionRoot, overlaps } from "./execution-inspection.js";

export interface RuntimeWorkInput {
  kind: "tool" | "resource" | "console" | "transfer" | "egress" | "capture";
  operationId?: string;
  taskId?: string;
  allowWhilePaused?: boolean;
  blocking?: boolean;
}
export interface RuntimeWorkLease {
  readonly id: string;
  release(): void;
  releaseAsync(options?: SqliteWriteOptions): Promise<void>;
  run<T>(action: () => T): T;
}
const acceptedWork = new AsyncLocalStorage<{ stateDir: string; id: string }>();
type ReleaseTable = "qm_runtime_work" | "execution_claims";
interface PendingRelease { id: string; table: ReleaseTable; finish: () => void }

export class AdmissionPausedError extends Error {
  readonly code = "NODE_ADMISSION_PAUSED";
  constructor(reason?: string | null) {
    super(reason ? `节点暂不接受新操作：${reason}` : "节点暂不接受新操作，已有操作继续执行。");
    this.name = "AdmissionPausedError";
  }
}

export class ExecutionReleasePendingError extends Error {
  readonly code = "EXECUTION_RELEASE_PENDING";
  readonly effect = "unknown";
  readonly retryHint = "query_original";
  readonly details: { leaseId: string };
  constructor(leaseId: string, cause: unknown) {
    super("动作已结束，执行占用尚待释放；请查询原操作，勿重新执行动作。", { cause });
    this.name = "ExecutionReleasePendingError";
    this.details = { leaseId };
  }
}

export type SourceAccess = "read" | "write";

export interface ExecutionClaimInput {
  workspaceRoot: string;
  kind: "agent" | "command" | "mutation" | "read";
  /** Only the trusted adapter/host reader assigns read, never inferred from a prompt. */
  access?: SourceAccess;
  agentId?: string;
  /** The exact agent turn in console_executions, never its latest turn. */
  executionId?: string;
  threadKey?: string;
  resources?: readonly string[];
  scopes?: readonly ExecutionResource[];
  operationId?: string;
  taskId?: string;
  title?: string;
  maxConcurrentAgents?: number;
  maxConcurrentReaders?: number;
}


export interface ExecutionClaim {
  readonly id: string;
  bindThread(threadKey: string): void;
  bindOperation(operationId: string): void;
  release(): void;
  releaseAsync(options?: SqliteWriteOptions): Promise<void>;
}
export interface ExecutionTicket {
  readonly id: string;
  tryAcquire(): ExecutionClaim | undefined;
  cancel(): void;
}

interface ExecutionConflictDetails {
  type: string; requested: ExecutionResource[]; blockedResources: ExecutionResource[];
  operationId: string | null; taskId: string | null; title: string | null; acquiredAt: string | null; queued: boolean;
  executionId?: string | null;
}

export class ExecutionConflictError extends Error {
  readonly code = "EXECUTION_CONFLICT";
  readonly details: Partial<ExecutionConflictDetails> & { claim_id: string; agent_id?: string };
  constructor(readonly claimId: string, readonly agentId: string | undefined, reason: string,
    details?: ExecutionConflictDetails,
    // Only the admission boundary knows the protected action has not started.
    readonly effect?: "not_started") {
    super(`${reason}。${effect === "not_started" ? "操作尚未开始。" : ""}占用：${claimId}${details ? `；${JSON.stringify(details)}` : ""}`);
    this.name = "ExecutionConflictError";
    // The claim identity must survive durable error envelopes and replay.
    this.details = { ...details, claim_id: claimId, ...(agentId ? { agent_id: agentId } : {}) };
  }
}

/** Cooperative cross-process admission, not an OS sandbox. Active claims are never stolen. */
export class ExecutionCoordinator {
  private readonly database: DatabaseHandle;
  private readonly ownerId = randomUUID();
  private closed = false;
  private closePromise?: Promise<void>;
  private readonly stateDir: string;
  private readonly pendingReleases = new Map<string, PendingRelease>();
  private releaseTimer?: ReturnType<typeof setTimeout>;
  private flushingReleases = false;
  private releaseDelayMs = 100;

  constructor(stateDir: string) { this.stateDir = resolve(stateDir); this.database = openDatabase(stateDir); }

  /** Joining already-held work still needs admission. New work must also use
   * beginWork(), which rechecks inside its registration transaction. */
  assertAccepting(): void {
    const inherited = acceptedWork.getStore();
    if (inherited?.stateDir === this.stateDir && this.database.sqlite.prepare("SELECT 1 FROM qm_runtime_work WHERE id=?").get(inherited.id)) return;
    const state = this.database.sqlite.prepare("SELECT accepting,reason FROM qm_runtime_admission WHERE id=1").get() as { accepting: number; reason: string | null };
    if (!state.accepting) throw new AdmissionPausedError(state.reason);
  }

  pause(reason = "维护操作"): void {
    changeAdmission(this.database.sqlite, { accepting: false, reason });
  }

  async pauseAsync(reason = "维护操作", options?: SqliteWriteOptions): Promise<void> {
    await runSqliteWrite(this.database.sqlite, () => this.pause(reason), options);
  }

  resume(): void {
    changeAdmission(this.database.sqlite, { accepting: true, reason: null });
  }

  compareAndSetAdmission(expected: AdmissionState, next: Pick<AdmissionState, "accepting" | "reason">): AdmissionChange {
    return changeAdmission(this.database.sqlite, next, expected);
  }

  /** 只清除服务正常退出留下的暂停标记，维护暂停由维护流程显式恢复。 */
  resumeAfterRestart(): boolean {
    return this.database.sqlite.transaction(() => {
      const state = readAdmissionState(this.database.sqlite);
      if (state.accepting || !["服务正在退出", "服务准备停止"].includes(state.reason ?? "")) return false;
      this.resume();
      return true;
    }).immediate();
  }
  beginWork(input: RuntimeWorkInput): RuntimeWorkLease {
    if (this.closed || this.closePromise) throw new Error("Execution coordinator is closed or closing.");
    const id = `work_${randomUUID()}`;
    this.database.sqlite.transaction(() => {
      if (!input.allowWhilePaused) this.assertAccepting();
      const owners = this.database.sqlite.prepare("SELECT DISTINCT owner_pid FROM qm_runtime_work").all() as { owner_pid: number }[];
      for (const owner of owners) if (!pidAlive(owner.owner_pid))
        this.database.sqlite.prepare("DELETE FROM qm_runtime_work WHERE owner_pid=?").run(owner.owner_pid);
      this.database.sqlite.prepare(`INSERT INTO qm_runtime_work(id,owner_id,owner_pid,kind,operation_id,task_id,blocking,started_at)
        VALUES(?,?,?,?,?,?,?,?)`).run(id, this.ownerId, process.pid, input.kind, input.operationId ?? null,
          input.taskId ?? null, (input.kind === "egress" || (input.blocking ?? !input.allowWhilePaused)) ? 1 : 0, new Date().toISOString());
    }).immediate();
    const release = this.createReleaseHandle(id, "qm_runtime_work");
    return {
      id,
      release: release.release,
      releaseAsync: release.releaseAsync,
      run: action => {
        release.assertActive();
        return acceptedWork.run({ stateDir: this.stateDir, id }, action);
      },
    };
  }

  private createReleaseHandle(id: string, table: ReleaseTable) {
    let released = false;
    let releaseRequested = false;
    let releasePromise: Promise<void> | undefined;
    const requestRelease = () => {
      releaseRequested = true;
      this.pendingReleases.set(id, { id, table, finish: () => { released = true; } });
    };
    return {
      release: () => {
        if (released || this.closed) return;
        requestRelease();
        try {
          this.removeReleases([{ id, table }]);
          this.finishRelease(id);
        } catch (error) { this.scheduleReleases(); throw error; }
      },
      releaseAsync: (options?: SqliteWriteOptions): Promise<void> => {
        if (released) return Promise.resolve();
        if (releasePromise) return releasePromise;
        if (this.closed) return Promise.reject(new ExecutionReleasePendingError(id, new Error("Execution coordinator is closed.")));
        requestRelease();
        releasePromise = runSqliteWrite(this.database.sqlite, () => {
          this.removeReleases([{ id, table }]);
        }, options).then(() => { this.finishRelease(id); }).catch(error => {
          if (released) return;
          this.scheduleReleases();
          throw new ExecutionReleasePendingError(id, error);
        }).finally(() => { releasePromise = undefined; });
        return releasePromise;
      },
      assertActive: () => {
        if (releaseRequested || released || this.closed) throw new Error("执行占用已经释放或正在释放");
      },
    };
  }

  async beginWorkAsync(input: RuntimeWorkInput, options?: SqliteWriteOptions): Promise<RuntimeWorkLease> {
    return runSqliteWrite(this.database.sqlite, () => this.beginWork(input), options);
  }

  async withWork<T>(input: RuntimeWorkInput, action: () => Promise<T>, options?: SqliteWriteOptions): Promise<T> {
    const lease = await this.beginWorkAsync(input, options);
    let completed = false;
    try {
      const result = await lease.run(action);
      completed = true;
      return result;
    } finally {
      // 请求取消后仍须收尾；清理失败不能覆盖动作原异常。
      try { await lease.releaseAsync({ timeoutMs: options?.timeoutMs }); }
      catch (error) { if (completed) throw error; }
    }
  }

  private removeReleases(releases: readonly Pick<PendingRelease, "id" | "table">[]): void {
    const removeWork = this.database.sqlite.prepare("DELETE FROM qm_runtime_work WHERE id=? AND owner_id=?");
    const removeClaim = this.database.sqlite.prepare("DELETE FROM execution_claims WHERE id=? AND owner_id=?");
    for (const release of releases)
      (release.table === "qm_runtime_work" ? removeWork : removeClaim).run(release.id, this.ownerId);
  }

  private finishRelease(id: string): void {
    const release = this.pendingReleases.get(id);
    this.pendingReleases.delete(id);
    release?.finish();
    if (!this.pendingReleases.size && this.releaseTimer) {
      clearTimeout(this.releaseTimer);
      this.releaseTimer = undefined;
    }
  }

  private scheduleReleases(): void {
    if (this.closed || this.releaseTimer || this.flushingReleases || !this.pendingReleases.size) return;
    this.releaseTimer = setTimeout(() => {
      this.releaseTimer = undefined;
      void this.flushReleases();
    }, this.releaseDelayMs);
    this.releaseTimer.unref();
  }

  private async flushReleases(): Promise<void> {
    if (this.closed || this.flushingReleases || !this.pendingReleases.size) return;
    this.flushingReleases = true;
    const releases: PendingRelease[] = [];
    for (const release of this.pendingReleases.values()) { releases.push(release); if (releases.length === 64) break; }
    try {
      // 只补删本 owner 已结束的占用；不触碰活动租约或执行动作。
      await runSqliteWrite(this.database.sqlite, () => this.removeReleases(releases), { timeoutMs: 250 });
      for (const release of releases) this.finishRelease(release.id);
      this.releaseDelayMs = 100;
    } catch {
      this.releaseDelayMs = Math.min(this.releaseDelayMs * 2, 5_000);
    } finally {
      this.flushingReleases = false;
      this.scheduleReleases();
    }
  }

  ownsWriteClaim(id: string, path: string, operationId?: string): boolean {
    if (this.pendingReleases.has(id)) return false;
    const row = this.database.sqlite.prepare("SELECT * FROM execution_claims WHERE id=? AND owner_id=?")
      .get(id, this.ownerId) as ClaimRow | undefined;
    if (!row || !operationId || row.operation_id !== operationId) return false;
    return claimResources(row).some(scope => scope.access === "write" &&
      resourceContains(scope,{kind:"file",path:canonicalResourcePath(path),access:"read"}));
  }

  admissionState(): AdmissionState {
    return readAdmissionState(this.database.sqlite);
  }

  admissionStatus() {
    return readMaintenanceStatus(this.database.sqlite);
  }

  private row(input: ExecutionClaimInput): ClaimRow {
    if (this.closed || this.closePromise) throw new Error("Execution coordinator is closed or closing.");
    const resources = [...new Set(input.resources ?? [])].sort();
    if (resources.length > 16 || resources.some((key) => !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(key))) {
      throw new Error("Use at most 16 explicit, bounded resource keys.");
    }
    for (const value of [input.maxConcurrentAgents ?? 2, input.maxConcurrentReaders ?? 2]) {
      if (!Number.isInteger(value) || value < 1 || value > 16) throw new Error("Concurrency must be between 1 and 16.");
    }
    if (input.access !== undefined && input.access !== "read" && input.access !== "write") throw new Error("Invalid source access.");
    const objectId = input.kind === "agent" ? input.executionId : input.operationId;
    const owner = objectId ? this.database.sqlite.prepare("SELECT generation FROM execution_owners WHERE domain=? AND id=?")
      .get(input.kind === "agent" ? "execution" : "operation", objectId) as { generation: string } | undefined : undefined;
    return { id: `claim_${randomUUID().replaceAll("-", "")}`, owner_id: this.ownerId, owner_pid: process.pid,
      kind: input.kind, checkout_root: canonicalExecutionRoot(input.workspaceRoot), agent_id: input.agentId ?? null,
      thread_key: input.threadKey ?? null, access_mode: input.access ?? "write", resources: JSON.stringify(resources),
      scopes_json: input.scopes === undefined ? null : JSON.stringify(normalizeExecutionResources(input.scopes)),
      operation_id: input.operationId ?? null, task_id: input.taskId ?? null, title:input.title?.slice(0,200) ?? null,
      execution_id: input.executionId ?? null, execution_generation: owner?.generation ?? null,
      owner_process_start: processOwner.start };
  }

  private blocker(candidate: ClaimRow, input: ExecutionClaimInput, sequence = Number.MAX_SAFE_INTEGER): ClaimRow | undefined {
    // Expired WAITERS never started work. Active claims have no timeout-steal path.
    this.database.sqlite.prepare("delete from execution_waiters where expires_at_ms <= ?").run(Date.now());
    const active = (this.database.sqlite.prepare("select * from execution_claims").all() as ClaimRow[]).filter(row => {
      // The same single-claim recovery is used by admission and explicit recovery.
      // A live Core may own an ended attempt; a dead Core may leave live children.
      return recoverExecutionClaim(this.database.sqlite, row.id).state !== "released";
    });
    const conflict = active.find((row) => exclusiveConflict(candidate, row));
    if (conflict) return conflict;
    const prior = this.database.sqlite.prepare("select * from execution_waiters where sequence < ? order by sequence")
      .all(sequence) as WaiterRow[];
    // An earlier writer blocks later readers; neither reader-to-writer upgrades nor reader barging.
    const waiting = prior.find((row) => exclusiveConflict(candidate, row));
    if (waiting) return waiting;
    if (candidate.kind === "agent") {
      const agents = active.filter((row) => row.kind === "agent");
      if (agents.length >= (input.maxConcurrentAgents ?? 2)) return agents[0];
      const readers = agents.filter((row) => row.access_mode === "read" && overlaps(row.checkout_root, candidate.checkout_root));
      if (candidate.access_mode === "read" && readers.length >= (input.maxConcurrentReaders ?? 2)) return readers[0];
    }
    return undefined;
  }

  private insert(row: ClaimRow): ExecutionClaim {
    this.database.sqlite.prepare(`insert into execution_claims
      (id, owner_id, owner_pid, kind, checkout_root, agent_id, resources, acquired_at, access_mode, thread_key,scopes_json,operation_id,task_id,title,execution_id,execution_generation,owner_process_start)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.id, row.owner_id, row.owner_pid, row.kind, row.checkout_root, row.agent_id, row.resources,
        new Date().toISOString(), row.access_mode, row.thread_key,row.scopes_json,row.operation_id,row.task_id,row.title,
        row.execution_id,row.execution_generation,row.owner_process_start);
    const release = this.createReleaseHandle(row.id, "execution_claims");
    return {
      id: row.id,
      release: release.release,
      releaseAsync: release.releaseAsync,
      bindOperation: (operationId) => {
        release.assertActive();
        this.database.sqlite.transaction(() => {
          const owner = this.database.sqlite.prepare("SELECT generation,owner_pid,process_start FROM execution_owners WHERE domain='operation' AND id=?")
            .get(operationId) as { generation: string; owner_pid: number; process_start: string | null } | undefined;
          if (!owner || owner.owner_pid !== processOwner.pid || owner.process_start !== processOwner.start)
            throw new Error("The operation does not belong to this execution owner.");
          this.database.sqlite.prepare("UPDATE execution_claims SET operation_id=?,execution_generation=? WHERE id=? AND owner_id=?")
            .run(operationId,owner.generation,row.id,this.ownerId);
        }).immediate();
      },
      bindThread: (threadKey) => {
        release.assertActive();
        this.database.sqlite.transaction(() => {
          const other = this.database.sqlite.prepare("select * from execution_claims where thread_key = ? and id != ?")
            .get(threadKey, row.id) as ClaimRow | undefined;
          if (other) throw new ExecutionConflictError(other.id, other.agent_id ?? undefined, "Provider thread already active");
          this.database.sqlite.prepare("update execution_claims set thread_key = ? where id = ? and owner_id = ?")
            .run(threadKey, row.id, this.ownerId);
        }).immediate();
      },
    };
  }

  acquire(input: ExecutionClaimInput): ExecutionClaim {
    return this.acquireRow(this.row(input), input);
  }

  async acquireAsync(input: ExecutionClaimInput, options?: SqliteWriteOptions): Promise<ExecutionClaim> {
    const candidate = this.row(input);
    return runSqliteWrite(this.database.sqlite, () => this.acquireRow(candidate, input), options);
  }

  private acquireRow(candidate: ClaimRow, input: ExecutionClaimInput): ExecutionClaim {
    if (this.closed || this.closePromise) throw new Error("Execution coordinator is closed or closing.");
    return this.database.sqlite.transaction(() => {
      this.assertAccepting();
      if (candidate.operation_id) {
        const owned = this.database.sqlite.prepare("SELECT * FROM execution_claims WHERE owner_id=? AND operation_id=?")
          .all(this.ownerId,candidate.operation_id) as ClaimRow[];
        const parent = owned.find(row => !this.pendingReleases.has(row.id) &&
          claimResources(candidate).every(requested => claimResources(row).some(scope => resourceContains(scope,requested))));
        if (parent) return { id:parent.id,release:()=>{},releaseAsync:async()=>{},
          bindThread:()=>{throw new Error("内部调用不能改变所属代理线程");},
          bindOperation:()=>{throw new Error("内部调用不能改变所属执行");} };
      }
      const blocker = this.blocker(candidate, input);
      if (blocker) {
        const requested = claimResources(candidate);
        const blockedResources = claimResources(blocker).filter(scope => requested.some(other => resourcesConflict(scope,other)));
        throw new ExecutionConflictError(blocker.id,blocker.agent_id ?? undefined,"执行资源暂时不可用",{
          type:blockedResources.length ? "resource" : blocker.thread_key && blocker.thread_key===candidate.thread_key ? "thread" : blocker.agent_id && blocker.agent_id===candidate.agent_id ? "agent" : "capacity",
          requested,blockedResources,operationId:blocker.operation_id,executionId:blocker.execution_id,taskId:blocker.task_id,title:blocker.title,
          acquiredAt:blocker.acquired_at ?? null,queued:"sequence" in blocker,
        }, "not_started");
      }
      return this.insert(candidate);
    }).immediate();
  }

  enqueue(input: ExecutionClaimInput, waitMs: number): ExecutionTicket {
    const candidate = this.row(input);
    if (!Number.isInteger(waitMs) || waitMs < 1 || waitMs > 900_000) throw new Error("Queue timeout must be 1–900000 ms.");
    this.database.sqlite.transaction(() => {
      this.assertAccepting();
      this.database.sqlite.prepare("delete from execution_waiters where expires_at_ms <= ?").run(Date.now());
      const count = (this.database.sqlite.prepare("select count(*) as n from execution_waiters").get() as { n: number }).n;
      if (count >= 64) throw new ExecutionConflictError("queue", undefined, "Local queue capacity reached; no provider invoked", undefined, "not_started");
      this.database.sqlite.prepare(`insert into execution_waiters
        (id, owner_id, owner_pid, kind, checkout_root, agent_id, thread_key, access_mode, resources, expires_at_ms,scopes_json,operation_id,task_id,title,execution_id,execution_generation,owner_process_start)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(candidate.id, this.ownerId, process.pid, candidate.kind, candidate.checkout_root, candidate.agent_id,
          candidate.thread_key, candidate.access_mode, candidate.resources, Date.now() + waitMs,candidate.scopes_json,candidate.operation_id,candidate.task_id,candidate.title,
          candidate.execution_id,candidate.execution_generation,candidate.owner_process_start);
    }).immediate();
    return {
      id: candidate.id,
      tryAcquire: () => this.database.sqlite.transaction(() => {
        this.assertAccepting();
        const ticket = this.database.sqlite.prepare("select * from execution_waiters where id = ? and owner_id = ?")
          .get(candidate.id, this.ownerId) as WaiterRow | undefined;
        if (!ticket || ticket.expires_at_ms <= Date.now()) throw new Error("Execution wait expired or was cancelled; no provider invoked.");
        if (this.blocker(candidate, input, ticket.sequence)) return undefined;
        this.database.sqlite.prepare("delete from execution_waiters where id = ? and owner_id = ?").run(candidate.id, this.ownerId);
        return this.insert(candidate);
      }).immediate(),
      cancel: () => {
        if (!this.closed) this.database.sqlite.prepare("delete from execution_waiters where id = ? and owner_id = ?").run(candidate.id, this.ownerId);
      },
    };
  }

  async run<T>(input: ExecutionClaimInput, action: () => Promise<T>, options?: SqliteWriteOptions): Promise<T> {
    const claim = await this.acquireAsync(input, options);
    let completed = false;
    try {
      const result = await action();
      completed = true;
      return result;
    } finally {
      try { await claim.releaseAsync({ timeoutMs: options?.timeoutMs }); }
      catch (error) { if (completed) throw error; }
    }
  }

  inspect(workspaceRoot: string) {
    return readExecutionClaims(this.database.sqlite, workspaceRoot);
  }

  /** Read-only queue evidence; shared with isolated Console readers. */
  waitingState(workspaceRoot: string, agentId: string) {
    return readExecutionWaitingState(this.database.sqlite, workspaceRoot, agentId);
  }

  private cleanupForClose(): PendingRelease[] {
    const releases = [...this.pendingReleases.values()];
    this.database.sqlite.prepare("DELETE FROM execution_waiters WHERE owner_id=?").run(this.ownerId);
    this.removeReleases(releases);
    return releases;
  }

  private finishClose(releases: PendingRelease[]): void {
    for (const release of releases) this.finishRelease(release.id);
    this.database.close();
    this.closed = true;
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    this.releaseTimer = undefined;
  }

  close(): void {
    if (this.closed) return;
    // 同步关闭失败时保留连接与后台清理；活动子进程的占用不能推断为结束。
    const releases = this.database.sqlite.transaction(() => this.cleanupForClose()).immediate();
    this.finishClose(releases);
  }

  closeAsync(options?: SqliteWriteOptions): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.closePromise) return this.closePromise;
    this.closePromise = runSqliteWrite(this.database.sqlite, () => this.cleanupForClose(), options)
      .then(releases => { if (!this.closed) this.finishClose(releases); })
      .catch(error => { if (!this.closed) throw error; })
      .finally(() => { this.closePromise = undefined; });
    return this.closePromise;
  }
}
