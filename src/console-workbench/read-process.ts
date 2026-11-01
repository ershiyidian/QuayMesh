import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {existsSync} from 'node:fs';
import { CONSOLE_READ_OPERATIONS,CONSOLE_READ_BUSINESS_ERRORS } from './read-protocol.js';

export const CONSOLE_READ_TIMEOUT_MS = 5_000;
export const CONSOLE_READ_REQUEST_BYTES = 64 * 1024;
export const CONSOLE_READ_RESULT_BYTES = 8 * 1024 * 1024;
const MAX_ACTIVE = 1;
const MAX_QUEUED = 8;

export class ConsoleReadError extends Error {
  readonly status:number;
  readonly effect = 'none';
  constructor(readonly code: string) {
    const known=Object.hasOwn(CONSOLE_READ_BUSINESS_ERRORS,code)
      ? CONSOLE_READ_BUSINESS_ERRORS[code as keyof typeof CONSOLE_READ_BUSINESS_ERRORS] : undefined;
    super(known?.message??(code === 'console_read_timeout' ? '控制台读取超时，已终止该只读查询，请稍后重试'
      : code === 'console_read_busy' ? '控制台读取队列繁忙，请稍后重试'
      : code === 'console_read_too_large' ? '控制台读取结果超过大小限制，请缩小范围'
      : code === 'console_read_aborted' ? '控制台读取已取消' : '控制台读取失败，请稍后重试'));
    this.status=known?.status??503;
    this.name = 'ConsoleReadError';
  }
}

interface ReadJob {
  input: string;
  resolve: (value: unknown) => void;
  reject: (error: ConsoleReadError) => void;
  deadline: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abort?: () => void;
  child?: ChildProcessWithoutNullStreams;
  done: boolean;
  route: string;
  createdAt: number;
  result: string;
  finishReported: boolean;
}

export interface ConsoleReadDiagnostic {
  event: 'console_read'; phase: 'start'|'finish'|'timeout'; route: string;
  childPid: number|null; elapsedMs: number; result: string;
}

/** Dedicated Console reader capacity. Each child handles one request and exits;
 * no execution command, shell, SQL text, module path or credentials enter it. */
export class ConsoleReadProcessPool {
  private readonly queue: ReadJob[] = [];
  private readonly active = new Set<ReadJob>();
  private closed = false;
  constructor(private readonly worker = new URL('./read-worker.js', import.meta.url),
    private readonly timeoutMs = CONSOLE_READ_TIMEOUT_MS,
    private readonly report:(event:ConsoleReadDiagnostic)=>void = event=>console.info(JSON.stringify(event))) {}

  read<T>(request: unknown, signal?: AbortSignal): Promise<T> {
    if (this.closed || signal?.aborted) return Promise.reject(new ConsoleReadError('console_read_aborted'));
    if (this.active.size >= MAX_ACTIVE && this.queue.length >= MAX_QUEUED)
      return Promise.reject(new ConsoleReadError('console_read_busy'));
    let input: string;
    try { input = JSON.stringify(request); }
    catch { return Promise.reject(new ConsoleReadError('console_read_invalid')); }
    if (typeof input !== 'string' || Buffer.byteLength(input) > CONSOLE_READ_REQUEST_BYTES)
      return Promise.reject(new ConsoleReadError('console_read_too_large'));
    return new Promise<T>((resolve, reject) => {
      const operation=(request as {operation?:unknown}|null)?.operation;
      const route=CONSOLE_READ_OPERATIONS.includes(operation as typeof CONSOLE_READ_OPERATIONS[number])?String(operation):'unknown';
      const job: ReadJob = { input, resolve: value => resolve(value as T), reject, done: false,
        route,createdAt:performance.now(),result:'pending',finishReported:false,
        deadline: setTimeout(() => this.fail(job, 'console_read_timeout'), this.timeoutMs), signal };
      job.abort = () => this.fail(job, 'console_read_aborted');
      signal?.addEventListener('abort', job.abort, {once: true});
      this.queue.push(job); this.drain();
    });
  }

  close(): void {
    this.closed = true;
    for (const job of [...this.queue, ...this.active]) this.fail(job, 'console_read_aborted');
  }

  private settle(job: ReadJob, error?: string, value?: unknown): void {
    if (job.done) return;
    job.done = true; job.result=error??'completed'; clearTimeout(job.deadline);
    if (job.abort) job.signal?.removeEventListener('abort', job.abort);
    const index = this.queue.indexOf(job); if (index >= 0) this.queue.splice(index, 1);
    if (error) job.reject(new ConsoleReadError(error)); else job.resolve(value);
    if(!job.child)this.diagnostic(job,'finish');
  }

  private diagnostic(job:ReadJob,phase:ConsoleReadDiagnostic['phase']):void {
    if(phase==='finish'){if(job.finishReported)return;job.finishReported=true;}
    try{this.report({event:'console_read',phase,route:job.route,childPid:job.child?.pid??null,
      elapsedMs:Math.round(performance.now()-job.createdAt),result:job.result});}catch{/* Logging cannot change query lifecycle. */}
  }

  private fail(job: ReadJob, code: string): void {
    if(!job.done&&code==='console_read_timeout'){job.result=code;this.diagnostic(job,'timeout');}
    this.settle(job, code);
    // The ChildProcess handle belongs only to this read. Never kill a process
    // group, Core, a task, a host job, or a PID supplied in a request.
    if (job.child && job.child.exitCode === null && job.child.signalCode === null) job.child.kill('SIGKILL');
    // Keep the slot occupied until the OS confirms child close. A stuck native
    // call cannot turn repeated timeouts into unlimited replacement processes.
    this.drain();
  }

  private drain(): void {
    while (!this.closed && this.active.size < MAX_ACTIVE && this.queue.length) {
      const job = this.queue.shift()!;
      if (job.done) continue;
      this.active.add(job);
      this.start(job);
    }
  }

  private start(job: ReadJob): void {
    const env: NodeJS.ProcessEnv = {};
    // Preserve OS runtime locations only. In particular no NODE_OPTIONS,
    // QUAYMESH_*, cloud key, proxy credential, or model token is inherited.
    for (const key of Object.keys(process.env)) if (/^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|TMPDIR|HOME|USERPROFILE|LOCALAPPDATA|APPDATA|HOMEDRIVE|HOMEPATH|LANG|LC_ALL|TZ)$/i.test(key))
      env[key] = process.env[key];
    let child: ChildProcessWithoutNullStreams;
    try {
      // Source-run tests use the same compiled reader produced by the normal
      // build; never inherit a loader/debugger/NODE_OPTIONS into a child.
      const worker=!existsSync(this.worker)&&import.meta.url.endsWith('.ts')&&this.worker.href===new URL('./read-worker.js',import.meta.url).href
        ? new URL('../../dist/console-workbench/read-worker.js',import.meta.url) : this.worker;
      child = spawn(process.execPath, ['--max-old-space-size=192', fileURLToPath(worker)],
        {env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
      job.child = child;
      this.diagnostic(job,'start');
    } catch {
      this.active.delete(job); this.settle(job, 'console_read_failed'); this.drain(); return;
    }
    let bytes = 0;
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => {
      if (job.done) return;
      bytes += chunk.length;
      if (bytes > CONSOLE_READ_RESULT_BYTES) { this.fail(job, 'console_read_too_large'); return; }
      chunks.push(chunk);
    });
    // Import/native errors may contain paths or data. They never become a
    // Console response or a parent log; only fixed error codes are returned.
    (child.stderr as Readable).resume();
    child.stdin.on('error', () => this.fail(job, 'console_read_failed'));
    child.on('error', () => this.fail(job, 'console_read_failed'));
    child.on('close', code => {
      this.active.delete(job);
      if (!job.done) {
        try {
          if (code !== 0) throw new Error();
          const response = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {ok?: boolean; value?: unknown; code?: string};
          if (response.ok !== true) this.settle(job,
            response.code === 'console_read_too_large'||typeof response.code==='string'&&Object.hasOwn(CONSOLE_READ_BUSINESS_ERRORS,response.code)
              ? response.code : 'console_read_failed');
          else this.settle(job, undefined, response.value);
        } catch { this.settle(job, 'console_read_failed'); }
      }
      this.diagnostic(job,'finish');
      this.drain();
    });
    child.stdin.end(job.input);
  }
}
