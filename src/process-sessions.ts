import { appendOutputTail, saveOutputTail } from "./process-output-evidence.js";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { executionContract, type ExecutionContract, resolveShellCommand, terminateProcessTree } from "./process-platform.js";
import { WindowsCommandJob, processGroupAlive, watchOwnedProcesses } from "./process-job.js";
import { mergeEnvironment } from "./local-agent-command.js";
import { ExecutionCoordinator, type ExecutionClaim } from "./execution-coordinator.js";
import { WorkLedger } from "./work-ledger.js";
import { randomUUID, randomInt, createHash, type Hash } from "node:crypto";
import { pidAlive } from "./process-liveness.js";
import { diagnosticError } from "./server-diagnostics.js";
import { currentInvocation } from "./session/invocations.js";
import { requireCommandScope } from "./command-profiles.js";
import { type ExecutionResource } from "./execution-resources.js";

const DEFAULT_EXEC_YIELD_MS = 2_000;
const DEFAULT_INTERACTIVE_YIELD_MS = 250;
const DEFAULT_POLL_YIELD_MS = 5_000;
export const MAX_PROCESS_YIELD_MS = 12_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;
const DEFAULT_BUFFER_CHARACTERS = 1_000_000;
const COMPLETED_SESSION_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_STDIO_DRAIN_TIMEOUT_MS = 5_000;
const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;

export interface StartCommandInput {
  requestKey?: string;
  workspaceId: string;
  command: string;
  cwd: string;
  workspaceRoot?: string;
  tty?: boolean;
  columns?: number;
  rows?: number;
  yieldTimeMs?: number;
  maxOutputTokens?: number;
  resources?: string[];
  scopeRoot?:string;
  scopes?:readonly ExecutionResource[];
  program?:{executable:string;args:string[]};
  workRunId?: string;
  /** Session-scoped operation identity closed when this process reaches a terminal state. */
  sessionOperationId?: string;
  onFinish?: (finish: ProcessFinish) => void;
}

export interface ProcessFinish {
  workspaceId: string;
  sessionId: string;
  sessionOperationId?: string;
  success: boolean;
  cancelled: boolean;
  exitCode?: number;
  signal?: string;
  disposition?: ProcessSnapshot["disposition"];
}

export type ProcessFinishListener = (finish: ProcessFinish) => void | Promise<void>;

export interface ProcessOutputSink {
  open(operationId: string, command: string): Promise<void>;
  append(operationId: string, output: string): Promise<void>;
  finish(operationId: string, exitCode: number | null, signal: string | null): Promise<void>;
  fail?(operationId: string, errorCode: string, exitCode: number | null, signal: string | null): Promise<void>;
}

export interface WriteStdinInput {
  workspaceId: string;
  sessionId: string | number;
  chars?: string;
  columns?: number;
  rows?: number;
  yieldTimeMs?: number;
  maxOutputTokens?: number;
}

export interface ProcessOperationHandle {
  session_id: string;
  workspace_id: string;
  running: boolean;
  phase: "running" | "root_exited_stdio_open" | "closed";
  exit_code?: number;
  signal?: string;
}

export interface ProcessSnapshot {
  execution: ExecutionContract;
  phase: "running" | "root_exited_stdio_open" | "closed";
  rootExitedElapsedMs?: number;
  terminalReplay: boolean;
  outputScope: "since_previous_read";
  operationId?: string;
  workRunId?: string;
  sessionId?: string;
  legacySessionId?: number;
  output: string;
  outputTruncated: boolean;
  running: boolean;
  exitCode?: number;
  rootExitCode?: number;
  signal?: string;
  wallTimeMs: number;
  recoverableDescription?: string;
  outputComplete?: boolean;
  disposition?: "completed" | "incomplete_output" | "reconciliation_required" | "waiting_for_descendants";
}

interface ManagedProcess {
  write(data: string): void;
  kill(signal?: NodeJS.Signals): void | Promise<void>;
  resize?(columns: number, rows: number): void;
}

interface ProcessSession {
  cancelRequestedAt?: number;
  outputPending?: Promise<void>;
  stdioCompletion?: Promise<void>;
  stdioSettled?: boolean;
  pendingOutputWrites?: number;
  outputError?: Error;
  finalizing?: Promise<void>;
  execution: ExecutionContract;
  rootPid?: number;
  rootExitedAt?: number;
  rootExitCode?: number;
  rootSignal?: string;
  outputComplete?: boolean;
  disposition?: ProcessSnapshot["disposition"];
  pgid?: number;
  finishedAt?: number;
  terminalReceipt?: ProcessSnapshot;
  id: string;
  legacyId: number;
  workspaceId: string;
  process?: ManagedProcess;
  startedAt: number;
  columns: number;
  rows: number;
  buffer: HeadTailBuffer;
  running: boolean;
  exitCode?: number;
  signal?: string;
  exitPromise: Promise<void>;
  resolveExit: () => void;
  rootExitPromise: Promise<void>;
  resolveRootExit: () => void;
  cleanupTimer?: NodeJS.Timeout;
  stdioDrainTimer?: NodeJS.Timeout;
  stopOwnedWatch?: () => void;
  wrapperPid?: number;
  pipeClosed?: boolean;
  closePromise?: Promise<void>;
  descendantLookupFailed?: boolean;
  commandJob?: WindowsCommandJob;
  executionClaim?: ExecutionClaim;
  workOperationId?: string;
  workRunId?: string;
  sessionOperationId?: string;
  onFinish?: (finish: ProcessFinish) => void;
  failure?: Record<string, unknown>;
  outputBytes: number;
  outputHash: Hash;
  outputTail: string;
  persistedOutputBytes: number;
}

interface ProcessSessionManagerOptions {
  environment?: () => NodeJS.ProcessEnv;
  diagnostics?: (event: string, fields: Record<string, unknown>, level: "info" | "warn" | "error") => void;
  maxBufferCharacters?: number;
  completedSessionTtlMs?: number;
  maxCompletedSessions?: number;
  stateDir?: string;
  stdioDrainTimeoutMs?: number;
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Duration and output limits must be non-negative.");
  }
  return Math.min(Math.floor(value), maximum);
}

function terminalSize(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > 1_000) {
    throw new Error("Terminal dimensions must be integers between 1 and 1000.");
  }
  return value;
}

function processEnvironment(input?: {
  workspaceId?: string;
  workspaceRoot?: string;
}): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
    NO_COLOR: "1",
    TERM: "dumb",
    PAGER: "cat",
    GIT_PAGER: "cat",
    GH_PAGER: "cat",
    CODEX_CI: "1",
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
    ...(input?.workspaceId ? { QUAYMESH_WORKSPACE_ID: input.workspaceId } : {}),
    ...(input?.workspaceRoot ? { QUAYMESH_WORKSPACE_ROOT: input.workspaceRoot } : {}),
  };
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function sliceCodePoints(value: string, start: number, end?: number): string {
  return Array.from(value).slice(start, end).join("");
}

function takeHead(value: string, count: number): string {
  if (count <= 0) return "";
  return sliceCodePoints(value, 0, count);
}

function takeTail(value: string, count: number): string {
  if (count <= 0) return "";
  const characters = Array.from(value);
  return characters.slice(Math.max(0, characters.length - count)).join("");
}

function splitBudget(maxCharacters: number): { head: number; tail: number } {
  return {
    head: Math.ceil(maxCharacters / 2),
    tail: Math.floor(maxCharacters / 2),
  };
}

function formatHeadTail(head: string, tail: string, omittedCharacters: number): string {
  if (omittedCharacters <= 0) return head + tail;
  return `${head}\n... output truncated (${omittedCharacters} characters omitted) ...\n${tail}`;
}

export class HeadTailBuffer {
  private head = "";
  private tail = "";
  private totalCharacters = 0;

  constructor(private readonly maxCharacters: number) {
    if (!Number.isInteger(maxCharacters) || maxCharacters < 1) {
      throw new Error("Head/tail buffer limit must be a positive integer.");
    }
  }

  append(output: string): void {
    if (!output) return;

    const previousTotal = this.totalCharacters;
    this.totalCharacters += codePointLength(output);

    if (this.totalCharacters <= this.maxCharacters) {
      this.head += output;
      return;
    }

    const budget = splitBudget(this.maxCharacters);
    if (previousTotal <= this.maxCharacters) {
      const fullOutput = this.head + output;
      this.head = takeHead(fullOutput, budget.head);
      this.tail = takeTail(fullOutput, budget.tail);
      return;
    }

    this.tail = takeTail(this.tail + output, budget.tail);
  }

  hasOutput(): boolean {
    return this.totalCharacters > 0;
  }

  drain(maxCharacters: number): { output: string; truncated: boolean } {
    if (!Number.isInteger(maxCharacters) || maxCharacters < 1) {
      throw new Error("Output limit must be a positive integer.");
    }

    const omittedByBuffer = Math.max(
      0,
      this.totalCharacters - codePointLength(this.head) - codePointLength(this.tail),
    );
    const retained = formatHeadTail(this.head, this.tail, omittedByBuffer);
    const output = truncateOutput(retained, maxCharacters);
    const truncated = omittedByBuffer > 0 || output.truncated;

    this.head = "";
    this.tail = "";
    this.totalCharacters = 0;

    return { output: output.output, truncated };
  }
}

function truncateOutput(output: string, maxCharacters: number): { output: string; truncated: boolean } {
  const outputCharacters = codePointLength(output);
  if (outputCharacters <= maxCharacters) return { output, truncated: false };

  const marker = "\n... output truncated ...\n";
  const markerCharacters = codePointLength(marker);
  const available = Math.max(0, maxCharacters - markerCharacters);
  const budget = splitBudget(available);
  return {
    output: takeHead(output, budget.head) + marker + takeTail(output, budget.tail),
    truncated: true,
  };
}

export class ProcessSessionManager {
  private readonly workStateDir?: string;
  private readonly sessions = new Map<string, ProcessSession>();
  private readonly legacySessions = new Map<number, string>();
  private handleStore?: { allocate(operationId:string):number; resolve(handle:number):string|null };

  setHandleStore(store: { allocate(operationId:string):number; resolve(handle:number):string|null } | undefined): void {
    this.handleStore = store;
  }

  resolveHandle(id: string | number): string {
    if (typeof id === "string") return id;
    const resolved = this.legacySessions.get(id) ?? this.handleStore?.resolve(id);
    if (!resolved) throw new Error(`COMMAND_NOT_FOUND: ${id}`);
    return resolved;
  }

  private readonly maxBufferCharacters: number;
  private readonly completedSessionTtlMs: number;
  private readonly stdioDrainTimeoutMs: number;
  readonly executionCoordinator?: ExecutionCoordinator;
  private readonly claims = new Set<ExecutionClaim>();
  private readonly finishListeners = new Set<ProcessFinishListener>();
  private outputSink?: ProcessOutputSink;
  private shuttingDown = false;
  private shutdownPromise?: Promise<void>;

  constructor(private readonly options: ProcessSessionManagerOptions = {}) {
    if (options.maxCompletedSessions !== undefined && (!Number.isInteger(options.maxCompletedSessions) || options.maxCompletedSessions < 1)) throw new Error("Terminal receipt cap must be a positive integer.");
    this.workStateDir = options.stateDir;
    this.maxBufferCharacters = options.maxBufferCharacters ?? DEFAULT_BUFFER_CHARACTERS;
    this.completedSessionTtlMs = options.completedSessionTtlMs ?? COMPLETED_SESSION_TTL_MS;
    this.stdioDrainTimeoutMs = boundedInteger(options.stdioDrainTimeoutMs, DEFAULT_STDIO_DRAIN_TIMEOUT_MS, 60_000);
    if (options.stateDir) this.executionCoordinator = new ExecutionCoordinator(options.stateDir);
  }

  async mutate<T>(workspaceRoot: string, operation: () => Promise<T>, scopes?:readonly ExecutionResource[]): Promise<T> {
    if (this.shuttingDown) throw new Error("Execution manager is shutting down.");
    const context=currentInvocation();
    const claim = this.executionCoordinator?.acquire({ workspaceRoot, kind: "mutation",scopes,
      operationId:context?.operation_id,taskId:context?.task_id });
    if (claim) this.claims.add(claim);
    try { return await operation(); } finally { this.releaseClaim(claim); }
  }

  addFinishListener(listener: ProcessFinishListener): void {
    this.finishListeners.add(listener);
  }

  setOutputSink(sink: ProcessOutputSink | undefined): void {
    this.outputSink = sink;
  }

  findOperation(operationId: string): ProcessOperationHandle | null {
    for (const session of this.sessions.values()) {
      if (session.sessionOperationId !== operationId) continue;
      const phase: ProcessOperationHandle["phase"] = !session.running
        ? "closed"
        : session.rootExitedAt === undefined
          ? "running"
          : "root_exited_stdio_open";
      return {
        session_id: session.id,
        workspace_id: session.workspaceId,
        running: session.running,
        phase,
        ...(session.exitCode === undefined ? {} : { exit_code: session.exitCode }),
        ...(session.signal === undefined ? {} : { signal: session.signal }),
      };
    }
    return null;
  }

  removeFinishListener(listener: ProcessFinishListener): void {
    this.finishListeners.delete(listener);
  }

  /** 普通查看读取当前内容；需要稳定输入的执行显式申请读取资源。 */
  async readWorkspace<T>(workspaceRoot: string, operation: () => Promise<T>): Promise<T> {
    if (this.shuttingDown) throw new Error("Execution manager is shutting down.");
    void workspaceRoot;
    return this.executionCoordinator
      ? this.executionCoordinator.withWork({kind:"resource",allowWhilePaused:true},operation)
      : operation();
  }

  private releaseClaim(claim?: ExecutionClaim): void {
    if (claim) { claim.release(); this.claims.delete(claim); }
  }

  async start(input: StartCommandInput): Promise<ProcessSnapshot> {
    if (this.shuttingDown) throw new Error("Execution manager is shutting down.");
    if (input.requestKey) {
      if (!input.workRunId || !this.workStateDir) throw new Error("Command requestKey requires persistent workRunId.");
      const ledger = new WorkLedger(this.workStateDir);
      try {
        ledger.requireScope(input.workRunId, input.workspaceRoot ?? input.cwd, input.workspaceId);
        const prior = ledger.db.prepare("select id from console_operations where run_id=? and request_key=?").get(input.workRunId, `command:${input.requestKey}`) as { id: string } | undefined;
        if (prior) throw new Error(`RECORDED_OPERATION: ${prior.id}; inspect the existing operation with workspace_context status or Console. Command was not replayed.`);
      } finally { ledger.close(); }
    }
    const yieldTimeMs = boundedInteger(input.yieldTimeMs, DEFAULT_EXEC_YIELD_MS, MAX_PROCESS_YIELD_MS);
    boundedInteger(input.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS, 100_000);
    const session = this.createSession(input);
    if (this.sessions.has(session.id)) throw new Error(`RECORDED_OPERATION: ${session.id}`);
    if (!session.sessionOperationId) session.sessionOperationId = currentInvocation()?.operation_id;
    const scopes=input.scopes ?? [{kind:"tree" as const,path:await requireCommandScope(input.cwd,input.scopeRoot),access:"write" as const}];
    session.executionClaim = this.executionCoordinator?.acquire({ workspaceRoot: input.workspaceRoot ?? input.cwd,
      kind: "command", resources: input.resources,scopes,operationId:session.sessionOperationId ?? session.id,
      taskId:currentInvocation()?.task_id,title:currentInvocation()?.tool_name ?? "命令" });
    if (session.executionClaim) this.claims.add(session.executionClaim);
    this.sessions.set(session.id, session);

    try {
      if (session.sessionOperationId && this.outputSink) {
        await this.outputSink.open(session.sessionOperationId, input.command);
        session.outputPending = Promise.resolve();
      }
      if (input.workRunId && this.workStateDir) {
        const ledger = new WorkLedger(this.workStateDir);
        try {
          ledger.requireScope(input.workRunId, input.workspaceRoot ?? input.cwd, input.workspaceId);
          if (input.requestKey) {
            const prior = ledger.db.prepare("select id from console_operations where run_id=? and request_key=?").get(input.workRunId, `command:${input.requestKey}`) as { id: string } | undefined;
            if (prior) throw new Error(`RECORDED_OPERATION: ${prior.id}; inspect the existing operation with workspace_context status or Console. Command was not replayed.`);
          }
          session.workOperationId = ledger.operation({ runId: input.workRunId, requestKey: `command:${input.requestKey ?? randomUUID()}`,
            kind: "command", label: "受管命令（不记录原始命令或凭据）", status: "running" });
        } finally { ledger.close(); }
      } else if (input.workRunId) throw new Error("Work accounting is unavailable; command was not started.");
      if (this.handleStore && session.sessionOperationId) session.legacyId = this.handleStore.allocate(session.sessionOperationId);
      this.legacySessions.set(session.legacyId,session.id);
      if (input.tty && process.platform !== "win32") await this.startPty(session, input);
      else await this.startPipe(session, input);
    } catch (error) {
      session.failure = diagnosticError(error);
      this.record(session, "process_start_failed", session.failure, "error");
      this.stopDescendantPoll(session);
      if (session.stdioDrainTimer) clearTimeout(session.stdioDrainTimer);
      this.endWorkOperation(session, false);
      this.sessions.delete(session.id);
      this.legacySessions.delete(session.legacyId);
      this.releaseClaim(session.executionClaim);
      throw error;
    }

    await this.waitForExit(session, yieldTimeMs);

    const snapshot = this.consume(session, input.maxOutputTokens);
    return snapshot;
  }

  async write(input: WriteStdinInput): Promise<ProcessSnapshot> {
    const session = this.getOwnedSession(input.workspaceId, input.sessionId);
    const chars = input.chars ?? "";
    const interactionRequested =
      chars.length > 0 || input.columns !== undefined || input.rows !== undefined;
    if (!session.running && interactionRequested) throw new Error("Process is terminal; only empty polls can replay its receipt.");

    if (input.columns !== undefined || input.rows !== undefined) {
      session.columns = terminalSize(input.columns, session.columns);
      session.rows = terminalSize(input.rows, session.rows);
      if (!session.process?.resize) {
        throw new Error(`Process session ${session.id} is not a PTY and cannot be resized.`);
      }
      session.process.resize(session.columns, session.rows);
    }

    const interruptRequested = chars.includes("\u0003") && session.running;
    if (interruptRequested) {
      try {
        await session.process?.kill("SIGINT");
      } catch (error) {
        this.record(session, "process_interrupt_error", diagnosticError(error), "warn");
      }
      if (session.rootExitedAt !== undefined && session.running) {
        this.finish(session, session.rootExitCode, "SIGINT");
      }
    }
    const writableChars = chars.replaceAll("\u0003", "");
    if (writableChars && session.running) {
      try {
        session.process?.write(writableChars);
      } catch (error) {
        this.record(session, "process_stdin_error", diagnosticError(error), "warn");
      }
    }

    if ((interactionRequested || !session.buffer.hasOutput()) && session.running) {
      const fallback = interactionRequested ? DEFAULT_INTERACTIVE_YIELD_MS : DEFAULT_POLL_YIELD_MS;
      const yieldTimeMs = boundedInteger(input.yieldTimeMs, fallback, MAX_PROCESS_YIELD_MS);
      await this.waitForExit(session, yieldTimeMs);
    }

    if (interruptRequested && session.running && session.rootExitedAt !== undefined) {
      this.finish(session, session.rootExitCode, "SIGINT");
    }

    const snapshot = this.consume(session, input.maxOutputTokens);
    return snapshot;
  }

  terminate(workspaceId: string, sessionId: string): void {
    const session = this.getOwnedSession(workspaceId, sessionId);
    if (!session.running) return;
    session.cancelRequestedAt ??= Date.now();
    this.record(session, "process_termination_requested", { sessionId });
    try {
      session.process?.kill("SIGTERM");
    } catch (error) {
      this.record(session, "process_terminate_error", diagnosticError(error), "warn");
    }
    if (session.rootExitedAt !== undefined) {
      this.finish(session, session.rootExitCode ?? 1, "SIGTERM");
    }
  }

  shutdown(): Promise<void> {
    this.shutdownPromise ??= this.closeOwnedProcesses();
    return this.shutdownPromise;
  }

  private async closeOwnedProcesses(): Promise<void> {
    this.shuttingDown = true;
    const active = [...this.sessions.values()].filter(session => session.running);
    const failures: unknown[] = [];
    await Promise.all(active.map(async session => {
      try { await session.process?.kill("SIGTERM"); } catch(error) { failures.push(error); }
    }));
    const force = setTimeout(() => {
      for (const session of active) if (session.running) void Promise.resolve(session.process?.kill("SIGKILL"))
        .catch(error => { failures.push(error); });
    }, 5000);
    force.unref();
    await Promise.all(active.map(session => session.exitPromise));
    await Promise.all(active.map(session => session.closePromise));
    clearTimeout(force);
    for (const session of this.sessions.values()) {
      if (session.stdioDrainTimer) clearTimeout(session.stdioDrainTimer);
      this.stopDescendantPoll(session);
      if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
    }
    this.sessions.clear();
    this.legacySessions.clear();
    if (this.claims.size === 0) this.executionCoordinator?.close();
    if (failures.length) throw new AggregateError(failures, "停止受管命令时发生错误");
  }

  private async waitForExit(session: ProcessSession, yieldTimeMs: number, surfaceRootExit = false): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const waits: Promise<void>[] = [session.exitPromise, new Promise<void>((resolve) => {
        timer = setTimeout(resolve, yieldTimeMs);
      })];
      if (surfaceRootExit) waits.push(session.rootExitPromise.then(async () => {
          // `exit` can precede `close` while descendants still own inherited
          // stdio. Give ordinary commands a short grace period to reach the
          // terminal close event, then surface the distinct recoverable phase.
          await Promise.race([
            session.exitPromise,
            new Promise<void>((resolve) => setTimeout(resolve, 20)),
          ]);
        }));
      await Promise.race(waits);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private createSession(input: StartCommandInput): ProcessSession {
    let resolveExit = (): void => undefined;
    let resolveRootExit = (): void => undefined;
    const exitPromise = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    const rootExitPromise = new Promise<void>((resolve) => {
      resolveRootExit = resolve;
    });

    return {
      execution: executionContract(input.tty),
      id: input.sessionOperationId ?? currentInvocation()?.operation_id ?? `command_${randomUUID()}`,
      legacyId: randomInt(1, 2 ** 48 - 1),
      workspaceId: input.workspaceId,
      workRunId: input.workRunId,
      sessionOperationId: input.sessionOperationId ?? currentInvocation()?.operation_id,
      onFinish: input.onFinish,
      outputBytes: 0,
      outputHash: createHash("sha256"),
      outputTail: "",
      persistedOutputBytes: -1,
      startedAt: Date.now(),
      columns: terminalSize(input.columns, DEFAULT_COLUMNS),
      rows: terminalSize(input.rows, DEFAULT_ROWS),
      buffer: new HeadTailBuffer(this.maxBufferCharacters),
      running: true,
      exitPromise,
      resolveExit,
      rootExitPromise,
      resolveRootExit,
    };
  }


  private async startPipe(session: ProcessSession, input: StartCommandInput): Promise<void> {
    const shell = input.program ? {executable:input.program.executable,args:input.program.args} : resolveShellCommand(input.command);
    const environment = mergeEnvironment(process.platform,
      processEnvironment({ workspaceId: input.workspaceId, workspaceRoot: input.workspaceRoot }),
      this.options.environment?.());
    const windows = process.platform === "win32";
    const job = windows ? new WindowsCommandJob() : undefined;
    session.commandJob = job;
    const child = windows
      ? spawn(process.execPath, [fileURLToPath(new URL("../node/process-runner.mjs", import.meta.url))], {
          cwd: input.cwd, env: environment, stdio: ["pipe", "pipe", "pipe", "ipc"], windowsHide: true,
        })
      : spawn(input.program?.executable ?? input.command,input.program?.args ?? [], {
          cwd: input.cwd, env: environment, stdio: "pipe", windowsHide: true, detached: true, shell: input.program ? false : shell.executable,
        });
    if (!child.stdin || !child.stdout || !child.stderr) {
      child.kill();
      throw new Error("命令需要可读写的进程管道");
    }
    const stdout = child.stdout, stderr = child.stderr;
    session.wrapperPid = windows ? child.pid : undefined;
    session.pgid = windows ? undefined : child.pid;
    session.rootPid = windows ? undefined : child.pid;
    let resolveClose!: () => void;
    session.closePromise = new Promise<void>(resolve => { resolveClose = resolve; });
    child.stdin.on("error", error => this.record(session, "process_stdin_error", diagnosticError(error), "warn"));
    session.process = {
      write: data => {
        if (!child.stdin?.writable || child.stdin.destroyed) throw new Error("命令输入管道已经关闭");
        child.stdin.write(data, error => { if (error) this.record(session, "process_stdin_error", diagnosticError(error), "warn"); });
      },
      kill: (signal = "SIGTERM") => {
        if (session.commandJob) session.commandJob.terminate(signal === "SIGINT" ? 130 : 143);
        else return terminateProcessTree(child, signal, !windows, undefined, session.pgid);
      },
    };
    const consume = (stream: typeof stdout) => {
      stream.setEncoding("utf8");
      const output = new Writable({
        decodeStrings: false,
        highWaterMark: 64 * 1024,
        write: (chunk: string | Buffer, _encoding, done) => {
          this.append(session, typeof chunk === "string" ? chunk : chunk.toString("utf8")).then(() => done(), error => done(error as Error));
        },
      });
      return pipeline(stream, output).catch(error => {
        session.outputError = error instanceof Error ? error : new Error(String(error));
        session.failure = diagnosticError(error);
        this.record(session, "process_output_stream_failed", session.failure, "error");
      });
    };
    const outputCompletion = Promise.all([consume(stdout), consume(stderr)]).then(() => undefined);
    session.stdioSettled = false;
    const stdioCompletion = outputCompletion.finally(() => {
      session.stdioSettled = true;
      this.checkOwnedCompletion(session, child);
    });
    session.stdioCompletion = stdioCompletion;
    const rootExited = (code?: number | null, signal?: string | null) => {
      if (session.rootExitedAt !== undefined) return;
      session.rootExitedAt = Date.now();
      session.rootExitCode = code ?? undefined;
      session.rootSignal = signal ?? undefined;
      session.resolveRootExit();
      session.stopOwnedWatch = watchOwnedProcesses(() => this.checkOwnedCompletion(session, child));
      session.stdioDrainTimer = setTimeout(() => this.checkOwnedCompletion(session, child), this.stdioDrainTimeoutMs);
      session.stdioDrainTimer.unref();
    };
    child.on("error", error => {
      session.failure = diagnosticError(error);
      this.record(session, "process_error", session.failure, "error");
    });
    child.once("close", (code, signal) => {
      rootExited(code, signal);
      session.pipeClosed = true;
      void stdioCompletion.then(() => resolveClose());
    });
    if (!windows) {
      child.once("exit", rootExited);
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", () => { this.record(session, "process_started", { childPid: child.pid }); resolve(); });
        child.once("error", reject);
      });
      return;
    }
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("命令启动器初始化超时")), 10000);
        const failed = (error: Error) => { clearTimeout(timeout); reject(error); };
        child.once("error", failed);
        child.once("spawn", () => {
          try {
            if (!child.pid) throw new Error("命令启动器没有 PID");
            // 启动器先加入作业组，收到消息后才创建用户命令。
            job!.assign(child.pid);
            child.send!({ type: "start", command: input.command, cwd: input.cwd, shell: shell.executable,program:input.program });
          } catch (error) { failed(error as Error); }
        });
        child.on("message", value => {
          const message = value as { type?: string; pid?: number; code?: number; signal?: string; message?: string };
          if (message.type === "started") {
            session.rootPid = message.pid;
            this.record(session, "process_started", { childPid: message.pid, launcherPid: child.pid });
            clearTimeout(timeout); child.off("error", failed); resolve();
          } else if (message.type === "start-error") {
            failed(new Error(message.message ?? "命令启动失败"));
          } else if (message.type === "root-exit") {
            rootExited(message.code, message.signal);
          } else if (message.type === "stream-error") {
            this.record(session, "process_stdin_error", { message: message.message }, "warn");
          }
        });
      });
    } catch (error) {
      job!.close();
      child.kill();
      await session.closePromise;
      throw error;
    }
  }

  private ownedProcessesAlive(session: ProcessSession): boolean | null {
    if (session.commandJob) {
      try { return session.commandJob.alivePids().some(pid => pid !== session.wrapperPid && pid !== session.rootPid); }
      catch (error) {
        session.descendantLookupFailed = true;
        this.record(session, "process_job_query_failed", diagnosticError(error), "error");
        return null;
      }
    }
    return session.pgid ? processGroupAlive(session.pgid) : null;
  }

  private checkOwnedCompletion(session: ProcessSession, child?: ChildProcess): void {
    if (!session.running || session.finalizing || session.rootExitedAt === undefined) return;
    const alive = this.ownedProcessesAlive(session);
    if (alive === true) {
      session.disposition = "waiting_for_descendants";
      return;
    }
    if (session.pipeClosed && alive === false && session.stdioSettled === true) {
      this.finish(session, session.rootExitCode, session.rootSignal);
      return;
    }
    if ((session.pendingOutputWrites ?? 0) > 0) return;
    if (Date.now() - session.rootExitedAt < this.stdioDrainTimeoutMs) return;
    session.disposition = alive === null ? "reconciliation_required" : "incomplete_output";
    session.outputComplete = false;
    session.failure = { code: session.disposition };
    this.record(session, "process_stdio_drain_timeout", {
      rootExitCode: session.rootExitCode, elapsedSinceRootExitMs: Date.now() - session.rootExitedAt,
      disposition: session.disposition,
    }, "warn");
    if (alive === false) { child?.stdout?.destroy(); child?.stderr?.destroy(); }
    if (session.stdioSettled === true) this.finish(session, session.rootExitCode, session.rootSignal);
  }

  private stopDescendantPoll(session: ProcessSession): void {
    session.stopOwnedWatch?.();
    session.stopOwnedWatch = undefined;
    session.commandJob?.close();
    session.commandJob = undefined;
  }

  private async startPty(session: ProcessSession, input: StartCommandInput): Promise<void> {
    const nodePty = await import("node-pty");
    const shell = input.program ? {executable:input.program.executable,args:input.program.args} : resolveShellCommand(input.command);
    const pty = nodePty.spawn(shell.executable, shell.args, {
      cwd: input.cwd,
      env: mergeEnvironment(process.platform,
        processEnvironment({ workspaceId: input.workspaceId, workspaceRoot: input.workspaceRoot }),
        this.options.environment?.()) as Record<string, string>,
      name: "xterm-256color", cols: session.columns, rows: session.rows,
    });
    session.rootPid = pty.pid;
    session.pgid = pty.pid;
    session.process = {
      write: data => pty.write(data),
      kill: signal => {
        try { process.kill(-pty.pid, (signal ?? "SIGTERM") as NodeJS.Signals); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      },
      resize: (columns, rows) => pty.resize(columns, rows),
    };
    session.stdioSettled = false;
    this.record(session, "process_started", { childPid: pty.pid });
    pty.onData(data => {
      pty.pause();
      void this.append(session, data).then(() => { if (session.running) pty.resume(); }, error => {
        session.outputError = error instanceof Error ? error : new Error(String(error));
        pty.kill();
      });
    });
    let resolveClose!: () => void;
    session.closePromise = new Promise<void>(resolve => { resolveClose = resolve; });
    pty.onExit(({ exitCode, signal }) => {
      session.rootExitedAt = Date.now();
      session.rootExitCode = exitCode;
      session.rootSignal = signal === 0 ? undefined : String(signal);
      session.pipeClosed = true;
      session.stdioSettled = true;
      session.stdioCompletion = Promise.resolve();
      session.resolveRootExit();
      session.stopOwnedWatch = watchOwnedProcesses(() => this.checkOwnedCompletion(session));
      this.checkOwnedCompletion(session);
      resolveClose();
    });
  }

  private finish(session: ProcessSession, exitCode?: number, signal?: string): void {
    if (session.finalizing) return;
    session.finalizing = (async () => {
      await session.stdioCompletion;
      if (session.outputPending && session.sessionOperationId && this.outputSink) {
        await session.outputPending.then(async () => {
          if (session.outputError) throw session.outputError;
          await this.outputSink!.finish(session.sessionOperationId!, exitCode ?? null, signal ?? null);
        }).catch((error: unknown) => {
          session.failure = diagnosticError(error);
          session.disposition = "incomplete_output";
          session.outputComplete = false;
          this.record(session, "process_output_persist_failed", session.failure, "error");
          return this.outputSink?.fail?.(
            session.sessionOperationId!,
            String((session.failure as { code?: unknown }).code ?? "OUTPUT_PERSIST_FAILED"),
            exitCode ?? null,
            signal ?? null,
          ).catch((failure: unknown) => {
            this.record(session, "process_output_failure_receipt_failed", diagnosticError(failure), "error");
          });
        });
      }
      await this.finishAfterOutput(session, exitCode, signal);
    })();
    void session.finalizing.catch(error => {
      this.record(session,"process_finalization_failed",diagnosticError(error),"error");
      this.releaseClaim(session.executionClaim);
      session.running=false;session.failure=diagnosticError(error);session.disposition="reconciliation_required";
      session.resolveExit();
    });
  }

  private async finishAfterOutput(session: ProcessSession, exitCode?: number, signal?: string): Promise<void> {
    if (!session.running) return;
    if (session.stdioDrainTimer) {
      clearTimeout(session.stdioDrainTimer);
      session.stdioDrainTimer = undefined;
    }
    this.stopDescendantPoll(session);
    session.finishedAt = Date.now();
    session.exitCode = exitCode;
    session.signal = signal;
    if (session.disposition === undefined || session.disposition === "waiting_for_descendants") {
      session.disposition = "completed";
      session.outputComplete = true;
    }
    if (session.outputComplete === undefined) session.outputComplete = false;
    const cancelled = session.cancelRequestedAt !== undefined;
    const success = !cancelled && exitCode === 0 && !signal && !session.failure && session.disposition === "completed" && session.outputComplete === true;
    this.record(session, "process_finished", { exitCode, signal, outputBytes: session.outputBytes, ...session.failure }, success ? "info" : "warn");
    this.endWorkOperation(session, success);
    // 进程与输出已经结束，立即释放执行范围；界面回调不占用命令资源。
    session.running = false;
    this.releaseClaim(session.executionClaim);
    const finish: ProcessFinish = {
        workspaceId: session.workspaceId,
        sessionId: session.id,
        ...(session.sessionOperationId ? { sessionOperationId: session.sessionOperationId } : {}),
        success,
        cancelled,
        exitCode: session.exitCode,
        signal: session.signal,
        disposition: session.disposition,
    };
    const callbacks = [
      ...(session.onFinish ? [session.onFinish] : []),
      ...this.finishListeners,
    ];
    for (const callback of callbacks) {
      try {
        await callback(finish);
      } catch (error) {
        this.record(session, "process_session_finish_callback_failed", diagnosticError(error), "error");
        session.failure = diagnosticError(error);
        session.disposition = "reconciliation_required";
      }
    }
    session.resolveExit();
    session.cleanupTimer = setTimeout(
      () => this.removeSession(session.id),
      this.completedSessionTtlMs,
    );
    session.cleanupTimer.unref();
    const completed = [...this.sessions.values()].filter((item) => !item.running)
      .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
    while (completed.length > (this.options.maxCompletedSessions ?? 64)) this.removeSession(completed.shift()!.id);
  }

  private endWorkOperation(session: ProcessSession, success: boolean): void {
    if (!session.workOperationId || !this.workStateDir) return;
    let ledger: WorkLedger | undefined;
    try {
      const outputPersisted = this.persistOutput(session);
      ledger = new WorkLedger(this.workStateDir);
      const operationStatus = session.disposition === "reconciliation_required" ? "reconciliation_required"
        : session.cancelRequestedAt !== undefined ? "cancelled" : success ? "completed" : "failed";
      ledger.endOperation(session.workOperationId, operationStatus, [{
        label: success ? "Managed process exited successfully (not deployment acceptance)" : session.disposition === "reconciliation_required" ? "Descendant state is unknown; reconcile before treating the command as finished" : session.disposition === "incomplete_output" ? "Root exited and no descendant remained, but the output pipe did not close" : "Managed process failed; inspect state before retrying",
        reference: JSON.stringify({ version: 1, boundary: "process", sessionId: session.id, pid: process.pid,
          exitCode: session.exitCode ?? null, signal: session.signal ?? null, elapsedMs: Date.now() - session.startedAt,
          outputBytes: session.outputBytes, outputSha256: session.outputHash.copy().digest("hex"),
          outputComplete: session.outputComplete === true, disposition: session.disposition,
          logReference: { event: "process_finished", operationId: session.workOperationId, sessionId: session.id, pid: process.pid },
          outputRecovery: outputPersisted ? "bounded_log_tail" : "metadata_only", hostAcknowledgment: "unknown", ...session.failure, retry: "reconcile_before_replay" }),
        outcome: success ? "passed" : session.disposition === "reconciliation_required" ? "not_run" : "failed",
      }]);
      if (operationStatus === "reconciliation_required" && session.workRunId) {
        ledger.markRunReconciliationRequired(session.workRunId);
      }
    } catch (error) {
      this.record(session, "process_accounting_failed", diagnosticError(error), "error");
      this.append(session, "Work accounting could not be finalized; reconcile the work run before marking it complete.\n");
    } finally {
      try { ledger?.close(); }
      catch (error) { this.record(session, "process_accounting_failed", diagnosticError(error), "error"); }
    }
  }

  private record(session: ProcessSession, event: string, fields: Record<string, unknown> = {}, level: "info" | "warn" | "error" = "info"): void {
    try {
      this.options.diagnostics?.(event, { workspaceId: session.workspaceId, workRunId: session.workRunId,
        operationId: session.workOperationId, sessionId: session.id, elapsedMs: Date.now() - session.startedAt, ...fields }, level);
    } catch {}
  }

  private append(session: ProcessSession, output: string): Promise<void> {
    session.outputBytes += Buffer.byteLength(output);
    session.outputHash.update(output);
    session.buffer.append(output);
    session.outputTail = appendOutputTail(session.outputTail, output);
    if (session.outputPending && session.sessionOperationId && this.outputSink) {
      const sink = this.outputSink;
      const operationId = session.sessionOperationId;
      session.pendingOutputWrites = (session.pendingOutputWrites ?? 0) + 1;
      const writing = session.outputPending.then(async () => {
        if (session.outputError) throw session.outputError;
        await sink.append(operationId, output);
      }).finally(() => { session.pendingOutputWrites = (session.pendingOutputWrites ?? 1) - 1; });
      session.outputPending = writing.catch((error: unknown) => {
        session.outputError = error instanceof Error ? error : new Error(String(error));
      });
      return writing;
    }
    return Promise.resolve();
  }

  private persistOutput(session: ProcessSession): boolean {
    if (!session.workOperationId || !this.workStateDir) return false;
    if (session.persistedOutputBytes === session.outputBytes) return true;
    try {
      saveOutputTail(this.workStateDir, session.workOperationId, session.outputTail);
      session.persistedOutputBytes = session.outputBytes;
      return true;
    } catch (error) {
      this.record(session, "process_output_persist_failed", diagnosticError(error), "error");
      return false;
    }
  }

  private consume(session: ProcessSession, maxOutputTokens?: number): ProcessSnapshot {
    this.persistOutput(session);
    if (session.terminalReceipt) return { ...session.terminalReceipt, execution: { ...session.execution }, terminalReplay: true };
    const limit = boundedInteger(maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS, 100_000);
    const maxCharacters = Math.max(256, limit * 4);
    const buffered = session.buffer.drain(maxCharacters);
    this.record(session, "process_output_consumed", { running: session.running,
      returnedOutputBytes: Buffer.byteLength(buffered.output), outputTruncated: buffered.truncated });

    const isRootExitedStdioOpen = session.running && session.rootExitedAt !== undefined;
    const phase: ProcessSnapshot["phase"] = !session.running
      ? "closed"
      : session.rootExitedAt === undefined
        ? "running"
        : "root_exited_stdio_open";

    const recoverableDescription = isRootExitedStdioOpen
      ? `Root process exited with code ${session.rootExitCode ?? "unknown"}, but background descendant processes are still active and holding output streams open. Session remains running until stdio closes or termination is requested.`
      : undefined;

    const snapshot: ProcessSnapshot = {
      execution: { ...session.execution },
      phase,
      rootExitedElapsedMs: isRootExitedStdioOpen ? Date.now() - session.rootExitedAt! : undefined,
      terminalReplay: false,
      outputScope: "since_previous_read",
      operationId: session.workOperationId,
      workRunId: session.workRunId,
      sessionId: session.id,
      legacySessionId: session.legacyId,
      output: buffered.output,
      outputTruncated: buffered.truncated,
      running: session.running,
      exitCode: session.exitCode ?? (isRootExitedStdioOpen ? session.rootExitCode : undefined),
      rootExitCode: session.rootExitCode,
      signal: session.signal ?? (isRootExitedStdioOpen ? session.rootSignal : undefined),
      wallTimeMs: (session.finishedAt ?? Date.now()) - session.startedAt,
      recoverableDescription,
      outputComplete: session.outputComplete,
      disposition: session.disposition,
    };
    if (!session.running) session.terminalReceipt = { ...snapshot, execution: { ...snapshot.execution } };
    return snapshot;
  }

  private getOwnedSession(workspaceId: string, sessionId: string | number): ProcessSession {
    const session = this.sessions.get(this.resolveHandle(sessionId));
    if (!session) throw new Error(`Unknown process session: ${sessionId}`);
    if (session.workspaceId !== workspaceId) {
      throw new Error(`Process session ${sessionId} does not belong to workspace ${workspaceId}.`);
    }
    return session;
  }

  private removeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session?.cleanupTimer) clearTimeout(session.cleanupTimer);
    if (session) this.legacySessions.delete(session.legacyId);
    this.sessions.delete(sessionId);
  }
}
