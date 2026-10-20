import { randomUUID } from "node:crypto";
import { realpathSync, existsSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import { runSqliteWrite, type SqliteWriteOptions } from "./db/async-write.js";
import { canonicalPathIdentity } from "./roots.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { pidAlive } from "./process-liveness.js";
import { canonicalResourcePath, normalizeExecutionResources, resourcesConflict,
  resourceContains, type ExecutionResource } from "./execution-resources.js";

export interface RuntimeWorkInput {
  kind: "tool" | "resource" | "console" | "transfer" | "egress";
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
  threadKey?: string;
  resources?: readonly string[];
  scopes?: readonly ExecutionResource[];
  operationId?: string;
  taskId?: string;
  title?: string;
  maxConcurrentAgents?: number;
  maxConcurrentReaders?: number;
}

interface ClaimRow {
  id: string; owner_id: string; owner_pid: number;
  kind: ExecutionClaimInput["kind"];
  checkout_root: string; agent_id: string | null; thread_key: string | null;
  access_mode: SourceAccess; resources: string; acquired_at?: string;
  scopes_json: string | null; operation_id: string | null; task_id: string | null; title: string | null;
}
interface WaiterRow extends ClaimRow { sequence: number; expires_at_ms: number }

export interface ExecutionClaim {
  readonly id: string;
  bindThread(threadKey: string): void;
  release(): void;
  releaseAsync(options?: SqliteWriteOptions): Promise<void>;
}
export interface ExecutionTicket {
  readonly id: string;
  tryAcquire(): ExecutionClaim | undefined;
  cancel(): void;
}

export class ExecutionConflictError extends Error {
  readonly code = "EXECUTION_CONFLICT";
  constructor(readonly claimId: string, readonly agentId: string | undefined, reason: string,
    readonly details?: { type: string; requested: ExecutionResource[]; blockedResources: ExecutionResource[];
      operationId: string | null; taskId: string | null; title: string | null; acquiredAt: string | null; queued: boolean }) {
    super(`${reason}。操作尚未开始。占用：${claimId}${details ? `；${JSON.stringify(details)}` : ""}`);
    this.name = "ExecutionConflictError";
  }
}

/** Aliases and subdirectories identify one real checkout; linked worktrees remain distinct. */
export function canonicalExecutionRoot(path: string): string {
  const real = realpathSync(resolve(path));
  let cursor = real;
  for (;;) {
    if (existsSync(resolve(cursor, ".git"))) return canonicalPathIdentity(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) return canonicalPathIdentity(real);
    cursor = parent;
  }
}
function contains(parent: string, child: string): boolean {
  const rest = relative(parent, child);
  return rest === "" || (!isAbsolute(rest) && rest !== ".." && !rest.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
}
export function overlaps(a: string, b: string): boolean { return contains(a, b) || contains(b, a); }
function claimResources(row: ClaimRow): ExecutionResource[] {
  const paths: ExecutionResource[] = row.scopes_json === null || row.scopes_json === undefined
    ? [{kind:"tree",path:row.checkout_root,access:row.access_mode}]
    : JSON.parse(row.scopes_json) as ExecutionResource[];
  return [...paths, ...(JSON.parse(row.resources) as string[]).map(key => ({kind:"named" as const,key,access:"write" as const}))];
}
function exclusiveConflict(a: ClaimRow, b: ClaimRow): boolean {
  return Boolean((a.agent_id && a.agent_id === b.agent_id) ||
    (a.thread_key && a.thread_key === b.thread_key) ||
    claimResources(a).some(resource => claimResources(b).some(other => resourcesConflict(resource,other))));
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

  private assertAccepting(): void {
    const inherited = acceptedWork.getStore();
    if (inherited?.stateDir === this.stateDir && this.database.sqlite.prepare("SELECT 1 FROM qm_runtime_work WHERE id=?").get(inherited.id)) return;
    const state = this.database.sqlite.prepare("SELECT accepting,reason FROM qm_runtime_admission WHERE id=1").get() as { accepting: number; reason: string | null };
    if (!state.accepting) throw new AdmissionPausedError(state.reason);
  }

  pause(reason = "维护操作"): void {
    this.database.sqlite.transaction(() => {
      this.database.sqlite.prepare("UPDATE qm_runtime_admission SET accepting=0,reason=?,changed_at=? WHERE id=1")
        .run(reason, new Date().toISOString());
    }).immediate();
  }

  async pauseAsync(reason = "维护操作", options?: SqliteWriteOptions): Promise<void> {
    await runSqliteWrite(this.database.sqlite, () => this.pause(reason), options);
  }

  resume(): void {
    this.database.sqlite.prepare("UPDATE qm_runtime_admission SET accepting=1,reason=NULL,changed_at=? WHERE id=1")
      .run(new Date().toISOString());
  }

  /** 只清除服务正常退出留下的暂停标记，维护暂停由维护流程显式恢复。 */
  resumeAfterRestart(): boolean {
    const state = this.database.sqlite.prepare("SELECT accepting,reason FROM qm_runtime_admission WHERE id=1")
      .get() as { accepting: number; reason: string | null };
    if (state.accepting !== 0 || !["服务正在退出", "服务准备停止"].includes(state.reason ?? "")) return false;
    this.resume();
    return true;
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
          input.taskId ?? null, input.allowWhilePaused || input.blocking === false ? 0 : 1, new Date().toISOString());
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

  admissionStatus() {
    return this.database.sqlite.transaction(() => {
      const state = this.database.sqlite.prepare("SELECT accepting,reason,changed_at FROM qm_runtime_admission WHERE id=1").get() as { accepting: number; reason: string | null; changed_at: string };
      const count = (sql: string) => Number((this.database.sqlite.prepare(sql).get() as { n: number }).n);
      const claims = count("SELECT COUNT(*) AS n FROM execution_claims");
      const waiting = count("SELECT COUNT(*) AS n FROM execution_waiters WHERE expires_at_ms>strftime('%s','now')*1000");
      const operations = count("SELECT COUNT(*) AS n FROM console_operations WHERE status IN ('running','starting')");
      const executions = count("SELECT COUNT(*) AS n FROM console_executions WHERE status IN ('running','starting')");
      const queuedOperations = count("SELECT COUNT(*) AS n FROM console_operations WHERE status='queued'");
      const queuedExecutions = count("SELECT COUNT(*) AS n FROM console_executions WHERE status='queued'");
      const rows = this.database.sqlite.prepare(`SELECT kind,owner_pid,COUNT(*) AS count FROM qm_runtime_work
        WHERE blocking=1 GROUP BY kind,owner_pid ORDER BY kind,owner_pid`).all() as { kind: string; owner_pid: number; count: number }[];
      const owners = new Map<number, boolean>();
      const counts = new Map<string, number>();
      for (const row of rows) {
        if (!owners.has(row.owner_pid)) owners.set(row.owner_pid, pidAlive(row.owner_pid));
        if (owners.get(row.owner_pid)) counts.set(row.kind, (counts.get(row.kind) ?? 0) + row.count);
      }
      const work = [...counts].map(([kind, count]) => ({ kind, count }));
      const activeWork = work.reduce((n, item) => n + item.count, 0);
      return { accepting: state.accepting === 1, reason: state.reason, changedAt: state.changed_at,
        idle: claims + operations + executions + activeWork === 0,
        claims, waiting, operations, executions, queuedOperations, queuedExecutions, activeWork, work };
    }).deferred();
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
    return { id: `claim_${randomUUID().replaceAll("-", "")}`, owner_id: this.ownerId, owner_pid: process.pid,
      kind: input.kind, checkout_root: canonicalExecutionRoot(input.workspaceRoot), agent_id: input.agentId ?? null,
      thread_key: input.threadKey ?? null, access_mode: input.access ?? "write", resources: JSON.stringify(resources),
      scopes_json: input.scopes === undefined ? null : JSON.stringify(normalizeExecutionResources(input.scopes)),
      operation_id: input.operationId ?? null, task_id: input.taskId ?? null, title:input.title?.slice(0,200) ?? null };
  }

  private blocker(candidate: ClaimRow, input: ExecutionClaimInput, sequence = Number.MAX_SAFE_INTEGER): ClaimRow | undefined {
    // Expired WAITERS never started work. Active claims have no timeout-steal path.
    this.database.sqlite.prepare("delete from execution_waiters where expires_at_ms <= ?").run(Date.now());
    const active = (this.database.sqlite.prepare("select * from execution_claims").all() as ClaimRow[]).filter(row => {
      if (pidAlive(row.owner_pid)) return true;
      // A dead owner is not sufficient to infer that a subprocess stopped.
      // Reclaim only claims whose authoritative operation is already terminal.
      const terminal = row.operation_id && this.database.sqlite.prepare(
        "select 1 from console_operations where id=? and status in ('completed','failed','cancelled')",
      ).get(row.operation_id);
      if (!terminal) return true;
      this.database.sqlite.prepare("delete from execution_claims where id=? and owner_id=?")
        .run(row.id,row.owner_id);
      return false;
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
      (id, owner_id, owner_pid, kind, checkout_root, agent_id, resources, acquired_at, access_mode, thread_key,scopes_json,operation_id,task_id,title)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.id, row.owner_id, row.owner_pid, row.kind, row.checkout_root, row.agent_id, row.resources,
        new Date().toISOString(), row.access_mode, row.thread_key,row.scopes_json,row.operation_id,row.task_id,row.title);
    const release = this.createReleaseHandle(row.id, "execution_claims");
    return {
      id: row.id,
      release: release.release,
      releaseAsync: release.releaseAsync,
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
        if (parent) return { id:parent.id,release:()=>{},releaseAsync:async()=>{},bindThread:()=>{throw new Error("内部调用不能改变所属代理线程");} };
      }
      const blocker = this.blocker(candidate, input);
      if (blocker) {
        const requested = claimResources(candidate);
        const blockedResources = claimResources(blocker).filter(scope => requested.some(other => resourcesConflict(scope,other)));
        throw new ExecutionConflictError(blocker.id,blocker.agent_id ?? undefined,"执行资源暂时不可用",{
          type:blockedResources.length ? "resource" : blocker.thread_key && blocker.thread_key===candidate.thread_key ? "thread" : blocker.agent_id && blocker.agent_id===candidate.agent_id ? "agent" : "capacity",
          requested,blockedResources,operationId:blocker.operation_id,taskId:blocker.task_id,title:blocker.title,
          acquiredAt:blocker.acquired_at ?? null,queued:"sequence" in blocker,
        });
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
      if (count >= 64) throw new ExecutionConflictError("queue", undefined, "Local queue capacity reached; no provider invoked");
      this.database.sqlite.prepare(`insert into execution_waiters
        (id, owner_id, owner_pid, kind, checkout_root, agent_id, thread_key, access_mode, resources, expires_at_ms,scopes_json,operation_id,task_id,title)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(candidate.id, this.ownerId, process.pid, candidate.kind, candidate.checkout_root, candidate.agent_id,
          candidate.thread_key, candidate.access_mode, candidate.resources, Date.now() + waitMs,candidate.scopes_json,candidate.operation_id,candidate.task_id,candidate.title);
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
    const root = canonicalExecutionRoot(workspaceRoot);
    const active = this.database.sqlite.prepare("select * from execution_claims").all() as ClaimRow[];
    const waiting = this.database.sqlite.prepare("select * from execution_waiters where expires_at_ms > ? order by sequence").all(Date.now()) as WaiterRow[];
    return [...active.map((row) => ({ ...row, state: "active" })), ...waiting.map((row) => ({ ...row, state: "queued" }))]
      .filter((row) => overlaps(row.checkout_root, root))
      .map((row) => ({ id: row.id, kind: row.kind, access: row.access_mode, state: row.state,
        agentId: row.agent_id ?? undefined, ownerPid: row.owner_pid, resources: JSON.parse(row.resources) as string[],
        scopes:claimResources(row),operationId:row.operation_id,taskId:row.task_id,title:row.title,
        acquiredAt: row.acquired_at,
        recovery: "Active claims require reconciliation after an interrupted owner; never replay or steal them by timeout." }));
  }

  /** Read-only queue evidence. Do not expose another workspace's agent, path or resource names. */
  waitingState(workspaceRoot: string, agentId: string) {
    const root = canonicalExecutionRoot(workspaceRoot);
    const ticket = this.database.sqlite.prepare("select * from execution_waiters where agent_id=? and checkout_root=? order by sequence limit 1")
      .get(agentId, root) as WaiterRow | undefined;
    if (!ticket) return undefined;
    const active = this.database.sqlite.prepare("select * from execution_claims").all() as ClaimRow[];
    const prior = this.database.sqlite.prepare("select * from execution_waiters where sequence < ? and expires_at_ms > ? order by sequence")
      .all(ticket.sequence, Date.now()) as WaiterRow[];
    const blockers = [...active, ...prior].filter((row) => exclusiveConflict(ticket, row));
    return { state: ticket.expires_at_ms <= Date.now() ? "expired_pending_settlement" : "queued",
      expiresAt: new Date(ticket.expires_at_ms).toISOString(),
      reason: blockers.length ? "claim_or_prior_waiter" : "admission_limit_or_pending_dispatch",
      owners: blockers.slice(0, 8).map((row) => ({ claimId: row.id, kind: row.kind, access: row.access_mode,
        scope: overlaps(row.checkout_root, root) ? "checkout" : "shared_resource", state: "sequence" in row ? "queued" : "active" })),
      ownersTruncated: blockers.length > 8,
      guidance: "Wait for admission or cancel this owned queued task. Active claims are never stolen; writes are never replayed automatically." };
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
