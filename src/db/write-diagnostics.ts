export type SqliteWriteDiagnosticSource = "session_store" | "session_feed_update" | "session_reconcile";
export type SqliteWritePhase = "setup" | "begin" | "body" | "commit" | "rollback" | "restore";
export type SqliteWriteErrorStage = SqliteWritePhase | "validation" | "retry";

interface PhaseTiming {
  count: number;
  totalMs: number;
  maxMs: number;
}

export interface SqliteWriteDiagnostic {
  source: SqliteWriteDiagnosticSource;
  outcome: "committed" | "failed" | "cancelled";
  elapsedMs: number;
  attempts: number;
  phases: Record<SqliteWritePhase, PhaseTiming>;
  retryCount: number;
  retryScheduledMs: number;
  retryElapsedMs: number;
  cleanupFailed: boolean;
  errorStage?: SqliteWriteErrorStage;
  errorCode?: string;
}

export type SqliteWriteReporter = (event: SqliteWriteDiagnostic) => void;

// Do not copy arbitrary error properties or a user-supplied label into diagnostics.
const errorCodes = new Set([
  "SQLITE_ERROR", "SQLITE_INTERNAL", "SQLITE_PERM", "SQLITE_ABORT", "SQLITE_BUSY", "SQLITE_LOCKED",
  "SQLITE_NOMEM", "SQLITE_READONLY", "SQLITE_INTERRUPT", "SQLITE_IOERR", "SQLITE_CORRUPT", "SQLITE_NOTFOUND",
  "SQLITE_FULL", "SQLITE_CANTOPEN", "SQLITE_PROTOCOL", "SQLITE_EMPTY", "SQLITE_SCHEMA", "SQLITE_TOOBIG",
  "SQLITE_CONSTRAINT", "SQLITE_MISMATCH", "SQLITE_MISUSE", "SQLITE_NOLFS", "SQLITE_AUTH", "SQLITE_FORMAT",
  "SQLITE_RANGE", "SQLITE_NOTADB", "SQLITE_NOTICE", "SQLITE_WARNING",
  "SQLITE_BUSY_RECOVERY", "SQLITE_BUSY_SNAPSHOT", "SQLITE_BUSY_TIMEOUT",
  "SQLITE_CONSTRAINT_CHECK", "SQLITE_CONSTRAINT_COMMITHOOK", "SQLITE_CONSTRAINT_FOREIGNKEY",
  "SQLITE_CONSTRAINT_FUNCTION", "SQLITE_CONSTRAINT_NOTNULL", "SQLITE_CONSTRAINT_PRIMARYKEY",
  "SQLITE_CONSTRAINT_TRIGGER", "SQLITE_CONSTRAINT_UNIQUE", "SQLITE_CONSTRAINT_VTAB",
  "SQLITE_CONSTRAINT_ROWID", "SQLITE_CONSTRAINT_PINNED", "SQLITE_CONSTRAINT_DATATYPE",
  "SQLITE_WRITE_ASYNC_CALLBACK", "SQLITE_WRITE_OUTER_TRANSACTION",
]);

function errorCode(error: unknown): string | undefined {
  try {
    const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
    if (typeof code !== "string" || code.length > 64) return undefined;
    if (errorCodes.has(code)) return code;
    // Other native extended codes retain only their known primary family.
    const primary = /^SQLITE_[A-Z]+(?=_)/u.exec(code)?.[0];
    return primary && errorCodes.has(primary) ? primary : undefined;
  } catch { return undefined; }
}

function timing(): PhaseTiming { return { count: 0, totalMs: 0, maxMs: 0 }; }
function rounded(value: number): number { return Math.round(value * 1000) / 1000; }

/** Optional observation only: no SQL, scheduling, logging, or change to retry deadlines. */
export class SqliteWriteObservation {
  private readonly startedAt = performance.now();
  private readonly phases: Record<SqliteWritePhase, PhaseTiming> = {
    setup: timing(), begin: timing(), body: timing(), commit: timing(), rollback: timing(), restore: timing(),
  };
  private phase?: SqliteWritePhase;
  private phaseStartedAt = 0;
  private retryStartedAt?: number;
  private retryCount = 0;
  private retryScheduledMs = 0;
  private retryElapsedMs = 0;

  constructor(private readonly report: SqliteWriteReporter, private readonly source: SqliteWriteDiagnosticSource) {}

  startPhase(phase: SqliteWritePhase): void {
    this.endPhase();
    this.phase = phase;
    this.phaseStartedAt = performance.now();
  }

  endPhase(): void {
    if (!this.phase) return;
    const elapsed = Math.max(0, performance.now() - this.phaseStartedAt), phase = this.phases[this.phase];
    phase.count++; phase.totalMs += elapsed; phase.maxMs = Math.max(phase.maxMs, elapsed);
    this.phase = undefined;
  }

  startRetry(scheduledMs: number): void {
    this.retryCount++; this.retryScheduledMs += scheduledMs; this.retryStartedAt = performance.now();
  }

  endRetry(): void {
    if (this.retryStartedAt === undefined) return;
    this.retryElapsedMs += Math.max(0, performance.now() - this.retryStartedAt);
    this.retryStartedAt = undefined;
  }

  finish(outcome: SqliteWriteDiagnostic["outcome"], attempts: number, cleanupFailed: boolean,
    stage?: SqliteWriteErrorStage, error?: unknown): void {
    this.endPhase(); this.endRetry();
    const elapsedMs = Math.max(0, performance.now() - this.startedAt);
    if (elapsedMs < 250 && !Object.values(this.phases).some(phase => phase.maxMs >= 50)) return;
    const phases = { ...this.phases };
    for (const key of Object.keys(phases) as SqliteWritePhase[]) {
      const phase = phases[key];
      phases[key] = { count: phase.count, totalMs: rounded(phase.totalMs), maxMs: rounded(phase.maxMs) };
    }
    const source = this.source === "session_feed_update" || this.source === "session_reconcile" ? this.source : "session_store";
    try {
      this.report({ source, outcome, elapsedMs: rounded(elapsedMs), attempts, phases,
        retryCount: this.retryCount, retryScheduledMs: rounded(this.retryScheduledMs), retryElapsedMs: rounded(this.retryElapsedMs),
        cleanupFailed, ...(outcome === "committed" ? {} : { errorStage: stage, errorCode: errorCode(error) }) });
    } catch { /* Diagnostics must not change the write result or original error. */ }
  }
}
