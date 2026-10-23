import { rotateDiagnosticLog, rotateDiagnosticLogAsync } from "./diagnostic-retention.js";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { join } from "node:path";
import { errorMonitor } from "node:events";
import type { Server, IncomingMessage, ServerResponse } from "node:http";
import { logEvent, shouldLog, type LoggingConfig } from "./logger.js";

export const httpDiagnosticRequestId = Symbol("quaymesh.httpRequestId");

export function diagnosticError(error: unknown): Record<string, unknown> {
  const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
  return {
    errorType: error instanceof Error ? "Error" : typeof error,
    errorCode: typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : undefined,
    errorFingerprint: createHash("sha256").update(error instanceof Error ? error.message : typeof error).digest("hex").slice(0, 16),
    frames: error instanceof Error ? error.stack?.split("\n").slice(1).flatMap((line) => {
      const location = /[\\/]([\w.-]+\.[cm]?[jt]s):(\d+):(\d+)\)?$/.exec(line);
      return location ? [`${location[1]}:${location[2]}:${location[3]}`] : [];
    }).slice(0, 8) : undefined,
  };
}

export class ServerDiagnostics {
  private readonly instanceId = randomUUID();
  private readonly path: string;
  private readonly startedAt = performance.now();
  private readonly pending = new Map<string, number>();
  private timer: NodeJS.Timeout;
  private detachHttp?: () => void;
  private writeFailureReported = false;
  private lastHeartbeat = performance.now();
  private readonly loopDelay = monitorEventLoopDelay({ resolution: 20 });
  private readonly buffered: string[] = [];
  private bufferedBytes = 0;
  private droppedEvents = 0;
  private sequence = 0;
  private flushTimer?: NodeJS.Timeout;
  private writing?: Promise<void>;
  private disposed = false;
  private readonly beforeExit = (code: number) => { this.flushAtExit(); this.record("server_before_exit", { exitCode: code }); };
  private readonly exit = (code: number) => { this.flushAtExit(); this.record("server_exit", { exitCode: code }); };
  private readonly fatal = (error: Error, origin: string) => { this.flushAtExit(); this.record("server_uncaught_exception", { origin, ...diagnosticError(error) }, "error"); };

  constructor(private readonly config: { stateDir: string; logging: LoggingConfig }, private readonly heartbeatMs = 30_000) {
    this.path = join(config.stateDir, "logs", "server-diagnostics.jsonl");
    process.on("beforeExit", this.beforeExit);
    process.on("exit", this.exit);
    process.on("uncaughtExceptionMonitor", this.fatal);
    this.loopDelay.enable();
    this.record("server_starting", { nodeVersion: process.version, platform: process.platform });
    this.timer = setInterval(() => {
      const current = performance.now();
      const memory = process.memoryUsage();
      let oldest = current;
      for (const started of this.pending.values()) oldest = Math.min(oldest, started);
      this.record("server_heartbeat", {
        rssBytes: memory.rss, heapUsedBytes: memory.heapUsed,
        timerDriftMs: Math.max(0, Math.round(current - this.lastHeartbeat - this.heartbeatMs)),
        eventLoopDelayMs: Math.max(0, Math.round(current - this.lastHeartbeat - this.heartbeatMs)),
        eventLoopDelayMetric: "heartbeat_timer_drift",
        eventLoopLagMaxMs: Math.round(this.loopDelay.max / 1e6),
        eventLoopLagP99Ms: Math.round(this.loopDelay.percentile(99) / 1e6),
        diagnosticBufferedBytes: this.bufferedBytes, diagnosticDroppedEvents: this.droppedEvents,
        pendingHttpRequests: this.pending.size,
        pendingRequests: this.pending.size,
        oldestRequestMs: Math.round(current - oldest),
      });
      this.lastHeartbeat = current;
      this.loopDelay.reset();
    }, heartbeatMs);
    this.timer.unref();
  }

  start<T>(create: () => T): T {
    try { return create(); }
    catch (error) {
      this.record("server_startup_failed", diagnosticError(error), "error");
      throw error;
    }
  }

  record(event: string, fields: Record<string, unknown> = {}, level: "info" | "warn" | "error" = "info"): void {
    if (!shouldLog(this.config.logging, level)) return;
    const identity = { instanceId: this.instanceId, diagnosticSequence: ++this.sequence, pid: process.pid, ppid: process.ppid, uptimeMs: Math.round(performance.now() - this.startedAt), ...fields };
    const critical = /^(server_(starting|before_exit|exit|uncaught_exception|startup_failed|shutdown_failed)|runtime_control_listen_error)$/.test(event);
    // 高频请求证据只写诊断文件，避免在组件日志中同步复制一遍。
    if (critical || level !== "info") try { logEvent(this.config.logging, level, event, identity); } catch {}
    let line: string;
    try { line = `${JSON.stringify({ ts: new Date().toISOString(), level, event, ...identity })}\n`; }
    catch { this.droppedEvents++; return; }
    if (critical) { this.writeImmediate(line, identity); return; }
    const bytes = Buffer.byteLength(line);
    if (this.bufferedBytes + bytes > 1024 * 1024) { this.droppedEvents++; return; }
    this.buffered.push(line); this.bufferedBytes += bytes;
    if (!this.flushTimer && !this.disposed) {
      this.flushTimer = setTimeout(() => { this.flushTimer = undefined; void this.flush(); }, 25);
      this.flushTimer.unref();
    }
  }

  private writeImmediate(line: string, identity: Record<string, unknown> = {}): void {
    try {
      mkdirSync(join(this.config.stateDir, "logs"), { recursive: true });
      // 异步批次持有轮转权时，紧急证据只追加，避免两个轮转覆盖同一归档。
      if (!this.writing) rotateDiagnosticLog(this.path);
      appendFileSync(this.path, line, { mode: 0o600 });
    } catch (error) { this.reportWriteFailure(error, identity); }
  }

  private reportWriteFailure(error: unknown, identity: Record<string, unknown> = {}): void {
    if (this.writeFailureReported) return;
    this.writeFailureReported = true;
    try { logEvent(this.config.logging, "error", "server_diagnostics_write_failed", { ...identity, ...diagnosticError(error) }); } catch {}
  }

  private flushAtExit(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (this.buffered.length) this.writeImmediate(this.buffered.splice(0).join(""));
    this.bufferedBytes = 0;
  }

  flush(): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (this.writing) return this.writing;
    const work = (async () => {
      while (this.buffered.length) {
        let batch = "", count = 0;
        while (this.buffered.length && Buffer.byteLength(batch) < 64 * 1024) {
          const line = this.buffered.shift()!;
          this.bufferedBytes -= Buffer.byteLength(line); batch += line; count++;
        }
        try {
          await mkdir(join(this.config.stateDir, "logs"), { recursive: true });
          await rotateDiagnosticLogAsync(this.path);
          await appendFile(this.path, batch, { mode: 0o600 });
        } catch (error) { this.droppedEvents += count; this.reportWriteFailure(error); }
      }
    })().finally(() => { this.writing = undefined; });
    this.writing = work;
    return work;
  }

  attach(http: Server): void {
    const listening = () => this.record("server_listening");
    const closed = () => this.record("server_http_closed", { pendingRequests: this.pending.size });
    const error = (failure: Error) => this.record("server_http_error", diagnosticError(failure), "error");
    const request = (req: IncomingMessage, res: ServerResponse) => {
      const requestId = randomUUID();
      (req as IncomingMessage & { [httpDiagnosticRequestId]?: string })[httpDiagnosticRequestId] = requestId;
      const start = performance.now();
      const path = req.url?.split("?")[0];
      const route = path === "/mcp" || path === "/mcp/" ? "mcp" : "other";
      const tracked = this.config.logging.requests;
      this.pending.set(requestId, start);
      if (tracked && route === "mcp") this.record("server_request_started", { requestId, route });
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        this.pending.delete(requestId);
        const aborted = !res.writableFinished;
        if (tracked && (route === "mcp" || aborted)) this.record(aborted ? "server_request_aborted" : "server_request_finished", {
          requestId, route, status: res.headersSent ? res.statusCode : undefined, headersSent: res.headersSent,
          durationMs: Math.round(performance.now() - start),
        }, aborted ? "warn" : "info");
        res.off("finish", finish);
        res.off("close", finish);
      };
      res.once("finish", finish);
      res.once("close", finish);
    };
    http.once("listening", listening);
    http.once("close", closed);
    http.on(errorMonitor, error);
    http.prependListener("request", request);
    this.detachHttp = () => {
      http.off("listening", listening);
      http.off("close", closed);
      http.off(errorMonitor, error);
      http.off("request", request);
    };
  }

  dispose(): Promise<void> {
    this.disposed = true;
    clearInterval(this.timer);
    this.loopDelay.disable();
    this.detachHttp?.();
    process.off("beforeExit", this.beforeExit);
    process.off("exit", this.exit);
    process.off("uncaughtExceptionMonitor", this.fatal);
    return this.flush();
  }
}
