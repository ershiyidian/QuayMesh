import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { openSync, readSync, closeSync } from "node:fs";

export const AUDIT_SINCE = "2026-09-06T16:00:00Z";
export const AUDIT_UNTIL = "2026-09-08T08:49:17Z";
const hash = (value: unknown) => createHash("sha256").update(String(value)).digest("hex").slice(0, 24);
const states = ["running", "starting", "queued", "pending", "completed", "failed", "cancelled", "reconciliation_required"];
const kinds = ["command", "read", "workspace_context", "apply_patch", "write", "edit", "bash", "verification", "delivery.v1", "agent"];
const pick = (value: unknown, allowed: string[]) => typeof value === "string" && allowed.includes(value) ? value : "unknown";
const count = (out: Record<string, number>, key: string) => { out[key] = (out[key] ?? 0) + 1; };
const time = (value: unknown) => typeof value === "string" && /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? Date.parse(value) : NaN;
type Row = Record<string, unknown>;
function durations(values: number[]) {
  values.sort((a, b) => a - b);
  return { count: values.length, p50Ms: values.length ? values[Math.ceil(values.length * .5) - 1] : null,
    p95Ms: values.length ? values[Math.ceil(values.length * .95) - 1] : null, maxMs: values.at(-1) ?? null,
    sumMs: values.reduce((a, b) => a + b, 0) };
}
export function intervalUnion(intervals: number[][]): number {
  let end = -Infinity, total = 0;
  for (const [a, b] of intervals.sort((a, b) => a[0]! - b[0]!)) {
    total += Math.max(0, b! - Math.max(a!, end)); end = Math.max(end, b!);
  }
  return total;
}

/** Auditable safe projection: no evidence, prose, config, or provider transcript columns.
 * JSON is projected inside SQLite to individual permitted metadata scalars only. */
export const SAFE_PROJECTION = {
  runs: `select id, project_id, status, acceptance, created_at, finished_at,
    case when json_valid(origin) then json_extract(origin,'$.entryPoint') end as entry,
    case when json_valid(origin) then json_extract(origin,'$.conversationHash') end as conversation
    from console_work_runs order by rowid limit ?`,
  operations: `select kind,status,created_at,finished_at from console_operations where run_id=? order by rowid limit ?`,
  executions: `select status,usage_quality,created_at,finished_at,
    case when json_valid(delta) then json_extract(delta,'$.totalTokens') end as tokens
    from console_executions where run_id=? order by rowid limit ?`,
};

export function collectTrajectories(path: string, options: { since: string; until: string; selection?: "overlap" | "created"; maxRows?: number }) {
  const since = time(options.since), until = time(options.until), selection = options.selection ?? "overlap";
  if (!Number.isFinite(since) || !Number.isFinite(until) || since >= until) throw new Error("Explicit timezone-qualified since < until required.");
  const cap = options.maxRows ?? 100_000;
  if (!Number.isInteger(cap) || cap < 1 || cap > 1_000_000) throw new Error("Invalid row bound.");
  const collectedAt = new Date().toISOString(), now = Date.parse(collectedAt);
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try { return db.transaction(() => {
    let scanned = 0, malformed = 0, selected = 0, operationRows = 0, executionRows = 0, truncated = false;
    const groups = new Map<string, ReturnType<typeof group>>();
    function group() { return { runs: 0, runStates: {} as Record<string, number>, acceptance: {} as Record<string, number>,
      projects: new Set<string>(), runHashes: [] as string[], operations: {} as Record<string, Record<string, number>>,
      ended: [] as number[], active: [] as number[], intervals: [] as number[][],
      executionStates: {} as Record<string, number>, usageQuality: {} as Record<string, number>, knownDeltaTokens: 0, missingDelta: 0 }; }
    const included = (row: Row) => {
      const start = time(row.created_at), finish = row.finished_at === null ? null : time(row.finished_at);
      if (!Number.isFinite(start) || (finish !== null && (!Number.isFinite(finish) || finish < start))) { malformed++; return false; }
      return start < until && (selection === "created" ? start >= since : finish === null || finish > since);
    };
    const rows = db.prepare(SAFE_PROJECTION.runs).iterate(cap + 1) as Iterable<Row>;
    for (const row of rows) {
      if (scanned++ >= cap) { truncated = true; break; }
      if (!included(row)) continue;
      selected++;
      const conversation = typeof row.conversation === "string" && /^[a-f0-9]{20,64}$/.test(row.conversation) ? row.conversation : undefined;
      const key = row.entry === "chatgpt_mcp" && conversation ? `parent:${conversation}` : row.entry === "other_mcp" ? "unassociated_other_mcp" : "unknown_origin";
      const g = groups.get(key) ?? group(); groups.set(key, g);
      g.runs++; g.projects.add(hash(row.project_id)); g.runHashes.push(hash(row.id));
      count(g.runStates, pick(row.status, states)); count(g.acceptance, pick(row.acceptance, ["pending", "passed", "failed", "not_applicable"]));
      if (operationRows < cap) for (const op of db.prepare(SAFE_PROJECTION.operations).iterate(row.id, cap - operationRows + 1) as Iterable<Row>) {
        if (operationRows >= cap) { truncated = true; break; } operationRows++;
        if (!included(op)) continue;
        const kind = pick(op.kind, kinds), status = pick(op.status, states);
        count(g.operations[kind] ??= {}, status);
        const a = time(op.created_at), b = time(op.finished_at);
        if (op.finished_at === null) g.active.push(Math.max(0, now - a));
        else { g.ended.push(b - a); g.intervals.push([Math.max(a, since), Math.min(b, until)]); }
      } else truncated = true;
      if (executionRows < cap) for (const ex of db.prepare(SAFE_PROJECTION.executions).iterate(row.id, cap - executionRows + 1) as Iterable<Row>) {
        if (executionRows >= cap) { truncated = true; break; } executionRows++;
        if (!included(ex)) continue;
        count(g.executionStates, pick(ex.status, states)); count(g.usageQuality, pick(ex.usage_quality, ["complete", "partial", "unavailable", "not_used"]));
        if (typeof ex.tokens === "number" && Number.isSafeInteger(ex.tokens) && ex.tokens >= 0) g.knownDeltaTokens += ex.tokens;
        else g.missingDelta++;
      } else truncated = true;
    }
    return { schema: "quaymesh.trajectory-audit.v1", collectedAt, window: { since: new Date(since).toISOString(), until: new Date(until).toISOString(), selection },
      coverage: { scannedRuns: Math.min(scanned, cap), selectedRuns: selected, operationRows, executionRows, malformedRecords: malformed, truncated, maxRowsPerTable: cap,
        diagnostics: "not_read", failureCauses: "unknown: evidence and arbitrary logs excluded", unledgeredCalls: "unknown" },
      notes: ["Half-open window; overlap selects start < until and finish > since or no finish; created selects since <= start < until. Same rule applies to operations/executions.",
        "Statuses and acceptance are current at collection, not historical point-in-time. Active elapsed is measured at collection.",
        "Lifecycle completion and acceptance are separate; no end-to-end request success rate. Unassociated children are never linked by project/time.",
        "Delta counted once per selected execution; missing is not zero. Whole execution usage is not prorated to window. Not host tokens or billing.",
        "Ended durations are whole operations; union is clipped to window. Diagnostics and structured failure evidence are not read; generic failures retain unknown cause."],
      conversations: [...groups].map(([association, g]) => ({ association, runs: g.runs, runHashes: g.runHashes, projectHashes: [...g.projects],
        runStates: g.runStates, acceptance: g.acceptance, operationsByKind: g.operations, endedDurations: durations(g.ended),
        endedUnionWallMsInWindow: intervalUnion(g.intervals), activeElapsedAtCollection: durations(g.active),
        executionStates: g.executionStates, usageQuality: g.usageQuality, knownDeltaTokens: g.knownDeltaTokens, missingDeltaExecutions: g.missingDelta })),
      providerInvoked: false, ledgerModified: false };
  })(); } finally { db.close(); }
}

const diagnosticEvents = ["server_starting", "server_listening", "server_startup_failed", "server_heartbeat", "server_before_exit", "server_exit",
  "server_uncaught_exception", "server_http_error", "server_http_closed", "server_request_started", "server_request_finished", "server_request_aborted",
  "process_started", "process_start_failed", "process_error", "process_finished", "process_accounting_failed", "process_output_consumed"];
const diagnosticCodes = ["ENOENT", "EACCES", "EPERM", "EADDRINUSE", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "ERR_STREAM_DESTROYED", "SQLITE_BUSY", "SQLITE_READONLY"];
/** Optional, explicit diagnostic files only. Never emits arbitrary strings, identifiers or exception messages.
 * Bounded streaming avoids materializing whole logs or overlong lines. Unknown is not a guessed cause. */
export function collectDiagnosticMetrics(path: string, since: string, until: string, limits: { maxBytes?: number; maxLines?: number; maxLineBytes?: number } = {}) {
  const a = time(since), b = time(until);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a >= b) throw new Error("Invalid diagnostic window.");
  const maxBytes = limits.maxBytes ?? 8 * 1024 * 1024, maxLines = limits.maxLines ?? 100_000, maxLineBytes = limits.maxLineBytes ?? 64 * 1024;
  for (const n of [maxBytes, maxLines, maxLineBytes]) if (!Number.isInteger(n) || n < 1 || n > 16 * 1024 * 1024) throw new Error("Invalid diagnostic bound.");
  const events: Record<string, number> = {}, codes: Record<string, number> = {};
  let bytes = 0, lines = 0, malformed = 0, overlong = 0, inWindow = 0, truncated = false, first: number | null = null, last: number | null = null;
  let pending: number[] = [], dropping = false;
  const line = () => {
    lines++;
    if (dropping) { overlong++; dropping = false; pending = []; return; }
    try {
      const row = JSON.parse(Buffer.from(pending).toString("utf8")) as Row;
      const ts = time(row?.ts);
      if (!Number.isFinite(ts)) { malformed++; return; }
      if (ts < a || ts >= b) return;
      inWindow++; first = first === null ? ts : Math.min(first, ts); last = last === null ? ts : Math.max(last, ts);
      const event = pick(row.event, diagnosticEvents); count(events, event);
      if (event.includes("failed") || event === "process_error" || event === "server_uncaught_exception" || event === "server_http_error") count(codes, pick(row.errorCode, diagnosticCodes));
      if (event === "process_finished") count(codes, typeof row.exitCode === "number" && row.exitCode === 0 ? "exit_zero" : "nonzero_or_unknown_exit");
    } catch { malformed++; } finally { pending = []; }
  };
  let fd: number;
  try { fd = openSync(path, "r"); } catch { return { available: false, coverage: "unavailable" as const }; }
  try {
    const buffer = Buffer.alloc(8192);
    while (bytes < maxBytes && lines < maxLines) {
      const n = readSync(fd, buffer, 0, Math.min(buffer.length, maxBytes - bytes), null);
      if (!n) break;
      bytes += n;
      for (let i = 0; i < n; i++) {
        if (buffer[i] === 10) { line(); if (lines >= maxLines) { truncated = true; break; } }
        else if (!dropping) { if (pending.length >= maxLineBytes) { pending = []; dropping = true; } else pending.push(buffer[i]!); }
      }
    }
    if (bytes >= maxBytes) truncated = true;
    if (!truncated && (pending.length || dropping)) { malformed++; /* incomplete final line is not an event */ }
  } finally { closeSync(fd); }
  return { available: true, bytesRead: bytes, lines, malformed, overlong, inWindow, truncated,
    coverage: "only_explicit_file_no_global_log_completeness", first: first === null ? null : new Date(first).toISOString(), last: last === null ? null : new Date(last).toISOString(),
    events, codes, limits: { maxBytes, maxLines, maxLineBytes }, linkage: "none; file-level metrics only" };
}
